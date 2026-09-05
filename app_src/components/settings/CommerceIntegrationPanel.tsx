'use client'

import {
  useEffect,
  useRef,
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
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import FormControl from '@mui/material/FormControl'
import FormControlLabel from '@mui/material/FormControlLabel'
import IconButton from '@mui/material/IconButton'
import InputLabel from '@mui/material/InputLabel'
import InputAdornment from '@mui/material/InputAdornment'
import MenuItem from '@mui/material/MenuItem'
import Select from '@mui/material/Select'
import Stack from '@mui/material/Stack'
import Switch from '@mui/material/Switch'
import Table from '@mui/material/Table'
import TableBody from '@mui/material/TableBody'
import TableCell from '@mui/material/TableCell'
import TableContainer from '@mui/material/TableContainer'
import TableHead from '@mui/material/TableHead'
import TableRow from '@mui/material/TableRow'
import TextField from '@mui/material/TextField'
import Tooltip from '@mui/material/Tooltip'
import Typography from '@mui/material/Typography'
import ExpandMoreRounded from '@mui/icons-material/ExpandMoreRounded'
import ContentCopyRounded from '@mui/icons-material/ContentCopyRounded'
import IntegrationInstructionsRounded from '@mui/icons-material/IntegrationInstructionsRounded'
import LinkRounded from '@mui/icons-material/LinkRounded'
import LinkOffRounded from '@mui/icons-material/LinkOffRounded'
import OpenInNewRounded from '@mui/icons-material/OpenInNewRounded'
import PowerSettingsNewRounded from '@mui/icons-material/PowerSettingsNewRounded'
import StorefrontRounded from '@mui/icons-material/StorefrontRounded'
import SyncRounded from '@mui/icons-material/SyncRounded'
import VisibilityOffRounded from '@mui/icons-material/VisibilityOffRounded'
import VisibilityRounded from '@mui/icons-material/VisibilityRounded'
import AddRounded from '@mui/icons-material/AddRounded'
import IntegrationSetupJourney, {
  type IntegrationSetupStepState,
} from '@/components/settings/IntegrationSetupJourney'
import CommerceIntakeWorkflow from '@/components/settings/CommerceIntakeWorkflow'
import ShopifyCarrierServiceSetupPanel
  from '@/components/settings/ShopifyCarrierServiceSetupPanel'
import { copyPlainTextToClipboard } from '@/lib/browserClipboard'
import { SHOPIFY_DISTRIBUTED_OPERATIONS_SCOPES }
  from '@/lib/integrations/commerceCapabilities'
import { resolveCommerceSetupPermissionGuidance }
  from '@/lib/integrations/commerceSetupGuidance'
import {
  clearShopifyOrderWebhookRecoveryDraft,
  isShopifyOrderWebhookRecoveryKey,
  loadShopifyOrderWebhookRecoveryDraft,
  resolveShopifyOrderWebhookRecovery,
  saveShopifyOrderWebhookRecoveryDraft,
  shopifyOrderWebhookRecoveryKeyHash,
} from '@/lib/integrations/shopifyOrderWebhookRecovery'

type CommerceProvider = 'shopify' | 'faire'
type CommerceEnvironment = 'sandbox' | 'production'
type CommerceOrderHistoryMode =
  | 'new_orders_only'
  | 'last_7_days'
  | 'last_30_days'
  | 'last_60_days'
  | 'provider_all'

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
  receiptIntakeEnabled: boolean
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
  orderHistoryPolicy: null | {
    mode: CommerceOrderHistoryMode
    ingestionFloor: string | null
    frozenAt: string
  }
  fulfillmentNotificationPolicy:
    | {
      mode: 'clawpilot_explicit'
      notifyCustomerDefault: boolean
      revision: number
      changeReason: string
      updatedAt: string
    }
    | {
      mode: 'provider_managed'
      notifyCustomerDefault: null
      revision: 0
      changeReason: null
      updatedAt: null
    }
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
    webhookReceiptHealth: {
      integrationAccountId: string
      accountGlobalId: string
      status: 'ready' | 'attention'
      actionable: number
      staleQueued: number
      staleProcessing: number
      failed: number
      deadLetter: number
      heldProductDeletes: number
      oldestActionableAt: string | null
    } | null
  }
  fulfillmentWriteReadiness: {
    ready: boolean
    authMode: string | null
    requiredAuthMode: 'faire_oauth'
    requiredScopes: string[]
    credentialBinding: {
      current: boolean
    }
    providerScopeEvidence: {
      recordedForCredentialGeneration: boolean
      current: boolean
      verificationSource: string | null
    }
    activeCapabilities: {
      required: string[]
      current: string[]
      missing: string[]
    }
    blockedBy: {
      code: string
      message: string
    } | null
    providerWrites: 0
  } | null
  webhookUrl: string | null
  updatedAt: string
}

type CommerceState = {
  organizationId: string
  accounts: CommerceAccount[]
}

type ProviderWriteControl = {
  accountGlobalId: string
  accountDisplayName: string
  provider: CommerceProvider
  environment: 'mock' | CommerceEnvironment
  requestedMode: 'off' | 'on'
  rowVersion: number
  effectiveFromDefault: boolean
  bindingStatus: 'off' | 'current' | 'unavailable' | 'revalidation_required'
  bindingCurrent: boolean
  enableAvailable: boolean
  blocker: { code: string; message: string } | null
  boundCredentialGeneration: number | null
  boundGrantedScopeDigest: string | null
  currentCredentialGeneration: number
  currentGrantedScopeDigest: string | null
  changedBy: string | null
  changedRole: 'owner' | 'admin' | 'member' | null
  updatedAt: string | null
  commandEnforcement:
    | 'shopify_order_management'
    | 'shopify_fulfillment'
    | 'shopify_order_management_and_fulfillment'
    | 'faire_fulfillment'
    | 'not_connected'
  providerWritesEffective: boolean
  fulfillmentWritesEffective: boolean
  fulfillmentWritesBlockedReason: string | null
}

type ProviderWritePayload = {
  ok?: boolean
  error?: string
  code?: string
  state?: {
    organizationId: string
    accounts: ProviderWriteControl[]
  }
  result?: {
    control: ProviderWriteControl
    replayed: boolean
  }
  canManage?: boolean
  canEnable?: boolean
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
      restrictedOrderScopeApprovalUrl: string
      protectedCustomerDataApprovalUrl: string
      defaultAppUrl: string
      apiVersion: string
      requiredBeforeConnect: readonly string[]
      receiptProofScopes: readonly string[]
      acceptedReceiptTopics: readonly string[]
      webhookSetupGroups: readonly {
        key: string
        label: string
        topics: readonly string[]
        requiredScopes: readonly string[]
        state: 'available' | 'processor_pending' | 'privacy_lifecycle_pending'
        behavior: string
      }[]
      unsupportedCredentialMode: string
    }
    faire: {
      developerPortalUrl: string
      setupGuideUrl: string
      directTokenGuideUrl: string
      callbackUrl: string
      brandApiKeyRequiredBeforeConnect: readonly string[]
      oauthRequiredBeforeConnect: readonly string[]
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
    faireBrandApiKey: boolean
    faireCustomAppOauth: boolean
  }
}

type CommercePayload = {
  ok?: boolean
  error?: string
  code?: string
  canManage?: boolean
  canActivate?: boolean
  canRevealCredentials?: boolean
  intakeAvailable?: boolean
  integrations?: CommerceState
  catalog?: CommerceCatalog
  authorizationUrl?: string
  callbackUrl?: string
  expiresAt?: string
  requestedScopes?: string[]
  credential?: RevealedCommerceCredential
  recoveryIdempotencyKey?: string | null
}

type RevealedCommerceCredential = {
  provider: CommerceProvider
  environment: CommerceEnvironment
  accountGlobalId: string
  authMode: string
  credentialVersion: number
  revealedAt: string
  expiresAt: string
  clientId?: string
  clientSecret?: string
  applicationId?: string
  applicationSecret?: string
}

type ShopifyOrderPreviewLine = {
  externalLineId: string
  sku: string | null
  quantity: number
  currentQuantity: number
  unfulfilledQuantity: number
  requiresShipping: boolean
  mappingStatus: 'inactive' | 'mapped' | 'missing' | 'sku_missing'
  mappedProductGlobalId: string | null
  packageProfileReady: boolean
}

type ShopifyOrderPreviewOrder = {
  externalOrderId: string
  orderName: string
  providerCreatedAt: string
  providerProcessedAt: string
  providerUpdatedAt: string
  providerCancelledAt: string | null
  providerClosedAt: string | null
  testOrder: boolean
  sourceName: string | null
  financialStatus: string | null
  fulfillmentStatus: string
  fulfillable: boolean
  requiresShipping: boolean
  currencyCode: string
  subtotalAmount: string
  shippingAmount: string
  taxAmount: string
  totalAmount: string
  lineItemQuantity: number
  lineItemsTruncated: boolean
  normalizedLines: ShopifyOrderPreviewLine[]
  gapCodes: string[]
  diagnosticState: 'complete' | 'gaps'
  sourceHash: string
}

type ShopifyOrderPreviewState = {
  accountGlobalId: string
  status: 'empty' | 'held'
  policy: {
    version: string
    retentionHours: number
    maxOrders: number
    maxLinesPerOrder: number
    rawPayloadStored: boolean
    customerFieldsRequested: boolean
    shopifyWritesAllowed: boolean
    canonicalPromotionAllowed: boolean
  }
  run: {
    credentialVersion: number
    windowEnd: string
    ordersSeen: number
    ordersStaged: number
    moreAvailable: boolean
    grantedScopes: string[]
    canonicalOrdersCreated: number
    shopifyWrites: number
    syncCursorAdvanced: boolean
    completedAt: string
    expiresAt: string
  } | null
  orders: ShopifyOrderPreviewOrder[]
  gapCounts: Record<string, number>
}

type ShopifyOrderPreviewPayload = {
  ok?: boolean
  error?: string
  code?: string
  preview?: ShopifyOrderPreviewState
  state?: ShopifyOrderPreviewState
  deleted?: number
}

type ShopifyForm = {
  displayName: string
  environment: CommerceEnvironment
  shopDomain: string
  clientId: string
  clientSecret: string
  confirmLiveAccess: boolean
  orderHistoryMode: Exclude<CommerceOrderHistoryMode, 'provider_all'>
}

type FaireForm = {
  authPath: 'brand_api_key' | 'oauth'
  displayName: string
  apiKey: string
  applicationId: string
  applicationSecret: string
  scopeProfile: 'connection_test' | 'distributed_operations'
  confirmLiveAccess: boolean
  orderHistoryMode: CommerceOrderHistoryMode
}

const ORDER_HISTORY_LABELS: Record<CommerceOrderHistoryMode, string> = {
  new_orders_only: 'Only orders created after connection',
  last_7_days: 'Orders from the prior 7 days',
  last_30_days: 'Orders from the prior 30 days',
  last_60_days: 'Orders from the prior 60 days',
  provider_all: 'All history available from the provider',
}

const COMMERCE_PROVIDER_OPTIONS: readonly {
  provider: CommerceProvider
  description: string
}[] = [
  {
    provider: 'shopify',
    description: 'Connect a merchant-owned Shopify Dev Dashboard app.',
  },
  {
    provider: 'faire',
    description: 'Connect a Faire brand API key or approved Custom App.',
  },
]

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
      'Confirm the myshopify.com domain and copy the current client ID and secret from the installed Dev Dashboard app.',
    SHOPIFY_CANONICAL_DOMAIN_REQUIRED:
      'Shopify verified this store under a different permanent myshopify.com domain. Reconnect with that permanent domain.',
    SHOPIFY_ACCESS_DENIED:
      'Update the app version scopes, release it, approve the change in Shopify, then test the connection again.',
    SHOPIFY_PROBE_INVALID:
      'Shopify authenticated the app but did not return a complete installed-store identity. Confirm the app is installed on this store, then retry.',
    SHOPIFY_SCOPE_PROFILE_INCOMPLETE:
      'Add the listed least-privilege receipt scopes to the Shopify app version, release it, approve the change, and test again.',
    SHOPIFY_ORDER_READ_SCOPE_REQUIRED:
      'Add read_orders to the released Shopify app version, approve the scope change, and test the connection again.',
    SHOPIFY_ORDER_PREVIEW_DISABLED:
      'This held order-preview diagnostic is available only in an approved ClawPilot development lane with its server feature flag enabled.',
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
      'Use the trusted Railway production service or an explicitly approved public HTTPS tunnel for the live Faire authorization.',
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

async function requestProviderWrites(
  init?: RequestInit,
): Promise<ProviderWritePayload> {
  const response = await fetch('/api/integrations/commerce/provider-writes', {
    cache: 'no-store',
    ...init,
  })
  const result = await response.json().catch(() => ({})) as
    ProviderWritePayload
  if (!response.ok || !result.ok) {
    throw new CommerceRequestError(
      result.error || 'Provider writes control request failed',
      result.code,
    )
  }
  return result
}

async function requestShopifyOrderPreview(
  accountGlobalId: string,
  init?: RequestInit,
): Promise<ShopifyOrderPreviewPayload> {
  const path = new URL(
    '/api/integrations/commerce/shopify/order-preview',
    window.location.origin,
  )
  if (!init || init.method === 'GET') {
    path.searchParams.set('accountGlobalId', accountGlobalId)
  }
  const response = await fetch(`${path.pathname}${path.search}`, {
    cache: 'no-store',
    ...init,
  })
  const result = await response.json().catch(() => ({})) as
    ShopifyOrderPreviewPayload
  if (!response.ok || !result.ok) {
    throw new CommerceRequestError(
      result.error || 'Shopify order-preview request failed',
      result.code,
    )
  }
  return result
}

function money(amount: string, currency: string) {
  const value = Number(amount)
  if (!Number.isFinite(value)) return `${amount} ${currency}`
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
    }).format(value)
  } catch {
    return `${amount} ${currency}`
  }
}

function statusColor(
  status: CommerceAccount['status'] | CommerceAccount['verificationStatus'],
) {
  if (status === 'active' || status === 'verified') return 'success' as const
  if (status === 'error' || status === 'failed') return 'error' as const
  return 'default' as const
}

function connectionSetupState(
  account: CommerceAccount | undefined,
): IntegrationSetupStepState {
  if (!account?.configured) return 'pending'
  if (account.verificationStatus === 'verified') return 'complete'
  return 'attention'
}

function accountConfigurationText(
  account: CommerceAccount | undefined,
  key: string,
) {
  const value = account?.configuration[key]
  return typeof value === 'string' && value.trim() ? value.trim() : ''
}

function setupTimestamp(value: string | null | undefined) {
  if (!value) return 'Not yet'
  const timestamp = new Date(value)
  return Number.isNaN(timestamp.getTime())
    ? 'Recorded'
    : timestamp.toLocaleString()
}

function maskedCommerceCredential(account: CommerceAccount | undefined) {
  if (!account?.configured) return 'Not stored'
  const suffix = account.credentialIdentifierLastFour
    ? ` · ••••${account.credentialIdentifierLastFour}`
    : ''
  return `Generation ${account.credentialVersion}${suffix}`
}

function hasEffectiveShopifyScope(
  grantedScopes: readonly string[],
  requiredScope: string,
) {
  if (grantedScopes.includes(requiredScope)) return true
  if (!requiredScope.startsWith('read_')) return false
  return grantedScopes.includes(`write_${requiredScope.slice('read_'.length)}`)
}

function webhookSubscriptionReadiness(
  configuration: Record<string, unknown>,
  key: string,
) {
  const value = configuration[key]
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {
      observed: false,
      ready: false,
      missingTopics: [] as string[],
      conflictingTopics: [] as string[],
    }
  }
  const state = value as Record<string, unknown>
  return {
    observed: true,
    ready: state.ready === true,
    missingTopics: valueStrings(state.missingTopics),
    conflictingTopics: valueStrings(state.conflictingTopics),
  }
}

function orderWebhookSubscriptionReadiness(account: CommerceAccount) {
  const value = account.configuration.orderWebhookSubscriptions
  const desiredTopics = [
    'orders/create',
    'orders/updated',
    'orders/edited',
    'orders/cancelled',
    'orders/paid',
    'orders/fulfilled',
    'orders/partially_fulfilled',
  ]
  const desiredFields = ['admin_graphql_api_id', 'updated_at']
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {
      desiredTopics,
      desiredFields,
      observed: false,
      observedCount: 0,
      matchingCount: 0,
      missingTopics: desiredTopics,
      conflictingTopics: [] as string[],
      effective: false,
      observedAt: null as string | null,
    }
  }
  const state = value as Record<string, unknown>
  const observedAt = typeof state.observedAt === 'string'
    ? state.observedAt
    : null
  const observedTime = observedAt ? Date.parse(observedAt) : Number.NaN
  const currentEvidence = Number.isFinite(observedTime)
    && observedTime >= Date.now() - 24 * 60 * 60 * 1_000
  const bindingCurrent = state.accountGlobalId === account.globalId
    && state.credentialGeneration === account.credentialVersion
    && state.desiredUri === account.webhookUrl
  return {
    desiredTopics,
    desiredFields,
    observed: true,
    observedCount: Number(state.observedCount || 0),
    matchingCount: Number(state.matchingCount || 0),
    missingTopics: valueStrings(state.missingTopics),
    conflictingTopics: valueStrings(state.conflictingTopics),
    effective: state.ready === true && bindingCurrent && currentEvidence,
    observedAt,
  }
}

export default function CommerceIntegrationPanel({
  onNavigate,
}: {
  onNavigate?: (hash: string) => void
} = {}) {
  const [integrations, setIntegrations] = useState<CommerceState>({
    organizationId: '',
    accounts: [],
  })
  const [catalog, setCatalog] = useState<CommerceCatalog | null>(null)
  const [canManage, setCanManage] = useState(false)
  const [canActivate, setCanActivate] = useState(false)
  const [canRevealCredentials, setCanRevealCredentials] = useState(false)
  const [intakeAvailable, setIntakeAvailable] = useState(false)
  const [providerWriteControls, setProviderWriteControls] = useState<
    Record<string, ProviderWriteControl>
  >({})
  const [providerWritesError, setProviderWritesError] = useState('')
  const [loading, setLoading] = useState(true)
  const [pendingAction, setPendingAction] = useState('')
  const [notificationPolicyDrafts, setNotificationPolicyDrafts] = useState<
    Record<string, {
      notifyCustomerDefault: boolean
      reason: string
      confirmed: boolean
    }>
  >({})
  const [orderWebhookDrafts, setOrderWebhookDrafts] = useState<Record<
    string,
    { confirmation: string; idempotencyKey: string | null }
  >>({})
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [revealedCredential, setRevealedCredential] =
    useState<RevealedCommerceCredential | null>(null)
  const organizationIdRef = useRef(integrations.organizationId)
  const orderWebhookRequestRef = useRef('')
  const [shopifyPreviews, setShopifyPreviews] = useState<
    Record<string, ShopifyOrderPreviewState>
  >({})
  const [shopify, setShopify] = useState<ShopifyForm>({
    displayName: '',
    environment: 'sandbox',
    shopDomain: '',
    clientId: '',
    clientSecret: '',
    confirmLiveAccess: false,
    orderHistoryMode: 'new_orders_only',
  })
  const [faire, setFaire] = useState<FaireForm>({
    authPath: 'brand_api_key',
    displayName: '',
    apiKey: '',
    applicationId: '',
    applicationSecret: '',
    scopeProfile: 'connection_test',
    confirmLiveAccess: false,
    orderHistoryMode: 'new_orders_only',
  })
  const [providerCatalogOpen, setProviderCatalogOpen] = useState(false)
  const [selectedSetupProvider, setSelectedSetupProvider] =
    useState<CommerceProvider | null>(null)
  const [setupChecklistProvider, setSetupChecklistProvider] = useState<CommerceProvider | null>(null)
  const setupScopeInputRef = useRef<
    HTMLInputElement | HTMLTextAreaElement | null
  >(null)
  const [copiedSetupScopes, setCopiedSetupScopes] = useState<null | string>(null)

  function applyPayload(payload: CommercePayload) {
    if (payload.integrations) {
      if (
        payload.integrations.organizationId
          !== organizationIdRef.current
      ) {
        organizationIdRef.current = payload.integrations.organizationId
        setRevealedCredential(null)
      }
      setIntegrations(payload.integrations)
    }
    if (payload.catalog) setCatalog(payload.catalog)
    setCanManage(payload.canManage === true)
    setCanActivate(payload.canActivate === true)
    setIntakeAvailable(payload.intakeAvailable === true)
    if (typeof payload.canRevealCredentials === 'boolean') {
      setCanRevealCredentials(payload.canRevealCredentials)
    }
  }

  function applyProviderWritePayload(payload: ProviderWritePayload) {
    if (!payload.state) return
    setProviderWriteControls(Object.fromEntries(
      payload.state.accounts.map((control) => [
        control.accountGlobalId,
        control,
      ]),
    ))
    setProviderWritesError('')
  }

  useEffect(() => {
    let active = true
    requestProviderWrites()
      .then((payload) => {
        if (active) applyProviderWritePayload(payload)
      })
      .catch((requestError) => {
        if (active) {
          setProviderWritesError(actionableCommerceError(requestError))
        }
      })
    requestCommerce()
      .then((payload) => {
        if (active) {
          applyPayload(payload)
          const url = new URL(window.location.href)
          const oauthStatus = url.searchParams.get('faireOauth')
          const oauthCode = url.searchParams.get('faireOauthCode')
          if (oauthStatus === 'connected') {
            setNotice(
              'Faire Custom App connected and verified. This connection authorizes automatic read-only product catalog sync with no second approval. ClawPilot initializes the resumed policy and queues work when product-read access, the development runtime, and the Operations product target are eligible.',
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

  useEffect(() => {
    if (!revealedCredential) return
    const clearRevealedCredential = () => setRevealedCredential(null)
    const clearWhenHidden = () => {
      if (document.visibilityState !== 'visible') clearRevealedCredential()
    }
    const timeout = window.setTimeout(
      clearRevealedCredential,
      Math.min(
        30_000,
        Math.max(0, Date.parse(revealedCredential.expiresAt) - Date.now()),
      ),
    )
    window.addEventListener('blur', clearRevealedCredential)
    window.addEventListener('pagehide', clearRevealedCredential)
    document.addEventListener('visibilitychange', clearWhenHidden)
    return () => {
      window.clearTimeout(timeout)
      window.removeEventListener('blur', clearRevealedCredential)
      window.removeEventListener('pagehide', clearRevealedCredential)
      document.removeEventListener('visibilitychange', clearWhenHidden)
    }
  }, [revealedCredential])

  useEffect(() => {
    if (!integrations.organizationId || typeof window === 'undefined') return
    let recoveryStorage: Storage
    try {
      recoveryStorage = window.sessionStorage
    } catch {
      return
    }
    setOrderWebhookDrafts((current) => {
      const next = { ...current }
      let changed = false
      for (const account of integrations.accounts) {
        if (account.provider !== 'shopify' || next[account.globalId]) continue
        const recovered = loadShopifyOrderWebhookRecoveryDraft(
          recoveryStorage,
          {
            organizationId: integrations.organizationId,
            accountGlobalId: account.globalId,
          },
        )
        if (recovered) {
          next[account.globalId] = recovered
          changed = true
        }
      }
      return changed ? next : current
    })
  }, [integrations.accounts, integrations.organizationId])

  async function action(
    key: string,
    body: Record<string, unknown>,
    successMessage: string,
    additionalHeaders: Record<string, string> = {},
  ) {
    setPendingAction(key)
    setError('')
    setNotice('')
    try {
      const payload = await requestCommerce({
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          ...additionalHeaders,
        },
        body: JSON.stringify(body),
      })
      applyPayload(payload)
      void requestProviderWrites()
        .then((providerWritePayload) => {
          applyProviderWritePayload(providerWritePayload)
        })
        .catch((requestError) => {
          setProviderWritesError(actionableCommerceError(requestError))
        })
      setNotice(successMessage)
      return payload
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

  async function setProviderWrites(
    account: CommerceAccount,
    mode: 'off' | 'on',
  ) {
    const current = providerWriteControls[account.globalId]
    if (!current) return
    const key = `provider-writes:${account.globalId}`
    setPendingAction(key)
    setProviderWritesError('')
    setError('')
    setNotice('')
    try {
      const payload = await requestProviderWrites({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': [
            'provider-writes',
            account.globalId,
            current.rowVersion,
            mode,
            crypto.randomUUID(),
          ].join(':'),
        },
        body: JSON.stringify({
          accountGlobalId: account.globalId,
          mode,
          expectedRowVersion: current.rowVersion,
        }),
      })
      const saved = payload.result?.control
      if (!saved) {
        throw new CommerceRequestError(
          'Provider writes control response was incomplete',
          'COMMERCE_PROVIDER_WRITES_RESPONSE_INVALID',
        )
      }
      setProviderWriteControls((controls) => ({
        ...controls,
        [saved.accountGlobalId]: saved,
      }))
      setNotice(
        mode === 'on'
          ? `${account.displayName} Provider writes set to On for the current credential and granted scopes.`
          : `${account.displayName} Provider writes set to Off.`,
      )
    } catch (requestError) {
      setProviderWritesError(actionableCommerceError(requestError))
      await requestProviderWrites()
        .then((payload) => applyProviderWritePayload(payload))
        .catch(() => undefined)
    } finally {
      setPendingAction('')
    }
  }

  async function saveFulfillmentNotificationPolicy(
    account: CommerceAccount,
  ) {
    if (account.fulfillmentNotificationPolicy.mode !== 'clawpilot_explicit') {
      return
    }
    const draft = notificationPolicyDrafts[account.globalId]
    if (!draft) return
    const saved = await action(
      `fulfillment-notifications:${account.globalId}`,
      {
        action: 'set-shopify-fulfillment-notification-policy',
        accountGlobalId: account.globalId,
        expectedRevision: account.fulfillmentNotificationPolicy.revision,
        notifyCustomerDefault: draft.notifyCustomerDefault,
        reason: draft.reason.trim(),
        confirmCustomerNotifications:
          draft.notifyCustomerDefault ? draft.confirmed : false,
      },
      `Shopify customer notification requests now default to ${
        draft.notifyCustomerDefault ? 'on' : 'off'
      } for future orders.`,
    )
    if (saved) {
      setNotificationPolicyDrafts((current) => {
        const next = { ...current }
        delete next[account.globalId]
        return next
      })
    }
  }

  async function loadShopifyPreview(account: CommerceAccount) {
    const key = `preview-load:${account.globalId}`
    setPendingAction(key)
    setError('')
    try {
      const payload = await requestShopifyOrderPreview(
        account.globalId,
        { method: 'GET' },
      )
      if (payload.preview) {
        setShopifyPreviews((current) => ({
          ...current,
          [account.globalId]: payload.preview as ShopifyOrderPreviewState,
        }))
      }
    } catch (requestError) {
      setError(actionableCommerceError(requestError))
    } finally {
      setPendingAction('')
    }
  }

  async function importShopifyPreview(account: CommerceAccount) {
    const key = `preview-import:${account.globalId}`
    setPendingAction(key)
    setError('')
    setNotice('')
    try {
      const payload = await requestShopifyOrderPreview(account.globalId, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accountGlobalId: account.globalId,
          idempotencyKey: crypto.randomUUID(),
          confirmReadOnly: true,
        }),
      })
      if (payload.preview) {
        setShopifyPreviews((current) => ({
          ...current,
          [account.globalId]: payload.preview as ShopifyOrderPreviewState,
        }))
        setNotice(
          `${account.displayName} read-only Shopify order preview is held for review. No Shopify records or canonical ClawPilot orders were changed.`,
        )
      }
    } catch (requestError) {
      setError(actionableCommerceError(requestError))
    } finally {
      setPendingAction('')
    }
  }

  async function clearShopifyPreview(account: CommerceAccount) {
    if (
      !window.confirm(
        `Clear the ephemeral Shopify order preview for ${account.displayName}? This does not change Shopify or canonical ClawPilot orders.`,
      )
    ) return
    const key = `preview-clear:${account.globalId}`
    setPendingAction(key)
    setError('')
    setNotice('')
    try {
      const payload = await requestShopifyOrderPreview(account.globalId, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accountGlobalId: account.globalId,
          confirmClear: true,
        }),
      })
      if (payload.state) {
        setShopifyPreviews((current) => ({
          ...current,
          [account.globalId]: payload.state as ShopifyOrderPreviewState,
        }))
      }
      setNotice(`${account.displayName} held Shopify order preview cleared.`)
    } catch (requestError) {
      setError(actionableCommerceError(requestError))
    } finally {
      setPendingAction('')
    }
  }

  async function connectShopify(event: FormEvent) {
    event.preventDefault()
    const saved = await action(
      'connect-shopify',
      { action: 'connect-shopify', ...shopify },
      'Shopify merchant-owned app connected and verified. This connection authorizes automatic read-only product catalog sync with no second approval. ClawPilot initializes the resumed policy and queues work when product-read access, the development runtime, and the Operations product target are eligible. Signed receipt intake and provider writes remain separate.',
    )
    if (saved) {
      setRevealedCredential(null)
      setSelectedSetupProvider(null)
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
    if (faire.authPath === 'brand_api_key') {
      const saved = await action(
        'connect-faire-api-key',
        {
          action: 'connect-faire-api-key',
          displayName: faire.displayName,
          accessToken: faire.apiKey,
          orderHistoryMode: faire.orderHistoryMode,
          confirmLiveAccess: faire.confirmLiveAccess,
        },
        'Faire generated API key connected and verified. This connection authorizes automatic read-only product catalog sync with no second approval. ClawPilot initializes the resumed policy and queues work when product-read access, the development runtime, and the Operations product target are eligible. Order, inventory, fulfillment, and provider-write workflows remain separate.',
      )
      if (saved) {
        setRevealedCredential(null)
        setSelectedSetupProvider(null)
        setFaire((current) => ({
          ...current,
          apiKey: '',
          confirmLiveAccess: false,
        }))
      }
      return
    }
    setPendingAction('start-faire-oauth')
    setError('')
    setNotice('')
    try {
      const payload = await requestCommerce({
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'start-faire-oauth',
          displayName: faire.displayName,
          applicationId: faire.applicationId,
          applicationSecret: faire.applicationSecret,
          scopeProfile: faire.scopeProfile,
          orderHistoryMode: faire.orderHistoryMode,
          confirmLiveAccess: faire.confirmLiveAccess,
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
    setRevealedCredential(null)
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

  async function registerInventoryWebhooks(account: CommerceAccount) {
    if (!canActivate || pendingAction) return
    if (!window.confirm(
      `Register the inventory item and inventory level webhook topics for ${account.displayName}? This creates only the two exact Shopify subscriptions shown in this workflow.`,
    )) return
    await action(
      `register-inventory-webhooks:${account.globalId}`,
      {
        action: 'register-shopify-inventory-webhooks',
        accountGlobalId: account.globalId,
        confirmProviderWrites: true,
      },
      `${account.displayName} inventory webhook subscriptions registered and verified.`,
    )
  }

  async function registerScopeWebhooks(account: CommerceAccount) {
    if (!canActivate || pendingAction) return
    if (!window.confirm(
      `Register the Shopify access-scope safety webhook for ${account.displayName}? This creates only the app/scopes_update subscription shown in this workflow.`,
    )) return
    await action(
      `register-scope-webhooks:${account.globalId}`,
      {
        action: 'register-shopify-scope-webhooks',
        accountGlobalId: account.globalId,
        confirmProviderWrites: true,
      },
      `${account.displayName} access-scope safety webhook registered and verified.`,
    )
  }

  async function registerCatalogWebhooks(account: CommerceAccount) {
    if (!canActivate || pendingAction) return
    if (!window.confirm(
      `Register the product create, update, and delete webhook topics for ${account.displayName}? Product events will trigger a read-only catalog reconciliation in Shadow.`,
    )) return
    await action(
      `register-catalog-webhooks:${account.globalId}`,
      {
        action: 'register-shopify-catalog-webhooks',
        accountGlobalId: account.globalId,
        confirmProviderWrites: true,
      },
      `${account.displayName} catalog webhook subscriptions registered and verified.`,
    )
  }

  async function reconcileOrderWebhooks(account: CommerceAccount) {
    if (!canRevealCredentials || pendingAction) return
    if (!account.webhookUrl) {
      setError('The exact public Shopify callback is not available.')
      return
    }
    const expected = `RECONCILE 7 ORDER WEBHOOKS FOR ${account.globalId}`
    const draft = orderWebhookDrafts[account.globalId]
      || { confirmation: '', idempotencyKey: null }
    if (draft.confirmation !== expected) {
      setError(`Type exactly: ${expected}`)
      return
    }
    if (orderWebhookRequestRef.current) return
    orderWebhookRequestRef.current = account.globalId
    const finishPending = () => {
      orderWebhookRequestRef.current = ''
      setPendingAction('')
    }
    let recoveredKey: string | null = null
    if (!draft.idempotencyKey) {
      setPendingAction(`reconcile-order-webhooks:${account.globalId}`)
      setError('')
      setNotice('')
      try {
        const recovery = await requestCommerce({
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'recover-shopify-order-webhook-command',
            accountGlobalId: account.globalId,
            confirmation: draft.confirmation,
          }),
        })
        if (
          recovery.recoveryIdempotencyKey !== null
          && recovery.recoveryIdempotencyKey !== undefined
          && !isShopifyOrderWebhookRecoveryKey(
            recovery.recoveryIdempotencyKey,
          )
        ) {
          throw new CommerceRequestError(
            'ClawPilot received an invalid open-command recovery key.',
            'SHOPIFY_ORDER_WEBHOOK_RECOVERY_KEY_INVALID',
          )
        }
        recoveredKey = recovery.recoveryIdempotencyKey || null
      } catch (requestError) {
        finishPending()
        setError(actionableCommerceError(requestError))
        return
      }
    }
    const stableKey = draft.idempotencyKey
      || recoveredKey
      || crypto.randomUUID()
    const stableKeyHash = await shopifyOrderWebhookRecoveryKeyHash(stableKey)
    if (!stableKeyHash) {
      finishPending()
      setError(
        'ClawPilot could not bind the safe retry key to this browser; order webhooks were not changed.',
      )
      return
    }
    let recoveryStorage: Storage
    try {
      recoveryStorage = window.sessionStorage
    } catch {
      finishPending()
      setError(
        'ClawPilot could not access safe retry storage for this tab; order webhooks were not changed.',
      )
      return
    }
    const storedForRecovery = saveShopifyOrderWebhookRecoveryDraft(
      recoveryStorage,
      {
        organizationId: integrations.organizationId,
        accountGlobalId: account.globalId,
        confirmation: draft.confirmation,
        idempotencyKey: stableKey,
      },
    )
    if (!storedForRecovery) {
      finishPending()
      setError(
        'ClawPilot could not store the safe retry key for this tab; order webhooks were not changed.',
      )
      return
    }
    setOrderWebhookDrafts((current) => ({
      ...current,
      [account.globalId]: { ...draft, idempotencyKey: stableKey },
    }))
    const organizationId = integrations.organizationId
    const recoveryIdentity = {
      organizationId,
      accountGlobalId: account.globalId,
      credentialGeneration: account.credentialVersion,
      callbackUri: account.webhookUrl,
      idempotencyKeyHash: stableKeyHash,
    }
    setPendingAction(`reconcile-order-webhooks:${account.globalId}`)
    setError('')
    setNotice('')
    const outcome = await resolveShopifyOrderWebhookRecovery({
      identity: recoveryIdentity,
      patch: async () => {
        let response: Response
        try {
          response = await fetch('/api/integrations/commerce', {
            cache: 'no-store',
            method: 'PATCH',
            headers: {
              'Content-Type': 'application/json',
              'Idempotency-Key': stableKey,
            },
            body: JSON.stringify({
              action: 'reconcile-shopify-order-webhooks',
              accountGlobalId: account.globalId,
              confirmation: draft.confirmation,
            }),
          })
        } catch (requestError) {
          return {
            status: null,
            code: null,
            message: requestError instanceof Error
              ? requestError.message
              : 'The reconciliation response was lost.',
            payload: null,
            transportError: true,
            malformed: false,
          }
        }
        let decoded: unknown
        let malformed = false
        try {
          decoded = await response.json()
        } catch {
          decoded = null
          malformed = true
        }
        const payload = decoded
          && typeof decoded === 'object'
          && !Array.isArray(decoded)
          ? decoded as CommercePayload
          : null
        if (!payload || typeof payload.ok !== 'boolean') malformed = true
        return {
          status: response.status,
          code: typeof payload?.code === 'string' ? payload.code : null,
          message: typeof payload?.error === 'string'
            ? payload.error
            : response.ok
              ? 'ClawPilot received an incomplete reconciliation response.'
              : 'Shopify order webhook reconciliation failed.',
          payload,
          transportError: false,
          malformed,
        }
      },
      refresh: () => requestCommerce(),
    })
    finishPending()
    if (outcome.payload) applyPayload(outcome.payload as CommercePayload)
    if (outcome.disposition === 'retain') {
      setError(actionableCommerceError(new CommerceRequestError(
        outcome.message,
        outcome.code,
      )))
      return
    }
    const cleared = clearShopifyOrderWebhookRecoveryDraft(
      recoveryStorage,
      {
        organizationId,
        accountGlobalId: account.globalId,
      },
    )
    if (outcome.disposition === 'succeeded') {
      setOrderWebhookDrafts((current) => {
        const next = { ...current }
        delete next[account.globalId]
        return next
      })
      setNotice(
        `${account.displayName} order webhooks are registered with the exact minimized two-field JSON profile.${cleared ? '' : ' Browser recovery storage could not be cleared; close this tab before another attempt.'}`,
      )
      return
    }
    setOrderWebhookDrafts((current) => {
      const next = { ...current }
      delete next[account.globalId]
      return next
    })
    setError(actionableCommerceError(new CommerceRequestError(
      `${outcome.message} The rejected command was released; review the refreshed account state and confirm again.${cleared ? '' : ' Browser recovery storage could not be cleared; close this tab before another attempt.'}`,
      outcome.code,
    )))
  }

  async function revealCredential(account: CommerceAccount) {
    if (!account.configured || pendingAction) return
    const revealOrganizationId = organizationIdRef.current
    setRevealedCredential(null)
    if (!window.confirm(
      `Reveal the current ${providerLabel(account.provider)} application credentials? This action is audited and the values clear automatically.`,
    )) return
    const payload = await action(
      `reveal:${account.globalId}`,
      {
        action: 'reveal-credential',
        accountGlobalId: account.globalId,
      },
      `${account.displayName} credentials revealed for 30 seconds.`,
    )
    if (
      payload
      && payload.credential
      && organizationIdRef.current === revealOrganizationId
    ) {
      setRevealedCredential(payload.credential)
    }
  }

  async function copyRevealedCredential(label: string, value: string) {
    try {
      await navigator.clipboard.writeText(value)
      setNotice(`${label} copied.`)
    } catch {
      setError(
        `${label} could not be copied. Select the value and copy it manually.`,
      )
    }
  }

  async function copySetupChecklistScopes() {
    if (!setupChecklistProvider || !setupPermissionGuidance?.copyable) return
    const provider = setupChecklistProvider
    const value = setupPermissionGuidance.scopes.join(',')
    if (!value) return
    setError('')
    if (await copyPlainTextToClipboard(value)) {
      setCopiedSetupScopes(setupPermissionGuidanceKey)
      setTimeout(() => setCopiedSetupScopes(null), 1_200)
      setNotice(
        `${providerLabel(provider)} comma-separated setup scopes copied.`,
      )
      return
    }
    setupScopeInputRef.current?.focus()
    setupScopeInputRef.current?.select()
    setError(
      'The browser blocked clipboard access. The comma-separated scope list is selected; press Command+C to copy it.',
    )
  }

  if (loading) {
    return (
      <Stack alignItems="center" sx={{ py: 8 }}>
        <CircularProgress size={28} />
      </Stack>
    )
  }

  const shopifyAccount = integrations.accounts.find(
    (account) => account.provider === 'shopify'
      && account.environment === shopify.environment
      && account.configured,
  ) || integrations.accounts.find((account) => (
    account.provider === 'shopify'
    && account.environment === shopify.environment
  ))
  const faireAccount = integrations.accounts.find(
    (account) => account.provider === 'faire' && account.configured,
  ) || integrations.accounts.find((account) => account.provider === 'faire')
  const shopifyGrantedScopes = valueStrings(
    shopifyAccount?.configuration.grantedScopes,
  )
  const shopifyMissingScopes = valueStrings(
    shopifyAccount?.configuration.missingScopes,
  )
  const shopifyPreview = shopifyAccount
    ? shopifyPreviews[shopifyAccount.globalId]
    : undefined
  const shopifyDomain = accountConfigurationText(
    shopifyAccount,
    'shopDomain',
  ) || shopify.shopDomain.trim()
  const shopifyConnectionState = connectionSetupState(shopifyAccount)
  const shopifyPreviewState: IntegrationSetupStepState = shopifyPreview?.run
    ? 'complete'
    : shopifyAccount?.verificationStatus === 'verified'
      && shopifyGrantedScopes.includes('read_orders')
      ? 'current'
      : 'pending'
  const shopifyReceiptState: IntegrationSetupStepState =
    shopifyAccount?.receiptIntakeEnabled
      ? 'complete'
      : shopifyAccount?.verificationStatus === 'verified'
        && (
          shopifyMissingScopes.length > 0
          || shopifyAccount.webhookVerificationStatus !== 'verified'
        )
        ? 'attention'
        : shopifyAccount?.verificationStatus === 'verified'
          ? 'current'
        : 'pending'
  const faireConnectionState = connectionSetupState(faireAccount)
  const shopifyRequiredSetupChecklist = (catalog?.onboarding.shopify.requiredBeforeConnect || [])
    .join(' → ') || 'From the Shopify setup guide'
  const faireRequiredSetupSteps = faire.authPath === 'brand_api_key'
    ? catalog?.onboarding.faire.brandApiKeyRequiredBeforeConnect || []
    : catalog?.onboarding.faire.oauthRequiredBeforeConnect || []
  const faireRequiredSetupChecklist = faireRequiredSetupSteps
    .join(' → ') || 'From the Faire setup guide'
  const setupChecklistSteps = setupChecklistProvider === 'shopify'
    ? catalog?.onboarding.shopify.requiredBeforeConnect || []
    : setupChecklistProvider === 'faire'
      ? faireRequiredSetupSteps
      : []
  const setupPermissionGuidance = resolveCommerceSetupPermissionGuidance({
    provider: setupChecklistProvider,
    shopifyScopes: SHOPIFY_DISTRIBUTED_OPERATIONS_SCOPES,
    faireAuthPath: faire.authPath,
    faireScopeProfile: faire.scopeProfile,
    faireScopeProfiles: catalog?.onboarding.faire.scopeProfiles || {
      connection_test: [],
      distributed_operations: [],
    },
  })
  const setupPermissionGuidanceKey = setupChecklistProvider === 'faire'
    ? `faire:${faire.authPath}:${faire.scopeProfile}`
    : setupChecklistProvider || ''
  const configuredAccounts = integrations.accounts.filter(
    (account) => account.configured,
  )
  const setupInProgressAccounts = integrations.accounts.filter(
    (account) => !account.configured,
  )
  const configuredProviders = COMMERCE_PROVIDER_OPTIONS
    .map(({ provider }) => provider)
    .filter((provider) => configuredAccounts.some(
      (account) => account.provider === provider,
    ))

  return (
    <Stack spacing={3}>
      <Box>
        <Stack
          direction={{ xs: 'column', sm: 'row' }}
          spacing={1.5}
          alignItems={{ sm: 'center' }}
          justifyContent="space-between"
        >
          <Stack direction="row" spacing={1} alignItems="center">
            <StorefrontRounded color="primary" />
            <Typography variant="h6">Sales channels</Typography>
          </Stack>
          <Button
            variant="contained"
            startIcon={<AddRounded />}
            onClick={() => setProviderCatalogOpen(true)}
            sx={actionButtonSx}
          >
            Add sales channel
          </Button>
        </Stack>
        <Typography color="text.secondary" sx={{ mt: 0.75, maxWidth: 900 }}>
          Connect and manage the commerce channels used for distributed order
          operations. Sales channels are separate from restaurant POS and
          accounting integrations such as Toast.
        </Typography>
      </Box>
      <Dialog
        open={setupChecklistProvider !== null}
        onClose={() => setSetupChecklistProvider(null)}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>
          {setupChecklistProvider === 'shopify'
            ? 'Shopify setup checklist'
            : faire.authPath === 'brand_api_key'
              ? 'Faire generated API-key setup'
              : 'Faire Custom App OAuth setup'}
        </DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary">
            Complete these provider-side steps in order, then return to ClawPilot to verify the connection.
          </Typography>
          <Stack component="ol" spacing={1} sx={{ mt: 1.5, mb: 0, pl: 2.5 }}>
            {setupChecklistSteps.map((step, index) => (
              <Typography component="li" key={step} variant="body2" sx={{ pl: 0.5 }}>
                <strong>Step {index + 1}.</strong> {step}
              </Typography>
            ))}
          </Stack>
          {setupPermissionGuidance ? (
            <Box
              sx={{
                mt: 2,
                border: 1,
                borderColor: 'divider',
                borderRadius: 1.5,
                p: 1.5,
              }}
            >
              <Stack
                direction={{ xs: 'column', sm: 'row' }}
                spacing={1}
                alignItems={{ sm: 'center' }}
                justifyContent="space-between"
              >
                <Typography variant="subtitle2">
                  {setupPermissionGuidance.heading}
                </Typography>
                {setupPermissionGuidance.copyable ? (
                  <Button
                    size="small"
                    startIcon={<ContentCopyRounded fontSize="small" />}
                    onClick={() => void copySetupChecklistScopes()}
                  >
                    {copiedSetupScopes === setupPermissionGuidanceKey
                      ? 'Copied'
                      : 'Copy scope list'}
                  </Button>
                ) : null}
              </Stack>
              <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 0.5 }}>
                {setupPermissionGuidance.description}
              </Typography>
              {setupPermissionGuidance.copyable
                && setupPermissionGuidance.scopes.length ? (
                  <TextField
                    inputRef={setupScopeInputRef}
                    fullWidth
                    multiline
                    minRows={2}
                    label="Comma-separated scope list"
                    value={setupPermissionGuidance.scopes.join(',')}
                    onFocus={(event) => event.currentTarget.select()}
                    slotProps={{ htmlInput: { readOnly: true } }}
                    helperText="Use Copy scope list, or select this field and press Command+C."
                    sx={{ mt: 1.25 }}
                  />
                ) : null}
              {setupPermissionGuidance.scopes.length ? (
                <Stack direction="row" gap={0.75} flexWrap="wrap" sx={{ mt: 1 }}>
                  {setupPermissionGuidance.scopes.map((scope) => (
                    <Chip
                      key={scope}
                      size="small"
                      label={`${setupChecklistProvider}: ${scope}`}
                    />
                  ))}
                </Stack>
              ) : null}
            </Box>
          ) : null}
          {setupChecklistProvider === 'shopify' && catalog ? (
            <Stack spacing={1.25} sx={{ mt: 2 }}>
              <Alert severity="warning">
                <Typography variant="subtitle2">
                  Separate restricted-scope approval · <code>read_all_orders</code>
                </Typography>
                <Typography variant="body2" sx={{ mt: 0.5 }}>
                  Adding the scope to the app version is not the approval step.
                  Request Shopify&apos;s separate permission before ClawPilot can
                  read order history outside Shopify&apos;s default window.
                </Typography>
                <Button
                  href={catalog.onboarding.shopify.restrictedOrderScopeApprovalUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  size="small"
                  endIcon={<OpenInNewRounded />}
                  sx={{ mt: 0.5 }}
                >
                  Shopify read-all-orders approval
                </Button>
              </Alert>
              <Alert severity="info">
                <Typography variant="subtitle2">
                  Protected customer-data approval · <code>read_customers</code>
                </Typography>
                <Typography variant="body2" sx={{ mt: 0.5 }}>
                  Confirm the app&apos;s protected customer-data access and any
                  identifying fields it needs. Shopify determines the required
                  review based on the app type, distribution, and store plan.
                </Typography>
                <Button
                  href={catalog.onboarding.shopify.protectedCustomerDataApprovalUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  size="small"
                  endIcon={<OpenInNewRounded />}
                  sx={{ mt: 0.5 }}
                >
                  Shopify protected-data requirements
                </Button>
              </Alert>
            </Stack>
          ) : null}
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2, flexWrap: 'wrap' }}>
          {setupChecklistProvider === 'shopify' && catalog ? (
            <>
              <Button
                href={catalog.onboarding.shopify.developerPortalUrl}
                target="_blank"
                rel="noopener noreferrer"
                endIcon={<OpenInNewRounded />}
              >
                Shopify dashboard
              </Button>
              <Button
                href={catalog.onboarding.shopify.setupGuideUrl}
                target="_blank"
                rel="noopener noreferrer"
                endIcon={<OpenInNewRounded />}
              >
                Setup guide
              </Button>
            </>
          ) : null}
          {setupChecklistProvider === 'faire' && catalog ? (
            <>
              <Button
                href={catalog.onboarding.faire.developerPortalUrl}
                target="_blank"
                rel="noopener noreferrer"
                endIcon={<OpenInNewRounded />}
              >
                Faire developer portal
              </Button>
              <Button
                href={faire.authPath === 'brand_api_key'
                  ? catalog.onboarding.faire.directTokenGuideUrl
                  : catalog.onboarding.faire.setupGuideUrl}
                target="_blank"
                rel="noopener noreferrer"
                endIcon={<OpenInNewRounded />}
              >
                {faire.authPath === 'brand_api_key'
                  ? 'API key guide'
                  : 'OAuth guide'}
              </Button>
            </>
          ) : null}
          <Button onClick={() => setSetupChecklistProvider(null)}>Close</Button>
        </DialogActions>
      </Dialog>
      <Dialog
        open={providerCatalogOpen}
        onClose={() => setProviderCatalogOpen(false)}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>Add sales channel</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Choose a provider to begin its existing connection journey. A
            connected provider stays managed below instead of opening another
            connection from this catalog.
          </Typography>
          {!canManage ? (
            <Alert severity="info" sx={{ mb: 2 }}>
              Manage-integration access is required to start or resume setup.
            </Alert>
          ) : null}
          <Stack spacing={1.5}>
            {COMMERCE_PROVIDER_OPTIONS.map(({ provider, description }) => {
              const providerConfigured = configuredAccounts.some(
                (account) => account.provider === provider,
              )
              const providerSetupInProgress = setupInProgressAccounts.some(
                (account) => account.provider === provider,
              )
              return (
                <Card key={provider} variant="outlined">
                  <CardContent>
                    <Stack
                      direction={{ xs: 'column', sm: 'row' }}
                      spacing={1.5}
                      justifyContent="space-between"
                      alignItems={{ sm: 'center' }}
                    >
                      <Box>
                        <Stack direction="row" spacing={1} alignItems="center">
                          <Typography fontWeight={700}>
                            {providerLabel(provider)}
                          </Typography>
                          <Chip
                            size="small"
                            color={providerConfigured
                              ? 'success'
                              : providerSetupInProgress
                                ? 'warning'
                                : 'default'}
                            label={providerConfigured
                              ? 'Connected'
                              : providerSetupInProgress
                                ? 'Setup in progress'
                                : 'Available'}
                          />
                        </Stack>
                        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                          {description}
                        </Typography>
                      </Box>
                      <Button
                        variant="outlined"
                        disabled={!canManage || providerConfigured}
                        onClick={() => {
                          setSelectedSetupProvider(provider)
                          setProviderCatalogOpen(false)
                          setSetupChecklistProvider(null)
                        }}
                      >
                        {providerConfigured
                          ? 'Connected'
                          : providerSetupInProgress
                            ? 'Resume setup'
                            : 'Set up'}
                      </Button>
                    </Stack>
                  </CardContent>
                </Card>
              )
            })}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setProviderCatalogOpen(false)}>Close</Button>
        </DialogActions>
      </Dialog>
      {error ? <Alert severity="error">{error}</Alert> : null}
      {providerWritesError ? (
        <Alert severity="warning">{providerWritesError}</Alert>
      ) : null}
      {notice ? <Alert severity="success">{notice}</Alert> : null}

      {setupInProgressAccounts.length ? (
        <Box>
          <Typography variant="subtitle1" fontWeight={700} sx={{ mb: 1 }}>
            Setup in progress
          </Typography>
          <Stack spacing={1.5}>
            {setupInProgressAccounts.map((account) => (
              <Card key={account.globalId} variant="outlined">
                <CardContent>
                  <Stack
                    direction={{ xs: 'column', sm: 'row' }}
                    spacing={1.5}
                    justifyContent="space-between"
                    alignItems={{ sm: 'center' }}
                  >
                    <Box>
                      <Typography fontWeight={700}>{account.displayName}</Typography>
                      <Typography variant="body2" color="text.secondary">
                        {providerLabel(account.provider)} · {account.environment}
                        {' · '}{account.verificationStatus === 'failed'
                          ? 'Connection needs attention'
                          : 'Connection not completed'}
                      </Typography>
                    </Box>
                    <Button
                      variant="outlined"
                      disabled={!canManage || pendingAction !== ''}
                      onClick={() => setSelectedSetupProvider(account.provider)}
                    >
                      Resume setup
                    </Button>
                  </Stack>
                </CardContent>
              </Card>
            ))}
          </Stack>
        </Box>
      ) : null}

      {selectedSetupProvider ? (
        <Stack spacing={2}>
          <Stack
            direction={{ xs: 'column', sm: 'row' }}
            spacing={1}
            justifyContent="space-between"
            alignItems={{ sm: 'center' }}
          >
            <Box>
              <Typography variant="subtitle1" fontWeight={700}>
                Set up {providerLabel(selectedSetupProvider)}
              </Typography>
              <Typography variant="body2" color="text.secondary">
                Complete this provider&apos;s connection journey, then manage the
                connected channel below.
              </Typography>
            </Box>
            <Button
              variant="text"
              onClick={() => {
                setSelectedSetupProvider(null)
                setSetupChecklistProvider(null)
              }}
            >
              Close setup
            </Button>
          </Stack>
          <Alert severity="info">
            These are user-owned custom integrations. Create the application in
            the provider portal first. {selectedSetupProvider === 'shopify'
              ? 'Shopify verifies the installed merchant-owned app credentials directly.'
              : 'For one Faire brand, generate the final API key in Faire Brand Portal, or use Custom App OAuth when Faire accepts that flow.'}
          </Alert>
          <Alert severity="warning">
            A verified connection authorizes automatic read-only product catalog
            synchronization with no second approval. ClawPilot queues work only
            when product-read access, the development runtime, and the Operations
            product target are eligible. Canonical order import, inventory mutation,
            fulfillment export, and provider writes remain separately controlled.
          </Alert>
          <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1fr)',
          gap: 2,
        }}
      >
        {selectedSetupProvider === 'shopify' ? (
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
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} flexWrap="wrap" useFlexGap>
                <Button
                  onClick={() => setSetupChecklistProvider('shopify')}
                  type="button"
                  variant="contained"
                  size="small"
                  startIcon={<IntegrationInstructionsRounded />}
                >
                  Open Shopify setup checklist
                </Button>
                {catalog?.onboarding.shopify.developerPortalUrl ? (
                  <Button
                    href={catalog?.onboarding.shopify.developerPortalUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    variant="text"
                    size="small"
                    endIcon={<OpenInNewRounded />}
                  >
                    Open Shopify Dev Dashboard
                  </Button>
                ) : null}
              </Stack>
              <IntegrationSetupJourney
                title="Before you connect · Shopify setup"
                description="Follow the provider steps in order. Expand this journey later to review the current nonsecret operating facts."
                defaultExpanded={false}
                steps={[
                  {
                    key: 'shopify-app',
                    label: 'Create, release, and install the app',
                    state: shopifyAccount?.configured ? 'complete' : 'current',
                    description:
                      'Create the API-only app in the Shopify Dev Dashboard, release the required scopes, and install it on a store in the same Shopify organization. The default app home is expected for this server-to-server flow; it is not a ClawPilot sign-in URL.',
                    facts: [
                      {
                        label: 'Required setup checklist',
                        value: shopifyRequiredSetupChecklist,
                      },
                      {
                        label: 'API-only app home',
                        value: catalog?.onboarding.shopify.defaultAppUrl
                          || 'Shopify default app home',
                        copyable: Boolean(
                          catalog?.onboarding.shopify.defaultAppUrl,
                        ),
                      },
                      {
                        label: 'Admin API version',
                        value: catalog?.onboarding.shopify.apiVersion
                          || 'Server configured',
                      },
                      {
                        label: 'Store class',
                        value: shopifyAccount?.environment
                          || shopify.environment,
                      },
                      {
                        label: 'Provider scopes',
                        value: catalog?.providers.shopify.providerScopes
                          ? `${catalog.providers.shopify.providerScopes.length} provider scopes`
                          : 'Requested by ClawPilot',
                      },
                      {
                        label: 'Provider scope detail',
                        value: catalog?.providers.shopify.providerScopes?.join(' · ')
                          || 'Scope details unavailable in this environment',
                      },
                      {
                        label: 'Restricted scope approval',
                        value: 'read_all_orders · separate Shopify permission',
                      },
                      {
                        label: 'Protected customer data',
                        value: 'read_customers · confirm Shopify approval requirements',
                      },
                    ],
                    action: catalog ? (
                      <Stack
                        direction={{ xs: 'column', sm: 'row' }}
                        gap={1}
                        flexWrap="wrap"
                        useFlexGap
                      >
                        <Button
                          onClick={() => setSetupChecklistProvider('shopify')}
                          type="button"
                          variant="outlined"
                          size="small"
                        >
                          Open setup checklist
                        </Button>
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
                        <Button
                          href={catalog.onboarding.shopify.restrictedOrderScopeApprovalUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          variant="text"
                          size="small"
                          endIcon={<OpenInNewRounded />}
                        >
                          read_all_orders approval
                        </Button>
                        <Button
                          href={catalog.onboarding.shopify.protectedCustomerDataApprovalUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          variant="text"
                          size="small"
                          endIcon={<OpenInNewRounded />}
                        >
                          Protected customer data
                        </Button>
                      </Stack>
                    ) : undefined,
                  },
                  {
                    key: 'shopify-connect',
                    label: 'Verify and save the store connection',
                    state: shopifyConnectionState,
                    description:
                      'Enter the permanent myshopify.com domain and the installed app client credentials below. ClawPilot exchanges them server-side, verifies shop identity and scopes, and stores only encrypted credentials. Shopify Admin-created legacy apps and Admin API access tokens are not supported.',
                    facts: [
                      {
                        label: 'Shop domain',
                        value: shopifyDomain || 'Not entered',
                        copyable: Boolean(shopifyDomain),
                      },
                      {
                        label: 'ClawPilot integration ID',
                        value: shopifyAccount?.globalId || 'Not allocated',
                        copyable: Boolean(shopifyAccount?.globalId),
                      },
                      {
                        label: 'Stored credential',
                        value: maskedCommerceCredential(shopifyAccount),
                      },
                      {
                        label: 'API verified',
                        value: setupTimestamp(shopifyAccount?.verifiedAt),
                      },
                    ],
                  },
                  {
                    key: 'shopify-preview',
                    label: 'Inspect read-only order fit',
                    state: shopifyPreviewState,
                    description:
                      'After read_orders is granted, fetch the held development preview to see mapping and package-readiness gaps before any canonical import is designed.',
                    facts: [
                      {
                        label: 'Granted scopes',
                        value: shopifyGrantedScopes.length
                          ? `${shopifyGrantedScopes.length} provider-reported`
                          : 'Not verified',
                      },
                      {
                        label: 'Held preview',
                        value: shopifyPreview?.run
                          ? `${shopifyPreview.run.ordersStaged} orders · expires ${setupTimestamp(
                            shopifyPreview.run.expiresAt,
                          )}`
                          : 'Not loaded',
                      },
                      {
                        label: 'Canonical orders created',
                        value: String(
                          shopifyPreview?.run?.canonicalOrdersCreated || 0,
                        ),
                      },
                      {
                        label: 'Shopify writes',
                        value: String(shopifyPreview?.run?.shopifyWrites || 0),
                      },
                    ],
                  },
                  {
                    key: 'shopify-receipts',
                    label: 'Signed receipt setup',
                    state: shopifyReceiptState,
                    optional: true,
                    description:
                      'Signed receipt intake is optional and separate from the API connection. Queueing requires the receipt-proof scopes and one valid signed allowed-topic delivery. Held receipts remain retained as evidence; order/customer processing and domain workers remain off.',
                    facts: [
                      {
                        label: 'New signed receipts',
                        value: shopifyAccount?.receiptIntakeEnabled
                          ? 'Queued for intake'
                          : 'Held as evidence',
                      },
                      {
                        label: 'Webhook secret',
                        value: shopifyAccount
                          ? humanize(
                            shopifyAccount.webhookVerificationStatus,
                          )
                          : 'Not verified',
                      },
                      {
                        label: 'Signed receipts retained',
                        value: String(
                          shopifyAccount?.evidence.webhookReceipts || 0,
                        ),
                      },
                      {
                        label: 'Order-domain workers',
                        value: catalog?.activationBoundary.domainWorkersActivated
                          ? 'Activated'
                          : 'Not activated',
                      },
                    ],
                  },
                ]}
              />
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
              <FormControl sx={fieldSx}>
                <InputLabel id="shopify-order-history-label">
                  Initial order history
                </InputLabel>
                <Select
                  labelId="shopify-order-history-label"
                  label="Initial order history"
                  value={shopifyAccount?.orderHistoryPolicy?.mode
                    && shopifyAccount.orderHistoryPolicy.mode !== 'provider_all'
                    ? shopifyAccount.orderHistoryPolicy.mode
                    : shopify.orderHistoryMode}
                  disabled={Boolean(shopifyAccount?.orderHistoryPolicy)}
                  onChange={(event) => setShopify((current) => ({
                    ...current,
                    orderHistoryMode: event.target
                      .value as ShopifyForm['orderHistoryMode'],
                  }))}
                >
                  <MenuItem value="new_orders_only">
                    Only orders created after connection
                  </MenuItem>
                  <MenuItem value="last_7_days">Prior 7 days</MenuItem>
                  <MenuItem value="last_30_days">Prior 30 days</MenuItem>
                  <MenuItem value="last_60_days">Prior 60 days</MenuItem>
                </Select>
              </FormControl>
              <Typography variant="caption" color="text.secondary">
                This cutoff is frozen on the first connection and remains the
                same if credentials are reconnected. Start history and Refresh
                will not first import unknown orders created before it;
                already-retained orders can still receive provider updates.
              </Typography>
              <TextField
                required
                label="Shopify .myshopify.com domain"
                value={shopify.shopDomain}
                onChange={(event) => setShopify((current) => ({
                  ...current,
                  shopDomain: event.target.value,
                }))}
                placeholder="store-name.myshopify.com"
                helperText="A store-owned alias is accepted; ClawPilot verifies and stores Shopify's permanent canonical domain."
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
        ) : null}

        {selectedSetupProvider === 'faire' ? (
          <Card variant="outlined">
          <CardContent>
            <Stack component="form" spacing={2} onSubmit={connectFaire}>
              <Box>
                <Typography variant="subtitle1" fontWeight={700}>
                  Faire custom integration
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  Connect one production Faire brand with the generated API
                  key from Brand Portal, or use Custom App OAuth when Faire
                  accepts that application&apos;s authorization flow.
                </Typography>
              </Box>
              <FormControl sx={fieldSx}>
                <InputLabel id="faire-auth-path-label">
                  Connection method
                </InputLabel>
                <Select
                  labelId="faire-auth-path-label"
                  label="Connection method"
                  value={faire.authPath}
                  onChange={(event) => {
                    const authPath = event.target.value as FaireForm['authPath']
                    setFaire((current) => ({
                      ...current,
                      authPath,
                      apiKey: authPath === 'oauth' ? '' : current.apiKey,
                      applicationSecret:
                        authPath === 'brand_api_key'
                          ? ''
                          : current.applicationSecret,
                      confirmLiveAccess: false,
                    }))
                  }}
                >
                  <MenuItem value="brand_api_key">
                    Generated API key — single brand (recommended)
                  </MenuItem>
                  <MenuItem value="oauth">
                    Custom App OAuth — if enabled by Faire
                  </MenuItem>
                </Select>
              </FormControl>
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} flexWrap="wrap" useFlexGap>
                <Button
                  onClick={() => setSetupChecklistProvider('faire')}
                  type="button"
                  variant="contained"
                  size="small"
                  startIcon={<IntegrationInstructionsRounded />}
                >
                  Open Faire setup checklist
                </Button>
                {catalog?.onboarding.faire.developerPortalUrl ? (
                  <Button
                    href={catalog?.onboarding.faire.developerPortalUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    variant="text"
                    size="small"
                    endIcon={<OpenInNewRounded />}
                  >
                    Open Faire developer portal
                  </Button>
                ) : null}
              </Stack>
              <IntegrationSetupJourney
                title="Before you connect · Faire setup"
                description="Follow the provider-side path that matches the credential Faire issued. The generated brand API key and OAuth application credentials are different values."
                defaultExpanded={false}
                steps={[
                  {
                    key: 'faire-path',
                    label: 'Choose the Faire connection path',
                    state: faireAccount?.configured ? 'complete' : 'current',
                    description: faire.authPath === 'brand_api_key'
                      ? 'Use this path when Faire Brand Portal shows Email partner and Generate API key. The generated final API key is connectable below; the Application ID or APA application token is not the API key.'
                      : 'Use this path only when Faire accepts the Custom App OAuth authorization request made with the Application ID and Secret ID.',
                    facts: [
                      {
                        label: 'ClawPilot auth mode',
                        value: faireAccount?.authMode
                          || (
                            faire.authPath === 'brand_api_key'
                              ? 'Generated brand API key'
                              : 'Faire Custom App OAuth'
                          ),
                      },
                      {
                        label: 'Provider environment',
                        value: 'Faire production · no public sandbox',
                      },
                    ],
                    action: catalog ? (
                      <Stack
                        direction={{ xs: 'column', sm: 'row' }}
                        gap={1}
                        flexWrap="wrap"
                        useFlexGap
                      >
                        <Button
                          onClick={() => setSetupChecklistProvider('faire')}
                          type="button"
                          variant="outlined"
                          size="small"
                        >
                          Open setup checklist
                        </Button>
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
                          Custom App OAuth guide
                        </Button>
                        <Button
                          href={catalog.onboarding.faire.directTokenGuideUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          variant="text"
                          size="small"
                          endIcon={<OpenInNewRounded />}
                        >
                          Generate a single-brand API key
                        </Button>
                      </Stack>
                    ) : undefined,
                  },
                  {
                    key: 'faire-app',
                    label: faire.authPath === 'brand_api_key'
                      ? 'Generate the brand API key'
                      : 'Configure the Custom App',
                    state: faireAccount?.configured ? 'complete' : 'current',
                    description: faire.authPath === 'brand_api_key'
                      ? 'In Faire Brand Portal, open the unpublished integration for your Custom App and choose Generate API key. Copy the generated key once and keep it separate from the Application ID and Secret ID.'
                      : 'Copy the Application ID and Secret ID from App Details and Settings. Faire proves OAuth eligibility only by accepting the authorization request; there is no documented preliminary server ping.',
                    facts: faire.authPath === 'brand_api_key' ? [
                      {
                        label: 'Provider flow',
                        value: 'Unpublished integration · single brand',
                      },
                      {
                        label: 'Credential accepted below',
                        value: 'Generated API key only',
                      },
                      {
                        label: 'Identity verification',
                        value: 'One read-only brand-profile request',
                      },
                      {
                        label: 'OAuth permission list',
                        value: 'Not applicable · access is issued with the generated key',
                      },
                      {
                        label: 'Provider support',
                        value: catalog
                          ? catalog.onboarding.faire.supportContact
                          : 'Faire Developer Support',
                      },
                      {
                        label: 'Required setup checklist',
                        value: faireRequiredSetupChecklist,
                      },
                    ] : [
                      {
                        label: 'ClawPilot OAuth callback URL',
                        value: catalog?.onboarding.faire.callbackUrl
                          || 'Load the hosted callback before continuing',
                        copyable: Boolean(
                          catalog?.onboarding.faire.callbackUrl,
                        ),
                      },
                      {
                        label: 'Permission profile',
                        value: faire.scopeProfile === 'connection_test'
                          ? 'Connection test · READ_BRAND'
                          : 'Distributed operations · 10 permissions',
                      },
                      {
                        label: 'Minimum identity probe',
                        value: catalog?.onboarding.faire.minimumProbeScope
                          || 'READ_BRAND',
                      },
                      {
                        label: 'Exact OAuth permissions',
                        value: catalog?.onboarding.faire.scopeProfiles[
                          faire.scopeProfile
                        ].join(' · ') || 'No permissions selected',
                      },
                      {
                        label: 'Provider support',
                        value: catalog
                          ? catalog.onboarding.faire.supportContact
                          : 'Faire Developer Support',
                      },
                      {
                        label: 'Required setup checklist',
                        value: faireRequiredSetupChecklist,
                      },
                    ],
                  },
                  {
                    key: 'faire-authorize',
                    label: 'Verify the intended brand',
                    state: faireConnectionState,
                    description: faire.authPath === 'brand_api_key'
                      ? 'Paste the generated API key below. ClawPilot sends one read-only request to Faire’s brand-profile endpoint, verifies the immutable brand identity, and encrypts the key. That verified connection authorizes automatic product catalog sync; eligible work queues without a second approval.'
                      : 'Enter the application credentials below, continue to Faire, approve the intended brand, and return through the one-use callback. ClawPilot exchanges the code server-side and verifies the brand profile before encrypted persistence.',
                    facts: [
                      {
                        label: 'Faire brand ID',
                        value: faireAccount?.externalAccountId || 'Not verified',
                        copyable: Boolean(faireAccount?.externalAccountId),
                      },
                      {
                        label: 'ClawPilot integration ID',
                        value: faireAccount?.globalId || 'Not allocated',
                        copyable: Boolean(faireAccount?.globalId),
                      },
                      {
                        label: 'Stored credential',
                        value: maskedCommerceCredential(faireAccount),
                      },
                      {
                        label: 'API verified',
                        value: setupTimestamp(faireAccount?.verifiedAt),
                      },
                    ],
                  },
                  {
                    key: 'faire-sync',
                    label: 'Authorize product catalog synchronization',
                    state: faireAccount?.verificationStatus === 'verified'
                      ? 'complete'
                      : 'pending',
                    optional: true,
                    description:
                      'Verification authorizes automatic read-only product catalog sync. ClawPilot initializes the resumed policy and queues work when product-read access, the development runtime, and the Operations product target are eligible. Order, inventory, shipment, and provider-write workers remain inactive.',
                    facts: [
                      {
                        label: 'Product sync authorization',
                        value: faireAccount?.verificationStatus === 'verified'
                          ? 'Authorized · eligibility checked automatically'
                          : 'Waiting for connection',
                      },
                      {
                        label: 'Provider attempts',
                        value: String(
                          faireAccount?.evidence.providerAttempts || 0,
                        ),
                      },
                      {
                        label: 'Domain workers',
                        value: catalog?.activationBoundary.domainWorkersActivated
                          ? 'Activated'
                          : 'Not activated',
                      },
                    ],
                  },
                ]}
              />
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
              <FormControl sx={fieldSx}>
                <InputLabel id="faire-order-history-label">
                  Initial order history
                </InputLabel>
                <Select
                  labelId="faire-order-history-label"
                  label="Initial order history"
                  value={faireAccount?.orderHistoryPolicy?.mode
                    || faire.orderHistoryMode}
                  disabled={Boolean(faireAccount?.orderHistoryPolicy)}
                  onChange={(event) => setFaire((current) => ({
                    ...current,
                    orderHistoryMode: event.target
                      .value as FaireForm['orderHistoryMode'],
                  }))}
                >
                  <MenuItem value="new_orders_only">
                    Only orders created after connection
                  </MenuItem>
                  <MenuItem value="last_7_days">Prior 7 days</MenuItem>
                  <MenuItem value="last_30_days">Prior 30 days</MenuItem>
                  <MenuItem value="last_60_days">Prior 60 days</MenuItem>
                  <MenuItem value="provider_all">
                    All provider-available history
                  </MenuItem>
                </Select>
              </FormControl>
              <Typography variant="caption" color="text.secondary">
                This cutoff is frozen on the first connection and remains the
                same if credentials are reconnected. Start history and Refresh
                will not first import unknown orders created before it;
                already-retained orders can still receive provider updates.
              </Typography>
              {faire.authPath === 'brand_api_key' ? (
                <TextField
                  required
                  type="password"
                  label="Faire generated API key"
                  value={faire.apiKey}
                  onChange={(event) => setFaire((current) => ({
                    ...current,
                    apiKey: event.target.value,
                  }))}
                  placeholder="Paste the final key generated in Brand Portal"
                  helperText="Use the final API key from Generate API key. Do not paste the Application ID, APA application token, or Secret ID. ClawPilot encrypts this key and never reveals it after save."
                  autoComplete="new-password"
                  inputProps={{ maxLength: 4096 }}
                  sx={fieldSx}
                />
              ) : (
                <>
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
                        scopeProfile:
                          event.target.value as FaireForm['scopeProfile'],
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
                </>
              )}
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
                label={faire.authPath === 'brand_api_key'
                  ? 'I authorize one read-only Faire brand-profile request to verify this generated API key. The verification call writes no Faire data; after connection, eligible product-only catalog sync may read automatically.'
                  : 'I authorize the Faire redirect, server-side code exchange, and live production brand-profile verification.'}
              />
              <Button
                type="submit"
                variant="contained"
                startIcon={<LinkRounded />}
                disabled={
                  pendingAction !== ''
                  || !faire.confirmLiveAccess
                  || (
                    faire.authPath === 'brand_api_key'
                      ? !faire.apiKey
                      : !faire.applicationId || !faire.applicationSecret
                  )
                }
                sx={actionButtonSx}
              >
                {pendingAction === 'connect-faire-api-key'
                  ? 'Verifying API key…'
                  : pendingAction === 'start-faire-oauth'
                    ? 'Preparing Faire…'
                    : faire.authPath === 'brand_api_key'
                      ? 'Connect generated API key'
                      : 'Continue to Faire'}
              </Button>
            </Stack>
          </CardContent>
          </Card>
        ) : null}
          </Box>
        </Stack>
      ) : null}

      <Box>
        <Typography variant="subtitle1" fontWeight={700} sx={{ mb: 1 }}>
          Connected sales channels
        </Typography>
        {configuredAccounts.length === 0 ? (
          <Alert severity="info">
            No sales channels are connected yet. Choose Add sales channel to
            start a provider setup.
          </Alert>
        ) : (
          <Stack spacing={2}>
            {configuredAccounts.map((account) => {
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
              const missingReceiptProofScopes = account.provider === 'shopify'
                ? valueStrings(catalog?.onboarding.shopify.receiptProofScopes)
                  .filter((scope) => !hasEffectiveShopifyScope(
                    grantedScopes,
                    scope,
                  ))
                : []
              const webhookSubscriptionGroups = account.provider === 'shopify'
                ? [
                    {
                      key: 'scopeWebhookSubscriptions',
                      label: 'Access-scope safety',
                    },
                    {
                      key: 'webhookSubscriptions',
                      label: 'Inventory freshness',
                    },
                    {
                      key: 'catalogWebhookSubscriptions',
                      label: 'Product catalog',
                    },
                  ].map((group) => ({
                    ...group,
                    ...webhookSubscriptionReadiness(
                      account.configuration,
                      group.key,
                    ),
                  }))
                : []
              const missingWebhookSubscriptionGroups =
                webhookSubscriptionGroups
                  .filter((group) => !group.ready)
                  .map((group) => group.label)
              const orderWebhookReadiness = account.provider === 'shopify'
                ? orderWebhookSubscriptionReadiness(account)
                : null
              const orderWebhookConfirmation = account.provider === 'shopify'
                ? `RECONCILE 7 ORDER WEBHOOKS FOR ${account.globalId}`
                : ''
              const orderWebhookDraft = orderWebhookDrafts[account.globalId]
                || { confirmation: '', idempotencyKey: null }
              const orderWebhookPending = pendingAction
                === `reconcile-order-webhooks:${account.globalId}`
              const webhookReceiptHealth =
                account.evidence.webhookReceiptHealth
              const preview = shopifyPreviews[account.globalId]
              const revealed = revealedCredential?.accountGlobalId
                === account.globalId
                ? revealedCredential
                : null
              const revealedIdentifier = account.provider === 'shopify'
                ? revealed?.clientId
                : revealed?.applicationId
              const revealedSecret = account.provider === 'shopify'
                ? revealed?.clientSecret
                : revealed?.applicationSecret
              const revealedIdentifierLabel = account.provider === 'shopify'
                ? 'Shopify client ID'
                : 'Faire Application ID'
              const revealedSecretLabel = account.provider === 'shopify'
                ? 'Shopify client secret'
                : 'Faire Secret ID'
              const canPreviewShopifyOrders = account.provider === 'shopify'
                && account.environment === 'sandbox'
                && account.configured
                && account.verificationStatus === 'verified'
                && grantedScopes.includes('read_orders')
              const activationBlockers = account.provider === 'shopify'
                && !account.receiptIntakeEnabled
                ? [
                    ...(!canActivate
                      ? ['Owner or operations-administrator access is required.']
                      : []),
                    ...(missingReceiptProofScopes.length
                      ? [`Add and approve these app scopes: ${missingReceiptProofScopes.join(', ')}.`]
                      : []),
                    ...(account.webhookVerificationStatus !== 'verified'
                      ? ['Send one valid signed allowed-topic delivery to the callback URL.']
                      : []),
                    ...(missingWebhookSubscriptionGroups.length
                      ? [`Register and verify these webhook groups: ${missingWebhookSubscriptionGroups.join(', ')}.`]
                      : []),
                  ]
                : []
              const notificationPolicy = account.fulfillmentNotificationPolicy
              const notificationDraft = notificationPolicyDrafts[account.globalId]
              const notificationDefault = notificationDraft
                ? notificationDraft.notifyCustomerDefault
                : notificationPolicy.notifyCustomerDefault === true
              const notificationReason = notificationDraft?.reason || ''
              const notificationConfirmation = notificationDraft?.confirmed === true
              const notificationChanged = Boolean(
                notificationDraft
                && notificationDefault
                  !== (notificationPolicy.notifyCustomerDefault === true),
              )
              const notificationPending = pendingAction
                === `fulfillment-notifications:${account.globalId}`
              const fulfillmentReadiness =
                account.fulfillmentWriteReadiness
              const providerWriteControl =
                providerWriteControls[account.globalId]
              const providerWritePending = pendingAction
                === `provider-writes:${account.globalId}`
              const providerWriteStatusLabel = !providerWriteControl
                ? 'Loading'
                : providerWriteControl.providerWritesEffective
                    ? providerWriteControl.fulfillmentWritesEffective
                      ? 'On'
                      : 'On · Order editing only'
                    : providerWriteControl.requestedMode === 'on'
                      ? 'Revalidation required'
                      : providerWriteControl.commandEnforcement
                          === 'not_connected'
                        ? 'Not connected'
                        : 'Off'
              const providerWriteDetailBase = !providerWriteControl
                ? 'Loading this connection control.'
                : providerWriteControl.bindingStatus
                  === 'revalidation_required'
                  ? providerWriteControl.blocker?.message
                    || 'The saved credential or scope binding is stale.'
                  : providerWriteControl.commandEnforcement === 'not_connected'
                    ? 'Provider write commands are not connected for this provider yet. Imports and refresh remain available.'
                    : providerWriteControl.commandEnforcement === 'faire_fulfillment'
                      ? 'Controls Faire fulfillment and tracking updates for this connection. Imports and refresh remain available while Off.'
                      : providerWriteControl.commandEnforcement === 'shopify_fulfillment'
                        ? 'Controls Shopify fulfillment and tracking updates for this connection. Imports and refresh remain available while Off.'
                        : providerWriteControl.commandEnforcement === 'shopify_order_management_and_fulfillment'
                          ? 'Controls Shopify order changes, fulfillment, and tracking updates. Imports and refresh remain available while Off.'
                          : 'Controls Shopify order changes for this connection. Imports and refresh remain available while Off.'
              const providerWriteDetail = providerWriteControl
                ? `${providerWriteDetailBase} Turning Off blocks new attempts; an already authorized in-flight attempt may finish.`
                : providerWriteDetailBase
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
                          {account.orderHistoryPolicy ? (
                            <Typography variant="caption" color="text.secondary">
                              Order history: {ORDER_HISTORY_LABELS[
                                account.orderHistoryPolicy.mode
                              ]} · frozen {setupTimestamp(
                                account.orderHistoryPolicy.frozenAt,
                              )}
                              {account.orderHistoryPolicy.ingestionFloor
                                ? ` · floor ${setupTimestamp(
                                  account.orderHistoryPolicy.ingestionFloor,
                                )}`
                                : ''}
                            </Typography>
                          ) : null}
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
                            color={
                              account.provider === 'shopify'
                                ? account.receiptIntakeEnabled
                                  ? 'success'
                                  : 'default'
                                : account.verificationStatus === 'verified'
                                  ? 'success'
                                  : 'default'
                            }
                            label={account.provider === 'shopify'
                              ? `Signed receipts · ${
                                  account.receiptIntakeEnabled
                                    ? 'queued'
                                    : 'held'
                                }`
                              : (
                                  account.verificationStatus === 'verified'
                                    ? 'Product sync authorized'
                                    : 'Product sync needs attention'
                                )}
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
                          ? 'This connection authorizes automatic product catalog sync with no second approval. The signed receipt control below only chooses whether new verified webhook receipts are queued for intake or retained as held evidence. It does not change the API credential, product-catalog authorization, Operations activation, or provider-write authority.'
                          : 'This connection authorizes automatic product catalog sync with no second approval. Eligibility and worker status appear below; the control only pauses or resumes sync. Orders and inventory remain separate.'}
                      </Alert>

                      <Box
                        sx={{
                          border: '1px solid',
                          borderColor: 'divider',
                          borderRadius: 1.5,
                          px: 1.5,
                          py: 1,
                        }}
                      >
                        <Stack
                          direction={{ xs: 'column', sm: 'row' }}
                          alignItems={{ xs: 'stretch', sm: 'center' }}
                          justifyContent="space-between"
                          spacing={1}
                        >
                          <Box>
                            <Stack direction="row" spacing={1} alignItems="center">
                              <Typography variant="subtitle2" fontWeight={700}>
                                Provider writes
                              </Typography>
                              <Chip
                                size="small"
                                color={providerWriteControl?.bindingStatus
                                  === 'revalidation_required'
                                  ? 'warning'
                                  : 'default'}
                                label={providerWriteStatusLabel}
                              />
                            </Stack>
                            <Typography
                              variant="caption"
                              color="text.secondary"
                              display="block"
                              sx={{ mt: 0.25 }}
                            >
                              {providerWriteDetail}
                            </Typography>
                          </Box>
                          {providerWriteControl
                            && (
                              providerWriteControl.requestedMode === 'on'
                              || providerWriteControl.commandEnforcement
                                !== 'not_connected'
                            ) ? (
                              <Switch
                                checked={providerWriteControl.requestedMode
                                  === 'on'}
                                disabled={providerWritePending
                                  || pendingAction !== ''
                                  || (providerWriteControl.requestedMode
                                      !== 'on'
                                    && (!canActivate
                                      || !providerWriteControl.enableAvailable))}
                                onChange={(_, checked) => {
                                  void setProviderWrites(
                                    account,
                                    checked ? 'on' : 'off',
                                  )
                                }}
                                slotProps={{
                                  input: {
                                    'aria-label': `Provider writes for ${account.displayName}`,
                                  },
                                }}
                              />
                            ) : null}
                        </Stack>
                        {providerWriteControl?.blocker
                          && !providerWriteControl.providerWritesEffective ? (
                            <Typography
                              variant="caption"
                              color="text.secondary"
                              display="block"
                              sx={{ mt: 0.5 }}
                            >
                              {providerWriteControl.blocker.message}
                            </Typography>
                          ) : null}
                        {providerWriteControl
                          && !providerWriteControl.fulfillmentWritesEffective
                          && providerWriteControl.fulfillmentWritesBlockedReason
                          && (
                            providerWriteControl.providerWritesEffective
                            || providerWriteControl.requestedMode === 'on'
                          ) ? (
                            <Typography
                              variant="caption"
                              color="warning.main"
                              display="block"
                              sx={{ mt: 0.5 }}
                            >
                              {providerWriteControl.fulfillmentWritesBlockedReason}
                            </Typography>
                          ) : null}
                        {providerWritePending ? (
                          <Typography variant="caption" color="text.secondary">
                            Saving…
                          </Typography>
                        ) : null}
                      </Box>

                      {account.provider === 'shopify'
                        && webhookReceiptHealth
                        && webhookReceiptHealth.actionable > 0 ? (
                          <Alert severity="warning">
                            <Typography variant="body2" fontWeight={700}>
                              Current Shopify webhook receipts need attention
                            </Typography>
                            <Typography variant="body2">
                              {webhookReceiptHealth.actionable} actionable receipt{
                                webhookReceiptHealth.actionable === 1 ? '' : 's'
                              }: {webhookReceiptHealth.staleQueued} stale queued,{' '}
                              {webhookReceiptHealth.staleProcessing} stale processing,{' '}
                              {webhookReceiptHealth.failed} failed,{' '}
                              {webhookReceiptHealth.deadLetter} dead-letter, and{' '}
                              {webhookReceiptHealth.heldProductDeletes} replayable held product deletion{
                                webhookReceiptHealth.heldProductDeletes === 1 ? '' : 's'
                              }.
                            </Typography>
                            <Typography variant="caption" display="block" sx={{ mt: 0.5 }}>
                              This alert covers only the current credential generation.
                              Ordinary held inventory/catalog history and prior generations remain
                              informational evidence below.
                            </Typography>
                          </Alert>
                        ) : null}

                      {intakeAvailable ? (
                        <CommerceIntakeWorkflow
                          accountGlobalId={account.globalId}
                          provider={account.provider}
                          displayName={account.displayName}
                          canManage={canManage}
                          canActivate={canActivate}
                          connectionReady={
                            account.configured
                            && account.verificationStatus === 'verified'
                          }
                        />
                      ) : null}

                      <Box>
                        <Typography variant="subtitle2" fontWeight={700}>
                          Fulfillment &amp; tracking
                        </Typography>
                        {account.provider === 'shopify' ? (
                          notificationPolicy.mode === 'clawpilot_explicit' ? (
                            <Stack spacing={1.25} sx={{ mt: 1 }}>
                              <Alert severity={notificationDefault ? 'warning' : 'info'}>
                                Customer notification requests use a ClawPilot default for this
                                Shopify connection.
                                The resolved choice is frozen into each fulfillment export, so
                                changing this setting never changes the request captured for prior
                                shipments.
                                Operators may record a reasoned per-order exception when confirming
                                a future shipment.
                              </Alert>
                              <FormControlLabel
                                control={(
                                  <Checkbox
                                    checked={notificationDefault}
                                    disabled={!canActivate || notificationPending}
                                    onChange={(event) => {
                                      const nextDefault = event.target.checked
                                      setNotificationPolicyDrafts((current) => ({
                                        ...current,
                                        [account.globalId]: {
                                          notifyCustomerDefault: nextDefault,
                                          reason: nextDefault
                                            ? 'Enable Shopify customer notification requests for future fulfillment confirmations'
                                            : 'Disable Shopify customer notification requests for future fulfillment confirmations',
                                          confirmed: false,
                                        },
                                      }))
                                    }}
                                  />
                                )}
                                label={notificationDefault
                                  ? 'Request customer notifications for future Shopify fulfillments'
                                  : 'Do not request customer notifications for future Shopify fulfillments'}
                              />
                              <TextField
                                label="Policy change reason"
                                value={notificationReason}
                                disabled={!canActivate || notificationPending || !notificationChanged}
                                onChange={(event) => {
                                  setNotificationPolicyDrafts((current) => ({
                                    ...current,
                                    [account.globalId]: {
                                      notifyCustomerDefault: notificationDefault,
                                      reason: event.target.value,
                                      confirmed: notificationConfirmation,
                                    },
                                  }))
                                }}
                                inputProps={{ maxLength: 500 }}
                                helperText={`Revision ${notificationPolicy.revision} · ${
                                  notificationReason.trim().length
                                }/500 · audited`}
                              />
                              {notificationDefault && notificationChanged ? (
                                <FormControlLabel
                                  control={(
                                    <Checkbox
                                      checked={notificationConfirmation}
                                      disabled={!canActivate || notificationPending}
                                      onChange={(event) => {
                                        setNotificationPolicyDrafts((current) => ({
                                          ...current,
                                          [account.globalId]: {
                                            notifyCustomerDefault: notificationDefault,
                                            reason: notificationReason,
                                            confirmed: event.target.checked,
                                          },
                                        }))
                                      }}
                                    />
                                  )}
                                  label="I confirm future Shopify fulfillment confirmations may email customers"
                                />
                              ) : null}
                              <Stack direction="row" spacing={1} alignItems="center">
                                <Button
                                  size="small"
                                  variant="outlined"
                                  disabled={
                                    !canActivate
                                    || notificationPending
                                    || !notificationChanged
                                    || notificationReason.trim().length < 10
                                    || (notificationDefault && !notificationConfirmation)
                                  }
                                  startIcon={notificationPending
                                    ? <CircularProgress size={16} />
                                    : undefined}
                                  onClick={() => {
                                    void saveFulfillmentNotificationPolicy(account)
                                  }}
                                >
                                  {notificationPending ? 'Saving' : 'Save notification default'}
                                </Button>
                                {!canActivate ? (
                                  <Typography variant="caption" color="text.secondary">
                                    Owner or operations-administrator access is required.
                                  </Typography>
                                ) : null}
                              </Stack>
                            </Stack>
                          ) : (
                            <Alert severity="info" sx={{ mt: 1 }}>
                              Shopify manages customer notifications for this connection;
                              ClawPilot exposes no notification override.
                            </Alert>
                          )
                        ) : account.provider === 'faire' && fulfillmentReadiness ? (
                            <Alert
                              severity={fulfillmentReadiness.ready
                                ? 'success'
                                : 'warning'}
                              sx={{ mt: 1 }}
                            >
                              <Typography variant="body2" fontWeight={700}>
                                Faire fulfillment writes · {fulfillmentReadiness.ready
                                  ? 'ready'
                                  : 'blocked'}
                              </Typography>
                              <Typography variant="body2">
                                {fulfillmentReadiness.blockedBy?.message
                                  || 'Exact OAuth, scope evidence, credential binding, and Active capability claims are current.'}
                              </Typography>
                              <Typography variant="caption" display="block" sx={{ mt: 0.5 }}>
                                Auth: {fulfillmentReadiness.authMode || 'not configured'}
                                {' · '}binding: {fulfillmentReadiness.credentialBinding.current
                                  ? 'current'
                                  : 'not current'}
                                {' · '}provider scope evidence: {
                                  fulfillmentReadiness.providerScopeEvidence.current
                                    ? 'current'
                                    : fulfillmentReadiness.providerScopeEvidence
                                      .recordedForCredentialGeneration
                                      ? 'recorded but not current'
                                      : 'not recorded'
                                }
                              </Typography>
                              <Typography variant="caption" display="block">
                                Required OAuth scopes: {
                                  fulfillmentReadiness.requiredScopes.join(', ')
                                }
                              </Typography>
                              <Typography variant="caption" display="block">
                                Active claims: {fulfillmentReadiness.activeCapabilities
                                  .missing.length
                                  ? `missing ${fulfillmentReadiness.activeCapabilities.missing.join(', ')}`
                                  : 'current'} · diagnostic provider writes: 0
                              </Typography>
                              <Typography variant="caption" display="block" sx={{ mt: 0.5 }}>
                                Faire may send a processing email when a NEW order is accepted,
                                and submitting shipment tracking triggers Faire&apos;s shipment email.
                                Use a controlled recipient for test orders; ClawPilot exposes no
                                notification toggle.
                              </Typography>
                            </Alert>
                          ) : account.provider === 'faire' ? (
                            <Alert severity="info" sx={{ mt: 1 }}>
                              Faire fulfillment write readiness is not available.
                            </Alert>
                          ) : null}
                      </Box>

                      {account.provider === 'shopify' ? (
                        <Box
                          sx={{
                            border: 1,
                            borderColor: 'divider',
                            borderRadius: 2,
                            p: 1.5,
                          }}
                        >
                          <Stack
                            direction={{ xs: 'column', sm: 'row' }}
                            spacing={1}
                            alignItems={{ sm: 'center' }}
                            justifyContent="space-between"
                          >
                            <Box>
                              <Typography variant="subtitle2" fontWeight={700}>
                                Fulfillment locations &amp; warehouses
                              </Typography>
                              <Typography variant="body2" color="text.secondary">
                                Read Shopify locations, map an existing warehouse,
                                or create a ClawPilot warehouse from an eligible
                                merchant-managed Shopify location.
                              </Typography>
                            </Box>
                            <Button
                              size="small"
                              variant="outlined"
                              onClick={() => {
                                if (onNavigate) {
                                  onNavigate('#operations/imports')
                                } else {
                                  window.location.hash = '#operations/imports'
                                }
                              }}
                              sx={{ flexShrink: 0 }}
                            >
                              Configure locations
                            </Button>
                          </Stack>
                        </Box>
                      ) : null}

                      {account.provider === 'shopify' ? (
                        <ShopifyCarrierServiceSetupPanel
                          accountGlobalId={account.globalId}
                          displayName={account.displayName}
                        />
                      ) : null}

                      {account.provider === 'shopify' && account.webhookUrl ? (
                        <Box>
                          <Typography variant="subtitle2" fontWeight={700}>
                            Shopify event webhook setup
                          </Typography>
                          <Typography
                            variant="body2"
                            color="text.secondary"
                            sx={{ mb: 1 }}
                          >
                            Use the account-specific URL below only for Shopify
                            event subscriptions such as app scope, inventory,
                            and product changes. It is separate from the
                            CarrierService POST callback used for live cart and
                            checkout rates above. Test connection performs a
                            live, read-only discovery and reports whether every
                            required event subscription points to this exact
                            URL. One valid signed delivery separately verifies
                            the stored app secret; neither check writes to
                            Shopify. Test connection refreshes the 24-hour
                            operational status, but an older exact discovery
                            alone does not block a valid signed order event.
                          </Typography>
                          <Stack spacing={1} sx={{ mb: 1 }}>
                            {webhookSubscriptionGroups.map((group) => (
                              <Alert
                                key={group.key}
                                severity={group.ready ? 'success' : 'warning'}
                              >
                                <Typography variant="body2" fontWeight={700}>
                                  {group.label} · {group.ready ? 'ready' : 'not ready'}
                                </Typography>
                                <Typography variant="body2">
                                  {!group.observed
                                    ? 'Test the Shopify connection to discover this subscription group.'
                                    : group.ready
                                      ? 'Every required topic points to this exact callback URL.'
                                      : `Discovery found ${group.missingTopics.length} missing and ${group.conflictingTopics.length} conflicting topic${group.missingTopics.length + group.conflictingTopics.length === 1 ? '' : 's'}. No provider writes were made.`}
                                </Typography>
                              </Alert>
                            ))}
                          </Stack>
                          {orderWebhookReadiness ? (
                            <Box
                              sx={{
                                border: 1,
                                borderColor: orderWebhookReadiness.effective
                                  ? 'success.main'
                                  : 'warning.main',
                                borderRadius: 2,
                                p: 1.5,
                                mb: 1,
                              }}
                            >
                              <Typography variant="subtitle2" fontWeight={700}>
                                Order event subscriptions
                              </Typography>
                              <Stack spacing={0.75} sx={{ mt: 1 }}>
                                <Alert severity="info">
                                  <Typography variant="body2" fontWeight={700}>
                                    Desired · seven minimized JSON topics
                                  </Typography>
                                  <Typography variant="body2">
                                    Fields: {orderWebhookReadiness.desiredFields.join(', ')}
                                  </Typography>
                                  <Typography variant="caption" display="block">
                                    {orderWebhookReadiness.desiredTopics.join(', ')}
                                  </Typography>
                                </Alert>
                                <Alert severity={
                                  orderWebhookReadiness.observed ? 'info' : 'warning'
                                }>
                                  <Typography variant="body2" fontWeight={700}>
                                    Current · {orderWebhookReadiness.observed
                                      ? `${orderWebhookReadiness.matchingCount} of 7 exact`
                                      : 'not discovered'}
                                  </Typography>
                                  <Typography variant="body2">
                                    {orderWebhookReadiness.observed
                                      ? `${orderWebhookReadiness.observedCount} observed · ${orderWebhookReadiness.missingTopics.length} missing · ${orderWebhookReadiness.conflictingTopics.length} conflicting`
                                      : 'Test the connection or run the single reconciliation action below.'}
                                  </Typography>
                                </Alert>
                                <Alert severity={
                                  orderWebhookReadiness.effective
                                    ? 'success'
                                    : 'warning'
                                }>
                                  <Typography variant="body2" fontWeight={700}>
                                    Effective · {orderWebhookReadiness.effective
                                      ? 'ready'
                                      : 'not ready'}
                                  </Typography>
                                  <Typography variant="body2">
                                    {orderWebhookReadiness.effective
                                      ? 'All seven topics match this account, credential generation, callback URL, JSON format, and two-field profile with current discovery evidence.'
                                      : 'Operational status needs refresh or the topic, credential generation, callback URL, or two-field profile has drifted. Only exact binding/profile drift blocks signed delivery; age alone does not.'}
                                  </Typography>
                                </Alert>
                              </Stack>
                              <TextField
                                fullWidth
                                size="small"
                                label="Typed order webhook confirmation"
                                value={orderWebhookDraft.confirmation}
                                disabled={
                                  !canRevealCredentials
                                  || orderWebhookPending
                                  || orderWebhookDraft.idempotencyKey !== null
                                }
                                onChange={(event) => {
                                  setOrderWebhookDrafts((current) => ({
                                    ...current,
                                    [account.globalId]: {
                                      confirmation: event.target.value,
                                      idempotencyKey: null,
                                    },
                                  }))
                                }}
                                helperText={orderWebhookDraft.idempotencyKey
                                  ? 'Safe retry is retained for this tab. Ambiguous outcomes stay read-only; a deterministic rejection may resume only the discovered residual plan. The key clears after bound success.'
                                  : `Type exactly: ${orderWebhookConfirmation}`}
                                inputProps={{
                                  autoComplete: 'off',
                                  spellCheck: false,
                                  maxLength: 96,
                                }}
                                sx={{ mt: 1 }}
                              />
                              <Stack
                                direction={{ xs: 'column', sm: 'row' }}
                                spacing={1}
                                alignItems={{ sm: 'center' }}
                                sx={{ mt: 1 }}
                              >
                                <Button
                                  variant="contained"
                                  disabled={
                                    !canRevealCredentials
                                    || pendingAction !== ''
                                    || orderWebhookDraft.confirmation
                                      !== orderWebhookConfirmation
                                  }
                                  startIcon={orderWebhookPending
                                    ? <CircularProgress size={16} />
                                    : <SyncRounded />}
                                  onClick={() => {
                                    void reconcileOrderWebhooks(account)
                                  }}
                                >
                                  {orderWebhookPending
                                    ? 'Reconciling order webhooks'
                                    : 'Reconcile order webhooks'}
                                </Button>
                                <Typography variant="caption" color="text.secondary">
                                  Creates missing or updates one mismatched required
                                  subscription. It never deletes subscriptions or
                                  touches other topics.
                                </Typography>
                              </Stack>
                            </Box>
                          ) : null}
                          <Accordion disableGutters sx={{ mb: 1 }}>
                            <AccordionSummary expandIcon={<ExpandMoreRounded />}>
                              <Box>
                                <Typography variant="subtitle2" fontWeight={700}>
                                  Event webhook setup plan
                                </Typography>
                                <Typography variant="caption" color="text.secondary">
                                  Provider registration and ClawPilot processing readiness are tracked separately.
                                </Typography>
                              </Box>
                            </AccordionSummary>
                            <AccordionDetails>
                              <Stack spacing={1}>
                                {catalog?.onboarding.shopify.webhookSetupGroups.map((group) => (
                                  <Alert
                                    key={group.key}
                                    severity={group.state === 'available' ? 'success' : 'info'}
                                  >
                                    <Typography variant="body2" fontWeight={700}>
                                      {group.label} · {group.state === 'available'
                                        ? 'Ready to register'
                                        : group.state === 'privacy_lifecycle_pending'
                                          ? 'Privacy lifecycle required'
                                          : 'Processor pending'}
                                    </Typography>
                                    <Typography variant="body2">{group.behavior}</Typography>
                                    <Typography variant="caption" display="block" sx={{ mt: 0.5 }}>
                                      Topics: {group.topics.join(', ')}
                                    </Typography>
                                    <Typography variant="caption" display="block">
                                      Scopes: {group.requiredScopes.length
                                        ? group.requiredScopes.join(', ')
                                        : 'None (control event only)'}
                                    </Typography>
                                  </Alert>
                                ))}
                              </Stack>
                            </AccordionDetails>
                          </Accordion>
                          <Stack
                            direction={{ xs: 'column', sm: 'row' }}
                            spacing={1}
                            alignItems={{ sm: 'flex-start' }}
                          >
                            <TextField
                              fullWidth
                              label="Signed Shopify event webhook URL"
                              value={account.webhookUrl}
                              InputProps={{ readOnly: true }}
                              helperText="Do not use this URL for Shopify CarrierService cart rates. Core order topics use a separate payload-free exact-read lane. Customer-bearing topics remain rejected until their protected-data lifecycle is implemented."
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
                            {canActivate ? (
                              <>
                                <Button
                                  variant="contained"
                                  disabled={pendingAction !== '' || !account.configured}
                                  onClick={() => registerScopeWebhooks(account)}
                                  sx={actionButtonSx}
                                >
                                  Register scope safety webhook
                                </Button>
                                <Button
                                  variant="contained"
                                  disabled={pendingAction !== '' || !account.configured}
                                  onClick={() => registerInventoryWebhooks(account)}
                                  sx={actionButtonSx}
                                >
                                  Register inventory webhooks
                                </Button>
                                <Button
                                  variant="contained"
                                  disabled={pendingAction !== '' || !account.configured}
                                  onClick={() => registerCatalogWebhooks(account)}
                                  sx={actionButtonSx}
                                >
                                  Register catalog webhooks
                                </Button>
                              </>
                            ) : null}
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
                            Distributed Operations scope profile
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

                      {account.provider === 'shopify' && !intakeAvailable ? (
                        <Accordion
                          disableGutters
                          variant="outlined"
                          sx={{ borderRadius: '8px !important' }}
                        >
                          <AccordionSummary
                            expandIcon={<ExpandMoreRounded />}
                          >
                            <Box>
                              <Typography fontWeight={700}>
                                Development order preview · read only
                              </Typography>
                              <Typography
                                variant="body2"
                                color="text.secondary"
                              >
                                Inspect a held, minimized sample before
                                designing canonical order import.
                              </Typography>
                            </Box>
                          </AccordionSummary>
                          <AccordionDetails>
                            <Stack spacing={2}>
                              <Alert severity="warning">
                                ClawPilot fetches at most the newest 25 non-test
                                orders and the first 20 lines per order, marks
                                additional lines as a visible gap, keeps the
                                minimized diagnostic for 24 hours, and stores
                                no raw Shopify response, customer contact
                                fields, shipping address, or customized product
                                titles. This does not create canonical orders,
                                advance a synchronization cursor, enable
                                receipt intake, or write to Shopify.
                              </Alert>

                              {!canPreviewShopifyOrders ? (
                                <Alert severity="info">
                                  Preview requires a verified sandbox
                                  connection with <code>read_orders</code>{' '}
                                  granted. Test the connection after Shopify
                                  approves the released app scopes.
                                </Alert>
                              ) : null}

                              <Stack
                                direction={{ xs: 'column', sm: 'row' }}
                                gap={1}
                                flexWrap="wrap"
                              >
                                <Button
                                  variant="outlined"
                                  disabled={
                                    pendingAction !== ''
                                    || !account.configured
                                  }
                                  onClick={() => loadShopifyPreview(account)}
                                  sx={actionButtonSx}
                                >
                                  {pendingAction
                                    === `preview-load:${account.globalId}`
                                    ? 'Loading…'
                                    : 'Load current preview'}
                                </Button>
                                <Button
                                  variant="contained"
                                  startIcon={<SyncRounded />}
                                  disabled={
                                    pendingAction !== ''
                                    || !canPreviewShopifyOrders
                                  }
                                  onClick={() => importShopifyPreview(account)}
                                  sx={actionButtonSx}
                                >
                                  {pendingAction
                                    === `preview-import:${account.globalId}`
                                    ? 'Fetching…'
                                    : 'Fetch newest 25 · read only'}
                                </Button>
                                <Button
                                  variant="outlined"
                                  color="warning"
                                  disabled={
                                    pendingAction !== ''
                                    || !preview?.run
                                  }
                                  onClick={() => clearShopifyPreview(account)}
                                  sx={actionButtonSx}
                                >
                                  {pendingAction
                                    === `preview-clear:${account.globalId}`
                                    ? 'Clearing…'
                                    : 'Clear preview'}
                                </Button>
                              </Stack>

                              {preview?.run ? (
                                <>
                                  <Stack
                                    direction="row"
                                    gap={0.75}
                                    flexWrap="wrap"
                                  >
                                    <Chip
                                      size="small"
                                      color="success"
                                      label={`${preview.run.ordersStaged} held orders`}
                                    />
                                    <Chip
                                      size="small"
                                      label={`${preview.run.ordersSeen} seen`}
                                    />
                                    <Chip
                                      size="small"
                                      label={`${preview.run.canonicalOrdersCreated} canonical orders`}
                                    />
                                    <Chip
                                      size="small"
                                      label={`${preview.run.shopifyWrites} Shopify writes`}
                                    />
                                    <Chip
                                      size="small"
                                      label={`Cursor advanced: ${
                                        preview.run.syncCursorAdvanced
                                          ? 'yes'
                                          : 'no'
                                      }`}
                                    />
                                  </Stack>

                                  <Typography
                                    variant="caption"
                                    color="text.secondary"
                                  >
                                    Completed{' '}
                                    {new Date(
                                      preview.run.completedAt,
                                    ).toLocaleString()} · expires{' '}
                                    {new Date(
                                      preview.run.expiresAt,
                                    ).toLocaleString()}
                                  </Typography>

                                  {preview.run.moreAvailable ? (
                                    <Alert severity="info">
                                      More matching Shopify orders exist. Only
                                      the newest 25 were staged for this
                                      diagnostic; no next-page cursor was
                                      retained.
                                    </Alert>
                                  ) : null}

                                  {Object.keys(preview.gapCounts).length ? (
                                    <Box>
                                      <Typography
                                        variant="caption"
                                        color="text.secondary"
                                      >
                                        Diagnostic gaps
                                      </Typography>
                                      <Stack
                                        direction="row"
                                        gap={0.75}
                                        flexWrap="wrap"
                                        sx={{ mt: 0.5 }}
                                      >
                                        {Object.entries(preview.gapCounts)
                                          .map(([gap, count]) => (
                                            <Chip
                                              key={gap}
                                              size="small"
                                              color="warning"
                                              label={`${humanize(gap)} · ${count}`}
                                            />
                                          ))}
                                      </Stack>
                                    </Box>
                                  ) : null}

                                  {preview.orders.length ? (
                                    <TableContainer
                                      sx={{
                                        maxHeight: 480,
                                        border: 1,
                                        borderColor: 'divider',
                                        borderRadius: 1,
                                      }}
                                    >
                                      <Table size="small" stickyHeader>
                                        <TableHead>
                                          <TableRow>
                                            <TableCell>Order</TableCell>
                                            <TableCell>Created</TableCell>
                                            <TableCell>Status</TableCell>
                                            <TableCell>Units / SKUs</TableCell>
                                            <TableCell align="right">
                                              Total
                                            </TableCell>
                                            <TableCell>Gaps</TableCell>
                                          </TableRow>
                                        </TableHead>
                                        <TableBody>
                                          {preview.orders.map((order) => {
                                            const skus = order.normalizedLines
                                              .map((line) => (
                                                line.sku || 'No SKU'
                                              ))
                                            const uniqueSkus = [...new Set(
                                              skus,
                                            )]
                                            return (
                                              <TableRow
                                                key={order.externalOrderId}
                                                hover
                                              >
                                                <TableCell>
                                                  <Typography
                                                    variant="body2"
                                                    fontWeight={700}
                                                  >
                                                    {order.orderName}
                                                  </Typography>
                                                  <Typography
                                                    variant="caption"
                                                    color="text.secondary"
                                                  >
                                                    {order.sourceName
                                                      || 'Unknown source'}
                                                  </Typography>
                                                </TableCell>
                                                <TableCell>
                                                  {new Date(
                                                    order.providerCreatedAt,
                                                  ).toLocaleString()}
                                                </TableCell>
                                                <TableCell>
                                                  <Typography variant="body2">
                                                    {humanize(
                                                      order.financialStatus
                                                        || 'unknown',
                                                    )}
                                                  </Typography>
                                                  <Typography
                                                    variant="caption"
                                                    color="text.secondary"
                                                  >
                                                    {humanize(
                                                      order.fulfillmentStatus,
                                                    )}
                                                  </Typography>
                                                </TableCell>
                                                <TableCell>
                                                  <Typography variant="body2">
                                                    {order.lineItemQuantity}{' '}
                                                    units
                                                  </Typography>
                                                  <Typography
                                                    variant="caption"
                                                    color="text.secondary"
                                                  >
                                                    {uniqueSkus
                                                      .slice(0, 4)
                                                      .join(', ')}
                                                    {uniqueSkus.length > 4
                                                      ? ` +${
                                                        uniqueSkus.length - 4
                                                      }`
                                                      : ''}
                                                  </Typography>
                                                </TableCell>
                                                <TableCell align="right">
                                                  {money(
                                                    order.totalAmount,
                                                    order.currencyCode,
                                                  )}
                                                </TableCell>
                                                <TableCell>
                                                  {order.gapCodes.length
                                                    ? order.gapCodes
                                                      .map(humanize)
                                                      .join(', ')
                                                    : 'None detected'}
                                                </TableCell>
                                              </TableRow>
                                            )
                                          })}
                                        </TableBody>
                                      </Table>
                                    </TableContainer>
                                  ) : (
                                    <Alert severity="info">
                                      The completed preview contained no
                                      matching non-test orders.
                                    </Alert>
                                  )}
                                </>
                              ) : (
                                <Typography
                                  variant="body2"
                                  color="text.secondary"
                                >
                                  No current held preview is loaded. Loading
                                  checks ClawPilot only; fetching makes
                                  read-only Shopify Admin API calls.
                                </Typography>
                              )}
                            </Stack>
                          </AccordionDetails>
                        </Accordion>
                      ) : null}

                      {activationBlockers.length ? (
                        <Alert severity="info">
                          <Typography variant="body2" fontWeight={700}>
                            Signed receipts cannot be queued yet
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
                        {canRevealCredentials
                          && account.authMode !== 'faire_brand_token' ? (
                          <Button
                            variant="outlined"
                            startIcon={pendingAction
                              === `reveal:${account.globalId}`
                              ? <CircularProgress size={16} color="inherit" />
                              : <VisibilityRounded />}
                            disabled={
                              pendingAction !== ''
                              || !account.configured
                            }
                            onClick={() => {
                              void revealCredential(account)
                            }}
                            sx={actionButtonSx}
                          >
                            Reveal credentials
                          </Button>
                        ) : null}
                        {account.authMode === 'faire_brand_token' ? (
                          <Typography
                            variant="caption"
                            color="text.secondary"
                            sx={{ alignSelf: 'center', maxWidth: 360 }}
                          >
                            Faire generated API keys are encrypted and
                            non-revealable. Generate a replacement in Faire and
                            reconnect to rotate this credential.
                          </Typography>
                        ) : null}
                        {account.provider === 'shopify'
                          && account.configured
                          && !account.receiptIntakeEnabled ? (
                            <Button
                              variant="contained"
                              startIcon={<PowerSettingsNewRounded />}
                              disabled={
                                pendingAction !== ''
                                || !canActivate
                                || missingReceiptProofScopes.length > 0
                                || account.webhookVerificationStatus !== 'verified'
                                || missingWebhookSubscriptionGroups.length > 0
                              }
                              onClick={() => action(
                                `enable:${account.globalId}`,
                                {
                                  action: 'set-receipt-intake',
                                  accountGlobalId: account.globalId,
                                  enabled: true,
                                },
                                `${account.displayName} will queue new signed receipts for intake.`,
                              )}
                              sx={actionButtonSx}
                            >
                              Queue signed receipts
                            </Button>
                          ) : null}
                        {account.provider === 'shopify'
                          && account.receiptIntakeEnabled ? (
                          <Button
                            variant="outlined"
                            color="warning"
                            disabled={pendingAction !== ''}
                            onClick={() => action(
                              `disable:${account.globalId}`,
                              {
                                action: 'set-receipt-intake',
                                accountGlobalId: account.globalId,
                                enabled: false,
                              },
                              `${account.displayName} will retain new signed receipts as held evidence.`,
                            )}
                            sx={actionButtonSx}
                          >
                            Hold signed receipts
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

                      {revealed
                        && revealedIdentifier
                        && revealedSecret ? (
                        <Alert
                          severity="warning"
                          sx={{
                            borderRadius: '8px',
                            alignItems: 'flex-start',
                          }}
                          action={(
                            <Tooltip title="Hide credentials">
                              <IconButton
                                color="inherit"
                                size="small"
                                onClick={() => setRevealedCredential(null)}
                                aria-label={`Hide ${providerLabel(
                                  account.provider,
                                )} credentials`}
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
                            Current generation {revealed.credentialVersion} only.
                            This owning-organization administrator reveal was
                            recorded in organization activity. Provider access
                            and refresh tokens are never revealable. Copy only
                            to a trusted system; operating-system clipboard
                            contents are outside ClawPilot and do not
                            automatically clear.
                          </Typography>
                          <Box
                            sx={{
                              display: 'grid',
                              gridTemplateColumns: {
                                xs: '1fr',
                                sm: '1fr 1fr',
                              },
                              gap: 1.5,
                              mt: 1.5,
                            }}
                          >
                            <TextField
                              label={revealedIdentifierLabel}
                              value={revealedIdentifier}
                              InputProps={{
                                readOnly: true,
                                endAdornment: (
                                  <InputAdornment position="end">
                                    <Tooltip
                                      title={`Copy ${revealedIdentifierLabel}`}
                                    >
                                      <IconButton
                                        edge="end"
                                        onClick={() => {
                                          void copyRevealedCredential(
                                            revealedIdentifierLabel,
                                            revealedIdentifier,
                                          )
                                        }}
                                        aria-label={`Copy ${revealedIdentifierLabel}`}
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
                              label={revealedSecretLabel}
                              value={revealedSecret}
                              InputProps={{
                                readOnly: true,
                                endAdornment: (
                                  <InputAdornment position="end">
                                    <Tooltip
                                      title={`Copy ${revealedSecretLabel}`}
                                    >
                                      <IconButton
                                        edge="end"
                                        onClick={() => {
                                          void copyRevealedCredential(
                                            revealedSecretLabel,
                                            revealedSecret,
                                          )
                                        }}
                                        aria-label={`Copy ${revealedSecretLabel}`}
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

      {catalog && configuredProviders.length ? (
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
                    {configuredProviders.map((provider) => (
                      <TableCell key={provider}>
                        {providerLabel(provider)}
                      </TableCell>
                    ))}
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
                      {configuredProviders.map((provider) => {
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
            <Typography variant="subtitle2">Provider scopes and permissions</Typography>
            <Stack direction="row" gap={0.75} flexWrap="wrap" sx={{ mt: 1 }}>
              {configuredProviders.flatMap((provider) => (
                catalog.providers[provider].providerScopes || []
              ).map((scope) => (
                <Chip
                  key={`${provider}-${scope}`}
                  size="small"
                  label={`${providerLabel(provider)}: ${scope}`}
                />
              )))}
            </Stack>
            <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 0.5 }}>
              Scope chips are shown for setup reference only; ClawPilot verifies scope evidence
              after connection attempt before enabling catalog or product-read behavior.
            </Typography>
          </AccordionDetails>
        </Accordion>
      ) : null}

      {configuredProviders.length ? (
        <Typography variant="caption" color="text.secondary">
          Connected sales-channel application credentials are encrypted and
          masked by default. An authorized owning-organization administrator
          can request an audited 30-second reveal only where the provider
          credential type supports it. Provider API keys, access tokens, and
          refresh tokens are never returned.
        </Typography>
      ) : null}
    </Stack>
  )
}
