'use client'

import { useEffect, useMemo, useState, type FormEvent } from 'react'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Checkbox from '@mui/material/Checkbox'
import Chip from '@mui/material/Chip'
import CircularProgress from '@mui/material/CircularProgress'
import FormControl from '@mui/material/FormControl'
import FormControlLabel from '@mui/material/FormControlLabel'
import InputLabel from '@mui/material/InputLabel'
import MenuItem from '@mui/material/MenuItem'
import Select from '@mui/material/Select'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import DeleteOutlineRounded from '@mui/icons-material/DeleteOutlineRounded'
import SaveRounded from '@mui/icons-material/SaveRounded'
import VerifiedRounded from '@mui/icons-material/VerifiedRounded'

type Provider = 'wwex_speedship' | 'rl_carriers'
type Environment = 'sandbox' | 'production'

type IntegrationAccount = {
  globalId: string
  provider: Provider
  providerLabel: string
  environment: Environment
  displayName: string
  status: 'active' | 'disabled' | 'error'
  configured: boolean
  credentialVersion: number
  credentialKind: 'oauth_client_credentials' | 'api_key' | null
  credentialIdentifierLastFour: string | null
  verificationStatus: 'unverified' | 'verified' | 'failed'
  verifiedAt: string | null
  lastErrorCode: string | null
  allowedCapabilities: string[]
  supportedTransportModes: Array<'small_parcel' | 'ltl'>
  ratingActivation: { smallParcel: boolean; ltl: boolean }
  tenderActivation: { smallParcel: boolean; ltl: boolean }
  activationBlockers: string[]
  tenderActivationBlockers: string[]
  updatedAt: string
}

type Payload = {
  ok: boolean
  error?: string
  integrations?: {
    organizationId: string
    accounts: IntegrationAccount[]
  }
}

const blockerLabels: Record<string, string> = {
  credentials_required: 'Carrier credentials required',
  credential_verification_required: 'Credential verification required',
  billing_account_configuration_required: 'Provider billing account and registered ship-from address required',
  sandbox_contract_verification_required: 'Sandbox request/response verification required',
  package_code_confirmation_required: 'WWEX package-code mapping requires confirmation',
  cancel_contract_required: 'WWEX corrected cancellation contract required',
  provider_platform_review_required: 'WWEX platform review required',
  production_endpoint_configuration_required: 'WWEX production endpoints and audience required',
  production_certification_required: 'WWEX production certification required',
  production_rate_smoke_required: 'R+L production rate smoke test required',
  account_tariff_verification_required: 'R+L account and tariff verification required',
  bol_pickup_certification_required: 'R+L BOL and pickup certification required',
  shipment_void_unsupported: 'R+L shipment/BOL void is not published',
  one_off_tender_orchestration_required: 'One-off durable freight tender orchestration required',
  document_reconciliation_required: 'Freight document and partial-outcome reconciliation required',
}

const fieldSx = {
  '& .MuiOutlinedInput-root': { borderRadius: '8px', backgroundColor: '#20202A' },
}

function nextCredentialCommandIdempotencyKey() {
  return `brokered-transport-credential:${crypto.randomUUID()}`
}

async function requestTransport(init?: RequestInit) {
  const response = await fetch('/api/integrations/brokered-transport', {
    cache: 'no-store',
    ...init,
  })
  const result = await response.json().catch(() => ({})) as Payload
  if (!response.ok || !result.ok || !result.integrations) {
    throw new Error(result.error || 'Transport integration request failed')
  }
  return result.integrations
}

export default function BrokeredTransportIntegrationPanel() {
  const [provider, setProvider] = useState<Provider>('wwex_speedship')
  const [environment, setEnvironment] = useState<Environment>('sandbox')
  const [accounts, setAccounts] = useState<IntegrationAccount[]>([])
  const [displayName, setDisplayName] = useState('Worldwide Express sandbox')
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [audience, setAudience] = useState('staging-wwex-apig')
  const [apiKey, setApiKey] = useState('')
  const [verificationPostalCode, setVerificationPostalCode] = useState('')
  const [verificationCountryCode, setVerificationCountryCode] = useState<'USA' | 'CAN'>('USA')
  const [loading, setLoading] = useState(true)
  const [pending, setPending] = useState('')
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [confirmDisconnect, setConfirmDisconnect] = useState(false)
  const [credentialCommandIdempotencyKey, setCredentialCommandIdempotencyKey] =
    useState(nextCredentialCommandIdempotencyKey)

  useEffect(() => {
    let active = true
    void requestTransport()
      .then((result) => {
        if (active) setAccounts(result.accounts)
      })
      .catch((caught) => {
        if (active) setError(caught instanceof Error ? caught.message : 'Unable to load transport integrations')
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => { active = false }
  }, [])

  const account = useMemo(
    () => accounts.find((entry) => (
      entry.provider === provider && entry.environment === environment
    )) || null,
    [accounts, environment, provider],
  )

  useEffect(() => {
    if (account) setDisplayName(account.displayName)
  }, [account])

  function chooseProvider(value: Provider) {
    const nextEnvironment = value === 'rl_carriers' ? 'production' : 'sandbox'
    setProvider(value)
    setEnvironment(nextEnvironment)
    setDisplayName(value === 'wwex_speedship'
      ? `Worldwide Express ${nextEnvironment}`
      : 'R+L Carriers production')
    setAudience(value === 'wwex_speedship' && nextEnvironment === 'sandbox'
      ? 'staging-wwex-apig'
      : '')
    setClientId('')
    setClientSecret('')
    setApiKey('')
    setVerificationPostalCode('')
    setVerificationCountryCode('USA')
    setConfirmDisconnect(false)
    setNotice('')
    setError('')
    setCredentialCommandIdempotencyKey(nextCredentialCommandIdempotencyKey())
  }

  function chooseEnvironment(value: Environment) {
    setEnvironment(value)
    setDisplayName(`Worldwide Express ${value}`)
    setAudience(value === 'sandbox' ? 'staging-wwex-apig' : '')
    setClientId('')
    setClientSecret('')
    setConfirmDisconnect(false)
    setCredentialCommandIdempotencyKey(nextCredentialCommandIdempotencyKey())
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    setPending('save')
    setNotice('')
    setError('')
    try {
      const credential = provider === 'wwex_speedship'
        ? {
            authKind: 'oauth_client_credentials',
            clientId,
            clientSecret,
            audience,
          }
        : { authKind: 'api_key', apiKey }
      const result = await requestTransport({
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': credentialCommandIdempotencyKey,
        },
        body: JSON.stringify({
          action: 'update-credential',
          provider,
          environment,
          displayName,
          credential,
        }),
      })
      setAccounts(result.accounts)
      setClientId('')
      setClientSecret('')
      setApiKey('')
      setConfirmDisconnect(false)
      setCredentialCommandIdempotencyKey(nextCredentialCommandIdempotencyKey())
      setNotice('Credential encrypted and stored. Verify it to activate read-only rating; tendering remains independently disabled.')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to store transport credential')
    } finally {
      setPending('')
    }
  }

  async function disconnect() {
    setPending('disconnect')
    setNotice('')
    setError('')
    try {
      const result = await requestTransport({
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'disconnect', provider, environment }),
      })
      setAccounts(result.accounts)
      setConfirmDisconnect(false)
      setClientId('')
      setClientSecret('')
      setApiKey('')
      setNotice('Encrypted credential removed. The provider connection remains disabled.')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to disconnect transport credential')
    } finally {
      setPending('')
    }
  }

  async function activateRates() {
    setPending('activate')
    setNotice('')
    setError('')
    try {
      const result = await requestTransport({
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'verify-and-activate-rates',
          provider,
          environment,
          ratingModes: provider === 'wwex_speedship'
            ? ['small_parcel', 'ltl']
            : ['ltl'],
          ...(provider === 'rl_carriers' ? {
            verificationPostalCode,
            verificationCountryCode,
          } : {}),
        }),
      })
      setAccounts(result.accounts)
      setNotice(provider === 'wwex_speedship'
        ? 'Worldwide Express sandbox authentication passed. UPS Small Parcel and brokered LTL rating are active; tendering remains disabled.'
        : 'R+L production authentication and service-point verification passed. LTL rating is active; BOL, pickup, and tendering remain disabled.')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to verify and activate carrier rates')
    } finally {
      setPending('')
    }
  }

  const canSave = displayName.trim().length >= 2 && (
    provider === 'wwex_speedship'
      ? clientId.trim().length >= 3
        && clientSecret.trim().length >= 8
        && audience.trim().length >= 3
      : apiKey.trim().length >= 8
  )
  const ratingActive = Boolean(
    account
    && (provider === 'wwex_speedship'
      ? account.ratingActivation.smallParcel && account.ratingActivation.ltl
      : account.ratingActivation.ltl),
  )
  const canActivateRates = Boolean(
    account?.configured
    && (provider !== 'wwex_speedship' || environment === 'sandbox')
    && (provider !== 'rl_carriers'
      || /^(?:\d{5}(?:-\d{4})?|[A-Za-z]\d[A-Za-z][ -]?\d[A-Za-z]\d)$/.test(
        verificationPostalCode.trim(),
      )),
  )

  return (
    <Box sx={{ mt: 4, pt: 3, borderTop: '1px solid rgba(255,255,255,0.08)' }}>
      <Stack spacing={2.25}>
        <Box>
          <Typography variant="h6" sx={{ fontWeight: 700 }}>
            Brokered parcel and LTL
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Worldwide Express provides UPS Small Parcel and brokered LTL offers. R+L is a direct LTL connection. Provider and executing carrier remain separate shipment facts.
          </Typography>
        </Box>

        <Alert severity="info" sx={{ borderRadius: '8px' }}>
          Credentials are encrypted and never returned to the browser. Verification performs authentication and read-only carrier requests only. It does not create a shipment, pickup, BOL, label, or charge.
        </Alert>

        {error ? <Alert severity="error" sx={{ borderRadius: '8px' }}>{error}</Alert> : null}
        {notice ? <Alert severity="success" sx={{ borderRadius: '8px' }}>{notice}</Alert> : null}

        {loading ? (
          <Stack direction="row" spacing={1} alignItems="center">
            <CircularProgress size={18} />
            <Typography variant="body2">Loading transport connections…</Typography>
          </Stack>
        ) : (
          <Box component="form" onSubmit={submit}>
            <Stack spacing={2}>
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
                <FormControl fullWidth sx={fieldSx}>
                  <InputLabel id="brokered-transport-provider-label">Provider</InputLabel>
                  <Select
                    labelId="brokered-transport-provider-label"
                    value={provider}
                    label="Provider"
                    onChange={(event) => chooseProvider(event.target.value as Provider)}
                    disabled={Boolean(pending)}
                  >
                    <MenuItem value="wwex_speedship">Worldwide Express</MenuItem>
                    <MenuItem value="rl_carriers">R+L Carriers</MenuItem>
                  </Select>
                </FormControl>
                <FormControl fullWidth sx={fieldSx}>
                  <InputLabel id="brokered-transport-environment-label">Environment</InputLabel>
                  <Select
                    labelId="brokered-transport-environment-label"
                    value={environment}
                    label="Environment"
                    onChange={(event) => chooseEnvironment(event.target.value as Environment)}
                    disabled={provider === 'rl_carriers' || Boolean(pending)}
                  >
                    <MenuItem value="sandbox">Sandbox</MenuItem>
                    <MenuItem value="production">Production</MenuItem>
                  </Select>
                </FormControl>
              </Stack>

              <TextField
                required
                label="Connection name"
                value={displayName}
                onChange={(event) => {
                  setDisplayName(event.target.value)
                  setCredentialCommandIdempotencyKey(
                    nextCredentialCommandIdempotencyKey(),
                  )
                }}
                disabled={Boolean(pending)}
                inputProps={{ maxLength: 120 }}
                sx={fieldSx}
              />

              {provider === 'wwex_speedship' ? (
                <>
                  <TextField
                    required
                    label="Client ID"
                    value={clientId}
                    onChange={(event) => {
                      setClientId(event.target.value)
                      setCredentialCommandIdempotencyKey(
                        nextCredentialCommandIdempotencyKey(),
                      )
                    }}
                    disabled={Boolean(pending)}
                    autoComplete="off"
                    sx={fieldSx}
                  />
                  <TextField
                    required
                    type="password"
                    label="Client secret"
                    value={clientSecret}
                    onChange={(event) => {
                      setClientSecret(event.target.value)
                      setCredentialCommandIdempotencyKey(
                        nextCredentialCommandIdempotencyKey(),
                      )
                    }}
                    disabled={Boolean(pending)}
                    autoComplete="new-password"
                    sx={fieldSx}
                  />
                  <TextField
                    required
                    label="OAuth audience"
                    value={audience}
                    onChange={(event) => {
                      setAudience(event.target.value)
                      setCredentialCommandIdempotencyKey(
                        nextCredentialCommandIdempotencyKey(),
                      )
                    }}
                    disabled={Boolean(pending)}
                    helperText={environment === 'production'
                      ? 'Use the production audience issued by Worldwide Express after platform review.'
                      : 'The supplied sandbox collection uses staging-wwex-apig.'}
                    sx={fieldSx}
                  />
                </>
              ) : (
                <TextField
                  required
                  type="password"
                  label="R+L API key"
                  value={apiKey}
                  onChange={(event) => {
                    setApiKey(event.target.value)
                    setCredentialCommandIdempotencyKey(
                      nextCredentialCommandIdempotencyKey(),
                    )
                  }}
                  disabled={Boolean(pending)}
                  autoComplete="new-password"
                  helperText="R+L has not supplied a sandbox. Activation verifies this key with a read-only production service-point lookup."
                  sx={fieldSx}
                />
              )}

              {provider === 'rl_carriers' && account?.configured ? (
                <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
                  <TextField
                    required
                    fullWidth
                    label="Verification postal code"
                    value={verificationPostalCode}
                    onChange={(event) => setVerificationPostalCode(event.target.value)}
                    disabled={Boolean(pending)}
                    helperText="A normal origin ZIP/postal code used only for R+L's read-only ServicePoint lookup."
                    sx={fieldSx}
                  />
                  <FormControl fullWidth sx={fieldSx}>
                    <InputLabel id="rl-verification-country-label">Country</InputLabel>
                    <Select
                      labelId="rl-verification-country-label"
                      value={verificationCountryCode}
                      label="Country"
                      onChange={(event) => setVerificationCountryCode(
                        event.target.value as 'USA' | 'CAN',
                      )}
                      disabled={Boolean(pending)}
                    >
                      <MenuItem value="USA">United States</MenuItem>
                      <MenuItem value="CAN">Canada</MenuItem>
                    </Select>
                  </FormControl>
                </Stack>
              ) : null}

              {account ? (
                <Stack spacing={1}>
                  <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap">
                    <Chip size="small" label={account.configured ? 'Encrypted credential stored' : 'Not configured'} />
                    <Chip size="small" label={`Verification: ${account.verificationStatus}`} />
                    <Chip size="small" label={`Status: ${account.status}`} />
                    {account.ratingActivation.smallParcel
                      ? <Chip size="small" color="success" label="Small Parcel rating active" />
                      : null}
                    {account.ratingActivation.ltl
                      ? <Chip size="small" color="success" label="LTL rating active" />
                      : null}
                    {account.credentialIdentifierLastFour
                      ? <Chip size="small" label={`Credential ••••${account.credentialIdentifierLastFour}`} />
                      : null}
                    {account.supportedTransportModes.map((mode) => (
                      <Chip key={mode} size="small" variant="outlined" label={mode === 'small_parcel' ? 'Small Parcel' : 'LTL'} />
                    ))}
                  </Stack>
                  {account.activationBlockers.length ? (
                    <Alert severity="info" sx={{ borderRadius: '8px' }}>
                      <Typography variant="body2" sx={{ fontWeight: 700, mb: 0.5 }}>
                        Pre-activation blockers
                      </Typography>
                      <Box component="ul" sx={{ my: 0, pl: 2.5 }}>
                        {account.activationBlockers.map((blocker) => (
                          <li key={blocker}>{blockerLabels[blocker] || blocker}</li>
                        ))}
                      </Box>
                    </Alert>
                  ) : null}
                  {account.tenderActivationBlockers.length ? (
                    <Alert severity={ratingActive ? 'warning' : 'info'} sx={{ borderRadius: '8px' }}>
                      <Typography variant="body2" sx={{ fontWeight: 700, mb: 0.5 }}>
                        Tendering remains disabled
                      </Typography>
                      <Box component="ul" sx={{ my: 0, pl: 2.5 }}>
                        {account.tenderActivationBlockers.map((blocker) => (
                          <li key={blocker}>{blockerLabels[blocker] || blocker}</li>
                        ))}
                      </Box>
                    </Alert>
                  ) : null}
                </Stack>
              ) : null}

              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
                <Button
                  type="submit"
                  variant="contained"
                  startIcon={pending === 'save' ? <CircularProgress size={16} color="inherit" /> : <SaveRounded />}
                  disabled={Boolean(pending) || !canSave}
                  sx={{ minHeight: 40, borderRadius: '8px' }}
                >
                  Store credential
                </Button>
                {account?.configured ? (
                  <Button
                    type="button"
                    variant={ratingActive ? 'outlined' : 'contained'}
                    color="success"
                    startIcon={pending === 'activate'
                      ? <CircularProgress size={16} color="inherit" />
                      : <VerifiedRounded />}
                    disabled={Boolean(pending) || !canActivateRates}
                    onClick={() => void activateRates()}
                    sx={{ minHeight: 40, borderRadius: '8px' }}
                  >
                    {ratingActive ? 'Reverify active rates' : 'Verify and activate rates'}
                  </Button>
                ) : null}
                {account?.configured ? (
                  <Button
                    type="button"
                    color="error"
                    variant="outlined"
                    startIcon={<DeleteOutlineRounded />}
                    disabled={Boolean(pending)}
                    onClick={() => setConfirmDisconnect(true)}
                    sx={{ minHeight: 40, borderRadius: '8px' }}
                  >
                    Disconnect
                  </Button>
                ) : null}
              </Stack>

              {confirmDisconnect ? (
                <Alert severity="warning" sx={{ borderRadius: '8px' }}>
                  <FormControlLabel
                    control={<Checkbox onChange={(_, checked) => {
                      if (!checked) setConfirmDisconnect(false)
                    }} defaultChecked />}
                    label="Remove the encrypted credential and keep this provider disabled."
                  />
                  <Box sx={{ mt: 1 }}>
                    <Button
                      type="button"
                      color="error"
                      variant="contained"
                      disabled={Boolean(pending)}
                      onClick={() => void disconnect()}
                    >
                      Confirm disconnect
                    </Button>
                  </Box>
                </Alert>
              ) : null}
            </Stack>
          </Box>
        )}
      </Stack>
    </Box>
  )
}
