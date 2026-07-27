'use client'

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import Accordion from '@mui/material/Accordion'
import AccordionDetails from '@mui/material/AccordionDetails'
import AccordionSummary from '@mui/material/AccordionSummary'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Card from '@mui/material/Card'
import CardContent from '@mui/material/CardContent'
import Chip from '@mui/material/Chip'
import CircularProgress from '@mui/material/CircularProgress'
import Divider from '@mui/material/Divider'
import FormControl from '@mui/material/FormControl'
import FormHelperText from '@mui/material/FormHelperText'
import InputLabel from '@mui/material/InputLabel'
import MenuItem from '@mui/material/MenuItem'
import Select from '@mui/material/Select'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import BlockRounded from '@mui/icons-material/BlockRounded'
import CheckCircleOutlineRounded from '@mui/icons-material/CheckCircleOutlineRounded'
import CloudDownloadRounded from '@mui/icons-material/CloudDownloadRounded'
import ExpandMoreRounded from '@mui/icons-material/ExpandMoreRounded'
import PublishRounded from '@mui/icons-material/PublishRounded'
import RefreshRounded from '@mui/icons-material/RefreshRounded'

type CommerceProvider = 'shopify' | 'faire'
type CandidateState =
  | 'held'
  | 'resolving'
  | 'ready'
  | 'promoted'
  | 'failed'
  | 'expired'

type DimensionsMm = {
  length?: number | null
  width?: number | null
  height?: number | null
}

type IntakeAddress = {
  name?: string | null
  line1?: string | null
  line2?: string | null
  city?: string | null
  region?: string | null
  postalCode?: string | null
  country?: string | null
}

type IntakeBlocker = {
  code: string
  label: string
  action: string
  terminal: boolean
}

type IntakeLine = {
  globalId: string
  externalLineId: string
  externalProductId?: string | null
  externalVariantId?: string | null
  sku?: string | null
  title: string
  quantity: number
  requiresShipping: boolean
  unitPriceMinor?: number | null
  currency?: string | null
  mappingStatus?: string | null
  productGlobalId?: string | null
  packageStatus?: string | null
  packageProfileGlobalId?: string | null
  weightGrams?: number | null
  dimensionsMm?: DimensionsMm | null
}

type IntakeCandidate = {
  globalId: string
  rowVersion: number
  externalOrderId: string
  orderNumber?: string | null
  state: CandidateState
  providerStatus?: string | null
  financialStatus?: string | null
  fulfillmentStatus?: string | null
  returnStatus?: string | null
  normalizedOrderStatus?: string | null
  normalizedPaymentStatus?: string | null
  normalizedFulfillmentStatus?: string | null
  normalizedReturnStatus?: string | null
  currency?: string | null
  totalMinor?: number | null
  requiresShipping: boolean
  sourceUpdatedAt?: string | null
  blockers?: IntakeBlocker[]
  customer?: {
    snapshotName?: string | null
    snapshotEmail?: string | null
    resolvedCustomerGlobalId?: string | null
    status?: string | null
  } | null
  shipTo?: {
    address?: IntakeAddress | null
    status?: string | null
  } | null
  delivery?: {
    requestedDeliveryAt?: string | null
    source?: string | null
    status?: string | null
  } | null
  lines?: IntakeLine[]
  canonicalOrderGlobalId?: string | null
  unsupportedReason?: string | null
}

type PackageProfile = {
  globalId: string
  label: string
  weightGrams?: number | null
  dimensionsMm?: DimensionsMm | null
}

type ProductCatalogEntry = {
  globalId: string
  name: string
  sku?: string | null
  packageProfiles?: PackageProfile[]
}

type CustomerCatalogEntry = {
  globalId: string
  name: string
  email?: string | null
}

type IntakePagination = {
  mode: 'operational'
  resource: 'orders' | 'products'
  consistencyMode?: 'provider_time_fenced' | 'provider_cursor_live'
  batchNumber: number
  runGlobalId: string
  continuationRunGlobalId?: string | null
  hasNextBatch: boolean
  sessionComplete: boolean
  restartRequired: boolean
  state:
    | 'available'
    | 'consumed'
    | 'exhausted'
    | 'invalid'
    | 'expired'
    | 'superseded'
  providerRowsSeen: number
  eligibleOrdersSeen: number
}

type ProductCandidate = {
  globalId: string
  rowVersion: number
  externalProductId: string
  externalVariantId: string
  externalInventoryItemId?: string | null
  sku?: string | null
  barcode?: string | null
  productTitle: string
  variantTitle?: string | null
  vendor?: string | null
  productType?: string | null
  selectedOptions?: Array<{
    name: string
    value: string
  }>
  providerStatus?: string | null
  normalizedStatus?: string | null
  state: CandidateState
  mappingStatus?: string | null
  productGlobalId?: string | null
  productMappingGlobalId?: string | null
  unitMultiplier?: number | null
  currency?: string | null
  priceMinor?: number | null
  compareAtPriceMinor?: number | null
  taxable?: boolean | null
  requiresShipping?: boolean | null
  inventoryQuantity?: number | null
  weightGrams?: number | null
  sourceUpdatedAt?: string | null
  blockers?: IntakeBlocker[]
  unsupportedReason?: string | null
}

type CommerceIntake = {
  accountGlobalId: string
  provider: CommerceProvider
  policy?: {
    version?: string | null
    retentionDays?: number | null
    activationState?:
      | 'disabled'
      | 'shadow'
      | 'read_only'
      | 'active'
      | 'frozen'
    activationRevision?: number | null
    operatorCommandsAllowed?: boolean
    providerWritesAllowed?: boolean
    syncCursorAdvanceAllowed?: boolean
  }
  run?: {
    globalId: string
    resource?: 'orders' | 'products'
    state: string
    startedAt?: string | null
    completedAt?: string | null
    recordsSeen?: number
    recordsRejected?: number
    recordsHeld?: number
    recordsPromoted?: number
    providerReads?: number
    providerWrites?: number
    syncCursorAdvanced?: boolean
  } | null
  pagination?: IntakePagination | null
  paginations?: {
    orders?: IntakePagination | null
    products?: IntakePagination | null
  }
  candidates?: IntakeCandidate[]
  productCandidates?: ProductCandidate[]
  rejections?: Array<{
    globalId: string
    rowVersion: number
    resourceType: 'order' | 'product'
    externalId: string
    sourceHash: string
    errorCode: string
    safeMessage: string
  }>
  productCatalog?: ProductCatalogEntry[]
  customerCatalog?: CustomerCatalogEntry[]
  evidence?: {
    providerReads?: number
    providerWrites?: number
    canonicalOrdersCreated?: number
    syncCursorAdvanced?: boolean
  }
}

type IntakePayload = {
  ok?: boolean
  error?: string
  code?: string
  intake?: CommerceIntake
  command?: {
    replayed?: boolean
    result?: unknown
  }
}

type ProductDraft = {
  productGlobalId: string
  name: string
  sku: string
  unitPriceMinor: string
  currency: string
}

type CatalogProductDraft = {
  productGlobalId: string
  name: string
  sku: string
  unitPriceMinor: string
  currency: string
  exclusionReason: string
}

type CustomerDraft = {
  customerGlobalId: string
  name: string
  email: string
  phone: string
}

type AddressDraft = {
  name: string
  line1: string
  line2: string
  city: string
  region: string
  postalCode: string
  country: string
}

type DeliveryDraft = {
  mode: 'provider' | 'manual' | 'default_sla'
  requestedDeliveryAt: string
}

type PackageDraft = {
  packageProfileGlobalId: string
  weightGrams: string
  length: string
  width: string
  height: string
}

type CommerceIntakeWorkflowProps = {
  accountGlobalId: string
  provider: CommerceProvider
  displayName: string
  canActivate: boolean
}

class IntakeRequestError extends Error {
  constructor(
    message: string,
    readonly code = 'COMMERCE_INTAKE_REQUEST_FAILED',
  ) {
    super(message)
    this.name = 'IntakeRequestError'
  }
}

const fieldSx = {
  '& .MuiOutlinedInput-root': {
    borderRadius: '8px',
  },
}

const actionButtonSx = {
  minHeight: 38,
  borderRadius: '8px',
  width: { xs: '100%', sm: 'auto' },
}

const terminalStates = new Set<CandidateState>([
  'promoted',
  'failed',
  'expired',
])

function providerLabel(provider: CommerceProvider) {
  return provider === 'shopify' ? 'Shopify' : 'Faire'
}

function humanize(value: string) {
  return value
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
}

function formatDate(value?: string | null) {
  if (!value) return 'Not recorded'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

function formatMoney(minor?: number | null, currency?: string | null) {
  if (!Number.isInteger(minor) || !currency) return 'Amount unavailable'
  try {
    const formatter = new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
    })
    const exponent = formatter.resolvedOptions().maximumFractionDigits ?? 2
    return formatter.format((minor as number) / (10 ** exponent))
  } catch {
    return `${minor} ${currency} minor units`
  }
}

function validCountryCode(value?: string | null) {
  return /^[A-Za-z]{2,3}$/.test(String(value || '').trim())
}

function idempotencyKey() {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `commerce-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function normalizeCurrency(value: string) {
  return value.trim().toUpperCase().slice(0, 3)
}

function validPrice(draft: ProductDraft) {
  return /^\d+$/.test(draft.unitPriceMinor)
    && /^[A-Z]{3}$/.test(normalizeCurrency(draft.currency))
}

function dimensionsLabel(dimensions?: DimensionsMm | null) {
  if (
    !dimensions
    || !dimensions.length
    || !dimensions.width
    || !dimensions.height
  ) return 'dimensions unavailable'
  return `${dimensions.length} × ${dimensions.width} × ${dimensions.height} mm`
}

function initialProductDraft(line: IntakeLine): ProductDraft {
  return {
    productGlobalId: line.productGlobalId || '',
    name: line.title || '',
    sku: line.sku || '',
    unitPriceMinor: Number.isInteger(line.unitPriceMinor)
      ? String(line.unitPriceMinor)
      : '',
    currency: normalizeCurrency(line.currency || ''),
  }
}

function initialCatalogProductDraft(
  candidate: ProductCandidate,
): CatalogProductDraft {
  const variant = candidate.variantTitle?.trim()
  const name = variant && variant !== candidate.productTitle
    ? `${candidate.productTitle} · ${variant}`
    : candidate.productTitle
  return {
    productGlobalId: candidate.productGlobalId || '',
    name,
    sku: candidate.sku || '',
    unitPriceMinor: Number.isInteger(candidate.priceMinor)
      ? String(candidate.priceMinor)
      : '',
    currency: normalizeCurrency(candidate.currency || ''),
    exclusionReason: '',
  }
}

function initialCustomerDraft(candidate: IntakeCandidate): CustomerDraft {
  return {
    customerGlobalId: candidate.customer?.resolvedCustomerGlobalId || '',
    name: candidate.customer?.snapshotName || '',
    email: candidate.customer?.snapshotEmail || '',
    phone: '',
  }
}

function initialAddressDraft(candidate: IntakeCandidate): AddressDraft {
  const address = candidate.shipTo?.address
  return {
    name: address?.name || '',
    line1: address?.line1 || '',
    line2: address?.line2 || '',
    city: address?.city || '',
    region: address?.region || '',
    postalCode: address?.postalCode || '',
    country: address?.country || '',
  }
}

function initialDeliveryDraft(candidate: IntakeCandidate): DeliveryDraft {
  return {
    mode: candidate.delivery?.requestedDeliveryAt
      ? 'provider'
      : 'default_sla',
    requestedDeliveryAt: '',
  }
}

function initialPackageDraft(line: IntakeLine): PackageDraft {
  return {
    packageProfileGlobalId: line.packageProfileGlobalId || '',
    weightGrams: line.weightGrams ? String(line.weightGrams) : '',
    length: line.dimensionsMm?.length
      ? String(line.dimensionsMm.length)
      : '',
    width: line.dimensionsMm?.width
      ? String(line.dimensionsMm.width)
      : '',
    height: line.dimensionsMm?.height
      ? String(line.dimensionsMm.height)
      : '',
  }
}

async function readPayload(response: Response): Promise<IntakePayload> {
  const payload = await response.json().catch(() => ({})) as IntakePayload
  if (!response.ok || payload.ok !== true || !payload.intake) {
    throw new IntakeRequestError(
      payload.error || 'Commerce order intake request failed.',
      payload.code,
    )
  }
  return payload
}

function safeError(error: unknown) {
  if (error instanceof IntakeRequestError) {
    return `${error.message} [${error.code}]`
  }
  return error instanceof Error
    ? error.message
    : 'Commerce order intake request failed.'
}

function stateColor(state: CandidateState) {
  if (state === 'ready' || state === 'promoted') return 'success' as const
  if (state === 'failed' || state === 'expired') return 'error' as const
  return 'warning' as const
}

function positiveInteger(value: string) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

export default function CommerceIntakeWorkflow({
  accountGlobalId,
  provider,
  displayName,
  canActivate,
}: CommerceIntakeWorkflowProps) {
  const [intake, setIntake] = useState<CommerceIntake | null>(null)
  const [loading, setLoading] = useState(true)
  const [pendingAction, setPendingAction] = useState('')
  const [error, setError] = useState('')
  const [errorCode, setErrorCode] = useState('')
  const [notice, setNotice] = useState('')
  const [productDrafts, setProductDrafts] = useState<
    Record<string, ProductDraft>
  >({})
  const [catalogProductDrafts, setCatalogProductDrafts] = useState<
    Record<string, CatalogProductDraft>
  >({})
  const [rejectionReasons, setRejectionReasons] = useState<
    Record<string, string>
  >({})
  const [customerDrafts, setCustomerDrafts] = useState<
    Record<string, CustomerDraft>
  >({})
  const [addressDrafts, setAddressDrafts] = useState<
    Record<string, AddressDraft>
  >({})
  const [deliveryDrafts, setDeliveryDrafts] = useState<
    Record<string, DeliveryDraft>
  >({})
  const [packageDrafts, setPackageDrafts] = useState<
    Record<string, PackageDraft>
  >({})
  const [unsupportedReasons, setUnsupportedReasons] = useState<
    Record<string, string>
  >({})
  const retryKeys = useRef(new Map<string, string>())

  const loadIntake = useCallback(async (signal?: AbortSignal) => {
    const params = new URLSearchParams({ accountGlobalId })
    const response = await fetch(
      `/api/integrations/commerce/intake?${params.toString()}`,
      {
        cache: 'no-store',
        signal,
      },
    )
    const payload = await readPayload(response)
    setIntake(payload.intake || null)
  }, [accountGlobalId])

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError('')
    setErrorCode('')
    setNotice('')
    setIntake(null)
    retryKeys.current.clear()
    setProductDrafts({})
    setCatalogProductDrafts({})
    setRejectionReasons({})
    setCustomerDrafts({})
    setAddressDrafts({})
    setDeliveryDrafts({})
    setPackageDrafts({})
    setUnsupportedReasons({})
    loadIntake(controller.signal)
      .catch((requestError) => {
        if (!controller.signal.aborted) {
          setError(safeError(requestError))
          setErrorCode(
            requestError instanceof IntakeRequestError
              ? requestError.code
              : '',
          )
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [loadIntake])

  const postCommand = useCallback(async (
    action: string,
    requestKey: string,
    command: Record<string, unknown>,
    successMessage: string,
  ) => {
    if (pendingAction) return
    const retryKey = `${accountGlobalId}:${requestKey}`
    const stableIdempotencyKey = retryKeys.current.get(retryKey)
      || idempotencyKey()
    retryKeys.current.set(retryKey, stableIdempotencyKey)
    setPendingAction(requestKey)
    setError('')
    setErrorCode('')
    setNotice('')
    try {
      const response = await fetch('/api/integrations/commerce/intake', {
        method: 'POST',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accountGlobalId,
          action,
          idempotencyKey: stableIdempotencyKey,
          ...command,
        }),
      })
      const payload = await readPayload(response)
      setIntake(payload.intake || null)
      retryKeys.current.delete(retryKey)
      setNotice(
        payload.command?.replayed
          ? `${successMessage} The original command result was replayed.`
          : successMessage,
      )
    } catch (requestError) {
      if (
        requestError instanceof IntakeRequestError
        && (
          requestError.code === 'COMMERCE_INTAKE_READ_RESTART_REQUIRED'
          || requestError.code
            === 'COMMERCE_INTAKE_CONTINUATION_RESTART_REQUIRED'
        )
      ) {
        retryKeys.current.delete(retryKey)
        await loadIntake().catch(() => undefined)
      }
      setError(safeError(requestError))
      setErrorCode(
        requestError instanceof IntakeRequestError
          ? requestError.code
          : '',
      )
    } finally {
      setPendingAction('')
    }
  }, [accountGlobalId, loadIntake, pendingAction])

  async function reloadWorkflow() {
    if (pendingAction) return
    setPendingAction('reload')
    setError('')
    setErrorCode('')
    setNotice('')
    try {
      await loadIntake()
      retryKeys.current.clear()
      setProductDrafts({})
      setCatalogProductDrafts({})
      setRejectionReasons({})
      setCustomerDrafts({})
      setAddressDrafts({})
      setDeliveryDrafts({})
      setPackageDrafts({})
      setUnsupportedReasons({})
      setNotice('Workflow reloaded from current ClawPilot intake state.')
    } catch (requestError) {
      setError(safeError(requestError))
      setErrorCode(
        requestError instanceof IntakeRequestError
          ? requestError.code
          : '',
      )
    } finally {
      setPendingAction('')
    }
  }

  async function initializeShadowActivation() {
    if (pendingAction) return
    if (
      !window.confirm(
        `Set ${displayName}'s organization Operations mode to Shadow? This enables reviewed ClawPilot intake decisions but does not write to ${providerLabel(provider)} or start background synchronization.`,
      )
    ) return
    setPendingAction('initialize-shadow')
    setError('')
    setErrorCode('')
    setNotice('')
    try {
      const response = await fetch('/api/integrations/commerce/intake', {
        method: 'POST',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accountGlobalId,
          action: 'initialize-shadow',
          confirmShadowActivation: true,
          expectedActivationState:
            intake?.policy?.activationState || 'missing',
          expectedActivationRevision:
            intake?.policy?.activationRevision ?? null,
        }),
      })
      const payload = await readPayload(response)
      setIntake(payload.intake || null)
      setNotice(
        'Operations is now in Shadow mode. Product and order intake actions are unlocked.',
      )
    } catch (requestError) {
      setError(safeError(requestError))
      setErrorCode(
        requestError instanceof IntakeRequestError
          ? requestError.code
          : '',
      )
    } finally {
      setPendingAction('')
    }
  }

  const candidates = useMemo(
    () => intake?.candidates || [],
    [intake?.candidates],
  )
  const productCandidates = useMemo(
    () => intake?.productCandidates || [],
    [intake?.productCandidates],
  )
  const productCatalog = intake?.productCatalog || []
  const customerCatalog = intake?.customerCatalog || []
  const rejections = intake?.rejections || []
  const latestPagination = intake?.pagination || null
  const orderPagination = intake?.paginations?.orders
    || (latestPagination?.resource === 'orders' ? latestPagination : null)
  const productPagination = intake?.paginations?.products
    || (latestPagination?.resource === 'products' ? latestPagination : null)
  const operatorCommandsAllowed =
    intake?.policy?.operatorCommandsAllowed === true
  const activationRecoveryAvailable = canActivate && (
    errorCode === 'COMMERCE_INTAKE_ACTIVATION_REQUIRED'
    || intake?.policy?.activationState === 'disabled'
    || intake?.policy?.activationState === 'read_only'
  )
  const canFetchNextOrders = Boolean(
    orderPagination?.hasNextBatch
    && orderPagination.continuationRunGlobalId,
  )
  const orderFetchAction = canFetchNextOrders ? 'fetch-next' : 'fetch'
  const orderFetchRequestKey = canFetchNextOrders
    ? `fetch-next:${orderPagination?.continuationRunGlobalId}`
    : 'fetch-orders'
  const orderFetchCommand = canFetchNextOrders
    ? {
        confirmReadOnly: true,
        continuationRunGlobalId:
          orderPagination?.continuationRunGlobalId,
      }
    : { confirmReadOnly: true }
  const orderFetchLabel = canFetchNextOrders
    ? 'Fetch next order batch'
    : orderPagination?.restartRequired
      ? 'Restart operational fetch'
      : orderPagination?.sessionComplete
        ? 'Check for newer orders'
        : orderPagination
          ? 'Start new operational fetch'
          : 'Fetch operational orders'
  const orderFetchSuccessMessage = canFetchNextOrders
    ? `${providerLabel(provider)} next order batch fetched and staged.`
    : `${providerLabel(provider)} operational orders fetched into held intake candidates.`
  const canFetchNextProducts = Boolean(
    productPagination?.hasNextBatch
    && productPagination.continuationRunGlobalId,
  )
  const productFetchAction = canFetchNextProducts
    ? 'fetch-next-products'
    : 'fetch-products'
  const productFetchRequestKey = canFetchNextProducts
    ? `fetch-next-products:${productPagination?.continuationRunGlobalId}`
    : 'fetch-products'
  const productFetchCommand = canFetchNextProducts
    ? {
        confirmReadOnly: true,
        continuationRunGlobalId:
          productPagination?.continuationRunGlobalId,
      }
    : { confirmReadOnly: true }
  const productFetchLabel = canFetchNextProducts
    ? 'Fetch next product batch'
    : productPagination?.restartRequired
      ? 'Restart catalog fetch'
      : productPagination?.sessionComplete
        ? 'Check for product changes'
        : productPagination
          ? 'Start new catalog fetch'
          : 'Fetch product catalog'
  const productFetchSuccessMessage = canFetchNextProducts
    ? `${providerLabel(provider)} next product batch fetched and staged.`
    : `${providerLabel(provider)} product catalog fetched into held mapping candidates.`
  const candidateCounts = useMemo(() => {
    const counts: Record<CandidateState, number> = {
      held: 0,
      resolving: 0,
      ready: 0,
      promoted: 0,
      failed: 0,
      expired: 0,
    }
    for (const candidate of candidates) counts[candidate.state] += 1
    return counts
  }, [candidates])
  const blockerCount = candidates.reduce(
    (count, candidate) => count + (candidate.blockers?.length || 0),
    0,
  )
  const unresolvedProductCount = productCandidates.filter((candidate) => (
    !terminalStates.has(candidate.state)
    && candidate.mappingStatus !== 'resolved'
  )).length

  function catalogProductDraft(candidate: ProductCandidate) {
    return catalogProductDrafts[candidate.globalId]
      || initialCatalogProductDraft(candidate)
  }

  function updateCatalogProductDraft(
    candidate: ProductCandidate,
    update: Partial<CatalogProductDraft>,
  ) {
    setCatalogProductDrafts((current) => ({
      ...current,
      [candidate.globalId]: {
        ...(current[candidate.globalId]
          || initialCatalogProductDraft(candidate)),
        ...update,
      },
    }))
  }

  async function mapCatalogProduct(candidate: ProductCandidate) {
    const draft = catalogProductDraft(candidate)
    if (!draft.productGlobalId) return
    await postCommand(
      'resolve-catalog-product',
      `resolve-catalog-product-existing:${candidate.globalId}`,
      {
        candidateGlobalId: candidate.globalId,
        rowVersion: candidate.rowVersion,
        resolution: {
          mode: 'existing',
          productGlobalId: draft.productGlobalId,
        },
      },
      `${candidate.productTitle} mapped to the selected ClawPilot product.`,
    )
  }

  async function createCatalogProduct(candidate: ProductCandidate) {
    const draft = catalogProductDraft(candidate)
    if (!draft.name.trim() || !validPrice(draft)) return
    await postCommand(
      'resolve-catalog-product',
      `resolve-catalog-product-create:${candidate.globalId}`,
      {
        candidateGlobalId: candidate.globalId,
        rowVersion: candidate.rowVersion,
        resolution: {
          mode: 'create',
          name: draft.name.trim(),
          sku: draft.sku.trim(),
          unitPriceMinor: Number(draft.unitPriceMinor),
          currency: normalizeCurrency(draft.currency),
        },
      },
      `${draft.name.trim()} created and mapped to this provider variant.`,
    )
  }

  async function excludeCatalogProduct(candidate: ProductCandidate) {
    const draft = catalogProductDraft(candidate)
    const reason = draft.exclusionReason.trim()
    if (!reason) return
    await postCommand(
      'resolve-catalog-product',
      `resolve-catalog-product-exclude:${candidate.globalId}`,
      {
        candidateGlobalId: candidate.globalId,
        rowVersion: candidate.rowVersion,
        resolution: {
          mode: 'exclude',
          reasonCode: 'operator_confirmed_catalog_exclusion',
          reason,
        },
      },
      `${candidate.productTitle} excluded from catalog mapping with an audit reason.`,
    )
  }

  function productDraft(candidate: IntakeCandidate, line: IntakeLine) {
    const key = `${candidate.globalId}:${line.globalId}`
    return productDrafts[key] || initialProductDraft(line)
  }

  function updateProductDraft(
    candidate: IntakeCandidate,
    line: IntakeLine,
    update: Partial<ProductDraft>,
  ) {
    const key = `${candidate.globalId}:${line.globalId}`
    setProductDrafts((current) => ({
      ...current,
      [key]: {
        ...(current[key] || initialProductDraft(line)),
        ...update,
      },
    }))
  }

  function customerDraft(candidate: IntakeCandidate) {
    return customerDrafts[candidate.globalId]
      || initialCustomerDraft(candidate)
  }

  function updateCustomerDraft(
    candidate: IntakeCandidate,
    update: Partial<CustomerDraft>,
  ) {
    setCustomerDrafts((current) => ({
      ...current,
      [candidate.globalId]: {
        ...(current[candidate.globalId] || initialCustomerDraft(candidate)),
        ...update,
      },
    }))
  }

  function addressDraft(candidate: IntakeCandidate) {
    return addressDrafts[candidate.globalId] || initialAddressDraft(candidate)
  }

  function updateAddressDraft(
    candidate: IntakeCandidate,
    update: Partial<AddressDraft>,
  ) {
    setAddressDrafts((current) => ({
      ...current,
      [candidate.globalId]: {
        ...(current[candidate.globalId] || initialAddressDraft(candidate)),
        ...update,
      },
    }))
  }

  function deliveryDraft(candidate: IntakeCandidate) {
    return deliveryDrafts[candidate.globalId]
      || initialDeliveryDraft(candidate)
  }

  function updateDeliveryDraft(
    candidate: IntakeCandidate,
    update: Partial<DeliveryDraft>,
  ) {
    setDeliveryDrafts((current) => ({
      ...current,
      [candidate.globalId]: {
        ...(current[candidate.globalId] || initialDeliveryDraft(candidate)),
        ...update,
      },
    }))
  }

  function packageDraft(candidate: IntakeCandidate, line: IntakeLine) {
    const key = `${candidate.globalId}:${line.globalId}`
    return packageDrafts[key] || initialPackageDraft(line)
  }

  function updatePackageDraft(
    candidate: IntakeCandidate,
    line: IntakeLine,
    update: Partial<PackageDraft>,
  ) {
    const key = `${candidate.globalId}:${line.globalId}`
    setPackageDrafts((current) => ({
      ...current,
      [key]: {
        ...(current[key] || initialPackageDraft(line)),
        ...update,
      },
    }))
  }

  function candidateUnavailableReason(candidate: IntakeCandidate) {
    if (!Number.isInteger(candidate.rowVersion)) {
      return 'Candidate version evidence is unavailable. Refresh before acting.'
    }
    if (candidate.state === 'promoted') {
      return `Already promoted as ${
        candidate.canonicalOrderGlobalId || 'a canonical order'
      }.`
    }
    if (candidate.state === 'expired') {
      return 'This retained candidate expired. Fetch a current provider copy.'
    }
    if (candidate.state === 'failed') {
      return 'This disposition is terminal. Refresh to fetch a current provider revision.'
    }
    return ''
  }

  async function resolveExistingProduct(
    candidate: IntakeCandidate,
    line: IntakeLine,
  ) {
    const draft = productDraft(candidate, line)
    if (!draft.productGlobalId || !validPrice(draft)) return
    await postCommand(
      'resolve-product',
      `resolve-product-existing:${candidate.globalId}:${line.globalId}`,
      {
        candidateGlobalId: candidate.globalId,
        lineGlobalId: line.globalId,
        rowVersion: candidate.rowVersion,
        product: {
          mode: 'existing',
          productGlobalId: draft.productGlobalId,
          unitPriceMinor: Number(draft.unitPriceMinor),
          currency: normalizeCurrency(draft.currency),
        },
      },
      `${line.title} mapped to the selected ClawPilot product.`,
    )
  }

  async function createProduct(
    candidate: IntakeCandidate,
    line: IntakeLine,
  ) {
    const draft = productDraft(candidate, line)
    if (!draft.name.trim() || !validPrice(draft)) return
    await postCommand(
      'resolve-product',
      `resolve-product-create:${candidate.globalId}:${line.globalId}`,
      {
        candidateGlobalId: candidate.globalId,
        lineGlobalId: line.globalId,
        rowVersion: candidate.rowVersion,
        product: {
          mode: 'create',
          name: draft.name.trim(),
          sku: draft.sku.trim(),
          unitPriceMinor: Number(draft.unitPriceMinor),
          currency: normalizeCurrency(draft.currency),
        },
      },
      `${draft.name.trim()} created and mapped to this provider line.`,
    )
  }

  async function resolveExistingCustomer(candidate: IntakeCandidate) {
    const draft = customerDraft(candidate)
    if (!draft.customerGlobalId) return
    await postCommand(
      'resolve-customer',
      `resolve-customer-existing:${candidate.globalId}`,
      {
        candidateGlobalId: candidate.globalId,
        rowVersion: candidate.rowVersion,
        customer: {
          mode: 'existing',
          customerGlobalId: draft.customerGlobalId,
        },
      },
      'Order customer mapped to the selected CRM organization.',
    )
  }

  async function createCustomer(candidate: IntakeCandidate) {
    const draft = customerDraft(candidate)
    if (!draft.name.trim()) return
    await postCommand(
      'resolve-customer',
      `resolve-customer-create:${candidate.globalId}`,
      {
        candidateGlobalId: candidate.globalId,
        rowVersion: candidate.rowVersion,
        customer: {
          mode: 'create',
          name: draft.name.trim(),
          ...(draft.email.trim() ? { email: draft.email.trim() } : {}),
          ...(draft.phone.trim() ? { phone: draft.phone.trim() } : {}),
        },
      },
      `${draft.name.trim()} created and assigned to this order.`,
    )
  }

  async function confirmAddress(
    candidate: IntakeCandidate,
    address: IntakeAddress,
    requestName: string,
  ) {
    await postCommand(
      'confirm-address',
      `confirm-address:${requestName}:${candidate.globalId}`,
      {
        candidateGlobalId: candidate.globalId,
        rowVersion: candidate.rowVersion,
        address: {
          name: address.name || '',
          line1: address.line1 || '',
          ...(address.line2 ? { line2: address.line2 } : {}),
          city: address.city || '',
          region: address.region || '',
          postalCode: address.postalCode || '',
          country: address.country || '',
        },
      },
      requestName === 'provider'
        ? 'Provider ship-to snapshot confirmed.'
        : 'Manual ship-to address recorded.',
    )
  }

  async function resolveDelivery(candidate: IntakeCandidate) {
    const draft = deliveryDraft(candidate)
    if (draft.mode === 'provider' && !candidate.delivery?.requestedDeliveryAt) {
      return
    }
    if (draft.mode === 'manual' && !draft.requestedDeliveryAt) return
    const manualRequestedDelivery = draft.mode === 'manual'
      ? new Date(draft.requestedDeliveryAt)
      : null
    if (
      manualRequestedDelivery
      && Number.isNaN(manualRequestedDelivery.getTime())
    ) {
      setError('Enter a valid requested-delivery date and time.')
      return
    }
    await postCommand(
      'resolve-delivery',
      `resolve-delivery:${candidate.globalId}`,
      {
        candidateGlobalId: candidate.globalId,
        rowVersion: candidate.rowVersion,
        decision: {
          mode: draft.mode,
          ...(draft.mode === 'provider'
            ? {
                requestedDeliveryAt:
                  candidate.delivery?.requestedDeliveryAt,
              }
            : {}),
          ...(draft.mode === 'manual'
            ? {
                requestedDeliveryAt:
                  manualRequestedDelivery?.toISOString(),
              }
            : {}),
        },
      },
      'Requested delivery decision recorded.',
    )
  }

  async function resolvePackageProfile(
    candidate: IntakeCandidate,
    line: IntakeLine,
  ) {
    const draft = packageDraft(candidate, line)
    if (!draft.packageProfileGlobalId) return
    await postCommand(
      'resolve-package',
      `resolve-package-profile:${candidate.globalId}:${line.globalId}`,
      {
        candidateGlobalId: candidate.globalId,
        lineGlobalId: line.globalId,
        rowVersion: candidate.rowVersion,
        package: {
          mode: 'profile',
          packageProfileGlobalId: draft.packageProfileGlobalId,
        },
      },
      `Package profile assigned to ${line.title}.`,
    )
  }

  async function resolveManualPackage(
    candidate: IntakeCandidate,
    line: IntakeLine,
  ) {
    const draft = packageDraft(candidate, line)
    const weightGrams = positiveInteger(draft.weightGrams)
    const length = positiveInteger(draft.length)
    const width = positiveInteger(draft.width)
    const height = positiveInteger(draft.height)
    if (!weightGrams || !length || !width || !height) return
    await postCommand(
      'resolve-package',
      `resolve-package-manual:${candidate.globalId}:${line.globalId}`,
      {
        candidateGlobalId: candidate.globalId,
        lineGlobalId: line.globalId,
        rowVersion: candidate.rowVersion,
        package: {
          mode: 'manual',
          weightGrams,
          dimensionsMm: { length, width, height },
        },
      },
      `Manual package facts recorded for ${line.title}.`,
    )
  }

  if (loading) {
    return (
      <Stack
        direction="row"
        spacing={1}
        alignItems="center"
        aria-live="polite"
      >
        <CircularProgress size={20} />
        <Typography variant="body2">
          Loading normalized order intake…
        </Typography>
      </Stack>
    )
  }

  return (
    <Accordion
      disableGutters
      variant="outlined"
      sx={{ borderRadius: '8px !important' }}
    >
      <AccordionSummary expandIcon={<ExpandMoreRounded />}>
        <Box>
          <Typography fontWeight={700}>
            Commerce intake · map, resolve, and promote
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Fetch read-only {providerLabel(provider)} products and orders,
            map the catalog, resolve each hold, and explicitly promote
            canonical orders.
          </Typography>
        </Box>
      </AccordionSummary>
      <AccordionDetails>
        <Stack spacing={2.5}>
          {error ? (
            <Alert severity="error" onClose={() => setError('')}>
              {error}
            </Alert>
          ) : null}
          {notice ? (
            <Alert severity="success" onClose={() => setNotice('')}>
              {notice}
            </Alert>
          ) : null}

          <Alert severity="info">
            This workflow is provider-read-only. It cannot update{' '}
            {providerLabel(provider)}, register webhooks, advance a sync
            cursor, reserve inventory, or export fulfillment. Credentials and
            provider tokens are never returned here.
          </Alert>
          {!operatorCommandsAllowed ? (
            <Alert
              severity="warning"
              action={(
                <Stack direction={{ xs: 'column', sm: 'row' }} spacing={0.5}>
                  {activationRecoveryAvailable ? (
                    <Button
                      color="inherit"
                      size="small"
                      disabled={pendingAction !== ''}
                      onClick={() => void initializeShadowActivation()}
                    >
                      {pendingAction === 'initialize-shadow'
                        ? 'Enabling…'
                        : 'Enable Shadow'}
                    </Button>
                  ) : null}
                  <Button color="inherit" size="small" href="#operations">
                    Review Operations
                  </Button>
                </Stack>
              )}
            >
              Resolution and promotion are locked while Operations activation
              is {humanize(intake?.policy?.activationState || 'not initialized')}.
              {activationRecoveryAvailable
                ? ' Enable Shadow here to unlock the reviewed workflow.'
                : ' Review Operations activation before continuing.'}
            </Alert>
          ) : null}
          {(
            orderPagination?.consistencyMode === 'provider_cursor_live'
            || productPagination?.consistencyMode === 'provider_cursor_live'
          ) ? (
            <Alert severity="warning">
              Faire supplies live cursors rather than time-fenced snapshots.
              Finish each available product or order session promptly. Every staged
              Faire order must use its <strong>Refresh</strong> action for an
              exact current read before validation; use{' '}
              <strong>Check for newer orders</strong> afterward to reconcile
              records that changed while paging.
            </Alert>
          ) : null}

          <Box
            sx={{
              display: 'grid',
              gridTemplateColumns: {
                xs: '1fr',
                sm: 'repeat(2, minmax(0, 1fr))',
                lg: 'repeat(4, minmax(0, 1fr))',
              },
              gap: 1,
            }}
          >
            {[
              {
                label: '1 · Fetch',
                value: latestPagination
                  ? `${humanize(latestPagination.resource)} batch ${
                    latestPagination.batchNumber
                  }`
                  : intake?.run
                    ? `${intake.run.recordsSeen || 0} seen`
                    : 'Not started',
                detail: latestPagination
                  ? `${latestPagination.providerRowsSeen} scanned · ${
                    latestPagination.eligibleOrdersSeen
                  } eligible · ${
                    latestPagination.consistencyMode
                      === 'provider_cursor_live'
                      ? 'live cursor'
                      : 'time-fenced'
                  }`
                  : 'Bounded provider read',
              },
              {
                label: '2 · Resolve',
                value: `${blockerCount} order blockers`,
                detail: `${unresolvedProductCount} product mapping(s) open`,
              },
              {
                label: '3 · Validate',
                value: `${candidateCounts.ready} ready`,
                detail: 'All required evidence checked',
              },
              {
                label: '4 · Promote',
                value: `${candidateCounts.promoted} promoted`,
                detail: 'Canonical transaction only',
              },
            ].map((step) => (
              <Card key={step.label} variant="outlined">
                <CardContent sx={{ '&:last-child': { pb: 2 } }}>
                  <Typography variant="caption" color="text.secondary">
                    {step.label}
                  </Typography>
                  <Typography fontWeight={700}>{step.value}</Typography>
                  <Typography variant="caption" color="text.secondary">
                    {step.detail}
                  </Typography>
                </CardContent>
              </Card>
            ))}
          </Box>

          <Stack
            direction={{ xs: 'column', sm: 'row' }}
            justifyContent="space-between"
            spacing={1}
            alignItems={{ sm: 'center' }}
          >
            <Box>
              <Typography variant="subtitle2" fontWeight={700}>
                {displayName}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                {accountGlobalId} · policy {intake?.policy?.version || 'not reported'}
                {' · '}
                {intake?.policy?.retentionDays
                  ? `${intake.policy.retentionDays}-day candidate retention`
                  : 'retention not reported'}
              </Typography>
            </Box>
            <Button
              variant="outlined"
              startIcon={<RefreshRounded />}
              disabled={Boolean(pendingAction)}
              onClick={() => {
                void reloadWorkflow()
              }}
              sx={actionButtonSx}
            >
              {pendingAction === 'reload'
                ? 'Reloading…'
                : 'Reload workflow'}
            </Button>
          </Stack>

          <Box
            sx={{
              display: 'grid',
              gridTemplateColumns: {
                xs: '1fr',
                md: 'repeat(2, minmax(0, 1fr))',
              },
              gap: 1,
            }}
          >
            {([
              {
                key: 'products',
                title: 'Product catalog intake',
                detail: 'Stage provider variants, then map, create, or exclude each one.',
                pagination: productPagination,
                canFetchNext: canFetchNextProducts,
                fetchAction: productFetchAction,
                fetchRequestKey: productFetchRequestKey,
                fetchCommand: productFetchCommand,
                fetchLabel: productFetchLabel,
                fetchSuccessMessage: productFetchSuccessMessage,
                restartAction: 'fetch-products',
                restartKey:
                  `restart-products:${productPagination?.runGlobalId || 'new'}`,
                restartMessage:
                  `${providerLabel(provider)} catalog intake restarted from the newest products.`,
              },
              {
                key: 'orders',
                title: 'Operational order intake',
                detail: 'Stage open orders only; canonical creation still requires promotion.',
                pagination: orderPagination,
                canFetchNext: canFetchNextOrders,
                fetchAction: orderFetchAction,
                fetchRequestKey: orderFetchRequestKey,
                fetchCommand: orderFetchCommand,
                fetchLabel: orderFetchLabel,
                fetchSuccessMessage: orderFetchSuccessMessage,
                restartAction: 'fetch',
                restartKey:
                  `restart-orders:${orderPagination?.runGlobalId || 'new'}`,
                restartMessage:
                  `${providerLabel(provider)} order intake restarted from the newest eligible orders.`,
              },
            ] as const).map((workflow) => (
              <Card key={workflow.key} variant="outlined">
                <CardContent sx={{ '&:last-child': { pb: 2 } }}>
                  <Stack spacing={1.25}>
                    <Box>
                      <Typography fontWeight={700}>
                        {workflow.title}
                      </Typography>
                      <Typography variant="body2" color="text.secondary">
                        {workflow.detail}
                      </Typography>
                    </Box>
                    {workflow.pagination ? (
                      <Typography variant="caption" color="text.secondary">
                        Batch {workflow.pagination.batchNumber} ·{' '}
                        {workflow.pagination.providerRowsSeen} scanned ·{' '}
                        {workflow.pagination.eligibleOrdersSeen} eligible ·{' '}
                        {humanize(workflow.pagination.state)}
                      </Typography>
                    ) : (
                      <Typography variant="caption" color="text.secondary">
                        No read session has been started.
                      </Typography>
                    )}
                    <Stack
                      direction={{ xs: 'column', sm: 'row' }}
                      spacing={1}
                    >
                      {(
                        workflow.canFetchNext
                        || workflow.pagination?.restartRequired
                      ) ? (
                        <Button
                          variant="outlined"
                          color="warning"
                          disabled={
                            Boolean(pendingAction)
                            || !operatorCommandsAllowed
                          }
                          onClick={() => {
                            void postCommand(
                              workflow.restartAction,
                              workflow.restartKey,
                              { confirmReadOnly: true },
                              workflow.restartMessage,
                            )
                          }}
                          sx={actionButtonSx}
                        >
                          {pendingAction === workflow.restartKey
                            ? 'Restarting…'
                            : 'Restart session'}
                        </Button>
                      ) : null}
                      <Button
                        variant="contained"
                        startIcon={workflow.pagination
                          ? <RefreshRounded />
                          : <CloudDownloadRounded />}
                        disabled={
                          Boolean(pendingAction)
                          || !operatorCommandsAllowed
                        }
                        onClick={() => {
                          void postCommand(
                            workflow.fetchAction,
                            workflow.fetchRequestKey,
                            workflow.fetchCommand,
                            workflow.fetchSuccessMessage,
                          )
                        }}
                        sx={actionButtonSx}
                      >
                        {pendingAction === workflow.fetchRequestKey
                          ? 'Fetching…'
                          : workflow.fetchLabel}
                      </Button>
                    </Stack>
                    {workflow.pagination?.restartRequired ? (
                      <Alert severity="warning">
                        This saved continuation cannot resume. Use the restart
                        action above to begin a new bounded read.
                      </Alert>
                    ) : workflow.pagination?.hasNextBatch ? (
                      <Alert severity="info">
                        More {workflow.key} are available. Fetch the next
                        batch to continue this same session.
                      </Alert>
                    ) : workflow.pagination?.sessionComplete ? (
                      <Alert severity="info">
                        This session is complete. Use the check action when
                        you are ready to read newer provider changes.
                      </Alert>
                    ) : null}
                  </Stack>
                </CardContent>
              </Card>
            ))}
          </Box>

          <Box
            sx={{
              display: 'grid',
              gridTemplateColumns: {
                xs: '1fr 1fr',
                md: 'repeat(4, minmax(0, 1fr))',
              },
              gap: 1,
            }}
          >
            <Typography variant="caption">
              Provider reads: {intake?.evidence?.providerReads
                ?? intake?.run?.providerReads
                ?? 0}
            </Typography>
            <Typography variant="caption">
              Provider writes: {intake?.evidence?.providerWrites
                ?? intake?.run?.providerWrites
                ?? 0}
            </Typography>
            <Typography variant="caption">
              Canonical orders: {intake?.evidence?.canonicalOrdersCreated
                ?? intake?.run?.recordsPromoted
                ?? 0}
            </Typography>
            <Typography variant="caption">
              Cursor advanced: {
                intake?.evidence?.syncCursorAdvanced
                  ?? intake?.run?.syncCursorAdvanced
                  ? 'yes'
                  : 'no'
              }
            </Typography>
          </Box>

          {rejections.length ? (
            <Stack spacing={1}>
              <Alert severity="warning">
                <Typography variant="body2" fontWeight={700}>
                  Provider records need an operator disposition
                </Typography>
                <Typography variant="body2">
                  Valid records continued staging. Retry an order by exact
                  provider identity, or enter an audit reason to exclude any
                  record. Product rejections require exclusion before a
                  corrected catalog revision can be fetched.
                </Typography>
              </Alert>
              {rejections.map((rejection) => {
                const exclusionReason =
                  rejectionReasons[rejection.globalId] || ''
                const retryKey =
                  `retry-rejection:${rejection.globalId}`
                const excludeKey =
                  `exclude-rejection:${rejection.globalId}`
                return (
                  <Card key={rejection.globalId} variant="outlined">
                    <CardContent sx={{ '&:last-child': { pb: 2 } }}>
                      <Stack spacing={1.25}>
                        <Box>
                          <Stack
                            direction={{ xs: 'column', sm: 'row' }}
                            justifyContent="space-between"
                            spacing={0.75}
                          >
                            <Typography fontWeight={700}>
                              {humanize(rejection.resourceType)}{' '}
                              {rejection.externalId}
                            </Typography>
                            <Chip
                              size="small"
                              color="warning"
                              label={rejection.errorCode}
                            />
                          </Stack>
                          <Typography
                            variant="body2"
                            color="text.secondary"
                            sx={{ mt: 0.5, overflowWrap: 'anywhere' }}
                          >
                            {rejection.safeMessage}
                          </Typography>
                        </Box>
                        {rejection.resourceType === 'order' ? (
                          <Button
                            variant="outlined"
                            startIcon={<RefreshRounded />}
                            disabled={
                              Boolean(pendingAction)
                              || !operatorCommandsAllowed
                            }
                            onClick={() => {
                              void postCommand(
                                'retry-rejection',
                                retryKey,
                                {
                                  confirmReadOnly: true,
                                  rejectionGlobalId: rejection.globalId,
                                },
                                'The exact rejected order was read again and restaged for review.',
                              )
                            }}
                            sx={actionButtonSx}
                          >
                            {pendingAction === retryKey
                              ? 'Retrying exact order…'
                              : 'Retry exact order'}
                          </Button>
                        ) : (
                          <Alert severity="info">
                            Exact product-variant retry is unavailable because
                            the provider does not expose a safe identity read.
                            Exclude this revision, correct it in{' '}
                            {providerLabel(provider)}, then use{' '}
                            <strong>Fetch product catalog</strong> above.
                          </Alert>
                        )}
                        <Box
                          sx={{
                            display: 'grid',
                            gridTemplateColumns: {
                              xs: '1fr',
                              sm: '1fr auto',
                            },
                            gap: 1,
                            alignItems: 'start',
                          }}
                        >
                          <TextField
                            label="Exclusion audit reason"
                            value={exclusionReason}
                            onChange={(event) => {
                              setRejectionReasons((current) => ({
                                ...current,
                                [rejection.globalId]: event.target.value,
                              }))
                            }}
                            helperText="Required. This closes only this rejected provider revision."
                            sx={fieldSx}
                          />
                          <Button
                            variant="outlined"
                            color="warning"
                            startIcon={<BlockRounded />}
                            disabled={
                              Boolean(pendingAction)
                              || !operatorCommandsAllowed
                              || !exclusionReason.trim()
                            }
                            onClick={() => {
                              void postCommand(
                                'exclude-rejection',
                                excludeKey,
                                {
                                  rejectionGlobalId: rejection.globalId,
                                  rowVersion: rejection.rowVersion,
                                  reason: exclusionReason.trim(),
                                },
                                'Rejected provider revision excluded with an audit reason.',
                              )
                            }}
                            sx={actionButtonSx}
                          >
                            {pendingAction === excludeKey
                              ? 'Excluding…'
                              : 'Exclude this revision'}
                          </Button>
                        </Box>
                      </Stack>
                    </CardContent>
                  </Card>
                )
              })}
            </Stack>
          ) : null}

          <Divider />

          <Box>
            <Typography variant="h6" fontWeight={700}>
              Product catalog mapping
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Each provider variant must be mapped to an existing ClawPilot
              product, used to create a new product, or explicitly excluded
              with a reason.
            </Typography>
          </Box>

          {!productPagination && productCandidates.length === 0 ? (
            <Alert severity="info">
              Use <strong>Fetch product catalog</strong> above to stage
              provider variants for explicit mapping. A catalog fetch does
              not create products by itself.
            </Alert>
          ) : productCandidates.length === 0 ? (
            <Alert severity="info">
              The current catalog session has no product variants awaiting
              review.
              {productPagination?.hasNextBatch
                ? ' Fetch the next product batch to continue.'
                : ' Check for product changes after the provider catalog changes.'}
            </Alert>
          ) : (
            <Stack spacing={1.5}>
              {productCandidates.map((candidate) => {
                const draft = catalogProductDraft(candidate)
                const mapped = candidate.mappingStatus === 'resolved'
                  && Boolean(candidate.productGlobalId)
                const terminal = terminalStates.has(candidate.state)
                const actionsLocked = (
                  terminal
                  || mapped
                  || !operatorCommandsAllowed
                  || !Number.isInteger(candidate.rowVersion)
                )
                const mapKey =
                  `resolve-catalog-product-existing:${candidate.globalId}`
                const createKey =
                  `resolve-catalog-product-create:${candidate.globalId}`
                const excludeKey =
                  `resolve-catalog-product-exclude:${candidate.globalId}`
                return (
                  <Card key={candidate.globalId} variant="outlined">
                    <CardContent>
                      <Stack spacing={1.5}>
                        <Stack
                          direction={{ xs: 'column', sm: 'row' }}
                          justifyContent="space-between"
                          spacing={1}
                        >
                          <Box>
                            <Typography fontWeight={700}>
                              {candidate.productTitle}
                              {candidate.variantTitle
                                && candidate.variantTitle
                                  !== candidate.productTitle
                                ? ` · ${candidate.variantTitle}`
                                : ''}
                            </Typography>
                            <Typography
                              variant="caption"
                              color="text.secondary"
                              sx={{ overflowWrap: 'anywhere' }}
                            >
                              SKU {candidate.sku || 'unavailable'} · variant{' '}
                              {candidate.externalVariantId} · updated{' '}
                              {formatDate(candidate.sourceUpdatedAt)}
                            </Typography>
                            <Typography
                              variant="caption"
                              color="text.secondary"
                              display="block"
                              sx={{ overflowWrap: 'anywhere' }}
                            >
                              Vendor {candidate.vendor || 'unavailable'} · type{' '}
                              {candidate.productType || 'unavailable'} · barcode{' '}
                              {candidate.barcode || 'unavailable'}
                            </Typography>
                            {candidate.externalInventoryItemId ? (
                              <Typography
                                variant="caption"
                                color="text.secondary"
                                display="block"
                                sx={{ overflowWrap: 'anywhere' }}
                              >
                                Inventory item {candidate.externalInventoryItemId}
                              </Typography>
                            ) : null}
                          </Box>
                          <Stack direction="row" gap={0.5} flexWrap="wrap">
                            <Chip
                              size="small"
                              color={stateColor(candidate.state)}
                              label={humanize(candidate.state)}
                            />
                            <Chip
                              size="small"
                              label={formatMoney(
                                candidate.priceMinor,
                                candidate.currency,
                              )}
                            />
                            {Number.isInteger(candidate.inventoryQuantity) ? (
                              <Chip
                                size="small"
                                label={`Inventory ${
                                  candidate.inventoryQuantity
                                }`}
                              />
                            ) : null}
                            {candidate.compareAtPriceMinor !== null
                            && candidate.compareAtPriceMinor !== undefined ? (
                              <Chip
                                size="small"
                                label={`Compare at ${formatMoney(
                                  candidate.compareAtPriceMinor,
                                  candidate.currency,
                                )}`}
                              />
                            ) : null}
                            {typeof candidate.taxable === 'boolean' ? (
                              <Chip
                                size="small"
                                label={candidate.taxable
                                  ? 'Taxable'
                                  : 'Not taxable'}
                              />
                            ) : null}
                            {typeof candidate.requiresShipping === 'boolean' ? (
                              <Chip
                                size="small"
                                label={candidate.requiresShipping
                                  ? 'Requires shipping'
                                  : 'No shipping required'}
                              />
                            ) : null}
                            {Number.isInteger(candidate.weightGrams) ? (
                              <Chip
                                size="small"
                                label={`${candidate.weightGrams} g`}
                              />
                            ) : null}
                          </Stack>
                        </Stack>

                        {candidate.selectedOptions?.length ? (
                          <Stack direction="row" gap={0.5} flexWrap="wrap">
                            {candidate.selectedOptions.map((option) => (
                              <Chip
                                key={`${option.name}:${option.value}`}
                                size="small"
                                variant="outlined"
                                label={`${option.name}: ${option.value}`}
                              />
                            ))}
                          </Stack>
                        ) : null}

                        {mapped ? (
                          <Alert severity="success">
                            Mapped to ClawPilot product{' '}
                            {candidate.productGlobalId}.
                          </Alert>
                        ) : candidate.state === 'failed' ? (
                          <Alert severity="info">
                            This provider revision was excluded:{' '}
                            {candidate.unsupportedReason
                              || 'operator-confirmed exclusion'}.
                            A later catalog fetch can stage a corrected
                            provider revision.
                          </Alert>
                        ) : candidate.state === 'expired' ? (
                          <Alert severity="info">
                            This retained candidate expired. Use the catalog
                            fetch above to stage the provider&apos;s current
                            revision.
                          </Alert>
                        ) : (
                          <Alert severity="warning">
                            Choose one executable disposition below. SKU and
                            barcode are evidence only; the provider variant ID
                            remains the integration identity.
                          </Alert>
                        )}

                        {!actionsLocked ? (
                          <>
                            <Stack
                              direction={{ xs: 'column', sm: 'row' }}
                              spacing={1}
                              alignItems={{ sm: 'flex-start' }}
                            >
                              <FormControl fullWidth sx={fieldSx}>
                                <InputLabel>Existing product</InputLabel>
                                <Select
                                  label="Existing product"
                                  value={draft.productGlobalId}
                                  onChange={(event) => {
                                    updateCatalogProductDraft(candidate, {
                                      productGlobalId: event.target.value,
                                    })
                                  }}
                                >
                                  <MenuItem value="">
                                    Select a product
                                  </MenuItem>
                                  {productCatalog.map((product) => (
                                    <MenuItem
                                      key={product.globalId}
                                      value={product.globalId}
                                    >
                                      {product.name}
                                      {product.sku
                                        ? ` · ${product.sku}`
                                        : ''}
                                    </MenuItem>
                                  ))}
                                </Select>
                                <FormHelperText>
                                  Creates an account-scoped variant mapping.
                                </FormHelperText>
                              </FormControl>
                              <Button
                                variant="outlined"
                                disabled={
                                  Boolean(pendingAction)
                                  || !draft.productGlobalId
                                }
                                onClick={() => {
                                  void mapCatalogProduct(candidate)
                                }}
                                sx={actionButtonSx}
                              >
                                {pendingAction === mapKey
                                  ? 'Mapping…'
                                  : 'Map existing product'}
                              </Button>
                            </Stack>

                            <Divider>
                              <Typography
                                variant="caption"
                                color="text.secondary"
                              >
                                or create and map
                              </Typography>
                            </Divider>

                            <Box
                              sx={{
                                display: 'grid',
                                gridTemplateColumns: {
                                  xs: '1fr',
                                  sm: '2fr 1fr',
                                  md: '2fr 1fr 1fr 1fr',
                                },
                                gap: 1,
                              }}
                            >
                              <TextField
                                label="Product name"
                                value={draft.name}
                                onChange={(event) => {
                                  updateCatalogProductDraft(candidate, {
                                    name: event.target.value,
                                  })
                                }}
                                sx={fieldSx}
                              />
                              <TextField
                                label="SKU (optional)"
                                value={draft.sku}
                                onChange={(event) => {
                                  updateCatalogProductDraft(candidate, {
                                    sku: event.target.value,
                                  })
                                }}
                                inputProps={{ maxLength: 25 }}
                                sx={fieldSx}
                              />
                              <TextField
                                label="Price (minor units)"
                                type="number"
                                value={draft.unitPriceMinor}
                                onChange={(event) => {
                                  updateCatalogProductDraft(candidate, {
                                    unitPriceMinor: event.target.value,
                                  })
                                }}
                                inputProps={{ min: 0, step: 1 }}
                                sx={fieldSx}
                              />
                              <TextField
                                label="Currency"
                                value={draft.currency}
                                onChange={(event) => {
                                  updateCatalogProductDraft(candidate, {
                                    currency: normalizeCurrency(
                                      event.target.value,
                                    ),
                                  })
                                }}
                                inputProps={{
                                  maxLength: 3,
                                  autoCapitalize: 'characters',
                                }}
                                sx={fieldSx}
                              />
                            </Box>
                            <Button
                              variant="outlined"
                              disabled={
                                Boolean(pendingAction)
                                || !draft.name.trim()
                                || !validPrice(draft)
                              }
                              onClick={() => {
                                void createCatalogProduct(candidate)
                              }}
                              sx={actionButtonSx}
                            >
                              {pendingAction === createKey
                                ? 'Creating…'
                                : 'Create and map product'}
                            </Button>

                            <Divider>
                              <Typography
                                variant="caption"
                                color="text.secondary"
                              >
                                or exclude this revision
                              </Typography>
                            </Divider>

                            <Box
                              sx={{
                                display: 'grid',
                                gridTemplateColumns: {
                                  xs: '1fr',
                                  sm: '1fr auto',
                                },
                                gap: 1,
                                alignItems: 'start',
                              }}
                            >
                              <TextField
                                label="Catalog exclusion reason"
                                value={draft.exclusionReason}
                                onChange={(event) => {
                                  updateCatalogProductDraft(candidate, {
                                    exclusionReason: event.target.value,
                                  })
                                }}
                                helperText="Required and audited. A future provider revision may be staged again."
                                sx={fieldSx}
                              />
                              <Button
                                variant="outlined"
                                color="warning"
                                startIcon={<BlockRounded />}
                                disabled={
                                  Boolean(pendingAction)
                                  || !draft.exclusionReason.trim()
                                }
                                onClick={() => {
                                  void excludeCatalogProduct(candidate)
                                }}
                                sx={actionButtonSx}
                              >
                                {pendingAction === excludeKey
                                  ? 'Excluding…'
                                  : 'Exclude product revision'}
                              </Button>
                            </Box>
                          </>
                        ) : null}
                      </Stack>
                    </CardContent>
                  </Card>
                )
              })}
            </Stack>
          )}

          <Divider />

          <Box>
            <Typography variant="h6" fontWeight={700}>
              Operational order candidates
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Resolve and validate held orders before explicitly promoting
              each canonical transaction.
            </Typography>
          </Box>

          {!orderPagination && candidates.length === 0 ? (
            <Alert severity="info">
              Select <strong>Fetch operational orders</strong> to create
              bounded held candidates. Nothing is imported until a ready
              candidate is explicitly promoted.
            </Alert>
          ) : candidates.length === 0 ? (
            <Alert severity="info">
              This batch produced no eligible order candidate.
              {orderPagination?.hasNextBatch
                ? ' Fetch the next batch to continue the same session.'
                : ' Check for newer orders after the provider data changes.'}
            </Alert>
          ) : (
            <Stack spacing={2}>
              {candidates.map((candidate) => {
                const unavailableReason = candidateUnavailableReason(candidate)
                const candidateLocked = Boolean(unavailableReason)
                  || !operatorCommandsAllowed
                const refreshLocked = (
                  !Number.isInteger(candidate.rowVersion)
                  || candidate.state === 'promoted'
                  || candidate.state === 'expired'
                )
                const address = candidate.shipTo?.address
                const manualAddress = addressDraft(candidate)
                const addressComplete = [
                  manualAddress.name,
                  manualAddress.line1,
                  manualAddress.city,
                  manualAddress.region,
                  manualAddress.postalCode,
                  manualAddress.country,
                ].slice(0, -1).every((value) => value.trim())
                  && validCountryCode(manualAddress.country)
                const providerAddressComplete = address
                  ? [
                      address.name,
                      address.line1,
                      address.city,
                      address.region,
                      address.postalCode,
                    ].every((value) => Boolean(value))
                      && validCountryCode(address.country)
                  : false
                const customer = customerDraft(candidate)
                const delivery = deliveryDraft(candidate)
                const promotionReason = candidate.state === 'ready'
                  ? ''
                  : candidate.unsupportedReason
                    || (candidate.blockers?.length
                      ? `${candidate.blockers.length} blocker(s) still require resolution and validation.`
                      : 'Run validation successfully before promotion.')
                return (
                  <Card key={candidate.globalId} variant="outlined">
                    <CardContent>
                      <Stack spacing={2}>
                        <Stack
                          direction={{ xs: 'column', sm: 'row' }}
                          justifyContent="space-between"
                          spacing={1}
                        >
                          <Box>
                            <Typography fontWeight={700}>
                              Order {candidate.orderNumber
                                || candidate.externalOrderId}
                            </Typography>
                            <Typography
                              variant="caption"
                              color="text.secondary"
                            >
                              {candidate.globalId} · provider update{' '}
                              {formatDate(candidate.sourceUpdatedAt)}
                            </Typography>
                          </Box>
                          <Stack direction="row" gap={0.75} flexWrap="wrap">
                            <Chip
                              size="small"
                              color={stateColor(candidate.state)}
                              label={humanize(candidate.state)}
                            />
                            <Chip
                              size="small"
                              label={formatMoney(
                                candidate.totalMinor,
                                candidate.currency,
                              )}
                            />
                            {candidate.providerStatus ? (
                              <Chip
                                size="small"
                                label={`Raw order ${candidate.providerStatus}`}
                              />
                            ) : null}
                            {candidate.financialStatus ? (
                              <Chip
                                size="small"
                                label={`Raw payment ${candidate.financialStatus}`}
                              />
                            ) : null}
                            {candidate.fulfillmentStatus ? (
                              <Chip
                                size="small"
                                label={`Raw fulfillment ${candidate.fulfillmentStatus}`}
                              />
                            ) : null}
                            {candidate.returnStatus ? (
                              <Chip
                                size="small"
                                label={`Raw return ${candidate.returnStatus}`}
                              />
                            ) : null}
                            {candidate.normalizedOrderStatus ? (
                              <Chip
                                size="small"
                                color="info"
                                variant="outlined"
                                label={`ClawPilot order ${humanize(
                                  candidate.normalizedOrderStatus,
                                )}`}
                              />
                            ) : null}
                            {candidate.normalizedPaymentStatus ? (
                              <Chip
                                size="small"
                                color="info"
                                variant="outlined"
                                label={`ClawPilot payment ${humanize(
                                  candidate.normalizedPaymentStatus,
                                )}`}
                              />
                            ) : null}
                            {candidate.normalizedFulfillmentStatus ? (
                              <Chip
                                size="small"
                                color="info"
                                variant="outlined"
                                label={`ClawPilot fulfillment ${humanize(
                                  candidate.normalizedFulfillmentStatus,
                                )}`}
                              />
                            ) : null}
                            {candidate.normalizedReturnStatus ? (
                              <Chip
                                size="small"
                                color="info"
                                variant="outlined"
                                label={`ClawPilot return ${humanize(
                                  candidate.normalizedReturnStatus,
                                )}`}
                              />
                            ) : null}
                          </Stack>
                        </Stack>

                        {candidate.canonicalOrderGlobalId ? (
                          <Alert severity="success">
                            Canonical order {candidate.canonicalOrderGlobalId}
                            {' '}was created by promotion.
                          </Alert>
                        ) : null}
                        {candidate.unsupportedReason ? (
                          <Alert severity="warning">
                            Unsupported: {candidate.unsupportedReason}
                          </Alert>
                        ) : null}
                        {unavailableReason ? (
                          <Alert severity="info">{unavailableReason}</Alert>
                        ) : null}

                        {candidate.blockers?.length ? (
                          <Alert severity="warning">
                            <Typography variant="body2" fontWeight={700}>
                              Resolution required
                            </Typography>
                            <Stack component="ul" spacing={0.5} sx={{ pl: 2.5 }}>
                              {candidate.blockers.map((blocker) => (
                                <Typography
                                  key={`${blocker.code}:${blocker.label}`}
                                  component="li"
                                  variant="body2"
                                >
                                  {blocker.label} — {blocker.action}
                                  {blocker.terminal
                                    ? ' This provider condition is terminal.'
                                    : ''}
                                </Typography>
                              ))}
                            </Stack>
                          </Alert>
                        ) : null}

                        {!candidateLocked ? (
                          <>
                        <Accordion disableGutters variant="outlined">
                          <AccordionSummary
                            expandIcon={<ExpandMoreRounded />}
                          >
                            <Box>
                              <Typography fontWeight={700}>
                                Products, order-time price, and packages
                              </Typography>
                              <Typography
                                variant="caption"
                                color="text.secondary"
                              >
                                Bind each exact provider variant; SKU is
                                evidence, not identity.
                              </Typography>
                            </Box>
                          </AccordionSummary>
                          <AccordionDetails>
                            <Stack spacing={2}>
                              {(candidate.lines || []).map((line) => {
                                const draft = productDraft(candidate, line)
                                const packaging = packageDraft(candidate, line)
                                const selectedProduct = productCatalog.find(
                                  (product) => product.globalId
                                    === (draft.productGlobalId
                                      || line.productGlobalId),
                                )
                                const packageProfiles =
                                  selectedProduct?.packageProfiles || []
                                const manualPackageValid = [
                                  packaging.weightGrams,
                                  packaging.length,
                                  packaging.width,
                                  packaging.height,
                                ].every((value) => positiveInteger(value))
                                return (
                                  <Card
                                    key={line.globalId}
                                    variant="outlined"
                                  >
                                    <CardContent>
                                      <Stack spacing={1.5}>
                                        <Stack
                                          direction={{
                                            xs: 'column',
                                            sm: 'row',
                                          }}
                                          justifyContent="space-between"
                                          spacing={1}
                                        >
                                          <Box>
                                            <Typography fontWeight={700}>
                                              {line.title}
                                            </Typography>
                                            <Typography
                                              variant="caption"
                                              color="text.secondary"
                                            >
                                              Qty {line.quantity} · SKU{' '}
                                              {line.sku || 'unavailable'} ·{' '}
                                              variant{' '}
                                              {line.externalVariantId
                                                || 'unavailable'}
                                            </Typography>
                                          </Box>
                                          <Stack
                                            direction="row"
                                            gap={0.5}
                                            flexWrap="wrap"
                                          >
                                            <Chip
                                              size="small"
                                              label={`Mapping ${
                                                line.mappingStatus
                                                  || 'unresolved'
                                              }`}
                                            />
                                            <Chip
                                              size="small"
                                              label={`Package ${
                                                line.packageStatus
                                                  || 'unresolved'
                                              }`}
                                            />
                                          </Stack>
                                        </Stack>

                                        <Box
                                          sx={{
                                            display: 'grid',
                                            gridTemplateColumns: {
                                              xs: '1fr',
                                              sm: '2fr 1fr',
                                            },
                                            gap: 1,
                                          }}
                                        >
                                          <TextField
                                            label="Order-time price (minor units)"
                                            type="number"
                                            value={draft.unitPriceMinor}
                                            onChange={(event) => {
                                              updateProductDraft(
                                                candidate,
                                                line,
                                                {
                                                  unitPriceMinor:
                                                    event.target.value,
                                                },
                                              )
                                            }}
                                            inputProps={{ min: 0, step: 1 }}
                                            helperText="Required. For USD, $12.34 is 1234. The current product price is never substituted."
                                            sx={fieldSx}
                                          />
                                          <TextField
                                            label="Currency"
                                            value={draft.currency}
                                            onChange={(event) => {
                                              updateProductDraft(
                                                candidate,
                                                line,
                                                {
                                                  currency: normalizeCurrency(
                                                    event.target.value,
                                                  ),
                                                },
                                              )
                                            }}
                                            inputProps={{
                                              maxLength: 3,
                                              autoCapitalize: 'characters',
                                            }}
                                            helperText="ISO 4217"
                                            sx={fieldSx}
                                          />
                                        </Box>

                                        <Stack
                                          direction={{
                                            xs: 'column',
                                            sm: 'row',
                                          }}
                                          spacing={1}
                                          alignItems={{
                                            sm: 'flex-start',
                                          }}
                                        >
                                          <FormControl
                                            fullWidth
                                            sx={fieldSx}
                                          >
                                            <InputLabel>
                                              Existing product
                                            </InputLabel>
                                            <Select
                                              label="Existing product"
                                              value={draft.productGlobalId}
                                              onChange={(event) => {
                                                updateProductDraft(
                                                  candidate,
                                                  line,
                                                  {
                                                    productGlobalId:
                                                      event.target.value,
                                                  },
                                                )
                                              }}
                                            >
                                              <MenuItem value="">
                                                Select a product
                                              </MenuItem>
                                              {productCatalog.map((product) => (
                                                <MenuItem
                                                  key={product.globalId}
                                                  value={product.globalId}
                                                >
                                                  {product.name}
                                                  {product.sku
                                                    ? ` · ${product.sku}`
                                                    : ''}
                                                </MenuItem>
                                              ))}
                                            </Select>
                                            <FormHelperText>
                                              Confirms the exact account-scoped
                                              provider variant mapping.
                                            </FormHelperText>
                                          </FormControl>
                                          <Button
                                            variant="outlined"
                                            disabled={
                                              candidateLocked
                                              || Boolean(pendingAction)
                                              || !draft.productGlobalId
                                              || !validPrice(draft)
                                            }
                                            onClick={() => {
                                              void resolveExistingProduct(
                                                candidate,
                                                line,
                                              )
                                            }}
                                            sx={actionButtonSx}
                                          >
                                            Select and bind
                                          </Button>
                                        </Stack>

                                        <Divider>
                                          <Typography
                                            variant="caption"
                                            color="text.secondary"
                                          >
                                            or create explicitly
                                          </Typography>
                                        </Divider>

                                        <Box
                                          sx={{
                                            display: 'grid',
                                            gridTemplateColumns: {
                                              xs: '1fr',
                                              sm: '2fr 1fr auto',
                                            },
                                            gap: 1,
                                            alignItems: 'start',
                                          }}
                                        >
                                          <TextField
                                            label="New product name"
                                            value={draft.name}
                                            onChange={(event) => {
                                              updateProductDraft(
                                                candidate,
                                                line,
                                                { name: event.target.value },
                                              )
                                            }}
                                            sx={fieldSx}
                                          />
                                          <TextField
                                            label="SKU"
                                            value={draft.sku}
                                            onChange={(event) => {
                                              updateProductDraft(
                                                candidate,
                                                line,
                                                { sku: event.target.value },
                                              )
                                            }}
                                            sx={fieldSx}
                                          />
                                          <Button
                                            variant="outlined"
                                            disabled={
                                              candidateLocked
                                              || Boolean(pendingAction)
                                              || !draft.name.trim()
                                              || !validPrice(draft)
                                            }
                                            onClick={() => {
                                              void createProduct(
                                                candidate,
                                                line,
                                              )
                                            }}
                                            sx={actionButtonSx}
                                          >
                                            Create and bind
                                          </Button>
                                        </Box>

                                        {line.requiresShipping !== false ? (
                                          <>
                                        <Divider />

                                        <Stack spacing={1}>
                                          <Typography
                                            variant="subtitle2"
                                            fontWeight={700}
                                          >
                                            Package resolution
                                          </Typography>
                                          {packageProfiles.length ? (
                                            <Stack
                                              direction={{
                                                xs: 'column',
                                                sm: 'row',
                                              }}
                                              spacing={1}
                                              alignItems={{
                                                sm: 'flex-start',
                                              }}
                                            >
                                              <FormControl
                                                fullWidth
                                                sx={fieldSx}
                                              >
                                                <InputLabel>
                                                  Package profile
                                                </InputLabel>
                                                <Select
                                                  label="Package profile"
                                                  value={
                                                    packaging.packageProfileGlobalId
                                                  }
                                                  onChange={(event) => {
                                                    updatePackageDraft(
                                                      candidate,
                                                      line,
                                                      {
                                                        packageProfileGlobalId:
                                                          event.target.value,
                                                      },
                                                    )
                                                  }}
                                                >
                                                  <MenuItem value="">
                                                    Select a package profile
                                                  </MenuItem>
                                                  {packageProfiles.map(
                                                    (profile) => (
                                                      <MenuItem
                                                        key={profile.globalId}
                                                        value={profile.globalId}
                                                      >
                                                        {profile.label} ·{' '}
                                                        {profile.weightGrams
                                                          || '?'} g ·{' '}
                                                        {dimensionsLabel(
                                                          profile.dimensionsMm,
                                                        )}
                                                      </MenuItem>
                                                    ),
                                                  )}
                                                </Select>
                                              </FormControl>
                                              <Button
                                                variant="outlined"
                                                disabled={
                                                  candidateLocked
                                                  || Boolean(pendingAction)
                                                  || !packaging
                                                    .packageProfileGlobalId
                                                }
                                                onClick={() => {
                                                  void resolvePackageProfile(
                                                    candidate,
                                                    line,
                                                  )
                                                }}
                                                sx={actionButtonSx}
                                              >
                                                Use profile
                                              </Button>
                                            </Stack>
                                          ) : (
                                            <Alert severity="info">
                                              No active package profile is
                                              available for the selected
                                              product. Enter order-specific
                                              facts below.
                                            </Alert>
                                          )}
                                          <Box
                                            sx={{
                                              display: 'grid',
                                              gridTemplateColumns: {
                                                xs: '1fr 1fr',
                                                md: 'repeat(5, 1fr)',
                                              },
                                              gap: 1,
                                            }}
                                          >
                                            {[
                                              ['weightGrams', 'Weight g'],
                                              ['length', 'Length mm'],
                                              ['width', 'Width mm'],
                                              ['height', 'Height mm'],
                                            ].map(([field, label]) => (
                                              <TextField
                                                key={field}
                                                label={label}
                                                type="number"
                                                value={
                                                  packaging[
                                                    field as keyof PackageDraft
                                                  ]
                                                }
                                                onChange={(event) => {
                                                  updatePackageDraft(
                                                    candidate,
                                                    line,
                                                    {
                                                      [field]:
                                                        event.target.value,
                                                    },
                                                  )
                                                }}
                                                inputProps={{
                                                  min: 1,
                                                  step: 1,
                                                }}
                                                sx={fieldSx}
                                              />
                                            ))}
                                            <Button
                                              variant="outlined"
                                              disabled={
                                                candidateLocked
                                                || Boolean(pendingAction)
                                                || !manualPackageValid
                                              }
                                              onClick={() => {
                                                void resolveManualPackage(
                                                  candidate,
                                                  line,
                                                )
                                              }}
                                              sx={actionButtonSx}
                                            >
                                              Use manual facts
                                            </Button>
                                          </Box>
                                        </Stack>
                                          </>
                                        ) : (
                                          <Alert severity="info">
                                            This line does not require shipping,
                                            so package resolution is already
                                            satisfied.
                                          </Alert>
                                        )}
                                      </Stack>
                                    </CardContent>
                                  </Card>
                                )
                              })}
                            </Stack>
                          </AccordionDetails>
                        </Accordion>

                        <Accordion disableGutters variant="outlined">
                          <AccordionSummary
                            expandIcon={<ExpandMoreRounded />}
                          >
                            <Box>
                              <Typography fontWeight={700}>
                                Customer and ship-to
                              </Typography>
                              <Typography
                                variant="caption"
                                color="text.secondary"
                              >
                                Order snapshots never overwrite current CRM
                                master data.
                              </Typography>
                            </Box>
                          </AccordionSummary>
                          <AccordionDetails>
                            <Stack spacing={2}>
                              <Stack
                                direction={{ xs: 'column', sm: 'row' }}
                                spacing={1}
                                alignItems={{ sm: 'flex-start' }}
                              >
                                <FormControl fullWidth sx={fieldSx}>
                                  <InputLabel>Existing customer</InputLabel>
                                  <Select
                                    label="Existing customer"
                                    value={customer.customerGlobalId}
                                    onChange={(event) => {
                                      updateCustomerDraft(candidate, {
                                        customerGlobalId: event.target.value,
                                      })
                                    }}
                                  >
                                    <MenuItem value="">
                                      Select a CRM organization
                                    </MenuItem>
                                    {customerCatalog.map((entry) => (
                                      <MenuItem
                                        key={entry.globalId}
                                        value={entry.globalId}
                                      >
                                        {entry.name}
                                        {entry.email
                                          ? ` · ${entry.email}`
                                          : ''}
                                      </MenuItem>
                                    ))}
                                  </Select>
                                </FormControl>
                                <Button
                                  variant="outlined"
                                  disabled={
                                    candidateLocked
                                    || Boolean(pendingAction)
                                    || !customer.customerGlobalId
                                  }
                                  onClick={() => {
                                    void resolveExistingCustomer(candidate)
                                  }}
                                  sx={actionButtonSx}
                                >
                                  Select customer
                                </Button>
                              </Stack>

                              <Divider>
                                <Typography
                                  variant="caption"
                                  color="text.secondary"
                                >
                                  or create a separate provider customer
                                </Typography>
                              </Divider>

                              <Alert severity="info">
                                Creation uses this sales-channel connection&apos;s
                                provider customer identity. It never updates a
                                same-name CRM organization. Select an existing
                                customer above when the order belongs to one.
                              </Alert>

                              <Box
                                sx={{
                                  display: 'grid',
                                  gridTemplateColumns: {
                                    xs: '1fr',
                                    sm: 'repeat(3, 1fr)',
                                  },
                                  gap: 1,
                                }}
                              >
                                <TextField
                                  label="Organization name"
                                  value={customer.name}
                                  onChange={(event) => {
                                    updateCustomerDraft(candidate, {
                                      name: event.target.value,
                                    })
                                  }}
                                  sx={fieldSx}
                                />
                                <TextField
                                  label="Email (optional)"
                                  type="email"
                                  value={customer.email}
                                  onChange={(event) => {
                                    updateCustomerDraft(candidate, {
                                      email: event.target.value,
                                    })
                                  }}
                                  sx={fieldSx}
                                />
                                <TextField
                                  label="Phone (optional)"
                                  value={customer.phone}
                                  onChange={(event) => {
                                    updateCustomerDraft(candidate, {
                                      phone: event.target.value,
                                    })
                                  }}
                                  sx={fieldSx}
                                />
                              </Box>
                              <Button
                                variant="outlined"
                                disabled={
                                  candidateLocked
                                  || Boolean(pendingAction)
                                  || !customer.name.trim()
                                }
                                onClick={() => {
                                  void createCustomer(candidate)
                                }}
                                sx={actionButtonSx}
                              >
                                Create and assign customer
                              </Button>

                              {candidate.requiresShipping !== false ? (
                                <>
                              <Divider />

                              <Box>
                                <Typography
                                  variant="subtitle2"
                                  fontWeight={700}
                                >
                                  Provider ship-to snapshot
                                </Typography>
                                <Typography
                                  variant="body2"
                                  color="text.secondary"
                                  sx={{
                                    whiteSpace: 'pre-line',
                                    overflowWrap: 'anywhere',
                                    mt: 0.5,
                                  }}
                                >
                                  {address
                                    ? [
                                        address.name,
                                        address.line1,
                                        address.line2,
                                        [
                                          address.city,
                                          address.region,
                                          address.postalCode,
                                        ].filter(Boolean).join(', '),
                                        address.country,
                                      ].filter(Boolean).join('\n')
                                    : 'Provider address unavailable or redacted.'}
                                </Typography>
                                <Button
                                  variant="outlined"
                                  disabled={
                                    candidateLocked
                                    || Boolean(pendingAction)
                                    || !providerAddressComplete
                                  }
                                  onClick={() => {
                                    if (address) {
                                      void confirmAddress(
                                        candidate,
                                        address,
                                        'provider',
                                      )
                                    }
                                  }}
                                  sx={{ ...actionButtonSx, mt: 1 }}
                                >
                                  Confirm provider snapshot
                                </Button>
                                {!providerAddressComplete ? (
                                  <Typography
                                    variant="caption"
                                    color="text.secondary"
                                    display="block"
                                    sx={{ mt: 0.5 }}
                                  >
                                    Provider confirmation is unavailable
                                    because the snapshot is incomplete. Enter
                                    the address manually.
                                  </Typography>
                                ) : null}
                              </Box>

                              <Box
                                sx={{
                                  display: 'grid',
                                  gridTemplateColumns: {
                                    xs: '1fr',
                                    sm: 'repeat(2, 1fr)',
                                    md: 'repeat(3, 1fr)',
                                  },
                                  gap: 1,
                                }}
                              >
                                {([
                                  ['name', 'Recipient name'],
                                  ['line1', 'Address line 1'],
                                  ['line2', 'Address line 2 (optional)'],
                                  ['city', 'City'],
                                  ['region', 'State / region'],
                                  ['postalCode', 'Postal code'],
                                  ['country', 'Country code'],
                                ] as const).map(([field, label]) => (
                                  <TextField
                                    key={field}
                                    label={label}
                                    value={manualAddress[field]}
                                    onChange={(event) => {
                                      updateAddressDraft(candidate, {
                                        [field]: field === 'country'
                                          ? event.target.value
                                            .trim()
                                            .toUpperCase()
                                            .slice(0, 3)
                                          : event.target.value,
                                      })
                                    }}
                                    inputProps={field === 'country'
                                      ? {
                                          maxLength: 3,
                                          autoCapitalize: 'characters',
                                        }
                                      : undefined}
                                    sx={fieldSx}
                                  />
                                ))}
                              </Box>
                              <Button
                                variant="outlined"
                                disabled={
                                  candidateLocked
                                  || Boolean(pendingAction)
                                  || !addressComplete
                                }
                                onClick={() => {
                                  void confirmAddress(
                                    candidate,
                                    manualAddress,
                                    'manual',
                                  )
                                }}
                                sx={actionButtonSx}
                              >
                                Use manual ship-to
                              </Button>
                                </>
                              ) : (
                                <Alert severity="info">
                                  This order does not require shipping, so no
                                  ship-to address is required.
                                </Alert>
                              )}
                            </Stack>
                          </AccordionDetails>
                        </Accordion>

                        {candidate.requiresShipping !== false ? (
                        <Accordion disableGutters variant="outlined">
                          <AccordionSummary
                            expandIcon={<ExpandMoreRounded />}
                          >
                            <Box>
                              <Typography fontWeight={700}>
                                Requested delivery
                              </Typography>
                              <Typography
                                variant="caption"
                                color="text.secondary"
                              >
                                Provider date, explicit UTC instant, or the
                                versioned default SLA.
                              </Typography>
                            </Box>
                          </AccordionSummary>
                          <AccordionDetails>
                            <Stack spacing={1.5}>
                              <FormControl fullWidth sx={fieldSx}>
                                <InputLabel>Delivery decision</InputLabel>
                                <Select
                                  label="Delivery decision"
                                  value={delivery.mode}
                                  onChange={(event) => {
                                    updateDeliveryDraft(candidate, {
                                      mode: event.target.value as
                                        DeliveryDraft['mode'],
                                    })
                                  }}
                                >
                                  <MenuItem
                                    value="provider"
                                    disabled={
                                      !candidate.delivery
                                        ?.requestedDeliveryAt
                                    }
                                  >
                                    Provider date ·{' '}
                                    {candidate.delivery?.requestedDeliveryAt
                                      ? formatDate(
                                          candidate.delivery
                                            .requestedDeliveryAt,
                                        )
                                      : 'unavailable'}
                                  </MenuItem>
                                  <MenuItem value="manual">
                                    Enter requested delivery
                                  </MenuItem>
                                  <MenuItem value="default_sla">
                                    Use versioned default SLA
                                  </MenuItem>
                                </Select>
                                {!candidate.delivery?.requestedDeliveryAt ? (
                                  <FormHelperText>
                                    Provider-date selection is unavailable
                                    because {providerLabel(provider)} did not
                                    supply one.
                                  </FormHelperText>
                                ) : null}
                              </FormControl>
                              {delivery.mode === 'manual' ? (
                                <TextField
                                  label="Requested delivery"
                                  type="datetime-local"
                                  value={delivery.requestedDeliveryAt}
                                  onChange={(event) => {
                                    updateDeliveryDraft(candidate, {
                                      requestedDeliveryAt:
                                        event.target.value,
                                    })
                                  }}
                                  InputLabelProps={{ shrink: true }}
                                  helperText="Entered in your browser timezone and stored as UTC."
                                  sx={fieldSx}
                                />
                              ) : null}
                              <Button
                                variant="outlined"
                                disabled={
                                  candidateLocked
                                  || Boolean(pendingAction)
                                  || (delivery.mode === 'provider'
                                    && !candidate.delivery
                                      ?.requestedDeliveryAt)
                                  || (delivery.mode === 'manual'
                                    && !delivery.requestedDeliveryAt)
                                }
                                onClick={() => {
                                  void resolveDelivery(candidate)
                                }}
                                sx={actionButtonSx}
                              >
                                Save delivery decision
                              </Button>
                            </Stack>
                          </AccordionDetails>
                        </Accordion>
                        ) : (
                          <Alert severity="info">
                            Requested delivery and package decisions are not
                            required for this non-shipping order.
                          </Alert>
                        )}
                          </>
                        ) : null}

                        <Divider />

                        <Stack
                          direction={{ xs: 'column', md: 'row' }}
                          spacing={1}
                          alignItems={{ md: 'flex-start' }}
                          flexWrap="wrap"
                        >
                          <Button
                            variant="outlined"
                            startIcon={<RefreshRounded />}
                            disabled={
                              refreshLocked || Boolean(pendingAction)
                            }
                            onClick={() => {
                              void postCommand(
                                'refresh',
                                `refresh:${candidate.globalId}`,
                                {
                                  candidateGlobalId: candidate.globalId,
                                  rowVersion: candidate.rowVersion,
                                  confirmReadOnly: true,
                                },
                                'Candidate refreshed from the provider. Review any changed evidence.',
                              )
                            }}
                            sx={actionButtonSx}
                          >
                            Refresh
                          </Button>
                          <Button
                            variant="outlined"
                            startIcon={<CheckCircleOutlineRounded />}
                            disabled={
                              candidateLocked || Boolean(pendingAction)
                            }
                            onClick={() => {
                              void postCommand(
                                'validate',
                                `validate:${candidate.globalId}`,
                                {
                                  candidateGlobalId: candidate.globalId,
                                  rowVersion: candidate.rowVersion,
                                },
                                'Candidate validation completed.',
                              )
                            }}
                            sx={actionButtonSx}
                          >
                            Validate
                          </Button>
                          <Button
                            variant="contained"
                            color="success"
                            startIcon={<PublishRounded />}
                            disabled={
                              Boolean(pendingAction)
                              || candidate.state !== 'ready'
                            }
                            onClick={() => {
                              void postCommand(
                                'promote',
                                `promote:${candidate.globalId}`,
                                {
                                  candidateGlobalId: candidate.globalId,
                                  rowVersion: candidate.rowVersion,
                                  confirmProviderWriteOff: true,
                                },
                                'Candidate promoted to one canonical ClawPilot order.',
                              )
                            }}
                            sx={actionButtonSx}
                          >
                            Promote canonical order
                          </Button>
                        </Stack>

                        {candidate.state !== 'ready'
                          && candidate.state !== 'promoted' ? (
                          <Typography
                            variant="caption"
                            color="text.secondary"
                          >
                            Promotion unavailable: {promotionReason}
                          </Typography>
                        ) : null}

                        {!terminalStates.has(candidate.state) ? (
                          <Box
                            sx={{
                              display: 'grid',
                              gridTemplateColumns: {
                                xs: '1fr',
                                sm: '1fr auto',
                              },
                              gap: 1,
                              alignItems: 'start',
                            }}
                          >
                            <TextField
                              label="Unsupported provider reason"
                              value={
                                unsupportedReasons[candidate.globalId] || ''
                              }
                              onChange={(event) => {
                                setUnsupportedReasons((current) => ({
                                  ...current,
                                  [candidate.globalId]: event.target.value,
                                }))
                              }}
                              helperText="Use only when refresh or an available resolution cannot safely complete this provider record."
                              sx={fieldSx}
                            />
                            <Button
                              variant="outlined"
                              color="warning"
                              startIcon={<BlockRounded />}
                              disabled={
                                Boolean(pendingAction)
                                || !operatorCommandsAllowed
                                || !(unsupportedReasons[
                                  candidate.globalId
                                ] || '').trim()
                              }
                              onClick={() => {
                                const reason = (
                                  unsupportedReasons[candidate.globalId]
                                  || ''
                                ).trim()
                                void postCommand(
                                  'mark-unsupported',
                                  `mark-unsupported:${candidate.globalId}`,
                                  {
                                    candidateGlobalId: candidate.globalId,
                                    rowVersion: candidate.rowVersion,
                                    reasonCode: 'operator_confirmed_unsupported',
                                    reason,
                                  },
                                  'Candidate marked unsupported with an operator reason.',
                                )
                              }}
                              sx={actionButtonSx}
                            >
                              Mark unsupported
                            </Button>
                          </Box>
                        ) : null}
                      </Stack>
                    </CardContent>
                  </Card>
                )
              })}
            </Stack>
          )}
        </Stack>
      </AccordionDetails>
    </Accordion>
  )
}
