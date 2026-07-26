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
import LinkRounded from '@mui/icons-material/LinkRounded'
import LinkOffRounded from '@mui/icons-material/LinkOffRounded'
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
  definitions: CapabilityDefinition[]
  providers: Record<CommerceProvider, ProviderCatalog>
  activationBoundary: {
    receiptIntakeOnly: boolean
    domainWorkersActivated: boolean
    canonicalOrderImport: boolean
    inventoryMutation: boolean
    fulfillmentExport: boolean
    multiMerchantOauth: boolean
  }
}

type CommercePayload = {
  ok?: boolean
  error?: string
  canManage?: boolean
  canActivate?: boolean
  integrations?: CommerceState
  catalog?: CommerceCatalog
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
  accessToken: string
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

async function requestCommerce(init?: RequestInit): Promise<CommercePayload> {
  const response = await fetch('/api/integrations/commerce', {
    cache: 'no-store',
    ...init,
  })
  const result = await response.json().catch(() => ({})) as CommercePayload
  if (!response.ok || !result.ok) {
    throw new Error(result.error || 'Sales-channel integration request failed')
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
    accessToken: '',
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
        if (active) applyPayload(payload)
      })
      .catch((requestError) => {
        if (active) {
          setError(
            requestError instanceof Error
              ? requestError.message
              : 'Sales-channel integration request failed',
          )
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
      setError(
        requestError instanceof Error
          ? requestError.message
          : 'Sales-channel integration request failed',
      )
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
      'Shopify store and app credentials verified. Send one signed app-scope, product, or inventory delivery to verify the webhook secret before enabling receipt intake.',
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
    const saved = await action(
      'connect-faire',
      { action: 'connect-faire', ...faire },
      'Faire brand identity and credential verified. Domain synchronization remains disabled.',
    )
    if (saved) {
      setFaire((current) => ({
        ...current,
        accessToken: '',
        confirmLiveAccess: false,
      }))
    }
  }

  async function disconnect(account: CommerceAccount) {
    if (
      !window.confirm(
        `Disconnect ${account.displayName}? Encrypted credentials will be removed; durable operational evidence remains.`,
      )
    ) return
    await action(
      `disconnect:${account.globalId}`,
      { action: 'disconnect', accountGlobalId: account.globalId },
      `${account.displayName} disconnected.`,
    )
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
        This slice verifies and encrypts credentials, audits provider
        capabilities, persists sync/retry evidence, and accepts signed Shopify
        receipt evidence. Canonical order import, inventory writes,
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
                  Shopify store
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  Dev Dashboard client-credentials connection for one
                  same-organization <code>.myshopify.com</code> store.
                  Multi-merchant OAuth is a later activation boundary.
                </Typography>
              </Box>
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
                  : 'Verify and save Shopify'}
              </Button>
            </Stack>
          </CardContent>
        </Card>

        <Card variant="outlined">
          <CardContent>
            <Stack component="form" spacing={2} onSubmit={connectFaire}>
              <Box>
                <Typography variant="subtitle1" fontWeight={700}>
                  Faire brand
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  Production-only brand API connection for the B2B wholesale
                  marketplace. Faire does not publish webhooks or a sandbox.
                </Typography>
              </Box>
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
                type="password"
                label="Faire brand API token"
                value={faire.accessToken}
                onChange={(event) => setFaire((current) => ({
                  ...current,
                  accessToken: event.target.value,
                }))}
                helperText="Retailer accounts cannot create custom API connections; this is for a Faire brand account."
                autoComplete="new-password"
                sx={fieldSx}
              />
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
                label="I authorize a live production brand-profile verification call."
              />
              <Button
                type="submit"
                variant="contained"
                startIcon={<LinkRounded />}
                disabled={
                  pendingAction !== ''
                  || !faire.confirmLiveAccess
                  || !faire.accessToken
                }
                sx={actionButtonSx}
              >
                {pendingAction === 'connect-faire'
                  ? 'Verifying…'
                  : 'Verify and save Faire'}
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
                            color={statusColor(account.status)}
                            label={humanize(account.status)}
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

                      {account.provider === 'shopify' && account.webhookUrl ? (
                        <TextField
                          label="Signed webhook receipt URL"
                          value={account.webhookUrl}
                          InputProps={{ readOnly: true }}
                          helperText="Send an app/scopes_update, product, or inventory signed delivery while disabled to verify the client secret; it is held and never imported. Order and customer topics are rejected."
                          sx={fieldSx}
                        />
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
        Shopify connections in this slice exchange Dev Dashboard app
        credentials for short-lived tokens when needed; Faire connections use
        a brand API token and production profile verification. Encrypted
        credentials are write-only and are never returned by this page.
      </Typography>
    </Stack>
  )
}
