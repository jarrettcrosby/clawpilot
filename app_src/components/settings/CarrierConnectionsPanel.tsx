'use client'

import { useEffect, useMemo, useState } from 'react'
import Accordion from '@mui/material/Accordion'
import AccordionDetails from '@mui/material/AccordionDetails'
import AccordionSummary from '@mui/material/AccordionSummary'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Card from '@mui/material/Card'
import CardActionArea from '@mui/material/CardActionArea'
import CardContent from '@mui/material/CardContent'
import Checkbox from '@mui/material/Checkbox'
import Chip from '@mui/material/Chip'
import CircularProgress from '@mui/material/CircularProgress'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import Divider from '@mui/material/Divider'
import FormControl from '@mui/material/FormControl'
import FormControlLabel from '@mui/material/FormControlLabel'
import InputLabel from '@mui/material/InputLabel'
import MenuItem from '@mui/material/MenuItem'
import Select from '@mui/material/Select'
import Stack from '@mui/material/Stack'
import Step from '@mui/material/Step'
import StepLabel from '@mui/material/StepLabel'
import Stepper from '@mui/material/Stepper'
import Switch from '@mui/material/Switch'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import AddRounded from '@mui/icons-material/AddRounded'
import CheckCircleRounded from '@mui/icons-material/CheckCircleRounded'
import ExpandMoreRounded from '@mui/icons-material/ExpandMoreRounded'
import LocalPrintshopRounded from '@mui/icons-material/LocalPrintshopRounded'
import LocalShippingRounded from '@mui/icons-material/LocalShippingRounded'
import SearchRounded from '@mui/icons-material/SearchRounded'
import SettingsRounded from '@mui/icons-material/SettingsRounded'
import CarrierIntegrationPanel from './CarrierIntegrationPanel'

type DirectProvider = 'ups_rest' | 'fedex_rest'
type BrokeredProvider = 'wwex_speedship' | 'rl_carriers'
type Provider = DirectProvider | BrokeredProvider | 'usps_rest'
type Environment = 'sandbox' | 'production'

type DirectBillingAccount = {
  globalId: string
  displayName: string
  senderName: string
  accountNumberLastFour: string
  status: 'needs_configuration' | 'active' | 'disabled'
}

type DirectConnection = {
  globalId: string
  provider: DirectProvider | 'usps_rest'
  environment: Environment
  displayName: string
  status: 'active' | 'disabled' | 'error'
  configured: boolean
  verificationStatus: 'unverified' | 'verified' | 'failed'
  allowedCapabilities: string[]
  carrierAccounts: DirectBillingAccount[]
  managedBy: string | null
}

type BrokeredConnection = {
  globalId: string
  provider: BrokeredProvider
  environment: Environment
  displayName: string
  status: 'active' | 'disabled' | 'error'
  configured: boolean
  verificationStatus: 'unverified' | 'verified' | 'failed'
  supportedTransportModes: Array<'small_parcel' | 'ltl'>
  ratingActivation: { smallParcel: boolean; ltl: boolean }
}

type DirectPayload = {
  ok?: boolean
  error?: string
  integrations?: { accounts: DirectConnection[] }
}

type BrokeredPayload = {
  ok?: boolean
  error?: string
  canActivate?: boolean
  integrations?: { accounts: BrokeredConnection[] }
}

type ProviderOption = {
  id: Provider
  name: string
  description: string
  services: string[]
  unavailable?: boolean
}

const PROVIDERS: ProviderOption[] = [
  {
    id: 'ups_rest',
    name: 'UPS',
    description: 'Connect a UPS developer application and billing account.',
    services: ['Parcel rates', 'Labels'],
  },
  {
    id: 'fedex_rest',
    name: 'FedEx',
    description: 'Connect a FedEx API project and billing account.',
    services: ['Parcel rates', 'Labels'],
  },
  {
    id: 'wwex_speedship',
    name: 'Worldwide Express',
    description: 'Use one sandbox connection for brokered parcel and LTL rates.',
    services: ['Parcel rates', 'LTL rates'],
  },
  {
    id: 'rl_carriers',
    name: 'R+L Carriers',
    description: 'Connect a production R+L API key for read-only LTL rates.',
    services: ['LTL rates'],
  },
  {
    id: 'usps_rest',
    name: 'USPS',
    description: 'USPS execution is not available in this release.',
    services: ['Unavailable'],
    unavailable: true,
  },
]

const WIZARD_STEPS = ['Carrier', 'Connection', 'Services', 'Done']
const POSTAL_CODE_PATTERN = /^(?:\d{5}(?:-\d{4})?|[A-Za-z]\d[A-Za-z][ -]?\d[A-Za-z]\d)$/
const fieldSx = {
  '& .MuiOutlinedInput-root': { borderRadius: '8px', backgroundColor: '#20202A' },
}

type DirectForm = {
  environment: Environment
  displayName: string
  clientId: string
  clientSecret: string
  accountName: string
  accountNumber: string
  senderName: string
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

type BrokeredForm = {
  displayName: string
  clientId: string
  clientSecret: string
  apiKey: string
  verificationPostalCode: string
  verificationCountryCode: 'USA' | 'CAN'
}

function directForm(provider: DirectProvider): DirectForm {
  const name = provider === 'ups_rest' ? 'UPS' : 'FedEx'
  return {
    environment: 'sandbox',
    displayName: `${name} sandbox`,
    clientId: '',
    clientSecret: '',
    accountName: `${name} billing account`,
    accountNumber: '',
    senderName: '',
    line1: '',
    line2: '',
    city: '',
    region: '',
    postalCode: '',
    countryCode: 'US',
    allowSenderBilling: true,
    allowRecipientBilling: false,
    allowThirdPartyBilling: false,
  }
}

function brokeredForm(provider: BrokeredProvider): BrokeredForm {
  return {
    displayName: provider === 'wwex_speedship'
      ? 'Worldwide Express sandbox'
      : 'R+L Carriers production',
    clientId: '',
    clientSecret: '',
    apiKey: '',
    verificationPostalCode: '',
    verificationCountryCode: 'USA',
  }
}

function providerName(provider: Provider) {
  return PROVIDERS.find((entry) => entry.id === provider)?.name || provider
}

function isDirectProvider(provider: Provider | null): provider is DirectProvider {
  return provider === 'ups_rest' || provider === 'fedex_rest'
}

function isBrokeredProvider(provider: Provider | null): provider is BrokeredProvider {
  return provider === 'wwex_speedship' || provider === 'rl_carriers'
}

async function requestDirect(init?: RequestInit) {
  const response = await fetch('/api/integrations/carriers', {
    cache: 'no-store',
    ...init,
  })
  const result = await response.json().catch(() => ({})) as DirectPayload
  if (!response.ok || !result.ok || !result.integrations) {
    throw new Error(result.error || 'Carrier connection request failed')
  }
  return result
}

async function requestBrokered(init?: RequestInit) {
  const response = await fetch('/api/integrations/brokered-transport', {
    cache: 'no-store',
    ...init,
  })
  const result = await response.json().catch(() => ({})) as BrokeredPayload
  if (!response.ok || !result.ok || !result.integrations) {
    throw new Error(result.error || 'Transport connection request failed')
  }
  return result
}

function idempotencyKey() {
  const unique = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`
  return `carrier-connection:${unique}`
}

export default function CarrierConnectionsPanel({
  onNavigate,
}: {
  onNavigate?: (hash: string) => void
}) {
  const [directConnections, setDirectConnections] = useState<DirectConnection[]>([])
  const [brokeredConnections, setBrokeredConnections] = useState<BrokeredConnection[]>([])
  const [canActivateBrokered, setCanActivateBrokered] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [notice, setNotice] = useState('')
  const [pendingConnection, setPendingConnection] = useState('')
  const [wizardOpen, setWizardOpen] = useState(false)
  const [wizardStep, setWizardStep] = useState(0)
  const [providerSearch, setProviderSearch] = useState('')
  const [selectedProvider, setSelectedProvider] = useState<Provider | null>(null)
  const [directDetails, setDirectDetails] = useState<DirectForm>(directForm('ups_rest'))
  const [brokeredDetails, setBrokeredDetails] = useState<BrokeredForm>(brokeredForm('wwex_speedship'))
  const [wwexParcelRates, setWwexParcelRates] = useState(true)
  const [wwexLtlRates, setWwexLtlRates] = useState(true)
  const [enableDirectRates, setEnableDirectRates] = useState(true)
  const [wizardBusy, setWizardBusy] = useState(false)
  const [wizardError, setWizardError] = useState('')
  const [completionStatus, setCompletionStatus] = useState<'active' | 'saved'>('active')
  const [troubleshootExpanded, setTroubleshootExpanded] = useState(false)

  useEffect(() => {
    let active = true
    void Promise.all([requestDirect(), requestBrokered()])
      .then(([direct, brokered]) => {
        if (!active) return
        setDirectConnections(direct.integrations?.accounts || [])
        setBrokeredConnections(brokered.integrations?.accounts || [])
        setCanActivateBrokered(brokered.canActivate === true)
      })
      .catch((caught) => {
        if (active) {
          setLoadError(caught instanceof Error ? caught.message : 'Unable to load carrier connections')
        }
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => { active = false }
  }, [])

  const connectedDirect = useMemo(
    () => directConnections.filter((entry) => (
      entry.provider !== 'usps_rest'
      && (entry.configured || entry.carrierAccounts.length > 0)
    )),
    [directConnections],
  )
  const connectedBrokered = useMemo(
    () => brokeredConnections.filter((entry) => entry.configured),
    [brokeredConnections],
  )
  const connectedProviders = useMemo(
    () => new Set<Provider>([
      ...connectedDirect.map((entry) => entry.provider),
      ...connectedBrokered.map((entry) => entry.provider),
    ]),
    [connectedBrokered, connectedDirect],
  )
  const filteredProviders = useMemo(() => {
    const search = providerSearch.trim().toLowerCase()
    if (!search) return PROVIDERS
    return PROVIDERS.filter((entry) => (
      entry.name.toLowerCase().includes(search)
      || entry.description.toLowerCase().includes(search)
      || entry.services.some((service) => service.toLowerCase().includes(search))
    ))
  }, [providerSearch])

  const detailsValid = useMemo(() => {
    if (isDirectProvider(selectedProvider)) {
      return directDetails.displayName.trim().length >= 2
        && directDetails.clientId.trim().length >= 3
        && directDetails.clientSecret.trim().length >= 8
        && directDetails.accountName.trim().length >= 2
        && directDetails.accountNumber.trim().length >= 4
        && directDetails.senderName.trim().length >= 2
        && directDetails.line1.trim().length >= 2
        && directDetails.city.trim().length >= 2
        && directDetails.region.trim().length >= 2
        && directDetails.postalCode.trim().length >= 3
        && /^[A-Za-z]{2}$/.test(directDetails.countryCode.trim())
        && (
          directDetails.allowSenderBilling
          || directDetails.allowRecipientBilling
          || directDetails.allowThirdPartyBilling
        )
    }
    if (selectedProvider === 'wwex_speedship') {
      return brokeredDetails.displayName.trim().length >= 2
        && brokeredDetails.clientId.trim().length >= 3
        && brokeredDetails.clientSecret.trim().length >= 8
    }
    if (selectedProvider === 'rl_carriers') {
      return brokeredDetails.displayName.trim().length >= 2
        && brokeredDetails.apiKey.trim().length >= 8
        && POSTAL_CODE_PATTERN.test(brokeredDetails.verificationPostalCode.trim())
    }
    return false
  }, [brokeredDetails, directDetails, selectedProvider])

  function openWizard() {
    setWizardOpen(true)
    setWizardStep(0)
    setProviderSearch('')
    setSelectedProvider(null)
    setWizardError('')
    setCompletionStatus('active')
  }

  function closeWizard() {
    if (wizardBusy) return
    setWizardOpen(false)
  }

  function chooseProvider(provider: Provider) {
    if (provider === 'usps_rest' || connectedProviders.has(provider)) return
    setSelectedProvider(provider)
    if (isDirectProvider(provider)) setDirectDetails(directForm(provider))
    if (isBrokeredProvider(provider)) setBrokeredDetails(brokeredForm(provider))
    setWizardError('')
    setWizardStep(1)
  }

  async function connectDetails() {
    if (!detailsValid || !selectedProvider) return
    setWizardBusy(true)
    setWizardError('')
    try {
      if (isDirectProvider(selectedProvider)) {
        const credentialResult = await requestDirect({
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'update-credential',
            provider: selectedProvider,
            environment: directDetails.environment,
            displayName: directDetails.displayName.trim(),
            clientId: directDetails.clientId.trim(),
            clientSecret: directDetails.clientSecret,
          }),
        })
        setDirectConnections(credentialResult.integrations?.accounts || [])
        const accountResult = await requestDirect({
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'create-account',
            provider: selectedProvider,
            environment: directDetails.environment,
            displayName: directDetails.accountName.trim(),
            senderName: directDetails.senderName.trim(),
            accountNumber: directDetails.accountNumber.trim(),
            registeredAddress: {
              line1: directDetails.line1.trim(),
              line2: directDetails.line2.trim() || null,
              city: directDetails.city.trim(),
              region: directDetails.region.trim().toUpperCase(),
              postalCode: directDetails.postalCode.trim(),
              countryCode: directDetails.countryCode.trim().toUpperCase(),
            },
            allowSenderBilling: directDetails.allowSenderBilling,
            allowRecipientBilling: directDetails.allowRecipientBilling,
            allowThirdPartyBilling: directDetails.allowThirdPartyBilling,
          }),
        })
        setDirectConnections(accountResult.integrations?.accounts || [])
      } else if (isBrokeredProvider(selectedProvider)) {
        const brokeredResult = await requestBrokered({
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': idempotencyKey(),
          },
          body: JSON.stringify({
            action: 'update-credential',
            provider: selectedProvider,
            environment: selectedProvider === 'wwex_speedship' ? 'sandbox' : 'production',
            displayName: brokeredDetails.displayName.trim(),
            credential: selectedProvider === 'wwex_speedship'
              ? {
                  authKind: 'oauth_client_credentials',
                  clientId: brokeredDetails.clientId.trim(),
                  clientSecret: brokeredDetails.clientSecret,
                  audience: 'staging-wwex-apig',
                }
              : { authKind: 'api_key', apiKey: brokeredDetails.apiKey },
          }),
        })
        setBrokeredConnections(brokeredResult.integrations?.accounts || [])
        if (typeof brokeredResult.canActivate === 'boolean') {
          setCanActivateBrokered(brokeredResult.canActivate)
        }
      }
      setWizardStep(2)
    } catch (caught) {
      setWizardError(caught instanceof Error ? caught.message : 'Unable to connect carrier')
    } finally {
      setWizardBusy(false)
    }
  }

  async function finishSetup() {
    if (!selectedProvider) return
    setWizardBusy(true)
    setWizardError('')
    try {
      if (isDirectProvider(selectedProvider) && enableDirectRates) {
        const result = await requestDirect({
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'set-enabled',
            provider: selectedProvider,
            environment: directDetails.environment,
            enabled: true,
          }),
        })
        setDirectConnections(result.integrations?.accounts || [])
      } else if (isDirectProvider(selectedProvider)) {
        setCompletionStatus('saved')
      }
      if (isBrokeredProvider(selectedProvider)) {
        if (!canActivateBrokered) {
          setCompletionStatus('saved')
          setWizardStep(3)
          return
        }
        const ratingModes = selectedProvider === 'rl_carriers'
          ? ['ltl']
          : [
              ...(wwexParcelRates ? ['small_parcel'] : []),
              ...(wwexLtlRates ? ['ltl'] : []),
            ]
        if (!ratingModes.length) {
          setWizardError('Choose at least one rating service.')
          return
        }
        const result = await requestBrokered({
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'verify-and-activate-rates',
            provider: selectedProvider,
            environment: selectedProvider === 'wwex_speedship' ? 'sandbox' : 'production',
            ratingModes,
            ...(selectedProvider === 'rl_carriers' ? {
              verificationPostalCode: brokeredDetails.verificationPostalCode.trim(),
              verificationCountryCode: brokeredDetails.verificationCountryCode,
            } : {}),
          }),
        })
        setBrokeredConnections(result.integrations?.accounts || [])
      }
      if (!isDirectProvider(selectedProvider) || enableDirectRates) {
        setCompletionStatus('active')
      }
      setWizardStep(3)
    } catch (caught) {
      setWizardError(caught instanceof Error ? caught.message : 'Unable to finish carrier setup')
    } finally {
      setWizardBusy(false)
    }
  }

  async function toggleDirect(connection: DirectConnection, enabled: boolean) {
    const key = `${connection.provider}:${connection.environment}`
    setPendingConnection(key)
    setLoadError('')
    setNotice('')
    try {
      const result = await requestDirect({
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'set-enabled',
          provider: connection.provider,
          environment: connection.environment,
          enabled,
        }),
      })
      setDirectConnections(result.integrations?.accounts || [])
      setNotice(`${providerName(connection.provider)} ${enabled ? 'enabled' : 'disabled'}.`)
    } catch (caught) {
      setLoadError(caught instanceof Error ? caught.message : 'Unable to update carrier connection')
    } finally {
      setPendingConnection('')
    }
  }

  function navigateToPrinting() {
    setWizardOpen(false)
    onNavigate?.('#operations/printing')
  }

  const selectedOption = selectedProvider
    ? PROVIDERS.find((entry) => entry.id === selectedProvider) || null
    : null

  return (
    <Box data-testid="carrier-connections-landing" sx={{ maxWidth: 920, mx: 'auto' }}>
      <Stack spacing={2.5}>
        <Stack
          direction={{ xs: 'column', sm: 'row' }}
          spacing={1.5}
          justifyContent="space-between"
          alignItems={{ xs: 'stretch', sm: 'center' }}
        >
          <Box>
            <Stack direction="row" spacing={1} alignItems="center">
              <LocalShippingRounded color="primary" />
              <Typography variant="h6" fontWeight={700}>Carriers</Typography>
            </Stack>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
              Connect carrier accounts, see what is active, and keep advanced diagnostics out of the way.
            </Typography>
          </Box>
          <Button variant="contained" startIcon={<AddRounded />} onClick={openWizard}>
            Add carrier
          </Button>
        </Stack>

        {loadError ? (
          <Alert severity="error" onClose={() => setLoadError('')}>{loadError}</Alert>
        ) : null}
        {notice ? (
          <Alert severity="success" onClose={() => setNotice('')}>{notice}</Alert>
        ) : null}

        {loading ? (
          <Stack direction="row" spacing={1} alignItems="center" sx={{ py: 5, justifyContent: 'center' }}>
            <CircularProgress size={22} />
            <Typography variant="body2">Loading carrier connections…</Typography>
          </Stack>
        ) : connectedDirect.length || connectedBrokered.length ? (
          <Stack spacing={1} data-testid="carrier-connections-list">
            {connectedDirect.map((connection) => {
              const connectionKey = `${connection.provider}:${connection.environment}`
              const accountSummary = connection.carrierAccounts.length
                ? connection.carrierAccounts
                    .map((account) => `${account.displayName} ending ${account.accountNumberLastFour}`)
                    .join(' · ')
                : 'Billing account setup is incomplete'
              return (
                <Box
                  key={connectionKey}
                  data-testid={`carrier-connection-${connection.provider}-${connection.environment}`}
                  sx={{
                    p: 2,
                    border: '1px solid',
                    borderColor: 'divider',
                    borderRadius: '10px',
                    display: 'grid',
                    gridTemplateColumns: { xs: '1fr', md: 'minmax(0, 1fr) auto' },
                    gap: 1.5,
                    alignItems: 'center',
                  }}
                >
                  <Box sx={{ minWidth: 0 }}>
                    <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap alignItems="center">
                      <Typography variant="subtitle1" fontWeight={700}>
                        {providerName(connection.provider)}
                      </Typography>
                      <Chip size="small" variant="outlined" label={connection.environment} />
                      <Chip
                        size="small"
                        color={connection.verificationStatus === 'verified' ? 'success' : 'default'}
                        label={connection.verificationStatus === 'verified' ? 'Verified' : 'Needs attention'}
                      />
                      <Chip size="small" variant="outlined" label="Parcel rates" />
                      {connection.allowedCapabilities.includes('production_label') ? (
                        <Chip size="small" variant="outlined" label="Labels authorized" />
                      ) : null}
                    </Stack>
                    <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }} noWrap>
                      {accountSummary}
                    </Typography>
                  </Box>
                  <Stack direction="row" spacing={1} alignItems="center">
                    <FormControlLabel
                      control={(
                        <Switch
                          checked={connection.status === 'active'}
                          disabled={pendingConnection === connectionKey || Boolean(connection.managedBy)}
                          onChange={(_, enabled) => void toggleDirect(connection, enabled)}
                          inputProps={{ 'aria-label': `Enable ${providerName(connection.provider)}` }}
                        />
                      )}
                      label={connection.status === 'active' ? 'On' : 'Off'}
                      sx={{ m: 0 }}
                    />
                    <Button size="small" onClick={() => setTroubleshootExpanded(true)}>
                      Manage
                    </Button>
                  </Stack>
                </Box>
              )
            })}

            {connectedBrokered.map((connection) => (
              <Box
                key={`${connection.provider}:${connection.environment}`}
                data-testid={`carrier-connection-${connection.provider}-${connection.environment}`}
                sx={{
                  p: 2,
                  border: '1px solid',
                  borderColor: 'divider',
                  borderRadius: '10px',
                  display: 'grid',
                  gridTemplateColumns: { xs: '1fr', md: 'minmax(0, 1fr) auto' },
                  gap: 1.5,
                  alignItems: 'center',
                }}
              >
                <Box sx={{ minWidth: 0 }}>
                  <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap alignItems="center">
                    <Typography variant="subtitle1" fontWeight={700}>
                      {providerName(connection.provider)}
                    </Typography>
                    <Chip size="small" variant="outlined" label={connection.environment} />
                    <Chip
                      size="small"
                      color={connection.verificationStatus === 'verified' ? 'success' : 'default'}
                      label={connection.verificationStatus === 'verified' ? 'Verified' : 'Needs attention'}
                    />
                    {connection.ratingActivation.smallParcel ? (
                      <Chip size="small" variant="outlined" label="Parcel rates" />
                    ) : null}
                    {connection.ratingActivation.ltl ? (
                      <Chip size="small" variant="outlined" label="LTL rates" />
                    ) : null}
                  </Stack>
                  <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                    {connection.status === 'active'
                      ? 'Read-only rating is active. Tendering remains disabled.'
                      : canActivateBrokered
                        ? 'Credentials are saved. Finish verification to activate rating.'
                        : 'Credentials are saved. An operations activator must enable rating.'}
                  </Typography>
                </Box>
                <Stack direction="row" spacing={1} alignItems="center">
                  <Chip
                    size="small"
                    color={connection.status === 'active' ? 'success' : 'default'}
                    label={connection.status === 'active' ? 'On' : 'Off'}
                  />
                  <Button size="small" onClick={() => setTroubleshootExpanded(true)}>
                    Manage
                  </Button>
                </Stack>
              </Box>
            ))}
          </Stack>
        ) : (
          <Box
            data-testid="carrier-connections-empty"
            sx={{
              py: 5,
              px: 2,
              border: '1px dashed',
              borderColor: 'divider',
              borderRadius: '10px',
              textAlign: 'center',
            }}
          >
            <LocalShippingRounded sx={{ fontSize: 36, color: 'text.disabled' }} />
            <Typography variant="subtitle1" fontWeight={700} sx={{ mt: 1 }}>
              No carriers connected
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              Add a carrier to start testing rates and shipping configuration.
            </Typography>
            <Button variant="outlined" startIcon={<AddRounded />} onClick={openWizard}>
              Add your first carrier
            </Button>
          </Box>
        )}

        <Button
          variant="outlined"
          startIcon={<LocalPrintshopRounded />}
          onClick={() => onNavigate?.('#operations/printing')}
          sx={{ alignSelf: 'flex-start' }}
        >
          Set up label printing
        </Button>

        <Accordion
          data-testid="carrier-connections-troubleshoot"
          expanded={troubleshootExpanded}
          onChange={(_, expanded) => setTroubleshootExpanded(expanded)}
          disableGutters
          sx={{ border: '1px solid', borderColor: 'divider', borderRadius: '10px !important' }}
        >
          <AccordionSummary expandIcon={<ExpandMoreRounded />}>
            <Stack direction="row" spacing={1} alignItems="center">
              <SettingsRounded fontSize="small" />
              <Box>
                <Typography variant="subtitle2" fontWeight={700}>Troubleshoot</Typography>
                <Typography variant="caption" color="text.secondary">
                  Credential rotation, connection tests, rate diagnostics, and label test evidence.
                </Typography>
              </Box>
            </Stack>
          </AccordionSummary>
          <AccordionDetails>
            {troubleshootExpanded ? <CarrierIntegrationPanel brokeredFocus="all" /> : null}
          </AccordionDetails>
        </Accordion>
      </Stack>

      <Dialog open={wizardOpen} onClose={closeWizard} fullWidth maxWidth="md">
        <DialogTitle>
          {wizardStep === 0 ? 'Add carrier' : selectedOption?.name || 'Add carrier'}
        </DialogTitle>
        <DialogContent dividers>
          <Stepper activeStep={wizardStep} alternativeLabel sx={{ mb: 3 }}>
            {WIZARD_STEPS.map((label) => (
              <Step key={label}><StepLabel>{label}</StepLabel></Step>
            ))}
          </Stepper>

          {wizardError ? <Alert severity="error" sx={{ mb: 2 }}>{wizardError}</Alert> : null}

          {wizardStep === 0 ? (
            <Stack spacing={2}>
              <TextField
                autoFocus
                label="Search carriers"
                value={providerSearch}
                onChange={(event) => setProviderSearch(event.target.value)}
                InputProps={{ startAdornment: <SearchRounded sx={{ mr: 1, color: 'text.secondary' }} /> }}
                sx={fieldSx}
              />
              <Box
                data-testid="carrier-provider-picker"
                sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' }, gap: 1.5 }}
              >
                {filteredProviders.map((option) => {
                  const alreadyConnected = connectedProviders.has(option.id)
                  const unavailable = option.unavailable || alreadyConnected
                  return (
                    <Card key={option.id} variant="outlined">
                      <CardActionArea
                        disabled={unavailable}
                        onClick={() => chooseProvider(option.id)}
                        data-testid={`carrier-provider-${option.id}`}
                        sx={{ height: '100%', alignItems: 'stretch' }}
                      >
                        <CardContent>
                          <Stack direction="row" spacing={1} justifyContent="space-between" alignItems="center">
                            <Typography variant="subtitle1" fontWeight={700}>{option.name}</Typography>
                            {option.unavailable ? (
                              <Chip size="small" label="Unavailable" />
                            ) : alreadyConnected ? (
                              <Chip size="small" color="success" label="Connected" />
                            ) : null}
                          </Stack>
                          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.75, mb: 1.25 }}>
                            {option.description}
                          </Typography>
                          <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
                            {option.services.map((service) => (
                              <Chip key={service} size="small" variant="outlined" label={service} />
                            ))}
                          </Stack>
                        </CardContent>
                      </CardActionArea>
                    </Card>
                  )
                })}
              </Box>
              {!filteredProviders.length ? (
                <Typography variant="body2" color="text.secondary">No carriers match that search.</Typography>
              ) : null}
            </Stack>
          ) : null}

          {wizardStep === 1 && isDirectProvider(selectedProvider) ? (
            <Stack spacing={2}>
              <Alert severity="info">
                ClawPilot verifies these credentials before saving them. No label or shipment is created.
              </Alert>
              <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' }, gap: 1.5 }}>
                <FormControl sx={fieldSx}>
                  <InputLabel id="carrier-wizard-environment-label">Environment</InputLabel>
                  <Select
                    labelId="carrier-wizard-environment-label"
                    label="Environment"
                    value={directDetails.environment}
                    onChange={(event) => {
                      const environment = event.target.value as Environment
                      setDirectDetails((current) => ({
                        ...current,
                        environment,
                        displayName: `${providerName(selectedProvider)} ${environment}`,
                      }))
                    }}
                  >
                    <MenuItem value="sandbox">Sandbox / developer</MenuItem>
                    <MenuItem value="production">Production</MenuItem>
                  </Select>
                </FormControl>
                <TextField
                  required
                  label="Connection name"
                  value={directDetails.displayName}
                  onChange={(event) => setDirectDetails((current) => ({ ...current, displayName: event.target.value }))}
                  sx={fieldSx}
                />
                <TextField
                  required
                  label="Client ID"
                  value={directDetails.clientId}
                  onChange={(event) => setDirectDetails((current) => ({ ...current, clientId: event.target.value }))}
                  autoComplete="off"
                  sx={fieldSx}
                />
                <TextField
                  required
                  type="password"
                  label="Client secret"
                  value={directDetails.clientSecret}
                  onChange={(event) => setDirectDetails((current) => ({ ...current, clientSecret: event.target.value }))}
                  autoComplete="new-password"
                  sx={fieldSx}
                />
              </Box>
              <Divider />
              <Box>
                <Typography variant="subtitle2" fontWeight={700}>Billing account</Typography>
                <Typography variant="caption" color="text.secondary">
                  The account number is encrypted and cannot be changed after this account is created.
                </Typography>
              </Box>
              <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' }, gap: 1.5 }}>
                <TextField
                  required
                  label="Account name"
                  value={directDetails.accountName}
                  onChange={(event) => setDirectDetails((current) => ({ ...current, accountName: event.target.value }))}
                  sx={fieldSx}
                />
                <TextField
                  required
                  type="password"
                  label="Account number"
                  value={directDetails.accountNumber}
                  onChange={(event) => setDirectDetails((current) => ({ ...current, accountNumber: event.target.value }))}
                  autoComplete="off"
                  sx={fieldSx}
                />
                <TextField
                  required
                  label="Sender name"
                  value={directDetails.senderName}
                  onChange={(event) => setDirectDetails((current) => ({ ...current, senderName: event.target.value }))}
                  sx={{ ...fieldSx, gridColumn: { sm: '1 / -1' } }}
                />
                <TextField
                  required
                  label="Registered address line 1"
                  value={directDetails.line1}
                  onChange={(event) => setDirectDetails((current) => ({ ...current, line1: event.target.value }))}
                  sx={fieldSx}
                />
                <TextField
                  label="Address line 2"
                  value={directDetails.line2}
                  onChange={(event) => setDirectDetails((current) => ({ ...current, line2: event.target.value }))}
                  sx={fieldSx}
                />
                <TextField
                  required
                  label="City"
                  value={directDetails.city}
                  onChange={(event) => setDirectDetails((current) => ({ ...current, city: event.target.value }))}
                  sx={fieldSx}
                />
                <TextField
                  required
                  label="State / region"
                  value={directDetails.region}
                  onChange={(event) => setDirectDetails((current) => ({ ...current, region: event.target.value }))}
                  sx={fieldSx}
                />
                <TextField
                  required
                  label="Postal code"
                  value={directDetails.postalCode}
                  onChange={(event) => setDirectDetails((current) => ({ ...current, postalCode: event.target.value }))}
                  sx={fieldSx}
                />
                <TextField
                  required
                  label="Country code"
                  value={directDetails.countryCode}
                  onChange={(event) => setDirectDetails((current) => ({ ...current, countryCode: event.target.value.toUpperCase() }))}
                  inputProps={{ maxLength: 2 }}
                  sx={fieldSx}
                />
              </Box>
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
                <FormControlLabel
                  control={<Checkbox checked={directDetails.allowSenderBilling} onChange={(_, value) => setDirectDetails((current) => ({ ...current, allowSenderBilling: value }))} />}
                  label="Sender billing"
                />
                <FormControlLabel
                  control={<Checkbox checked={directDetails.allowRecipientBilling} onChange={(_, value) => setDirectDetails((current) => ({ ...current, allowRecipientBilling: value }))} />}
                  label="Recipient billing"
                />
                <FormControlLabel
                  control={<Checkbox checked={directDetails.allowThirdPartyBilling} onChange={(_, value) => setDirectDetails((current) => ({ ...current, allowThirdPartyBilling: value }))} />}
                  label="Third-party billing"
                />
              </Stack>
            </Stack>
          ) : null}

          {wizardStep === 1 && isBrokeredProvider(selectedProvider) ? (
            <Stack spacing={2}>
              <Alert severity="info">
                Credentials are encrypted before storage. Verification only requests authentication and rates;
                it never creates a tender, pickup, BOL, shipment, label, or charge.
              </Alert>
              <TextField
                required
                label="Connection name"
                value={brokeredDetails.displayName}
                onChange={(event) => setBrokeredDetails((current) => ({ ...current, displayName: event.target.value }))}
                sx={fieldSx}
              />
              {selectedProvider === 'wwex_speedship' ? (
                <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' }, gap: 1.5 }}>
                  <TextField
                    required
                    label="Client ID"
                    value={brokeredDetails.clientId}
                    onChange={(event) => setBrokeredDetails((current) => ({ ...current, clientId: event.target.value }))}
                    autoComplete="off"
                    sx={fieldSx}
                  />
                  <TextField
                    required
                    type="password"
                    label="Client secret"
                    value={brokeredDetails.clientSecret}
                    onChange={(event) => setBrokeredDetails((current) => ({ ...current, clientSecret: event.target.value }))}
                    autoComplete="new-password"
                    sx={fieldSx}
                  />
                </Box>
              ) : (
                <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' }, gap: 1.5 }}>
                  <TextField
                    required
                    type="password"
                    label="API key"
                    value={brokeredDetails.apiKey}
                    onChange={(event) => setBrokeredDetails((current) => ({ ...current, apiKey: event.target.value }))}
                    autoComplete="new-password"
                    sx={{ ...fieldSx, gridColumn: { sm: '1 / -1' } }}
                  />
                  <TextField
                    required
                    label="Service-point postal code"
                    value={brokeredDetails.verificationPostalCode}
                    onChange={(event) => setBrokeredDetails((current) => ({ ...current, verificationPostalCode: event.target.value }))}
                    helperText="Used for the read-only R+L verification request."
                    sx={fieldSx}
                  />
                  <FormControl sx={fieldSx}>
                    <InputLabel id="carrier-wizard-country-label">Country</InputLabel>
                    <Select
                      labelId="carrier-wizard-country-label"
                      label="Country"
                      value={brokeredDetails.verificationCountryCode}
                      onChange={(event) => setBrokeredDetails((current) => ({
                        ...current,
                        verificationCountryCode: event.target.value as 'USA' | 'CAN',
                      }))}
                    >
                      <MenuItem value="USA">United States</MenuItem>
                      <MenuItem value="CAN">Canada</MenuItem>
                    </Select>
                  </FormControl>
                </Box>
              )}
              <Typography variant="caption" color="text.secondary">
                {selectedProvider === 'wwex_speedship'
                  ? 'Worldwide Express setup is limited to the supported sandbox rating connection.'
                  : 'R+L setup uses its supported production rate-verification connection.'}
              </Typography>
            </Stack>
          ) : null}

          {wizardStep === 2 && selectedProvider ? (
            <Stack spacing={2}>
              <Box>
                <Typography variant="subtitle1" fontWeight={700}>Services and defaults</Typography>
                <Typography variant="body2" color="text.secondary">
                  Choose which safe rating services to activate. Tendering and live postage remain separately disabled.
                </Typography>
              </Box>
              {isDirectProvider(selectedProvider) ? (
                <Box sx={{ p: 2, border: '1px solid', borderColor: 'divider', borderRadius: '8px' }}>
                  <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap sx={{ mb: 1 }}>
                    <Chip label="Parcel rates" color="primary" />
                    <Chip label="Labels guarded separately" variant="outlined" />
                  </Stack>
                  <FormControlLabel
                    control={<Switch checked={enableDirectRates} onChange={(_, value) => setEnableDirectRates(value)} />}
                    label="Turn on this rating connection"
                  />
                </Box>
              ) : selectedProvider === 'wwex_speedship' ? (
                <Stack>
                  <FormControlLabel
                    control={<Checkbox checked={wwexParcelRates} onChange={(_, value) => setWwexParcelRates(value)} />}
                    label="UPS parcel rates through Worldwide Express"
                  />
                  <FormControlLabel
                    control={<Checkbox checked={wwexLtlRates} onChange={(_, value) => setWwexLtlRates(value)} />}
                    label="Brokered LTL rates"
                  />
                </Stack>
              ) : (
                <FormControlLabel control={<Checkbox checked disabled />} label="R+L LTL rates" />
              )}
              <Alert severity="info">
                Carrier and service defaults are selected in Create Shipment and order routing. This setup does not invent a global default that the backend cannot store.
              </Alert>
              {isBrokeredProvider(selectedProvider) && !canActivateBrokered ? (
                <Alert severity="warning" data-testid="carrier-activation-permission-warning">
                  Your credentials will stay saved, but an operations activator must verify and enable rates.
                </Alert>
              ) : null}
            </Stack>
          ) : null}

          {wizardStep === 3 && selectedProvider ? (
            <Stack spacing={2.5} alignItems="center" sx={{ py: 3, textAlign: 'center' }}>
              <CheckCircleRounded color="success" sx={{ fontSize: 52 }} />
              <Box>
                <Typography variant="h6" fontWeight={700}>
                  {completionStatus === 'active' ? 'Carrier connected' : 'Credentials saved'}
                </Typography>
                <Typography variant="body2" color="text.secondary" sx={{ mt: 0.75 }}>
                  {completionStatus === 'active'
                    ? `${providerName(selectedProvider)} is ready for its enabled rating services.`
                    : isBrokeredProvider(selectedProvider)
                      ? 'An operations activator can finish verification from Troubleshoot.'
                      : 'The connection is saved and left off. You can enable it from the carrier list.'}
                </Typography>
              </Box>
              <Button variant="outlined" startIcon={<LocalPrintshopRounded />} onClick={navigateToPrinting}>
                Set up label printing
              </Button>
            </Stack>
          ) : null}
        </DialogContent>
        <DialogActions>
          {wizardStep === 0 ? (
            <Button onClick={closeWizard}>Cancel</Button>
          ) : wizardStep === 1 ? (
            <>
              <Button onClick={() => setWizardStep(0)} disabled={wizardBusy}>Back</Button>
              <Button
                variant="contained"
                onClick={() => void connectDetails()}
                disabled={wizardBusy || !detailsValid}
                startIcon={wizardBusy ? <CircularProgress size={16} color="inherit" /> : undefined}
              >
                {isDirectProvider(selectedProvider) ? 'Test and connect' : 'Save securely'}
              </Button>
            </>
          ) : wizardStep === 2 ? (
            <Button
              variant="contained"
              onClick={() => void finishSetup()}
              disabled={wizardBusy || (selectedProvider === 'wwex_speedship' && !wwexParcelRates && !wwexLtlRates)}
              startIcon={wizardBusy ? <CircularProgress size={16} color="inherit" /> : undefined}
            >
              {isBrokeredProvider(selectedProvider) && !canActivateBrokered
                ? 'Save for an administrator'
                : 'Verify and finish'}
            </Button>
          ) : (
            <Button variant="contained" onClick={closeWizard}>Done</Button>
          )}
        </DialogActions>
      </Dialog>
    </Box>
  )
}
