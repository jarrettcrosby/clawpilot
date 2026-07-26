'use client'

import {
  useEffect,
  useState,
  type FormEvent,
} from 'react'
import Accordion from '@mui/material/Accordion'
import AccordionDetails from '@mui/material/AccordionDetails'
import AccordionSummary from '@mui/material/AccordionSummary'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Card from '@mui/material/Card'
import CardContent from '@mui/material/CardContent'
import Checkbox from '@mui/material/Checkbox'
import Chip from '@mui/material/Chip'
import CircularProgress from '@mui/material/CircularProgress'
import Divider from '@mui/material/Divider'
import FormControl from '@mui/material/FormControl'
import FormControlLabel from '@mui/material/FormControlLabel'
import InputLabel from '@mui/material/InputLabel'
import MenuItem from '@mui/material/MenuItem'
import Select from '@mui/material/Select'
import Stack from '@mui/material/Stack'
import Table from '@mui/material/Table'
import TableBody from '@mui/material/TableBody'
import TableCell from '@mui/material/TableCell'
import TableContainer from '@mui/material/TableContainer'
import TableHead from '@mui/material/TableHead'
import TableRow from '@mui/material/TableRow'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import ExpandMoreRounded from '@mui/icons-material/ExpandMoreRounded'
import ContentCopyRounded from '@mui/icons-material/ContentCopyRounded'
import LinkRounded from '@mui/icons-material/LinkRounded'
import LinkOffRounded from '@mui/icons-material/LinkOffRounded'
import OpenInNewRounded from '@mui/icons-material/OpenInNewRounded'
import PowerSettingsNewRounded from '@mui/icons-material/PowerSettingsNewRounded'
import StorefrontRounded from '@mui/icons-material/StorefrontRounded'
import SyncRounded from '@mui/icons-material/SyncRounded'

type CommerceProvider = 'shopify' | 'faire'
type CommerceEnvironment = 'sandbox' | 'production'

type SyncCursor = {
  resource: string
  cursorPresent: boolean
  highWatermark: string | null
  status: 'idle' | 'running' | 'succeeded' | 'failed'
  recordsSeen: number
  recordsApplied: number
  recordsHeld: number
  consecutiveFailures: number
  lastErrorCode: string | null
  lastStartedAt: string | null
  lastCompletedAt: string | null
  updatedAt: string
}

type CommerceAccount = {
  globalId: string
  provider: CommerceProvider
  environment: CommerceEnvironment
  externalAccountId: string | null
  displayName: string
  status: 'active' | 'disabled' | 'error'
  configured: boolean
  credentialVersion: number
  authMode: string | null
  credentialIdentifierLastFour: string | null
  verificationStatus: 'unverified' | 'verified' | 'failed'
  verifiedAt: string | null
  lastErrorCode: string | null
  webhookVerificationStatus: 'not_applicable' | 'unverified' | 'verified'
  webhookVerifiedAt: string | null
  configuration: Record<string, unknown>
  syncCursors: SyncCursor[]
  evidence: {
    webhookReceipts: number
    queuedWebhooks: number
    deadLetterWebhooks: number
    lastWebhookAt: string | null
    providerAttempts: number
    failedAttempts: number
    deadLetterAttempts: number
    lastAttemptAt: string | null
  }
  webhookUrl: string | null
  updatedAt: string
}

type CommerceState = {
  organizationId: string
  accounts: CommerceAccount[]
}

type CapabilityDefinition = {
  capability: string
  category: string
  direction: string
  owner: string
}

type ProviderCatalog = {
  label: string
  classification: string
  apiVersion: string
  environmentSupport: string[]
  environmentNote: string
  providerAvailableCapabilities: string[]
  implementation: Record<string, 'control_plane_implemented' | 'not_implemented'>
  capabilityScopes: Record<string, readonly string[]>
  providerScopes?: readonly string[]
  restrictedScopes?: readonly string[]
  constraints?: Record<string, unknown>
}

type CommerceCatalog = {
  classification: string
  onboarding: {
    shopify: {
      developerPortalUrl: string
      setupGuideUrl: string
      tokenGuideUrl: string
      defaultAppUrl: string
      apiVersion: string
      requiredBeforeConnect: readonly string[]
      receiptProofScopes: readonly string[]
      acceptedReceiptTopics: readonly string[]
      unsupportedCredentialMode: string
    }
    faire: {
      developerPortalUrl: string
      setupGuideUrl: string
      directTokenGuideUrl: string
      callbackUrl: string
      requiredBeforeConnect: readonly string[]
      supportContact: string
      minimumProbeScope: string
      scopeProfiles: {
        connection_test: readonly string[]
        distributed_operations: readonly string[]
      }
      sandboxAvailable: boolean
      webhooksAvailable: boolean
    }
  }
  definitions: CapabilityDefinition[]
  providers: Record<CommerceProvider, ProviderCatalog>
  activationBoundary: {
    receiptIntakeOnly: boolean
    domainWorkersActivated: boolean
    canonicalOrderImport: boolean
    inventoryMutation: boolean
    fulfillmentExport: boolean
    multiMerchantOauth: boolean
    faireCustomAppOauth: boolean
  }
}

type CommercePayload = {
  ok?: boolean
  error?: string
  code?: string
  canManage?: boolean
  canActivate?: boolean
  integrations?: CommerceState
  catalog?: CommerceCatalog
  authorizationUrl?: string
  callbackUrl?: string
  expiresAt?: string
  requestedScopes?: string[]
}

type ShopifyForm = {
  displayName: string
  environment: CommerceEnvironment
  shopDomain: string
  clientId: string
  clientSecret: string
  confirmLiveAccess: boolean
}

type FaireForm = {
  displayName: string
  applicationId: string
  applicationSecret: string
  scopeProfile: 'connection_test' | 'distributed_operations'
  confirmLiveAccess: boolean
}

const fieldSx = {
  '& .MuiOutlinedInput-root': {
    borderRadius: '8px',
    backgroundColor: '#20202A',
  },
}

const actionButtonSx = {
  minHeight: 38,
  borderRadius: '8px',
  width: { xs: '100%', sm: 'auto' },
}

function humanize(value: string) {
  return value
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
}

function providerLabel(provider: CommerceProvider) {
  return provider === 'shopify' ? 'Shopify' : 'Faire'
}

function valueStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : []
}

class CommerceRequestError extends Error {
  constructor(
    message: string,
    readonly code = 'COMMERCE_REQUEST_FAILED',
  ) {
    super(message)
    this.name = 'CommerceRequestError'
  }
}

function actionableCommerceError(error: unknown) {
  if (!(error instanceof CommerceRequestError)) {
    return error instanceof Error
      ? error.message
      : 'Sales-channel integration request failed'
  }
  const guidance: Record<string, string> = {
    SHOPIFY_SHOP_NOT_PERMITTED:
      'Create the app and store under the same organization in Shopify Dev Dashboard.',
    SHOPIFY_APP_NOT_INSTALLED:
      'Release an app version, install it on the exact store, then try again.',
    SHOPIFY_STORE_NOT_FOUND:
      'Confirm the permanent myshopify.com domain in Shopify store settings; do not use a storefront or admin URL.',
    SHOPIFY_CLIENT_CREDENTIALS_REJECTED:
      'Confirm the canonical myshopify.com domain and copy the current client ID and secret from the installed Dev Dashboard app.',
    SHOPIFY_ACCESS_DENIED:
      'Update the app version scopes, release it, approve the change in Shopify, then test the connection again.',
    SHOPIFY_SCOPE_PROFILE_INCOMPLETE:
      'Add the listed least-privilege receipt scopes to the Shopify app version, release it, approve the change, and test again.',
    FAIRE_ACCESS_DENIED:
      'Confirm the Faire app remains authorized for this brand, then reconnect it if access was revoked.',
    FAIRE_RESOURCE_NOT_FOUND:
      'Confirm this is an active Faire brand account; retailer accounts cannot use the custom integration API.',
    FAIRE_OAUTH_EXCHANGE_REJECTED:
      'Confirm the Application ID and Secret ID are the current credentials for this Faire Custom App, then start the authorization again.',
    FAIRE_OAUTH_STATE_INVALID:
      'The one-use setup window expired, was already used, or returned in another ClawPilot browser session. Start the Faire connection again.',
    FAIRE_OAUTH_AUTHORIZATION_DENIED:
      'The Faire authorization was not approved. Start again when you are ready to approve the requested permissions.',
    FAIRE_OAUTH_CALLBACK_INVALID:
      'Faire returned an incomplete authorization response. Start the connection again or contact Faire Developer Support.',
    FAIRE_OAUTH_PUBLIC_HTTPS_REQUIRED:
      'Use the hosted ClawPilot development environment or an approved public HTTPS tunnel for the live Faire authorization.',
    COMMERCE_ENCRYPTION_UNAVAILABLE:
      'Ask a ClawPilot administrator to configure commerce credential encryption for this environment.',
  }
  const nextStep = guidance[error.code]
  return `${error.message}${nextStep ? ` ${nextStep}` : ''} [${error.code}]`
}

async function requestCommerce(init?: RequestInit): Promise<CommercePayload> {
  const response = await fetch('/api/integrations/commerce', {
    cache: 'no-store',
    ...init,
  })
  const result = await response.json().catch(() => ({})) as CommercePayload
  if (!response.ok || !result.ok) {
    throw new CommerceRequestError(
      result.error || 'Sales-channel integration request failed',
      result.code,
    )
  }
  return result
}

function statusColor(
  status: CommerceAccount['status'] | CommerceAccount['verificationStatus'],
) {
  if (status === 'active' || status === 'verified') return 'success' as const
  if (status === 'error' || status === 'failed') return 'error' as const
  return 'default' as const
}

export default function CommerceIntegrationPanel() {
  const [integrations, setIntegrations] = useState<CommerceState>({
    organizationId: '',
    accounts: [],
  })
  const [catalog, setCatalog] = useState<CommerceCatalog | null>(null)
  const [canActivate, setCanActivate] = useState(false)
  const [loading, setLoading] = useState(true)
  const [pendingAction, setPendingAction] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [shopify, setShopify] = useState<ShopifyForm>({
    displayName: '',
    environment: 'sandbox',
    shopDomain: '',
    clientId: '',
    clientSecret: '',
    confirmLiveAccess: false,
  })
  const [faire, setFaire] = useState<FaireForm>({
    displayName: '',
    applicationId: '',
    applicationSecret: '',
    scopeProfile: 'connection_test',
    confirmLiveAccess: false,
  })

  function applyPayload(payload: CommercePayload) {
    if (payload.integrations) setIntegrations(payload.integrations)
    if (payload.catalog) setCatalog(payload.catalog)
    setCanActivate(payload.canActivate === true)
  }

  useEffect(() => {
    let active = true
    requestCommerce()
      .then((payload) => {
        if (active) {
          applyPayload(payload)
          const url = new URL(window.location.href)
          const oauthStatus = url.searchParams.get('faireOauth')
          const oauthCode = url.searchParams.get('faireOauthCode')
          if (oauthStatus === 'connected') {
            setNotice(
              'Faire Custom App authorized and its brand identity verified. Automated synchronization remains unavailable until the polling worker is released.',
            )
          } else if (oauthStatus === 'error') {
            setError(actionableCommerceError(new CommerceRequestError(
              'Faire Custom App authorization did not complete.',
              oauthCode || 'FAIRE_OAUTH_CALLBACK_INVALID',
            )))
          }
          if (oauthStatus) {
            for (const key of [
              'settings',
              'integration',
              'faireOauth',
              'faireOauthCode',
            ]) {
              url.searchParams.delete(key)
            }
            window.history.replaceState(
              window.history.state,
              '',
              `${url.pathname}${url.search}${url.hash}`,
            )
          }
        }
      })
      .catch((requestError) => {
        if (active) {
          setError(actionableCommerceError(requestError))
        }
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [])

  async function action(
    key: string,
    body: Record<string, unknown>,
    successMessage: string,
  ) {
    setPendingAction(key)
    setError('')
    setNotice('')
    try {
      const payload = await requestCommerce({
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      applyPayload(payload)
      setNotice(successMessage)
      return true
    } catch (requestError) {
      const actionError = actionableCommerceError(requestError)
      await requestCommerce()
        .then((payload) => applyPayload(payload))
        .catch(() => undefined)
      setError(actionError)
      return false
    } finally {
      setPendingAction('')
    }
  }

  async function connectShopify(event: FormEvent) {
    event.preventDefault()
    const saved = await action(
      'connect-shopify',
      { action: 'connect-shopify', ...shopify },
      'Shopify merchant-owned app connected and its API identity verified. Complete the receipt setup checklist below only when you are ready to enable signed receipt intake.',
    )
    if (saved) {
      setShopify((current) => ({
        ...current,
        clientId: '',
        clientSecret: '',
        confirmLiveAccess: false,
      }))
    }
  }

  async function connectFaire(event: FormEvent) {
    event.preventDefault()
    setPendingAction('start-faire-oauth')
    setError('')
    setNotice('')
    try {
      const payload = await requestCommerce({
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'start-faire-oauth',
          ...faire,
        }),
      })
      if (!payload.authorizationUrl) {
        throw new CommerceRequestError(
          'ClawPilot did not receive the Faire authorization URL.',
          'FAIRE_OAUTH_START_INVALID',
        )
      }
      const authorizationUrl = new URL(payload.authorizationUrl)
      if (
        authorizationUrl.origin !== 'https://faire.com'
        || authorizationUrl.pathname !== '/oauth2/authorize'
      ) {
        throw new CommerceRequestError(
          'ClawPilot rejected an unexpected Faire authorization URL.',
          'FAIRE_OAUTH_START_INVALID',
        )
      }
      setFaire((current) => ({
        ...current,
        applicationSecret: '',
        confirmLiveAccess: false,
      }))
      window.location.assign(authorizationUrl.toString())
    } catch (requestError) {
      setError(actionableCommerceError(requestError))
      setPendingAction('')
    }
  }

  async function disconnect(account: CommerceAccount) {
    if (
      !window.confirm(
        `Disconnect ${account.displayName}? ClawPilot will remove its encrypted credential and retain durable operational evidence. Revoke or remove provider-side access separately.`,
      )
    ) return
    await action(
      `disconnect:${account.globalId}`,
      { action: 'disconnect', accountGlobalId: account.globalId },
      `${account.displayName} disconnected.`,
    )
  }

  async function copyWebhookUrl(account: CommerceAccount) {
    if (!account.webhookUrl) return
    setError('')
    setNotice('')
    try {
      await navigator.clipboard.writeText(account.webhookUrl)
      setNotice(`${account.displayName} webhook URL copied.`)
    } catch {
      setError(
        'The webhook URL could not be copied automatically. Select it from the read-only field and copy it manually.',
      )
    }
  }

  if (loading) {
    return (
      <Stack alignItems="center" sx={{ py: 8 }}>
        <CircularProgress size={28} />
      </Stack>
    )
  }

  return (
    <Stack spacing={3}>
      <Box>
        <Stack direction="row" spacing={1} alignItems="center">
          <StorefrontRounded color="primary" />
          <Typography variant="h6">Sales channels</Typography>
        </Stack>
        <Typography color="text.secondary" sx={{ mt: 0.75, maxWidth: 900 }}>
          Shopify stores and Faire brands are commerce channels for distributed
          order operations. They are separate from restaurant POS and
          accounting integrations such as Toast.
        </Typography>
      </Box>

      <Alert severity="info">
        These are user-owned custom integrations. Create the application in
        the provider portal first. Shopify verifies the installed
        merchant-owned app credentials directly. Faire securely stages the
        Custom App credentials, redirects you to authorize the intended brand,
        and exchanges the one-use callback code on the server.
      </Alert>
      <Alert severity="warning">
        A verified connection proves provider identity and encrypted credential
        storage only. Canonical order import, inventory writes,
        reconciliation workers, fulfillment export, multi-merchant OAuth, and
        production domain activation are not enabled. Order and customer
        webhook topics are rejected until a retention/privacy lifecycle and
        canonical processor exist.
      </Alert>
      {error ? <Alert severity="error">{error}</Alert> : null}
      {notice ? <Alert severity="success">{notice}</Alert> : null}

      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: '1fr', lg: '1fr 1fr' },
          gap: 2,
        }}
      >
        <Card variant="outlined">
          <CardContent>
            <Stack
              component="form"
              spacing={2}
              onSubmit={connectShopify}
            >
              <Box>
                <Typography variant="subtitle1" fontWeight={700}>
                  Shopify merchant-owned app
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  Merchant-owned Dev Dashboard application for one
                  same-organization <code>.myshopify.com</code> store.
                </Typography>
              </Box>
              {catalog ? (
                <Alert severity="info" icon={false}>
                  <Typography variant="subtitle2" fontWeight={700}>
                    Before you connect
                  </Typography>
                  <Box
                    component="ol"
                    sx={{
                      pl: 2.5,
                      my: 1,
                      '& li': { mb: 0.5 },
                    }}
                  >
                    {catalog.onboarding.shopify.requiredBeforeConnect.map(
                      (step) => (
                        <Typography component="li" variant="body2" key={step}>
                          {step}
                        </Typography>
                      ),
                    )}
                  </Box>
                  <Typography variant="body2" color="text.secondary">
                    Use <code>{catalog.onboarding.shopify.defaultAppUrl}</code>{' '}
                    for an API-only app home, select webhook API version{' '}
                    <code>{catalog.onboarding.shopify.apiVersion}</code>, and
                    start with least privilege. The current receipt-proof
                    profile requires only{' '}
                    <code>
                      {catalog.onboarding.shopify.receiptProofScopes.join(', ')}
                    </code>
                    . Shopify Admin-created legacy apps and Admin API access
                    tokens are not supported. Public and custom-distribution
                    apps require a different OAuth flow and are not supported
                    by this connection form.
                  </Typography>
                  <Stack
                    direction={{ xs: 'column', sm: 'row' }}
                    spacing={1}
                    sx={{ mt: 1.5 }}
                  >
                    <Button
                      href={catalog.onboarding.shopify.developerPortalUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      variant="outlined"
                      size="small"
                      endIcon={<OpenInNewRounded />}
                    >
                      Open Shopify Dev Dashboard
                    </Button>
                    <Button
                      href={catalog.onboarding.shopify.setupGuideUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      variant="text"
                      size="small"
                      endIcon={<OpenInNewRounded />}
                    >
                      Shopify setup guide
                    </Button>
                    <Button
                      href={catalog.onboarding.shopify.tokenGuideUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      variant="text"
                      size="small"
                      endIcon={<OpenInNewRounded />}
                    >
                      Client-credentials guide
                    </Button>
                  </Stack>
                </Alert>
              ) : null}
              <TextField
                label="Connection name"
                value={shopify.displayName}
                onChange={(event) => setShopify((current) => ({
                  ...current,
                  displayName: event.target.value,
                }))}
                placeholder="Primary Shopify store"
                inputProps={{ maxLength: 120 }}
                sx={fieldSx}
              />
              <FormControl sx={fieldSx}>
                <InputLabel id="shopify-environment-label">
                  Store class
                </InputLabel>
                <Select
                  labelId="shopify-environment-label"
                  label="Store class"
                  value={shopify.environment}
                  onChange={(event) => setShopify((current) => ({
                    ...current,
                    environment: event.target.value as CommerceEnvironment,
                  }))}
                >
                  <MenuItem value="sandbox">
                    Development or test store
                  </MenuItem>
                  <MenuItem value="production">Production store</MenuItem>
                </Select>
              </FormControl>
              <TextField
                required
                label="Canonical Shopify domain"
                value={shopify.shopDomain}
                onChange={(event) => setShopify((current) => ({
                  ...current,
                  shopDomain: event.target.value,
                }))}
                placeholder="store-name.myshopify.com"
                autoComplete="off"
                sx={fieldSx}
              />
              <TextField
                required
                label="Shopify app client ID"
                value={shopify.clientId}
                onChange={(event) => setShopify((current) => ({
                  ...current,
                  clientId: event.target.value,
                }))}
                helperText="From the installed app in Shopify's Dev Dashboard."
                autoComplete="off"
                sx={fieldSx}
              />
              <TextField
                required
                type="password"
                label="Shopify app client secret"
                value={shopify.clientSecret}
                onChange={(event) => setShopify((current) => ({
                  ...current,
                  clientSecret: event.target.value,
                }))}
                helperText="Exchanged server-side for 24-hour Admin API tokens and used to verify webhook HMAC signatures. The short-lived token is not stored."
                autoComplete="new-password"
                sx={fieldSx}
              />
              <FormControlLabel
                control={(
                  <Checkbox
                    checked={shopify.confirmLiveAccess}
                    onChange={(event) => setShopify((current) => ({
                      ...current,
                      confirmLiveAccess: event.target.checked,
                    }))}
                  />
                )}
                label="I authorize a live identity and scope verification call to this store."
              />
              <Button
                type="submit"
                variant="contained"
                startIcon={<LinkRounded />}
                disabled={
                  pendingAction !== ''
                  || !shopify.confirmLiveAccess
                  || !shopify.shopDomain
                  || !shopify.clientId
                  || !shopify.clientSecret
                }
                sx={actionButtonSx}
              >
                {pendingAction === 'connect-shopify'
                  ? 'Verifying…'
                  : 'Connect Shopify Dev Dashboard app'}
              </Button>
            </Stack>
          </CardContent>
        </Card>

        <Card variant="outlined">
          <CardContent>
            <Stack component="form" spacing={2} onSubmit={connectFaire}>
              <Box>
                <Typography variant="subtitle1" fontWeight={700}>
                  Faire Custom App OAuth
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  Application ID + Secret ID authorization for the production
                  B2B wholesale marketplace. Faire confirms this Custom App&apos;s
                  OAuth eligibility only when it accepts the authorization
                  request.
                </Typography>
              </Box>
              {catalog ? (
                <Alert severity="info" icon={false}>
                  <Typography variant="subtitle2" fontWeight={700}>
                    Before you connect
                  </Typography>
                  <Box
                    component="ol"
                    sx={{
                      pl: 2.5,
                      my: 1,
                      '& li': { mb: 0.5 },
                    }}
                  >
                    {catalog.onboarding.faire.requiredBeforeConnect.map(
                      (step) => (
                        <Typography component="li" variant="body2" key={step}>
                          {step}
                        </Typography>
                      ),
                    )}
                  </Box>
                  <Typography variant="body2" color="text.secondary">
                    ClawPilot never places the Secret ID in the Faire
                    authorization URL. It encrypts the pending credential,
                    sends the Application ID and requested permissions to
                    Faire, then uses the Secret ID only on the server for the
                    one-use code exchange. Faire documents no preliminary
                    credential ping: the authorization redirect is the first
                    provider interaction, and the Secret ID is validated only
                    after Faire returns an authorization code. Faire separately
                    documents a single-brand API-key flow but does not publicly
                    explain whether its &quot;APA token&quot; is the same value
                    as the OAuth Application ID. Use the values Faire labels
                    for this OAuth flow. This ClawPilot form cannot accept the
                    final brand API key produced by the separate flow. If Faire
                    does not offer authorization for this Custom App, contact{' '}
                    <code>{catalog.onboarding.faire.supportContact}</code>.
                    The profile probe needs{' '}
                    <code>{catalog.onboarding.faire.minimumProbeScope}</code>.
                    Retailer accounts are ineligible, and Faire publishes no
                    sandbox or webhook flow for this custom integration.
                    The default connection-test profile requests only{' '}
                    <code>READ_BRAND</code>. The explicit distributed-operations
                    profile requests all ten documented OAuth permissions so
                    the encrypted connection is ready for the scoped WMS/DOM
                    capabilities shown below; selecting it does not activate
                    any domain worker.
                  </Typography>
                  <TextField
                    fullWidth
                    label="ClawPilot OAuth callback URL"
                    value={catalog.onboarding.faire.callbackUrl}
                    helperText="This exact HTTPS URL is sent to Faire for authorization and token exchange. Use it if Faire asks for the app callback or redirect URL."
                    InputProps={{ readOnly: true }}
                    sx={{ ...fieldSx, mt: 1.5 }}
                  />
                  <Stack
                    direction={{ xs: 'column', sm: 'row' }}
                    spacing={1}
                    sx={{ mt: 1.5 }}
                  >
                    <Button
                      href={catalog.onboarding.faire.developerPortalUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      variant="outlined"
                      size="small"
                      endIcon={<OpenInNewRounded />}
                    >
                      Open Faire developer portal
                    </Button>
                    <Button
                      href={catalog.onboarding.faire.setupGuideUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      variant="text"
                      size="small"
                      endIcon={<OpenInNewRounded />}
                    >
                      Faire OAuth guide
                    </Button>
                    <Button
                      href={catalog.onboarding.faire.directTokenGuideUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      variant="text"
                      size="small"
                      endIcon={<OpenInNewRounded />}
                    >
                      Single-brand guide — not connectable here
                    </Button>
                  </Stack>
                </Alert>
              ) : null}
              <TextField
                label="Connection name"
                value={faire.displayName}
                onChange={(event) => setFaire((current) => ({
                  ...current,
                  displayName: event.target.value,
                }))}
                placeholder="Primary Faire brand"
                inputProps={{ maxLength: 120 }}
                sx={fieldSx}
              />
              <TextField
                required
                label="Faire Application ID"
                value={faire.applicationId}
                onChange={(event) => setFaire((current) => ({
                  ...current,
                  applicationId: event.target.value,
                }))}
                placeholder="Application ID from Faire"
                helperText="Copy the Application ID shown in Faire Developer Portal under App Details and Settings."
                autoComplete="off"
                inputProps={{ maxLength: 255 }}
                sx={fieldSx}
              />
              <TextField
                required
                type="password"
                label="Faire Secret ID"
                value={faire.applicationSecret}
                onChange={(event) => setFaire((current) => ({
                  ...current,
                  applicationSecret: event.target.value,
                }))}
                helperText="Copy the Secret ID from Faire. It is encrypted for the pending setup and is never placed in the redirect URL or returned by the API."
                autoComplete="new-password"
                sx={fieldSx}
              />
              <FormControl sx={fieldSx}>
                <InputLabel id="faire-scope-profile-label">
                  Permission profile
                </InputLabel>
                <Select
                  labelId="faire-scope-profile-label"
                  label="Permission profile"
                  value={faire.scopeProfile}
                  onChange={(event) => setFaire((current) => ({
                    ...current,
                    scopeProfile: event.target.value as FaireForm['scopeProfile'],
                  }))}
                >
                  <MenuItem value="connection_test">
                    Connection test — READ_BRAND only
                  </MenuItem>
                  <MenuItem value="distributed_operations">
                    Distributed operations — all 10 documented permissions
                  </MenuItem>
                </Select>
              </FormControl>
              <FormControlLabel
                control={(
                  <Checkbox
                    checked={faire.confirmLiveAccess}
                    onChange={(event) => setFaire((current) => ({
                      ...current,
                      confirmLiveAccess: event.target.checked,
                    }))}
                  />
                )}
                label="I authorize the Faire redirect, server-side code exchange, and live production brand-profile verification."
              />
              <Button
                type="submit"
                variant="contained"
                startIcon={<LinkRounded />}
                disabled={
                  pendingAction !== ''
                  || !faire.confirmLiveAccess
                  || !faire.applicationId
                  || !faire.applicationSecret
                }
                sx={actionButtonSx}
              >
                {pendingAction === 'start-faire-oauth'
                  ? 'Preparing Faire…'
                  : 'Continue to Faire'}
              </Button>
            </Stack>
          </CardContent>
        </Card>
      </Box>

      <Box>
        <Typography variant="subtitle1" fontWeight={700} sx={{ mb: 1 }}>
          Connected channel identities
        </Typography>
        {integrations.accounts.length === 0 ? (
          <Alert severity="info">
            No Shopify store or Faire brand is connected for this organization.
          </Alert>
        ) : (
          <Stack spacing={2}>
            {integrations.accounts.map((account) => {
              const accountName = typeof account.configuration.accountName === 'string'
                ? account.configuration.accountName
                : account.displayName
              const grantedScopes = valueStrings(
                account.configuration.grantedScopes,
              )
              const requestedScopes = valueStrings(
                account.configuration.requestedScopes,
              )
              const missingScopes = valueStrings(
                account.configuration.missingScopes,
              )
              const activationBlockers = account.provider === 'shopify'
                && account.status !== 'active'
                ? [
                    ...(!canActivate
                      ? ['Owner or operations-administrator access is required.']
                      : []),
                    ...(missingScopes.length
                      ? [`Add and approve these app scopes: ${missingScopes.join(', ')}.`]
                      : []),
                    ...(account.webhookVerificationStatus !== 'verified'
                      ? ['Send one valid signed allowed-topic delivery to the callback URL.']
                      : []),
                  ]
                : []
              return (
                <Card key={account.globalId} variant="outlined">
                  <CardContent>
                    <Stack spacing={1.5}>
                      <Stack
                        direction={{ xs: 'column', sm: 'row' }}
                        justifyContent="space-between"
                        spacing={1}
                      >
                        <Box>
                          <Typography fontWeight={700}>
                            {account.displayName}
                          </Typography>
                          <Typography variant="body2" color="text.secondary">
                            {providerLabel(account.provider)} · {accountName} ·{' '}
                            {account.environment} · {account.globalId}
                          </Typography>
                        </Box>
                        <Stack direction="row" spacing={1} flexWrap="wrap">
                          <Chip
                            size="small"
                            color={statusColor(account.verificationStatus)}
                            label={`API ${humanize(account.verificationStatus)}`}
                          />
                          {account.provider === 'shopify' ? (
                            <Chip
                              size="small"
                              color={account.webhookVerificationStatus === 'verified'
                                ? 'success'
                                : 'default'}
                              label={`Webhook secret ${humanize(
                                account.webhookVerificationStatus,
                              )}`}
                            />
                          ) : null}
                          <Chip
                            size="small"
                            color={account.status === 'active'
                              ? 'success'
                              : 'default'}
                            label={account.provider === 'shopify'
                              ? `Receipt intake ${
                                account.status === 'active'
                                  ? 'enabled'
                                  : 'disabled'
                              }`
                              : 'Synchronization unavailable'}
                          />
                          {account.configured
                            && account.credentialIdentifierLastFour ? (
                            <Chip
                              size="small"
                              label={`Credential ••••${
                                account.credentialIdentifierLastFour
                              }`}
                            />
                          ) : null}
                        </Stack>
                      </Stack>

                      <Alert
                        severity={account.verificationStatus === 'verified'
                          ? 'success'
                          : 'warning'}
                      >
                        {account.verificationStatus === 'verified'
                          ? `${providerLabel(account.provider)} API connection established.`
                          : `${providerLabel(account.provider)} API connection needs attention.`}{' '}
                        {account.provider === 'shopify'
                          ? 'Receipt intake is a separate optional activation step.'
                          : 'Faire polling, order import, and inventory synchronization are not active yet.'}
                      </Alert>

                      {account.provider === 'shopify' && account.webhookUrl ? (
                        <Box>
                          <Typography variant="subtitle2" fontWeight={700}>
                            Optional signed receipt setup
                          </Typography>
                          <Typography
                            variant="body2"
                            color="text.secondary"
                            sx={{ mb: 1 }}
                          >
                            Use the account-specific URL below for shop-specific
                            webhook subscriptions. ClawPilot does not register
                            provider subscriptions in this slice. One valid
                            signed allowed-topic delivery verifies the stored
                            app secret; synthetic CLI delivery proves signing
                            only, not that a real subscription exists.
                          </Typography>
                          <Stack
                            direction={{ xs: 'column', sm: 'row' }}
                            spacing={1}
                            alignItems={{ sm: 'flex-start' }}
                          >
                            <TextField
                              fullWidth
                              label="Signed webhook receipt URL"
                              value={account.webhookUrl}
                              InputProps={{ readOnly: true }}
                              helperText="Order and customer topics are rejected."
                              sx={fieldSx}
                            />
                            <Button
                              variant="outlined"
                              startIcon={<ContentCopyRounded />}
                              onClick={() => copyWebhookUrl(account)}
                              sx={actionButtonSx}
                            >
                              Copy URL
                            </Button>
                          </Stack>
                          {catalog ? (
                            <>
                              <Typography
                                variant="caption"
                                color="text.secondary"
                                display="block"
                                sx={{ mt: 1 }}
                              >
                                Accepted receipt topics
                              </Typography>
                              <Stack
                                direction="row"
                                gap={0.75}
                                flexWrap="wrap"
                                sx={{ mt: 0.5 }}
                              >
                                {catalog.onboarding.shopify.acceptedReceiptTopics
                                  .map((topic) => (
                                    <Chip
                                      key={topic}
                                      size="small"
                                      label={topic}
                                    />
                                  ))}
                              </Stack>
                              <Button
                                href="https://shopify.dev/docs/apps/build/webhooks/subscribe"
                                target="_blank"
                                rel="noopener noreferrer"
                                variant="text"
                                size="small"
                                endIcon={<OpenInNewRounded />}
                                sx={{ mt: 0.75 }}
                              >
                                Shopify webhook subscription guide
                              </Button>
                            </>
                          ) : null}
                        </Box>
                      ) : null}

                      {requestedScopes.length ? (
                        <Box>
                          <Typography
                            variant="caption"
                            color="text.secondary"
                          >
                            Least-privilege receipt profile
                          </Typography>
                          <Stack
                            direction="row"
                            gap={0.75}
                            flexWrap="wrap"
                            sx={{ mt: 0.5 }}
                          >
                            {requestedScopes.map((scope) => (
                              <Chip
                                key={scope}
                                size="small"
                                color={missingScopes.includes(scope)
                                  ? 'warning'
                                  : 'success'}
                                label={`${scope}${
                                  missingScopes.includes(scope)
                                    ? ' · missing'
                                    : ' · granted'
                                }`}
                              />
                            ))}
                          </Stack>
                        </Box>
                      ) : null}

                      {grantedScopes.length ? (
                        <Box>
                          <Typography
                            variant="caption"
                            color="text.secondary"
                          >
                            Provider-reported granted scopes
                          </Typography>
                          <Stack
                            direction="row"
                            gap={0.75}
                            flexWrap="wrap"
                            sx={{ mt: 0.5 }}
                          >
                            {grantedScopes.map((scope) => (
                              <Chip key={scope} size="small" label={scope} />
                            ))}
                          </Stack>
                        </Box>
                      ) : null}

                      {activationBlockers.length ? (
                        <Alert severity="info">
                          <Typography variant="body2" fontWeight={700}>
                            Receipt intake is not ready to enable
                          </Typography>
                          <Box component="ul" sx={{ pl: 2.5, my: 0.5 }}>
                            {activationBlockers.map((blocker) => (
                              <Typography
                                component="li"
                                variant="body2"
                                key={blocker}
                              >
                                {blocker}
                              </Typography>
                            ))}
                          </Box>
                        </Alert>
                      ) : null}

                      <Stack
                        direction={{ xs: 'column', sm: 'row' }}
                        gap={1}
                        flexWrap="wrap"
                      >
                        <Button
                          variant="outlined"
                          startIcon={<SyncRounded />}
                          disabled={pendingAction !== '' || !account.configured}
                          onClick={() => action(
                            `test:${account.globalId}`,
                            {
                              action: 'test-connection',
                              accountGlobalId: account.globalId,
                            },
                            `${account.displayName} API credential verified.`,
                          )}
                          sx={actionButtonSx}
                        >
                          {pendingAction === `test:${account.globalId}`
                            ? 'Testing…'
                            : 'Test connection'}
                        </Button>
                        {account.provider === 'shopify'
                          && account.configured
                          && account.status !== 'active' ? (
                            <Button
                              variant="contained"
                              startIcon={<PowerSettingsNewRounded />}
                              disabled={
                                pendingAction !== ''
                                || !canActivate
                                || missingScopes.length > 0
                                || account.webhookVerificationStatus !== 'verified'
                              }
                              onClick={() => action(
                                `enable:${account.globalId}`,
                                {
                                  action: 'set-enabled',
                                  accountGlobalId: account.globalId,
                                  enabled: true,
                                },
                                `${account.displayName} signed receipt intake enabled.`,
                              )}
                              sx={actionButtonSx}
                            >
                              Enable receipt intake
                            </Button>
                          ) : null}
                        {account.status === 'active' ? (
                          <Button
                            variant="outlined"
                            color="warning"
                            disabled={pendingAction !== ''}
                            onClick={() => action(
                              `disable:${account.globalId}`,
                              {
                                action: 'set-enabled',
                                accountGlobalId: account.globalId,
                                enabled: false,
                              },
                              `${account.displayName} disabled.`,
                            )}
                            sx={actionButtonSx}
                          >
                            Disable
                          </Button>
                        ) : null}
                        <Button
                          variant="outlined"
                          color="error"
                          startIcon={<LinkOffRounded />}
                          disabled={pendingAction !== '' || !account.configured}
                          onClick={() => disconnect(account)}
                          sx={actionButtonSx}
                        >
                          Disconnect credential
                        </Button>
                      </Stack>

                      <Typography variant="caption" color="text.secondary">
                        Evidence: {account.evidence.webhookReceipts} webhook
                        receipts, {account.evidence.providerAttempts} provider
                        verification attempts, {account.evidence.deadLetterWebhooks
                          + account.evidence.deadLetterAttempts} dead-letter
                        records. Domain workers activated: no.
                      </Typography>
                    </Stack>
                  </CardContent>
                </Card>
              )
            })}
          </Stack>
        )}
      </Box>

      {catalog ? (
        <Accordion disableGutters>
          <AccordionSummary expandIcon={<ExpandMoreRounded />}>
            <Box>
              <Typography fontWeight={700}>
                Provider capability and scope audit
              </Typography>
              <Typography variant="body2" color="text.secondary">
                Provider availability is shown separately from behavior
                implemented in ClawPilot.
              </Typography>
            </Box>
          </AccordionSummary>
          <AccordionDetails>
            <Alert severity="warning" sx={{ mb: 2 }}>
              “Available from provider” does not mean activated in ClawPilot.
              Rows marked Planned have no canonical import/export worker.
            </Alert>
            <TableContainer sx={{ maxHeight: 560 }}>
              <Table size="small" stickyHeader>
                <TableHead>
                  <TableRow>
                    <TableCell>Capability</TableCell>
                    <TableCell>Shopify</TableCell>
                    <TableCell>Faire</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {catalog.definitions.map((definition) => (
                    <TableRow key={definition.capability}>
                      <TableCell sx={{ minWidth: 210 }}>
                        <Typography variant="body2" fontWeight={600}>
                          {humanize(definition.capability)}
                        </Typography>
                        <Typography variant="caption" color="text.secondary">
                          {definition.category} · {definition.direction} ·{' '}
                          {definition.owner}
                        </Typography>
                      </TableCell>
                      {(['shopify', 'faire'] as const).map((provider) => {
                        const descriptor = catalog.providers[provider]
                        const available =
                          descriptor.providerAvailableCapabilities.includes(
                            definition.capability,
                          )
                        const implemented =
                          descriptor.implementation[definition.capability]
                            === 'control_plane_implemented'
                        const scopes =
                          descriptor.capabilityScopes[definition.capability]
                          || []
                        return (
                          <TableCell key={provider} sx={{ minWidth: 230 }}>
                            <Stack
                              direction="row"
                              gap={0.5}
                              flexWrap="wrap"
                            >
                              <Chip
                                size="small"
                                color={available ? 'info' : 'default'}
                                label={available
                                  ? 'Provider available'
                                  : 'Provider unavailable'}
                              />
                              <Chip
                                size="small"
                                color={implemented ? 'success' : 'default'}
                                label={implemented
                                  ? 'Control plane'
                                  : 'Not implemented'}
                              />
                            </Stack>
                            {scopes.length ? (
                              <Typography
                                variant="caption"
                                color="text.secondary"
                                display="block"
                                sx={{ mt: 0.5 }}
                              >
                                {scopes.join(', ')}
                              </Typography>
                            ) : null}
                          </TableCell>
                        )
                      })}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
            <Divider sx={{ my: 2 }} />
            <Typography variant="subtitle2">Faire public scopes</Typography>
            <Stack direction="row" gap={0.75} flexWrap="wrap" sx={{ mt: 1 }}>
              {(catalog.providers.faire.providerScopes || []).map((scope) => (
                <Chip key={scope} size="small" label={scope} />
              ))}
            </Stack>
          </AccordionDetails>
        </Accordion>
      ) : null}

      <Typography variant="caption" color="text.secondary">
        Shopify custom integrations exchange merchant-owned Dev Dashboard app
        credentials for short-lived tokens when needed. Faire Custom Apps use
        an authorization-code exchange and both provider-required OAuth headers
        after the brand approves access. Encrypted credentials are write-only
        and are never returned by this page.
      </Typography>
    </Stack>
  )
}
