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
import FormHelperText from '@mui/material/FormHelperText'
import IconButton from '@mui/material/IconButton'
import InputLabel from '@mui/material/InputLabel'
import ListItemText from '@mui/material/ListItemText'
import MenuItem from '@mui/material/MenuItem'
import Select from '@mui/material/Select'
import Stack from '@mui/material/Stack'
import Switch from '@mui/material/Switch'
import Tab from '@mui/material/Tab'
import TablePagination from '@mui/material/TablePagination'
import Tabs from '@mui/material/Tabs'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import AddCircleOutlineRounded from '@mui/icons-material/AddCircleOutlineRounded'
import BlockRounded from '@mui/icons-material/BlockRounded'
import CheckCircleOutlineRounded from '@mui/icons-material/CheckCircleOutlineRounded'
import CloudDownloadRounded from '@mui/icons-material/CloudDownloadRounded'
import CloseRounded from '@mui/icons-material/CloseRounded'
import ExpandMoreRounded from '@mui/icons-material/ExpandMoreRounded'
import FileDownloadRounded from '@mui/icons-material/FileDownloadRounded'
import FileUploadRounded from '@mui/icons-material/FileUploadRounded'
import Inventory2Rounded from '@mui/icons-material/Inventory2Rounded'
import PublishRounded from '@mui/icons-material/PublishRounded'
import RefreshRounded from '@mui/icons-material/RefreshRounded'
import { useMeasurementSystem } from '@/components/measurements/MeasurementSystemProvider'
import {
  CommerceIntakeCsvError,
  exportCommerceIssueSummaryCsv,
  exportCommerceOrderSummaryCsv,
  exportCommerceProductReviewCsv,
  formatCommerceMoneyMajor,
  parseCommerceMoneyMajor,
  parseCommerceProductReviewCsv,
  type CommerceProductReviewDecision,
  type CommerceProductReviewImportResult,
} from '@/lib/integrations/commerceIntakeCsv'
import { commerceProductDisplayName } from '@/lib/integrations/commerceProductNaming'
import type {
  PackagingMaterial,
  PackagingMaterialsWorkspace,
} from '@/lib/operations/packagingMaterials'
import type { CartonizationPreviewResult } from '@/lib/operations/cartonizationPreview'
import {
  displayLengthToMillimeters,
  displayWeightToGrams,
  formatDimensionsMm,
  formatGrams,
  gramsToDisplayWeight,
  measurementUnits,
  millimetersToDisplayLength,
  type MeasurementSystem,
} from '@/lib/measurements'

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
  commerceVariantPackMappingGlobalId?: string | null
  packProfileVersionGlobalId?: string | null
  packProfilePackageLevel?: 'each' | 'inner_pack' | 'case' | 'pallet' | null
  packProfileBaseEachQuantity?: number | null
  packagingSource?: string | null
  packagingWeightSource?: string | null
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
  subtotalMinor?: number | null
  totalMinor?: number | null
  headerMoney?: {
    state: 'complete' | 'operational_incomplete'
    unavailableFields: string[]
    accountingEligible: boolean
    customerChargeEligible: boolean
  }
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
  checkoutRateReconciliation?: {
    globalId?: string | null
    receiptGlobalId?: string | null
    outcome?:
      | 'matched'
      | 'ambiguous'
      | 'rejected'
      | 'expired'
      | 'not_applicable'
      | null
    lineageRequired?: boolean
    fulfillmentEligible?: boolean
  } | null
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
  providerTaxonomy?: {
    scheme:
      | 'shopify_standard_product_taxonomy'
      | 'faire_product_type'
    externalId?: string | null
    name?: string | null
    fullName?: string | null
    marketplacePaths?: string[]
  } | null
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
  lastErrorCode?: string | null
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

type ProductIntakePolicy = {
  version: string
  unmatchedAction: 'review' | 'auto_create'
  autoCreateNewProducts: boolean
  revision: number
  updatedAt: string | null
}

type ProductCatalogSync = {
  status:
    | 'idle'
    | 'queued'
    | 'running'
    | 'retrying'
    | 'completed'
    | 'paused'
    | 'dead'
  rawStatus?: string | null
  activeBacklog?: number
  pageCount?: number
  providerRecordsSeen?: number
  productsCreated?: number
  productsMapped?: number
  productsUnchanged?: number
  productsSkipped?: number
  productsFailed?: number
  attemptCount?: number
  sweepFailureCount?: number
  maxAttempts?: number
  availableAt?: string | null
  lastErrorCode?: string | null
  startedAt?: string | null
  completedAt?: string | null
  lastSuccessAt?: string | null
  nextRunAt?: string | null
  updatedAt?: string | null
  resource?: 'products'
  readOnly?: boolean
  providerWrites?: number
  ordersTouched?: number
  inventoryTouched?: number
  dirtyVersion?: number | null
  reconciledVersion?: number | null
  pendingRefreshSignals?: number | null
  terminalRecoveryRequired?: boolean
  recoveryMode?: 'operator_policy_revision' | null
  deadEvidencePreserved?: boolean
  historicalTerminalEvidence?: boolean
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
    productIntake?: ProductIntakePolicy
    productCatalogSync?: ProductCatalogSync
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
  productCandidateSummary?: {
    scope: string
    limit: number
    total: number
    unresolved: number
    returned: number
    unresolvedReturned: number
    truncated: boolean
    unresolvedTruncated: boolean
  }
  rejectionSummary?: {
    scope: string
    limit: number
    total: number
    returned: number
    truncated: boolean
  }
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
  orderReconciliation?: {
    status: 'idle' | 'running' | 'succeeded' | 'failed'
    recordsSeen: number
    recordsHeld: number
    consecutiveFailures: number
    lastErrorCode: string | null
    lastStartedAt: string | null
    lastCompletedAt: string | null
    resumable: boolean
    resetRequired: boolean
    providerWrites: 0
    canonicalOrderWrites: 0
    inventoryWrites: 0
  } | null
}

type AutomaticProductCreationSummary = {
  enabled?: boolean
  created?: number
  mappedExisting?: number
  skipped?: number
  failed?: number | boolean
  remainingUnresolved?: number
  errorCode?: string
}

type IntakePayload = {
  ok?: boolean
  error?: string
  code?: string
  intake?: CommerceIntake
  command?: {
    replayed?: boolean
    result?: unknown
    automaticProductCreation?: AutomaticProductCreationSummary
    productIntake?: ProductIntakePolicy
  }
}

type CartonizationMaterialsPayload = {
  ok?: boolean
  error?: string
  packagingMaterials?: PackagingMaterialsWorkspace
}

type CartonizationPreviewPayload = {
  ok?: boolean
  error?: string
  code?: string
  preview?: CartonizationPreviewResult
}

type CartonizationRateEvidenceSummary = {
  globalId: string
  status: 'succeeded' | 'partial' | 'failed'
  evidenceMode: 'operational' | 'assumption_backed_sandbox'
  candidateOrderNumber: string
  warehouse: {
    globalId: string
    name: string
  }
  packages: Array<{
    packageKey: string
    packagingMaterialName: string
    ratedOuterDimensionsMm: {
      length: number
      width: number
      height: number
    }
    contentWeightGrams: number
    tareWeightGrams: number
    ratedGrossWeightGrams: number
    allocations: Array<{
      lineGlobalId: string
      title: string
      quantity: number
    }>
    quotes: Array<{
      provider: 'ups_rest' | 'fedex_rest'
      rateEvidenceGlobalId: string
      status: 'succeeded' | 'failed'
      shipmentRateContextHash: string | null
      rateScope: 'single_package' | 'multi_package_shipment'
      rates: Array<{
        serviceCode: string
        serviceName: string
        amount: string
        currency: string
      }>
    }>
  }>
}

type CartonizationRateEvidencePayload = {
  ok?: boolean
  error?: string
  code?: string
  evidence?: CartonizationRateEvidenceSummary
}

type ShipmentServiceOption = {
  provider: 'ups_rest' | 'fedex_rest'
  serviceCode: string
  serviceName: string
  currency: string
  amount: number
  packageCount: number
  rateEvidenceGlobalId: string
}

type SandboxParcelAssumptionDraft = {
  measurementSystem: MeasurementSystem
  length: string
  width: string
  height: string
  tareWeight: string
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
  measurementSystem: MeasurementSystem
  weight: string
  length: string
  width: string
  height: string
}

type CommerceIntakeWorkflowProps = {
  accountGlobalId: string
  provider: CommerceProvider
  displayName: string
  canManage: boolean
  canActivate: boolean
  connectionReady?: boolean
}

type WorkbenchTab = 'overview' | 'products' | 'orders' | 'issues'
type ProductReviewFilter = 'all' | 'needs_decision' | 'matched' | 'skipped'
type OrderReviewFilter = 'all' | 'needs_review' | 'ready' | 'added' | 'skipped'
type RejectionGroup = {
  code: string
  resourceType: 'order' | 'product'
  message: string
  count: number
}

class IntakeRequestError extends Error {
  constructor(
    message: string,
    readonly code = 'COMMERCE_INTAKE_REQUEST_FAILED',
    readonly preserveIdempotencyKey = false,
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

const workbenchPageSize = 10

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

function carrierLabel(provider: ShipmentServiceOption['provider']) {
  return provider === 'ups_rest' ? 'UPS' : 'FedEx'
}

function formatShipmentRate(amount: number, currency: string) {
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
    }).format(amount)
  } catch {
    return `${amount.toFixed(2)} ${currency}`
  }
}

function isGroundShipmentService(option: ShipmentServiceOption) {
  return (
    option.serviceCode === '03'
    || option.serviceCode === 'FEDEX_GROUND'
    || option.serviceName.toLowerCase().includes('ground')
  )
}

function commonShipmentServiceOptions(
  packages: CartonizationRateEvidenceSummary['packages'],
): ShipmentServiceOption[] {
  if (packages.length === 0) return []
  const options: ShipmentServiceOption[] = []
  for (const provider of ['ups_rest', 'fedex_rest'] as const) {
    const planQuotes = packages.map((item) => item.quotes.find(
      (quote) => quote.provider === provider,
    ))
    if (
      planQuotes.some((quote) => (
        quote?.status !== 'succeeded'
        || quote.rateScope !== 'multi_package_shipment'
        || !quote.shipmentRateContextHash
      ))
      || new Set(
        planQuotes.map((quote) => quote?.rateEvidenceGlobalId),
      ).size !== 1
      || new Set(
        planQuotes.map((quote) => quote?.shipmentRateContextHash),
      ).size !== 1
    ) continue
    const firstQuote = planQuotes[0]!
    const candidateKeys = new Set(
      firstQuote.rates.map((rate) => JSON.stringify([
        rate.serviceCode,
        rate.serviceName,
        rate.currency,
      ])),
    )
    for (const candidateKey of candidateKeys) {
      const [serviceCode, serviceName, currency] =
        JSON.parse(candidateKey) as [string, string, string]
      let amount: number | null = null
      let complete = true
      for (const quote of planQuotes) {
        const matchingRates = quote?.rates.filter((rate) => (
          rate.serviceCode === serviceCode
          && rate.serviceName === serviceName
          && rate.currency === currency
          && Number.isFinite(Number(rate.amount))
          && Number(rate.amount) >= 0
        )) || []
        if (quote?.status !== 'succeeded' || matchingRates.length !== 1) {
          complete = false
          break
        }
        const matchingAmount = Number(matchingRates[0].amount)
        if (amount !== null && matchingAmount !== amount) {
          complete = false
          break
        }
        amount = matchingAmount
      }
      if (complete && amount !== null) {
        options.push({
          provider,
          serviceCode,
          serviceName,
          currency,
          amount,
          packageCount: packages.length,
          rateEvidenceGlobalId: firstQuote.rateEvidenceGlobalId,
        })
      }
    }
  }
  return options.sort((left, right) => (
    Number(isGroundShipmentService(right))
      - Number(isGroundShipmentService(left))
    || carrierLabel(left.provider).localeCompare(
      carrierLabel(right.provider),
    )
    || left.amount - right.amount
    || left.serviceName.localeCompare(right.serviceName)
  ))
}

function packagingMaterialSummary(
  material: PackagingMaterial,
  system: MeasurementSystem,
) {
  const dimensions = material.innerDimensionsMm
  const dimensionsLabel = (
    dimensions.length !== null
    && dimensions.width !== null
    && dimensions.height !== null
  )
    ? formatDimensionsMm({
      lengthMm: dimensions.length,
      widthMm: dimensions.width,
      heightMm: dimensions.height,
    }, system, {
      maximumFractionDigits: 3,
    })
    : 'Incomplete dimensions'
  const maximumLabel = material.maxWeightGrams === null
    ? 'Maximum weight not recorded'
    : `${formatGrams(
      material.maxWeightGrams,
      system,
      { maximumFractionDigits: 3 },
    )} max`
  return `${dimensionsLabel} · ${maximumLabel}`
}

function rejectionTitle(code: string) {
  const titles: Record<string, string> = {
    COMMERCE_ORDER_MONEY_INCOMPLETE: 'Order totals could not be read',
    COMMERCE_ORDER_LINES_INCOMPLETE: 'Order line details are incomplete',
    COMMERCE_PRODUCT_RECORD_INVALID: 'Product details could not be read',
  }
  return titles[code] || 'Provider record needs review'
}

function rejectionGroupKey(group: RejectionGroup) {
  return [
    group.resourceType,
    group.code,
    group.message,
  ].join(':')
}

function candidateStateLabel(state: CandidateState) {
  const labels: Record<CandidateState, string> = {
    held: 'Needs review',
    resolving: 'In review',
    ready: 'Ready to add',
    promoted: 'Added to ClawPilot',
    failed: 'Skipped',
    expired: 'Expired',
  }
  return labels[state]
}

function formatDate(value?: string | null) {
  if (!value) return 'Not recorded'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

function catalogSyncDescription(
  sync: ProductCatalogSync | undefined,
  provider: CommerceProvider,
) {
  if (!sync || sync.status === 'idle') {
    if (sync?.historicalTerminalEvidence) {
      return 'A previous terminal catalog failure remains retained as historical evidence. Its credential or policy fence is no longer current, so it does not block the current eligible reconciliation.'
    }
    return 'This verified connection authorizes automatic read-only catalog sync. The initial backfill queues when product-read access, the development runtime, and the Operations product target are eligible; no second approval is required.'
  }
  if (sync.status === 'queued') {
    return 'The full product catalog is queued. ClawPilot will follow every provider page automatically; no per-page approval is required.'
  }
  if (sync.status === 'running') {
    return `ClawPilot is following the ${providerLabel(provider)} catalog in the background. ${
      sync.providerRecordsSeen || 0
    } provider variants have been read across ${
      sync.pageCount || 0
    } completed pages.`
  }
  if (sync.status === 'retrying') {
    return `A read-only provider request will retry automatically${
      sync.nextRunAt ? ` at ${formatDate(sync.nextRunAt)}` : ''
    }${
      sync.lastErrorCode ? ` (${sync.lastErrorCode})` : ''
    }. Products already imported remain available.`
  }
  if (sync.status === 'completed') {
    return `The catalog reconciliation completed after reading ${
      sync.providerRecordsSeen || 0
    } provider variants. ${
      sync.productsCreated || 0
    } products were created and ${
      sync.productsMapped || 0
    } were matched${
      sync.productsSkipped || sync.productsFailed
        ? `; ${
            (sync.productsSkipped || 0) + (sync.productsFailed || 0)
          } remain available for review`
        : ''
    }. The next automatic product check is ${
      sync.nextRunAt ? formatDate(sync.nextRunAt) : 'scheduled'
    }.`
  }
  if (sync.status === 'dead') {
    return `Automatic catalog sync is terminal after repeated or permanent errors${
      sync.lastErrorCode ? ` (${sync.lastErrorCode})` : ''
    }. ClawPilot will not retry the same continuation. Repair the sales-channel connection or Operations eligibility if needed, then an authorized operator must explicitly start a fresh reconciliation. The terminal job and its error evidence remain preserved.`
  }
  return 'Automatic catalog sync is paused. Existing ClawPilot products and provider mappings are unchanged.'
}

function automaticProductCreationNotice(
  summary?: AutomaticProductCreationSummary,
) {
  if (!summary) return ''
  const count = (value: unknown) => (
    typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= 0
      ? value
      : null
  )
  const created = count(summary.created)
  const mappedExisting = count(summary.mappedExisting)
  const skipped = count(summary.skipped)
  const failed = count(summary.failed)
  const remaining = count(summary.remainingUnresolved)
  if (summary.failed === true) {
    return `Automatic product creation could not complete${
      summary.errorCode ? ` (${summary.errorCode})` : ''
    }. Review the staged products; rows that were not created remain in review.`
  }
  const counts = [
    created === null ? null : `${created} created`,
    mappedExisting === null
      ? null
      : `${mappedExisting} matched to an existing product`,
    skipped === null ? null : `${skipped} skipped by automation`,
    failed === null ? null : `${failed} failed`,
    remaining === null ? null : `${remaining} remaining in review`,
  ].filter((value): value is string => Boolean(value))
  if (counts.length === 0) return ''
  const prefix = summary.enabled === false
    ? 'Automatic product creation is off'
    : 'Automatic product creation'
  const needsReview = remaining === null
    ? (skipped || 0) > 0 || (failed || 0) > 0
    : remaining > 0
  return `${prefix}: ${counts.join(', ')}.${
    needsReview
      ? ' Products not created remain in review.'
      : ''
  }`
}

function catalogSyncHasIssues(sync?: ProductCatalogSync) {
  return Boolean(
    sync
    && ((sync.productsSkipped || 0) > 0 || (sync.productsFailed || 0) > 0),
  )
}

function catalogSyncColor(sync?: ProductCatalogSync) {
  if (sync?.status === 'completed' && !catalogSyncHasIssues(sync)) {
    return 'success' as const
  }
  if (sync?.status === 'dead') return 'error' as const
  if (
    sync?.status === 'retrying'
    || (sync?.status === 'completed' && catalogSyncHasIssues(sync))
  ) return 'warning' as const
  if (sync?.status === 'queued' || sync?.status === 'running') {
    return 'info' as const
  }
  return 'default' as const
}

function catalogSyncLabel(sync?: ProductCatalogSync) {
  const labels: Record<ProductCatalogSync['status'], string> = {
    idle: 'Waiting to start',
    queued: 'Backfill queued',
    running: 'Catalog syncing',
    retrying: 'Retry scheduled',
    completed: 'Catalog current',
    paused: 'Automatic sync off',
    dead: 'Connection needs attention',
  }
  if (sync?.status === 'completed' && catalogSyncHasIssues(sync)) {
    return 'Catalog synced — review needed'
  }
  return sync?.status ? labels[sync.status] : 'Not started'
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
    return 'Amount unavailable'
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

function majorPriceFromMinor(
  minor?: number | null,
  currency?: string | null,
) {
  if (!Number.isInteger(minor) || !currency) return ''
  try {
    return formatCommerceMoneyMajor(minor as number, currency)
  } catch {
    return ''
  }
}

function validPrice(draft: ProductDraft) {
  try {
    parseCommerceMoneyMajor(
      draft.unitPriceMinor,
      normalizeCurrency(draft.currency),
    )
    return true
  } catch {
    return false
  }
}

function dimensionsLabel(
  dimensions: DimensionsMm | null | undefined,
  system: MeasurementSystem,
) {
  if (
    !dimensions
    || !dimensions.length
    || !dimensions.width
    || !dimensions.height
  ) return 'dimensions unavailable'
  return formatDimensionsMm({
    lengthMm: dimensions.length,
    widthMm: dimensions.width,
    heightMm: dimensions.height,
  }, system, { maximumFractionDigits: 3 })
}

function initialProductDraft(line: IntakeLine): ProductDraft {
  return {
    productGlobalId: line.productGlobalId || '',
    name: line.title || '',
    sku: line.sku || '',
    unitPriceMinor: majorPriceFromMinor(
      line.unitPriceMinor,
      line.currency,
    ),
    currency: normalizeCurrency(line.currency || ''),
  }
}

function initialCatalogProductDraft(
  candidate: ProductCandidate,
): CatalogProductDraft {
  return {
    productGlobalId: candidate.productGlobalId || '',
    name: commerceProductDisplayName({
      productTitle: candidate.productTitle,
      variantTitle: candidate.variantTitle,
      selectedOptions: candidate.selectedOptions,
    }),
    sku: candidate.sku || '',
    unitPriceMinor: majorPriceFromMinor(
      candidate.priceMinor,
      candidate.currency,
    ),
    currency: normalizeCurrency(candidate.currency || ''),
    exclusionReason: '',
  }
}

function downloadCsv(csv: string, filename: string) {
  const url = URL.createObjectURL(new Blob([csv], {
    type: 'text/csv;charset=utf-8',
  }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}

function csvFilename(
  provider: CommerceProvider,
  resource: 'products' | 'orders' | 'issues',
) {
  return `clawpilot-${provider}-${resource}-${
    new Date().toISOString().slice(0, 10)
  }.csv`
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

function displayDraftNumber(value: number) {
  return String(Number(value.toFixed(3)))
}

function initialPackageDraft(
  line: IntakeLine,
  system: MeasurementSystem,
): PackageDraft {
  return {
    packageProfileGlobalId: line.packageProfileGlobalId || '',
    measurementSystem: system,
    weight: line.weightGrams
      ? displayDraftNumber(gramsToDisplayWeight(line.weightGrams, system))
      : '',
    length: line.dimensionsMm?.length
      ? displayDraftNumber(millimetersToDisplayLength(line.dimensionsMm.length, system))
      : '',
    width: line.dimensionsMm?.width
      ? displayDraftNumber(millimetersToDisplayLength(line.dimensionsMm.width, system))
      : '',
    height: line.dimensionsMm?.height
      ? displayDraftNumber(millimetersToDisplayLength(line.dimensionsMm.height, system))
      : '',
  }
}

function initialSandboxParcelAssumption(
  material: PackagingMaterial | null,
  system: MeasurementSystem,
): SandboxParcelAssumptionDraft {
  const dimensions = material?.innerDimensionsMm
  return {
    measurementSystem: system,
    length: dimensions?.length
      ? displayDraftNumber(
          millimetersToDisplayLength(dimensions.length, system),
        )
      : '',
    width: dimensions?.width
      ? displayDraftNumber(
          millimetersToDisplayLength(dimensions.width, system),
        )
      : '',
    height: dimensions?.height
      ? displayDraftNumber(
          millimetersToDisplayLength(dimensions.height, system),
        )
      : '',
    tareWeight: material?.tareWeightGrams
      ? displayDraftNumber(
          gramsToDisplayWeight(material.tareWeightGrams, system),
        )
      : '',
  }
}

function operationalPackagingMaterialBlockers(
  material: PackagingMaterial,
  warehouseGlobalId: string,
) {
  const blockers: string[] = []
  const ratedOuter = material.ratedOuterDimensionsMm
  if (material.status !== 'active') blockers.push('material is not active')
  if (
    !ratedOuter.length
    || !ratedOuter.width
    || !ratedOuter.height
  ) {
    blockers.push('rated exterior dimensions are incomplete')
  }
  if (
    !['customer_confirmed', 'measured', 'provider'].includes(
      material.ratedOuterDimensionEvidenceType || '',
    )
    || !material.ratedOuterDimensionEvidenceReference
    || !material.ratedOuterDimensionConfirmedAt
  ) {
    blockers.push('factual rated exterior evidence is incomplete')
  }
  if (!material.tareWeightGrams || material.tareWeightGrams <= 0) {
    blockers.push('tare weight is incomplete')
  }
  const stock = material.stock.find((item) => (
    item.warehouseGlobalId === warehouseGlobalId
  ))
  if (
    !stock
    || stock.warehouseStatus !== 'active'
    || !stock.isAvailable
    || !stock.onHandQuantity
    || stock.onHandQuantity <= 0
  ) {
    blockers.push('available warehouse stock is missing')
  }
  return blockers
}

async function readPayload(response: Response): Promise<IntakePayload> {
  const payload = await response.json().catch(() => ({})) as IntakePayload
  const hasAuthoritativePolicyResult = Boolean(
    payload.command?.productIntake,
  )
  if (
    !response.ok
    || payload.ok !== true
    || (!payload.intake && !hasAuthoritativePolicyResult)
  ) {
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

function productLifecycleColor(status: string | null | undefined) {
  if (status === 'active') return 'success' as const
  if (status === 'unlisted') return 'info' as const
  if (status === 'unavailable') return 'error' as const
  return 'warning' as const
}

function positiveNumber(value: string) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

export default function CommerceIntakeWorkflow({
  accountGlobalId,
  provider,
  displayName,
  canManage,
  canActivate,
  connectionReady = true,
}: CommerceIntakeWorkflowProps) {
  const { measurementSystem } = useMeasurementSystem()
  const [intake, setIntake] = useState<CommerceIntake | null>(null)
  const [loading, setLoading] = useState(true)
  const [pendingAction, setPendingAction] = useState('')
  const [workbenchOpen, setWorkbenchOpen] = useState(false)
  const [workbenchTab, setWorkbenchTab] =
    useState<WorkbenchTab>('overview')
  const [productSearch, setProductSearch] = useState('')
  const [orderSearch, setOrderSearch] = useState('')
  const [issueSearch, setIssueSearch] = useState('')
  const [productFilter, setProductFilter] =
    useState<ProductReviewFilter>('all')
  const [orderFilter, setOrderFilter] =
    useState<OrderReviewFilter>('all')
  const [productPage, setProductPage] = useState(0)
  const [orderPage, setOrderPage] = useState(0)
  const [issuePage, setIssuePage] = useState(0)
  const [csvImportPreview, setCsvImportPreview] =
    useState<CommerceProductReviewImportResult | null>(null)
  const [csvImportFilename, setCsvImportFilename] = useState('')
  const [bulkProductProgress, setBulkProductProgress] = useState<{
    completed: number
    total: number
  } | null>(null)
  const [bulkRetryProgress, setBulkRetryProgress] = useState<{
    completed: number
    total: number
    groupKey: string
  } | null>(null)
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
  const [cartonizationCandidate, setCartonizationCandidate] =
    useState<IntakeCandidate | null>(null)
  const [cartonizationMaterials, setCartonizationMaterials] =
    useState<PackagingMaterial[]>([])
  const [cartonizationWarehouses, setCartonizationWarehouses] =
    useState<PackagingMaterialsWorkspace['warehouses']>([])
  const [
    selectedCartonizationWarehouseGlobalId,
    setSelectedCartonizationWarehouseGlobalId,
  ] = useState('')
  const [
    selectedCartonizationMaterialGlobalIds,
    setSelectedCartonizationMaterialGlobalIds,
  ] = useState<string[]>([])
  const [assumedCommittedByLine, setAssumedCommittedByLine] =
    useState<Record<string, string>>({})
  const [cartonizationPreview, setCartonizationPreview] =
    useState<CartonizationPreviewResult | null>(null)
  const [cartonizationRateEvidence, setCartonizationRateEvidence] =
    useState<CartonizationRateEvidenceSummary | null>(null)
  const [
    sandboxParcelAssumptionsByMaterial,
    setSandboxParcelAssumptionsByMaterial,
  ] = useState<Record<string, SandboxParcelAssumptionDraft>>({})
  const [sandboxAssumptionReason, setSandboxAssumptionReason] = useState('')
  const [
    allowSandboxMinimumOverride,
    setAllowSandboxMinimumOverride,
  ] = useState(false)
  const [
    sandboxAssumptionAcknowledged,
    setSandboxAssumptionAcknowledged,
  ] = useState(false)
  const [cartonizationLoading, setCartonizationLoading] = useState(false)
  const [cartonizationError, setCartonizationError] = useState('')
  const [unsupportedReasons, setUnsupportedReasons] = useState<
    Record<string, string>
  >({})
  const retryKeys = useRef(new Map<string, string>())
  const csvInputRef = useRef<HTMLInputElement | null>(null)

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
    setWorkbenchOpen(false)
    setWorkbenchTab('overview')
    setProductSearch('')
    setOrderSearch('')
    setIssueSearch('')
    setProductFilter('all')
    setOrderFilter('all')
    setProductPage(0)
    setOrderPage(0)
    setIssuePage(0)
    setCsvImportPreview(null)
    setCsvImportFilename('')
    setBulkProductProgress(null)
    setBulkRetryProgress(null)
    retryKeys.current.clear()
    setProductDrafts({})
    setCatalogProductDrafts({})
    setRejectionReasons({})
    setCustomerDrafts({})
    setAddressDrafts({})
    setDeliveryDrafts({})
    setPackageDrafts({})
    setCartonizationCandidate(null)
    setCartonizationMaterials([])
    setSelectedCartonizationMaterialGlobalIds([])
    setAssumedCommittedByLine({})
    setCartonizationPreview(null)
    setCartonizationError('')
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
      setIntake((current) => {
        const next = payload.intake || current
        const committedPolicy = payload.command?.productIntake
        if (!next || !committedPolicy) return payload.intake || null
        return {
          ...next,
          policy: {
            ...next.policy,
            productIntake: committedPolicy,
          },
        }
      })
      if (action === 'resolve-catalog-product') {
        setCsvImportPreview(null)
        setCsvImportFilename('')
      }
      retryKeys.current.delete(retryKey)
      const commandNotice = payload.command?.replayed
        ? `${successMessage} The original command result was replayed.`
        : successMessage
      const automaticNotice = automaticProductCreationNotice(
        payload.command?.automaticProductCreation,
      )
      setNotice(
        automaticNotice
          ? `${commandNotice} ${automaticNotice}`
          : commandNotice,
      )
    } catch (requestError) {
      if (
        requestError instanceof IntakeRequestError
        && (
          requestError.code === 'COMMERCE_INTAKE_READ_RESTART_REQUIRED'
          || requestError.code
            === 'COMMERCE_INTAKE_CONTINUATION_RESTART_REQUIRED'
          || requestError.code
            === 'COMMERCE_PRODUCT_INTAKE_POLICY_REVISION_CONFLICT'
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
      setCsvImportPreview(null)
      setCsvImportFilename('')
      setBulkProductProgress(null)
      setBulkRetryProgress(null)
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
  const rejections = useMemo(
    () => intake?.rejections || [],
    [intake?.rejections],
  )
  const latestPagination = intake?.pagination || null
  const orderPagination = intake?.paginations?.orders
    || (latestPagination?.resource === 'orders' ? latestPagination : null)
  const productPagination = intake?.paginations?.products
    || (latestPagination?.resource === 'products' ? latestPagination : null)
  const operatorCommandsAllowed =
    intake?.policy?.operatorCommandsAllowed === true
  const cartonizationEvidenceSafe = Boolean(
    cartonizationPreview?.readOnly === true
    && cartonizationPreview.evidence.databaseWrites === 0
    && cartonizationPreview.evidence.providerWrites === 0
    && cartonizationPreview.evidence.rateCalls === 0
    && cartonizationPreview.evidence.labelCalls === 0
    && cartonizationPreview.evidence.shipmentWrites === 0,
  )
  const selectedCartonizationMaterials =
    selectedCartonizationMaterialGlobalIds.flatMap((globalId) => {
      const material = cartonizationMaterials.find(
        (candidate) => candidate.globalId === globalId,
      )
      return material ? [material] : []
    })
  const promotedWarehousePlanning =
    cartonizationCandidate?.state === 'promoted'
  const operationalMaterialBlockers = selectedCartonizationMaterials.flatMap(
    (material) => operationalPackagingMaterialBlockers(
      material,
      selectedCartonizationWarehouseGlobalId,
    ).map((blocker) => `${material.code}: ${blocker}`),
  )
  const operationalRateEvidenceReady = (
    selectedCartonizationMaterials.length > 0
    && selectedCartonizationMaterials.length
      === selectedCartonizationMaterialGlobalIds.length
    && operationalMaterialBlockers.length === 0
  )
  const cartonizationShipmentServiceOptions = useMemo(
    () => commonShipmentServiceOptions(
      cartonizationRateEvidence?.packages || [],
    ),
    [cartonizationRateEvidence?.packages],
  )
  const productIntakePolicy = intake?.policy?.productIntake
  const productCatalogSync = intake?.policy?.productCatalogSync
  const orderReconciliation = intake?.orderReconciliation
  const automaticProductCreationEnabled = Boolean(
    productIntakePolicy?.autoCreateNewProducts
    && productIntakePolicy.unmatchedAction === 'auto_create',
  )
  const productIntakePolicyRevision = (
    typeof productIntakePolicy?.revision === 'number'
    && Number.isSafeInteger(productIntakePolicy.revision)
    && productIntakePolicy.revision >= 0
  )
    ? productIntakePolicy.revision
    : 0
  const pendingCatalogRefreshSignals = (
    provider === 'shopify'
    && typeof productCatalogSync?.pendingRefreshSignals === 'number'
    && Number.isSafeInteger(productCatalogSync.pendingRefreshSignals)
    && productCatalogSync.pendingRefreshSignals > 0
  )
    ? productCatalogSync.pendingRefreshSignals
    : 0
  const futureProductBehaviorMessage = automaticProductCreationEnabled
    ? 'Catalog sync is resumed. When product-read access, the development runtime, and the Operations product target are eligible, ClawPilot reconciles the catalog automatically. Eligible unmatched products are created and mapped; incomplete or unsafe products remain in review.'
    : pendingCatalogRefreshSignals > 0
      ? `${pendingCatalogRefreshSignals} catalog change notification${
          pendingCatalogRefreshSignals === 1 ? ' is' : 's are'
        } waiting while synchronization is paused. Resume synchronization to run a full read-only reconciliation; existing products and mappings remain unchanged until then.`
      : provider === 'faire'
        ? 'Catalog sync is paused. Faire does not currently provide catalog webhooks, so pending changes are discovered by the next full read-only reconciliation after synchronization resumes. Existing products and mappings remain unchanged.'
        : 'Catalog sync is paused. Existing products and mappings remain unchanged, and no new provider pages are read until sync is resumed.'
  useEffect(() => {
    if (
      !workbenchOpen
      || !(
        (
          productCatalogSync
          && ['queued', 'running', 'retrying'].includes(
            productCatalogSync.status,
          )
        )
        || orderReconciliation?.status === 'running'
      )
    ) return
    let requestPending = false
    const timer = window.setInterval(() => {
      if (requestPending) return
      requestPending = true
      loadIntake()
        .catch(() => undefined)
        .finally(() => {
          requestPending = false
        })
    }, 5_000)
    return () => window.clearInterval(timer)
  }, [
    loadIntake,
    orderReconciliation?.status,
    productCatalogSync,
    workbenchOpen,
  ])
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
    ? `${providerLabel(provider)} next order batch checked. Review ready orders and issues below.`
    : `${providerLabel(provider)} orders checked. Review ready orders and issues below.`
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
    ? `${providerLabel(provider)} next product batch checked. Review the product decisions below.`
    : `${providerLabel(provider)} products checked. Review the product decisions below.`
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
  const candidatesWithBlockers = candidates.filter(
    (candidate) => (candidate.blockers?.length || 0) > 0,
  )
  const rejectionSummary = intake?.rejectionSummary
  const totalRejectionCount = rejectionSummary?.total ?? rejections.length
  const rejectionReviewTruncated = Boolean(rejectionSummary?.truncated)
  const issueRecordCount =
    totalRejectionCount + candidatesWithBlockers.length
  const unresolvedProductCount = productCandidates.filter((candidate) => (
    !terminalStates.has(candidate.state)
    && candidate.mappingStatus !== 'resolved'
  )).length
  const productCandidateSummary = intake?.productCandidateSummary
  const totalProductCount = productCandidateSummary?.total
    ?? productCandidates.length
  const totalUnresolvedProductCount = productCandidateSummary?.unresolved
    ?? unresolvedProductCount
  const productReviewTruncated = Boolean(
    productCandidateSummary?.truncated,
  )
  const unresolvedProductCandidates = productCandidates.filter(
    (candidate) => (
      !terminalStates.has(candidate.state)
      && candidate.mappingStatus !== 'resolved'
    ),
  )
  const bulkNewProductCandidates = unresolvedProductCandidates.filter(
    (candidate) => !catalogProductDraft(candidate).productGlobalId,
  )
  const bulkCreatableProductCandidates = bulkNewProductCandidates.filter(
    (candidate) => {
      const draft = catalogProductDraft(candidate)
      return (
        Number.isInteger(candidate.rowVersion)
        && Boolean(draft.name.trim())
        && validPrice(draft)
      )
    },
  )
  const bulkInvalidProductCount = (
    bulkNewProductCandidates.length
    - bulkCreatableProductCandidates.length
  )
  const selectedExistingProductCount = (
    unresolvedProductCandidates.length
    - bulkNewProductCandidates.length
  )
  const filteredProductCandidates = useMemo(() => {
    const query = productSearch.trim().toLocaleLowerCase()
    return productCandidates.filter((candidate) => {
      const matchesFilter = productFilter === 'all'
        || (
          productFilter === 'needs_decision'
          && !terminalStates.has(candidate.state)
          && candidate.mappingStatus !== 'resolved'
        )
        || (
          productFilter === 'matched'
          && candidate.mappingStatus === 'resolved'
        )
        || (
          productFilter === 'skipped'
          && candidate.state === 'failed'
        )
      if (!matchesFilter) return false
      if (!query) return true
      return [
        candidate.productTitle,
        candidate.variantTitle,
        candidate.sku,
        candidate.barcode,
        candidate.vendor,
        candidate.productType,
        candidate.externalVariantId,
      ].some((value) => (
        String(value || '').toLocaleLowerCase().includes(query)
      ))
    })
  }, [productCandidates, productFilter, productSearch])
  const filteredOrderCandidates = useMemo(() => {
    const query = orderSearch.trim().toLocaleLowerCase()
    return candidates.filter((candidate) => {
      const matchesFilter = orderFilter === 'all'
        || (
          orderFilter === 'needs_review'
          && (
            candidate.state === 'held'
            || candidate.state === 'resolving'
          )
        )
        || (
          orderFilter === 'ready'
          && candidate.state === 'ready'
        )
        || (
          orderFilter === 'added'
          && candidate.state === 'promoted'
        )
        || (
          orderFilter === 'skipped'
          && (
            candidate.state === 'failed'
            || candidate.state === 'expired'
          )
        )
      if (!matchesFilter) return false
      if (!query) return true
      return [
        candidate.orderNumber,
        candidate.externalOrderId,
        candidate.state,
        candidate.providerStatus,
        candidate.normalizedOrderStatus,
        candidate.customer?.snapshotName,
      ].some((value) => (
        String(value || '').toLocaleLowerCase().includes(query)
      ))
    })
  }, [candidates, orderFilter, orderSearch])
  const filteredRejections = useMemo(() => {
    const query = issueSearch.trim().toLocaleLowerCase()
    if (!query) return rejections
    return rejections.filter((rejection) => [
      rejectionTitle(rejection.errorCode),
      rejection.errorCode,
      rejection.externalId,
      rejection.resourceType,
      rejection.safeMessage,
    ].some((value) => String(value || '').toLocaleLowerCase().includes(query)))
  }, [issueSearch, rejections])
  const rejectionGroups = useMemo(() => {
    const grouped = new Map<string, RejectionGroup>()
    for (const rejection of filteredRejections) {
      const key = [
        rejection.resourceType,
        rejection.errorCode,
        rejection.safeMessage,
      ].join(':')
      const current = grouped.get(key)
      grouped.set(key, {
        code: rejection.errorCode,
        resourceType: rejection.resourceType,
        message: rejection.safeMessage,
        count: (current?.count || 0) + 1,
      })
    }
    return Array.from(grouped.values())
      .sort((left, right) => right.count - left.count)
  }, [filteredRejections])
  const candidateBlockerGroups = useMemo(() => {
    const query = issueSearch.trim().toLocaleLowerCase()
    const grouped = new Map<string, {
      code: string
      label: string
      action: string
      count: number
    }>()
    for (const candidate of candidates) {
      const seen = new Set<string>()
      for (const blocker of candidate.blockers || []) {
        if (seen.has(blocker.code)) continue
        seen.add(blocker.code)
        const searchable = [
          blocker.code,
          blocker.label,
          blocker.action,
          candidate.externalOrderId,
          candidate.orderNumber,
        ].join(' ').toLocaleLowerCase()
        if (query && !searchable.includes(query)) continue
        const current = grouped.get(blocker.code)
        grouped.set(blocker.code, {
          code: blocker.code,
          label: blocker.label,
          action: blocker.action,
          count: (current?.count || 0) + 1,
        })
      }
    }
    return Array.from(grouped.values())
      .sort((left, right) => right.count - left.count)
  }, [candidates, issueSearch])
  const safeProductPage = Math.min(
    productPage,
    Math.max(0, Math.ceil(filteredProductCandidates.length / workbenchPageSize) - 1),
  )
  const safeOrderPage = Math.min(
    orderPage,
    Math.max(0, Math.ceil(filteredOrderCandidates.length / workbenchPageSize) - 1),
  )
  const safeIssuePage = Math.min(
    issuePage,
    Math.max(0, Math.ceil(filteredRejections.length / workbenchPageSize) - 1),
  )
  const visibleProductCandidates = filteredProductCandidates.slice(
    safeProductPage * workbenchPageSize,
    (safeProductPage + 1) * workbenchPageSize,
  )
  const visibleOrderCandidates = filteredOrderCandidates.slice(
    safeOrderPage * workbenchPageSize,
    (safeOrderPage + 1) * workbenchPageSize,
  )
  const visibleRejections = filteredRejections.slice(
    safeIssuePage * workbenchPageSize,
    (safeIssuePage + 1) * workbenchPageSize,
  )
  const recommendedAction = !operatorCommandsAllowed
    ? {
        label: 'Enable reviewed imports',
        detail: 'Operations must be in Shadow or Active mode before records can be reviewed.',
        tab: 'overview' as WorkbenchTab,
      }
    : totalUnresolvedProductCount > 0
      ? {
          label: `Review ${totalUnresolvedProductCount} ${
            totalUnresolvedProductCount === 1 ? 'product' : 'products'
          }`,
          detail: automaticProductCreationEnabled
            ? 'Automation handled safe products; resolve only the remaining exceptions.'
            : 'Match, create, or skip each provider product before adding orders.',
          tab: 'products' as WorkbenchTab,
        }
      : issueRecordCount > 0
        ? {
            label: `Review ${issueRecordCount} ${
              issueRecordCount === 1 ? 'issue' : 'issues'
            }`,
            detail: 'Grouped provider failures and order blockers show what can be fixed next.',
            tab: 'issues' as WorkbenchTab,
          }
        : candidates.length > 0
          ? {
              label: `Review ${candidates.length} ${
                candidates.length === 1 ? 'order' : 'orders'
              }`,
              detail: 'Complete required details, validate, and add each approved order.',
              tab: 'orders' as WorkbenchTab,
            }
          : {
              label: 'Check for products and orders',
              detail: 'Start or refresh the bounded provider reads below.',
              tab: 'overview' as WorkbenchTab,
            }

  function reportCsvError(requestError: unknown) {
    setError(
      requestError instanceof CommerceIntakeCsvError
        ? `${requestError.message} [${requestError.code}]`
        : requestError instanceof Error
          ? requestError.message
          : 'The CSV operation could not be completed.',
    )
  }

  function downloadProductReviewCsv() {
    setError('')
    setNotice('')
    try {
      const reviewCandidates = productCandidates.filter((candidate) => (
        !terminalStates.has(candidate.state)
        && candidate.mappingStatus !== 'resolved'
      ))
      const csv = exportCommerceProductReviewCsv({
        accountGlobalId,
        provider,
        candidates: reviewCandidates,
      })
      downloadCsv(csv, csvFilename(provider, 'products'))
      setNotice(
        `Downloaded ${reviewCandidates.length} product review ${
          reviewCandidates.length === 1 ? 'row' : 'rows'
        }. Enter an action for only the rows you want to apply, then import the file for validation.`,
      )
    } catch (requestError) {
      reportCsvError(requestError)
    }
  }

  function downloadOrderSummaryCsv() {
    setError('')
    setNotice('')
    try {
      const csv = exportCommerceOrderSummaryCsv({
        accountGlobalId,
        provider,
        candidates: candidates.map((candidate) => ({
          globalId: candidate.globalId,
          rowVersion: candidate.rowVersion,
          externalOrderId: candidate.externalOrderId,
          orderNumber: candidate.orderNumber,
          state: candidateStateLabel(candidate.state),
          normalizedOrderStatus: candidate.normalizedOrderStatus,
          normalizedPaymentStatus: candidate.normalizedPaymentStatus,
          normalizedFulfillmentStatus:
            candidate.normalizedFulfillmentStatus,
          normalizedReturnStatus: candidate.normalizedReturnStatus,
          currency: candidate.currency,
          totalMinor: candidate.totalMinor,
          lineCount: candidate.lines?.length || 0,
          requiresShipping: candidate.requiresShipping,
          blockerCodes: candidate.blockers?.map((blocker) => blocker.code),
          sourceUpdatedAt: candidate.sourceUpdatedAt,
          canonicalOrderGlobalId: candidate.canonicalOrderGlobalId,
        })),
      })
      downloadCsv(csv, csvFilename(provider, 'orders'))
      setNotice(
        `Downloaded ${candidates.length} sanitized order ${
          candidates.length === 1 ? 'row' : 'rows'
        }. Customer contact and address details are not included.`,
      )
    } catch (requestError) {
      reportCsvError(requestError)
    }
  }

  function downloadIssueSummaryCsv() {
    setError('')
    setNotice('')
    try {
      const csv = exportCommerceIssueSummaryCsv({
        accountGlobalId,
        provider,
        issues: rejections.map((rejection) => ({
          globalId: rejection.globalId,
          rowVersion: rejection.rowVersion,
          resourceType: rejection.resourceType,
          externalId: rejection.externalId,
          errorCode: rejection.errorCode,
          safeMessage: rejection.safeMessage,
        })),
      })
      downloadCsv(csv, csvFilename(provider, 'issues'))
      setNotice(
        `Downloaded ${rejections.length} sanitized provider ${
          rejections.length === 1 ? 'issue' : 'issues'
        }. Credentials and customer contact details are not included.`,
      )
    } catch (requestError) {
      reportCsvError(requestError)
    }
  }

  async function previewProductDecisionCsv(file: File) {
    if (pendingAction) return
    setPendingAction('preview-product-csv')
    setError('')
    setNotice('')
    setCsvImportPreview(null)
    setCsvImportFilename(file.name)
    try {
      const preview = parseCommerceProductReviewCsv({
        csv: await file.text(),
        accountGlobalId,
        expectedCandidates: productCandidates.map((candidate) => ({
          globalId: candidate.globalId,
          rowVersion: candidate.rowVersion,
        })),
      })
      setCsvImportPreview(preview)
      if (preview.ok) {
        setNotice(
          `CSV checked: ${preview.decisions.length} ${
            preview.decisions.length === 1 ? 'decision is' : 'decisions are'
          } ready to apply and ${preview.skippedRows} blank ${
            preview.skippedRows === 1 ? 'row was' : 'rows were'
          } left unchanged.`,
        )
      } else {
        setError(
          `CSV needs correction before anything can be applied. ${
            preview.errors.length
          } ${preview.errors.length === 1 ? 'error was' : 'errors were'} found.`,
        )
      }
    } catch (requestError) {
      reportCsvError(requestError)
    } finally {
      setPendingAction('')
      if (csvInputRef.current) csvInputRef.current.value = ''
    }
  }

  function csvDecisionResolution(decision: CommerceProductReviewDecision) {
    if (decision.action === 'map_existing') {
      return {
        mode: 'existing',
        productGlobalId: decision.productGlobalId,
      }
    }
    if (decision.action === 'create') {
      return {
        mode: 'create',
        name: decision.name,
        sku: decision.sku || '',
        unitPriceMinor: decision.unitPriceMinor,
        currency: decision.currency,
      }
    }
    return {
      mode: 'exclude',
      reasonCode: 'operator_confirmed_catalog_exclusion',
      reason: decision.reason,
    }
  }

  async function applyProductDecisionCsv() {
    if (
      pendingAction
      || !operatorCommandsAllowed
      || !csvImportPreview?.ok
      || csvImportPreview.decisions.length === 0
    ) return
    if (
      !window.confirm(
        `Apply ${csvImportPreview.decisions.length} reviewed product ${
          csvImportPreview.decisions.length === 1 ? 'decision' : 'decisions'
        } from ${csvImportFilename}? Each row is fenced to this connection and its current version.`,
      )
    ) return

    const decisions = csvImportPreview.decisions
    let applied = 0
    let lastIntake: CommerceIntake | null = intake
    setPendingAction('apply-product-csv')
    setError('')
    setNotice('')

    try {
      for (const decision of decisions) {
        const requestKey = [
          'csv-product',
          decision.candidateGlobalId,
          decision.rowVersion,
          decision.action,
        ].join(':')
        const retryKey = `${accountGlobalId}:${requestKey}`
        const stableIdempotencyKey = retryKeys.current.get(retryKey)
          || idempotencyKey()
        retryKeys.current.set(retryKey, stableIdempotencyKey)

        const response = await fetch('/api/integrations/commerce/intake', {
          method: 'POST',
          cache: 'no-store',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            accountGlobalId,
            action: 'resolve-catalog-product',
            idempotencyKey: stableIdempotencyKey,
            candidateGlobalId: decision.candidateGlobalId,
            rowVersion: decision.rowVersion,
            resolution: csvDecisionResolution(decision),
          }),
        })
        const payload = await readPayload(response)
        lastIntake = payload.intake || lastIntake
        retryKeys.current.delete(retryKey)
        applied += 1
      }

      setIntake(lastIntake)
      setCsvImportPreview(null)
      setCsvImportFilename('')
      setNotice(
        `${applied} product ${
          applied === 1 ? 'decision was' : 'decisions were'
        } applied. Provider data was not changed.`,
      )
    } catch (requestError) {
      setCsvImportPreview({
        ...csvImportPreview,
        totalRows: decisions.length - applied,
        skippedRows: 0,
        decisions: decisions.slice(applied),
      })
      await loadIntake().catch(() => undefined)
      setError(
        `${applied} ${
          applied === 1 ? 'decision was' : 'decisions were'
        } applied before processing stopped. ${
          safeError(requestError)
        } The failed row keeps its retry identity; retry the remaining preview after reviewing the current state.`,
      )
    } finally {
      setPendingAction('')
    }
  }

  async function retryOrderMoneyRejectionGroup(group: RejectionGroup) {
    if (
      pendingAction
      || !operatorCommandsAllowed
      || group.resourceType !== 'order'
      || group.code !== 'COMMERCE_ORDER_MONEY_INCOMPLETE'
    ) return

    const targets = filteredRejections.filter((rejection) => (
      rejection.resourceType === group.resourceType
      && rejection.errorCode === group.code
      && rejection.safeMessage === group.message
    ))
    if (targets.length === 0) return
    if (
      !window.confirm(
        `Retry ${targets.length} exact ${
          targets.length === 1 ? 'order' : 'orders'
        } from ${providerLabel(provider)}? ClawPilot will perform provider reads only, make no provider writes, and stop immediately if a retry conflicts or fails.`,
      )
    ) return

    let completed = 0
    let lastIntake: CommerceIntake | null = intake
    setPendingAction('bulk-retry-order-money')
    setBulkRetryProgress({
      completed: 0,
      total: targets.length,
      groupKey: rejectionGroupKey(group),
    })
    setError('')
    setErrorCode('')
    setNotice('')

    try {
      for (const rejection of targets) {
        const requestKey = [
          'bulk-retry-rejection',
          rejection.globalId,
          rejection.rowVersion,
        ].join(':')
        const retryKey = `${accountGlobalId}:${requestKey}`
        const stableIdempotencyKey = retryKeys.current.get(retryKey)
          || idempotencyKey()
        retryKeys.current.set(retryKey, stableIdempotencyKey)

        const response = await fetch('/api/integrations/commerce/intake', {
          method: 'POST',
          cache: 'no-store',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            accountGlobalId,
            action: 'retry-rejection',
            idempotencyKey: stableIdempotencyKey,
            confirmReadOnly: true,
            rejectionGlobalId: rejection.globalId,
          }),
        })
        const payload = await readPayload(response)
        lastIntake = payload.intake || lastIntake
        retryKeys.current.delete(retryKey)
        completed += 1
        setBulkRetryProgress({
          completed,
          total: targets.length,
          groupKey: rejectionGroupKey(group),
        })
      }

      setIntake(lastIntake)
      setNotice(
        `${completed} exact ${
          completed === 1 ? 'order was' : 'orders were'
        } read again from ${providerLabel(provider)}. Review the current issue list for any records that still need attention. Provider data was not changed.`,
      )
    } catch (requestError) {
      await loadIntake().catch(() => undefined)
      setError(
        `${completed} ${
          completed === 1 ? 'order was' : 'orders were'
        } retried before processing stopped. ${safeError(requestError)} The failed rejection keeps its retry identity; review the refreshed issue list before retrying the remainder.`,
      )
      setErrorCode(
        requestError instanceof IntakeRequestError
          ? requestError.code
          : '',
      )
    } finally {
      setBulkRetryProgress(null)
      setPendingAction('')
    }
  }

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
      `${candidate.productTitle} matched to the selected ClawPilot product.`,
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
          unitPriceMinor: parseCommerceMoneyMajor(
            draft.unitPriceMinor,
            normalizeCurrency(draft.currency),
          ),
          currency: normalizeCurrency(draft.currency),
        },
      },
      `${draft.name.trim()} created and matched to this provider variant.`,
    )
  }

  async function saveAutomaticProductCreationPolicy(enabled: boolean) {
    if (
      pendingAction
      || enabled === automaticProductCreationEnabled
      || (enabled && (!operatorCommandsAllowed || !connectionReady))
    ) return
    await postCommand(
      'set-product-intake-policy',
      `set-product-intake-policy:${productIntakePolicyRevision}:${
        enabled ? 'auto_create' : 'review'
      }`,
      {
        expectedPolicyRevision: productIntakePolicyRevision,
        unmatchedAction: enabled ? 'auto_create' : 'review',
        confirmAutoCreateProducts: enabled,
      },
      enabled
        ? `Catalog sync resumed for ${displayName}. ClawPilot will queue a full reconciliation when product-read access, the development runtime, and the Operations product target are eligible. ${providerLabel(provider)} and existing orders will not be changed.`
        : `Catalog sync paused for ${displayName}. Existing products, mappings, orders, and ${providerLabel(provider)} were not changed.`,
    )
  }

  async function resetTerminalProductCatalogSync() {
    if (
      pendingAction
      || !operatorCommandsAllowed
      || !connectionReady
      || !automaticProductCreationEnabled
      || productCatalogSync?.status !== 'dead'
      || productCatalogSync.terminalRecoveryRequired !== true
    ) return
    const errorCode = productCatalogSync.lastErrorCode || 'unknown error'
    const confirmed = window.confirm(
      `Start a fresh read-only ${providerLabel(provider)} catalog reconciliation after terminal error ${errorCode}? The failed job and its evidence will be preserved, and ClawPilot will start at the catalog root instead of retrying the old continuation.`,
    )
    if (!confirmed) return
    const resetReason = window.prompt(
      'Enter the audit reason for superseding this terminal catalog sweep.',
      `Reviewed terminal catalog sync error ${errorCode}; eligibility is repaired and a fresh root reconciliation is authorized.`,
    )?.trim()
    if (!resetReason) return
    if (resetReason.length < 10 || resetReason.length > 500) {
      setError('Enter an audit reason between 10 and 500 characters.')
      return
    }
    await postCommand(
      'set-product-intake-policy',
      `reset-product-catalog-sync:${productIntakePolicyRevision}:${errorCode}`,
      {
        expectedPolicyRevision: productIntakePolicyRevision,
        unmatchedAction: 'auto_create',
        confirmAutoCreateProducts: true,
        confirmCatalogSyncReset: true,
        catalogSyncResetReason: resetReason,
      },
      `A fresh read-only catalog reconciliation was queued for ${displayName}. The terminal job and its evidence were preserved; no order, inventory, or ${providerLabel(provider)} record was changed.`,
    )
  }

  async function createAllNewCatalogProducts() {
    if (
      pendingAction
      || !operatorCommandsAllowed
      || bulkCreatableProductCandidates.length === 0
    ) return

    const targets = bulkCreatableProductCandidates.map((candidate) => ({
      candidate,
      draft: { ...catalogProductDraft(candidate) },
    }))
    const isPartialCreate = bulkInvalidProductCount > 0
    const confirmationMessage = isPartialCreate
      ? `Create and match ${targets.length} ready ClawPilot ${
          targets.length === 1 ? 'product' : 'products'
        } using the staged ${providerLabel(provider)} names, SKUs, prices, and currencies, and leave ${bulkInvalidProductCount} ${
          bulkInvalidProductCount === 1 ? 'incomplete product' : 'incomplete products'
        } for review? This changes ClawPilot only and does not write to ${providerLabel(provider)}. Each included row is checked against its current version.`
      : `Create and match ${targets.length} new ClawPilot ${
          targets.length === 1 ? 'product' : 'products'
        } using the staged ${providerLabel(provider)} names, SKUs, prices, and currencies? This changes ClawPilot only and does not write to ${providerLabel(provider)}. Each row is checked against its current version.`
    if (
      !window.confirm(confirmationMessage)
    ) return

    let completed = 0
    let lastIntake: CommerceIntake | null = intake
    setPendingAction('bulk-create-products')
    setBulkProductProgress({ completed: 0, total: targets.length })
    setError('')
    setErrorCode('')
    setNotice('')
    setCsvImportPreview(null)
    setCsvImportFilename('')

    try {
      for (const { candidate, draft } of targets) {
        const requestKey = [
          'bulk-create-product',
          candidate.globalId,
          candidate.rowVersion,
        ].join(':')
        const retryKey = `${accountGlobalId}:${requestKey}`
        const stableIdempotencyKey = retryKeys.current.get(retryKey)
          || idempotencyKey()
        retryKeys.current.set(retryKey, stableIdempotencyKey)

        const response = await fetch('/api/integrations/commerce/intake', {
          method: 'POST',
          cache: 'no-store',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            accountGlobalId,
            action: 'resolve-catalog-product',
            idempotencyKey: stableIdempotencyKey,
            candidateGlobalId: candidate.globalId,
            rowVersion: candidate.rowVersion,
            resolution: {
              mode: 'create',
              name: draft.name.trim(),
              sku: draft.sku.trim(),
              unitPriceMinor: parseCommerceMoneyMajor(
                draft.unitPriceMinor,
                normalizeCurrency(draft.currency),
              ),
              currency: normalizeCurrency(draft.currency),
              identityConflictPolicy: 'provider_qualified',
            },
          }),
        })
        const payload = await readPayload(response)
        lastIntake = payload.intake || lastIntake
        retryKeys.current.delete(retryKey)
        completed += 1
        setBulkProductProgress({
          completed,
          total: targets.length,
        })
      }

      setIntake(lastIntake)
      setNotice(
        isPartialCreate
          ? `${completed} ready ClawPilot ${
              completed === 1 ? 'product was' : 'products were'
            } created and matched. ClawPilot left ${bulkInvalidProductCount} incomplete ${
              bulkInvalidProductCount === 1 ? 'product' : 'products'
            } in review without changing them. Provider data was not changed. ${futureProductBehaviorMessage}`
          : `${completed} new ClawPilot ${
              completed === 1 ? 'product was' : 'products were'
            } created and matched. Provider data was not changed. ${futureProductBehaviorMessage}`,
      )
    } catch (requestError) {
      await loadIntake().catch(() => undefined)
      setError(
        `${completed} ${
          completed === 1 ? 'product was' : 'products were'
        } created before processing stopped. ${safeError(requestError)} The failed row keeps its retry identity; review the current product list before retrying the remaining products.`,
      )
      setErrorCode(
        requestError instanceof IntakeRequestError
          ? requestError.code
          : '',
      )
    } finally {
      setBulkProductProgress(null)
      setPendingAction('')
    }
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
      `${candidate.productTitle} skipped with an audited reason.`,
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
    return packageDrafts[key] || initialPackageDraft(line, measurementSystem)
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
        ...(current[key] || initialPackageDraft(line, measurementSystem)),
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
          unitPriceMinor: parseCommerceMoneyMajor(
            draft.unitPriceMinor,
            normalizeCurrency(draft.currency),
          ),
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
          unitPriceMinor: parseCommerceMoneyMajor(
            draft.unitPriceMinor,
            normalizeCurrency(draft.currency),
          ),
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
    const displayWeight = positiveNumber(draft.weight)
    const displayLength = positiveNumber(draft.length)
    const displayWidth = positiveNumber(draft.width)
    const displayHeight = positiveNumber(draft.height)
    if (!displayWeight || !displayLength || !displayWidth || !displayHeight) return
    const weightGrams = displayWeightToGrams(
      displayWeight,
      draft.measurementSystem,
    )
    const length = displayLengthToMillimeters(
      displayLength,
      draft.measurementSystem,
    )
    const width = displayLengthToMillimeters(
      displayWidth,
      draft.measurementSystem,
    )
    const height = displayLengthToMillimeters(
      displayHeight,
      draft.measurementSystem,
    )
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

  async function openCartonizationPreview(candidate: IntakeCandidate) {
    setCartonizationCandidate(candidate)
    setCartonizationMaterials([])
    setCartonizationWarehouses([])
    setSelectedCartonizationWarehouseGlobalId('')
    setSelectedCartonizationMaterialGlobalIds([])
    setAssumedCommittedByLine(Object.fromEntries(
      (candidate.lines || [])
        .filter((line) => line.requiresShipping && line.quantity > 0)
        .map((line) => [line.globalId, '0']),
    ))
    setCartonizationPreview(null)
    setCartonizationRateEvidence(null)
    setAllowSandboxMinimumOverride(false)
    setSandboxAssumptionAcknowledged(false)
    setSandboxParcelAssumptionsByMaterial({})
    setSandboxAssumptionReason('')
    setCartonizationError('')
    setCartonizationLoading(true)
    try {
      const response = await fetch('/api/operations/packaging-materials', {
        cache: 'no-store',
      })
      const payload = await response.json().catch(() => ({})) as
        CartonizationMaterialsPayload
      if (!response.ok || !payload.ok || !payload.packagingMaterials) {
        throw new Error(payload.error || 'Packaging materials could not be loaded.')
      }
      const materials = payload.packagingMaterials.materials
      const activeWarehouseGlobalId =
        payload.packagingMaterials.warehouses.find(
          (warehouse) => warehouse.status === 'active',
        )?.globalId || ''
      const eligible = materials.filter(
        (material) => material.readiness.eligibleForCartonization,
      )
      const completeCustomerMaterial = materials.find((material) => (
        material.source === 'customer_supplied'
        && material.innerDimensionsMm.length
        && material.innerDimensionsMm.width
        && material.innerDimensionsMm.height
      ))
      const ag12v2Material = materials.find((material) => (
        material.code.trim().toUpperCase() === 'AG12V2'
        && material.source === 'customer_supplied'
        && material.innerDimensionsMm.length
        && material.innerDimensionsMm.width
        && material.innerDimensionsMm.height
      ))
      const operationalMaterials = activeWarehouseGlobalId
        ? materials.filter((material) => (
            operationalPackagingMaterialBlockers(
              material,
              activeWarehouseGlobalId,
            ).length === 0
          ))
        : []
      const operationalAg12v2Material = operationalMaterials.find(
        (material) => material.code.trim().toUpperCase() === 'AG12V2',
      )
      const recommendedMaterial = (
        candidate.state === 'promoted'
          ? operationalAg12v2Material
            || operationalMaterials[0]
            || eligible[0]
            || ag12v2Material
            || completeCustomerMaterial
            || null
          : ag12v2Material
            || completeCustomerMaterial
            || eligible[0]
            || null
      )
      setCartonizationMaterials(materials)
      setCartonizationWarehouses(payload.packagingMaterials.warehouses)
      setSelectedCartonizationWarehouseGlobalId(activeWarehouseGlobalId)
      setSelectedCartonizationMaterialGlobalIds(
        recommendedMaterial ? [recommendedMaterial.globalId] : [],
      )
      setSandboxParcelAssumptionsByMaterial(
        recommendedMaterial
          ? {
              [recommendedMaterial.globalId]:
                initialSandboxParcelAssumption(
                  recommendedMaterial,
                  measurementSystem,
                ),
            }
          : {},
      )
      if (materials.length === 0) {
        setCartonizationError(
          'No packaging materials exist yet. Add up to eight cartons or mailers in Operations > Packaging materials.',
        )
      } else if (eligible.length === 0 && !completeCustomerMaterial) {
        setCartonizationError(
          'No packaging material is optimizer-ready. Complete cost, active status, and warehouse stock in Operations > Packaging materials.',
        )
      }
    } catch (caught) {
      setCartonizationError(
        caught instanceof Error
          ? caught.message
          : 'Packaging materials could not be loaded.',
      )
    } finally {
      setCartonizationLoading(false)
    }
  }

  async function runCartonizationPreview() {
    const candidate = cartonizationCandidate
    if (!canManage || !operatorCommandsAllowed) {
      setCartonizationError(
        'Organization manager or administrator permission is required to run a pack-plan preview.',
      )
      return
    }
    if (candidate?.state === 'promoted') {
      setCartonizationError(
        'Fit-only preview is unavailable after an order is added to ClawPilot. Select current factual warehouse and packaging data, then use Save operational pack facts for warehouse planning.',
      )
      return
    }
    if (
      !candidate
      || !Number.isInteger(candidate.rowVersion)
      || selectedCartonizationMaterialGlobalIds.length < 1
      || selectedCartonizationMaterialGlobalIds.length > 8
    ) return
    const invalidAssumption = (candidate.lines || [])
      .filter((line) => line.requiresShipping && line.quantity > 0)
      .find((line) => {
        const quantity = Number(assumedCommittedByLine[line.globalId] || 0)
        return (
          !Number.isSafeInteger(quantity)
          || quantity < 0
          || quantity > line.quantity
        )
      })
    if (invalidAssumption) {
      setCartonizationError(
        `Committed inventory for ${invalidAssumption.title} must be a whole number from 0 to ${invalidAssumption.quantity}.`,
      )
      return
    }
    setCartonizationLoading(true)
    setCartonizationError('')
    setCartonizationPreview(null)
    try {
      const response = await fetch(
        '/api/integrations/commerce/intake/cartonization-preview',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            accountGlobalId,
            candidateGlobalId: candidate.globalId,
            expectedCandidateRowVersion: candidate.rowVersion,
            materialGlobalIds: selectedCartonizationMaterialGlobalIds,
            assumedCommittedByLine: (candidate.lines || [])
              .filter((line) => line.requiresShipping && line.quantity > 0)
              .flatMap((line) => {
                const quantity = Number(assumedCommittedByLine[line.globalId] || 0)
                return Number.isSafeInteger(quantity) && quantity > 0
                  ? [{ lineGlobalId: line.globalId, quantity }]
                  : []
              }),
          }),
        },
      )
      const payload = await response.json().catch(() => ({})) as
        CartonizationPreviewPayload
      if (!response.ok || !payload.ok || !payload.preview) {
        throw new Error(
          `${payload.error || 'Cartonization preview failed.'}${
            payload.code ? ` [${payload.code}]` : ''
          }`,
        )
      }
      setCartonizationPreview(payload.preview)
    } catch (caught) {
      setCartonizationError(
        caught instanceof Error ? caught.message : 'Cartonization preview failed.',
      )
    } finally {
      setCartonizationLoading(false)
    }
  }

  async function createCartonizationRateEvidence() {
    const candidate = cartonizationCandidate
    if (!canManage || !operatorCommandsAllowed) {
      setCartonizationError(
        'Organization manager or administrator permission is required to compare carrier rates.',
      )
      return
    }
    if (candidate?.state === 'promoted') {
      setCartonizationError(
        'Assumption-backed sandbox comparison is unavailable after an order is added to ClawPilot. Correct the warehouse, product packing profile, or packaging material master data, then use Save operational pack facts.',
      )
      return
    }
    if (!candidate) return
    if (
      selectedCartonizationMaterialGlobalIds.length < 1
      || selectedCartonizationMaterialGlobalIds.length > 8
      || selectedCartonizationMaterials.length
        !== selectedCartonizationMaterialGlobalIds.length
    ) {
      setCartonizationError(
        'Select between one and eight available packaging materials for a reloadable carrier comparison.',
      )
      return
    }
    if (!selectedCartonizationWarehouseGlobalId) {
      setCartonizationError(
        'Select the warehouse whose inventory and sender facts should be used.',
      )
      return
    }
    const selectedMaterialsWithAssumptions: Array<{
      materialGlobalId: string
      expectedRowVersion: number
      sandboxRateAssumptions: {
        ratedOuterDimensionsMm: {
          length: number
          width: number
          height: number
        }
        tareWeightGrams: number
      }
    }> = []
    for (const material of selectedCartonizationMaterials) {
      const assumption =
        sandboxParcelAssumptionsByMaterial[material.globalId]
      const displayLength = positiveNumber(assumption?.length || '')
      const displayWidth = positiveNumber(assumption?.width || '')
      const displayHeight = positiveNumber(assumption?.height || '')
      const displayTare = positiveNumber(assumption?.tareWeight || '')
      if (
        !assumption
        || !displayLength
        || !displayWidth
        || !displayHeight
        || !displayTare
      ) {
        setCartonizationError(
          `Enter positive rated exterior dimensions and a positive sandbox-only tare for ${material.code}.`,
        )
        return
      }
      const ratedOuterDimensionsMm = {
        length: displayLengthToMillimeters(
          displayLength,
          assumption.measurementSystem,
        ),
        width: displayLengthToMillimeters(
          displayWidth,
          assumption.measurementSystem,
        ),
        height: displayLengthToMillimeters(
          displayHeight,
          assumption.measurementSystem,
        ),
      }
      const tareWeightGrams = displayWeightToGrams(
        displayTare,
        assumption.measurementSystem,
      )
      if (
        !ratedOuterDimensionsMm.length
        || !ratedOuterDimensionsMm.width
        || !ratedOuterDimensionsMm.height
        || !tareWeightGrams
      ) {
        setCartonizationError(
          `The sandbox rate assumptions for ${material.code} could not be converted to canonical millimeters and grams.`,
        )
        return
      }
      selectedMaterialsWithAssumptions.push({
        materialGlobalId: material.globalId,
        expectedRowVersion: material.rowVersion,
        sandboxRateAssumptions: {
          ratedOuterDimensionsMm,
          tareWeightGrams,
        },
      })
    }
    const assumptionReason = sandboxAssumptionReason.trim()
    if (!sandboxAssumptionAcknowledged || assumptionReason.length < 12) {
      setCartonizationError(
        'Acknowledge the sandbox-only boundary and enter a short reason for the temporary rating assumptions.',
      )
      return
    }
    const invalidAssumption = (candidate.lines || [])
      .filter((line) => line.requiresShipping && line.quantity > 0)
      .find((line) => {
        const quantity = Number(assumedCommittedByLine[line.globalId] || 0)
        return (
          !Number.isSafeInteger(quantity)
          || quantity < 0
          || quantity > line.quantity
        )
      })
    if (invalidAssumption) {
      setCartonizationError(
        `Committed inventory for ${invalidAssumption.title} must be a whole number from 0 to ${invalidAssumption.quantity}.`,
      )
      return
    }

    setCartonizationLoading(true)
    setCartonizationError('')
    setCartonizationRateEvidence(null)
    const command = {
      evidenceMode: 'assumption_backed_sandbox' as const,
      accountGlobalId,
      candidateGlobalId: candidate.globalId,
      expectedCandidateRowVersion: candidate.rowVersion,
      warehouseGlobalId: selectedCartonizationWarehouseGlobalId,
      selectedMaterials: selectedMaterialsWithAssumptions,
      assumedCommittedQuantities: (candidate.lines || [])
        .filter((line) => line.requiresShipping && line.quantity > 0)
        .map((line) => ({
          lineGlobalId: line.globalId,
          quantity: Number(assumedCommittedByLine[line.globalId] || 0),
        })),
      sandboxAssumptions: {
        acknowledged: true,
        reason: assumptionReason,
        allowUnderMinimum: allowSandboxMinimumOverride,
        assumedMinimumInputQuantity: allowSandboxMinimumOverride
          ? 1
          : null,
      },
    }
    const retryKey =
      `cartonization-rate-evidence:${JSON.stringify(command)}`
    const stableIdempotencyKey = retryKeys.current.get(retryKey)
      || idempotencyKey()
    retryKeys.current.set(retryKey, stableIdempotencyKey)
    try {
      const response = await fetch(
        '/api/integrations/commerce/intake/cartonization-rate-evidence',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...command,
            idempotencyKey: stableIdempotencyKey,
          }),
        },
      )
      const payload = await response.json().catch(() => ({})) as
        CartonizationRateEvidencePayload
      if (!response.ok || !payload.ok || !payload.evidence) {
        const explicitApplicationFailure =
          typeof payload.code === 'string' && payload.code.trim().length > 0
        throw new IntakeRequestError(
          payload.error || 'Pack and carrier-rate evidence failed.',
          payload.code,
          response.status >= 500
            || !explicitApplicationFailure
            || payload.code === 'CARTONIZATION_RATE_EVIDENCE_IN_PROGRESS',
        )
      }
      retryKeys.current.delete(retryKey)
      setCartonizationRateEvidence(payload.evidence)
    } catch (caught) {
      if (
        caught instanceof IntakeRequestError
        && !caught.preserveIdempotencyKey
      ) {
        retryKeys.current.delete(retryKey)
      }
      setCartonizationError(
        caught instanceof IntakeRequestError
          ? `${caught.message} [${caught.code}]`
          : caught instanceof Error
            ? caught.message
            : 'Pack and carrier-rate evidence failed.',
      )
    } finally {
      setCartonizationLoading(false)
    }
  }

  async function createOperationalCartonizationRateEvidence() {
    const candidate = cartonizationCandidate
    if (!canManage || !operatorCommandsAllowed) {
      setCartonizationError(
        'Organization manager or administrator permission is required to save operational pack evidence.',
      )
      return
    }
    if (!candidate || !selectedCartonizationWarehouseGlobalId) return
    if (!operationalRateEvidenceReady) {
      setCartonizationError(
        operationalMaterialBlockers[0]
          || 'Select active, stocked packaging with factual rated exterior measurements and tare.',
      )
      return
    }
    setCartonizationLoading(true)
    setCartonizationError('')
    setCartonizationRateEvidence(null)
    const command = {
      evidenceMode: 'operational' as const,
      accountGlobalId,
      candidateGlobalId: candidate.globalId,
      expectedCandidateRowVersion: candidate.rowVersion,
      warehouseGlobalId: selectedCartonizationWarehouseGlobalId,
      selectedMaterials: selectedCartonizationMaterials.map(
        (material) => ({
          materialGlobalId: material.globalId,
          expectedRowVersion: material.rowVersion,
        }),
      ),
    }
    const retryKey =
      `cartonization-rate-evidence:${JSON.stringify(command)}`
    const stableIdempotencyKey = retryKeys.current.get(retryKey)
      || idempotencyKey()
    retryKeys.current.set(retryKey, stableIdempotencyKey)
    try {
      const response = await fetch(
        '/api/integrations/commerce/intake/cartonization-rate-evidence',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...command,
            idempotencyKey: stableIdempotencyKey,
          }),
        },
      )
      const payload = await response.json().catch(() => ({})) as
        CartonizationRateEvidencePayload
      if (!response.ok || !payload.ok || !payload.evidence) {
        const explicitApplicationFailure =
          typeof payload.code === 'string' && payload.code.trim().length > 0
        throw new IntakeRequestError(
          payload.error || 'Operational pack and rate evidence failed.',
          payload.code,
          response.status >= 500
            || !explicitApplicationFailure
            || payload.code === 'CARTONIZATION_RATE_EVIDENCE_IN_PROGRESS',
        )
      }
      retryKeys.current.delete(retryKey)
      setCartonizationRateEvidence(payload.evidence)
    } catch (caught) {
      if (
        caught instanceof IntakeRequestError
        && !caught.preserveIdempotencyKey
      ) {
        retryKeys.current.delete(retryKey)
      }
      setCartonizationError(
        caught instanceof IntakeRequestError
          ? `${caught.message} [${caught.code}]`
          : caught instanceof Error
            ? caught.message
            : 'Operational pack and rate evidence failed.',
      )
    } finally {
      setCartonizationLoading(false)
    }
  }

  function openCartonizationRateEvidence() {
    if (!cartonizationRateEvidence) return
    const url = new URL(window.location.href)
    url.searchParams.set('commerceAccount', accountGlobalId)
    url.searchParams.set(
      'cartonizationEvidence',
      cartonizationRateEvidence.globalId,
    )
    url.hash = 'operations/imports'
    window.location.assign(url.toString())
  }

  async function copyCartonizationRateEvidenceLink() {
    if (!cartonizationRateEvidence) return
    const url = new URL(window.location.href)
    url.searchParams.set('commerceAccount', accountGlobalId)
    url.searchParams.set(
      'cartonizationEvidence',
      cartonizationRateEvidence.globalId,
    )
    url.hash = 'operations/imports'
    await navigator.clipboard.writeText(url.toString())
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
    <>
      <Card variant="outlined">
        <CardContent sx={{ '&:last-child': { pb: 2 } }}>
          <Stack spacing={1.5}>
            <Stack
              direction={{ xs: 'column', md: 'row' }}
              justifyContent="space-between"
              alignItems={{ md: 'center' }}
              spacing={1.5}
            >
              <Box>
                <Typography fontWeight={700}>
                  Import products and orders
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  {automaticProductCreationEnabled
                    ? `The connected ${providerLabel(provider)} catalog syncs automatically. Use this workspace to monitor progress and resolve only the products or orders that need a decision.`
                    : `${providerLabel(provider)} catalog sync is paused. Existing imported records remain available for review.`}
                </Typography>
              </Box>
              <Button
                variant="contained"
                onClick={() => {
                  setWorkbenchTab('overview')
                  setWorkbenchOpen(true)
                }}
                sx={actionButtonSx}
              >
                Open import workspace
              </Button>
            </Stack>
            <Stack direction="row" gap={0.75} flexWrap="wrap">
              <Chip
                size="small"
                color={operatorCommandsAllowed ? 'success' : 'warning'}
                label={`Operations ${
                  humanize(intake?.policy?.activationState || 'not initialized')
                }`}
              />
              <Chip
                size="small"
                label={`${totalProductCount} products found`}
              />
              <Chip
                size="small"
                color={
                  totalUnresolvedProductCount ? 'warning' : 'default'
                }
                label={`${totalUnresolvedProductCount} products need a decision`}
              />
              <Chip
                size="small"
                label={`${candidates.length} orders ready for review`}
              />
              <Chip
                size="small"
                color={
                  orderReconciliation?.status === 'failed'
                    ? 'warning'
                    : orderReconciliation?.status === 'running'
                      ? 'info'
                      : 'default'
                }
                label={`Order staging ${humanize(
                  orderReconciliation?.status || 'idle',
                )}`}
              />
              <Chip
                size="small"
                color={issueRecordCount ? 'warning' : 'default'}
                label={`${issueRecordCount} ${
                  issueRecordCount === 1 ? 'issue' : 'issues'
                }`}
              />
            </Stack>
          </Stack>
        </CardContent>
      </Card>

      <Dialog
        fullScreen
        open={workbenchOpen}
        onClose={() => {
          if (!pendingAction) setWorkbenchOpen(false)
        }}
        aria-labelledby={`commerce-intake-title-${accountGlobalId}`}
      >
        <DialogTitle
          id={`commerce-intake-title-${accountGlobalId}`}
          sx={{
            borderBottom: 1,
            borderColor: 'divider',
            py: 1.5,
          }}
        >
          <Stack
            direction="row"
            alignItems="center"
            justifyContent="space-between"
            spacing={1}
          >
            <Box>
              <Typography component="div" variant="h6" fontWeight={700}>
                {displayName}
              </Typography>
              <Typography variant="body2" color="text.secondary">
                {providerLabel(provider)} import workspace · read-only provider
                access
              </Typography>
            </Box>
            <IconButton
              aria-label="Close import workspace"
              disabled={Boolean(pendingAction)}
              onClick={() => setWorkbenchOpen(false)}
            >
              <CloseRounded />
            </IconButton>
          </Stack>
        </DialogTitle>
        <Box sx={{ borderBottom: 1, borderColor: 'divider', px: 2 }}>
          <Tabs
            value={workbenchTab}
            onChange={(_event, value: WorkbenchTab) => {
              setWorkbenchTab(value)
            }}
            variant="scrollable"
            scrollButtons="auto"
            aria-label="Commerce import workspace sections"
          >
            <Tab
              id={`commerce-intake-tab-overview-${accountGlobalId}`}
              aria-controls={`commerce-intake-panel-overview-${accountGlobalId}`}
              value="overview"
              label="Overview"
            />
            <Tab
              id={`commerce-intake-tab-products-${accountGlobalId}`}
              aria-controls={`commerce-intake-panel-products-${accountGlobalId}`}
              value="products"
              label={`Products (${totalUnresolvedProductCount})`}
            />
            <Tab
              id={`commerce-intake-tab-orders-${accountGlobalId}`}
              aria-controls={`commerce-intake-panel-orders-${accountGlobalId}`}
              value="orders"
              label={`Orders (${candidates.length})`}
            />
            <Tab
              id={`commerce-intake-tab-issues-${accountGlobalId}`}
              aria-controls={`commerce-intake-panel-issues-${accountGlobalId}`}
              value="issues"
              label={`Issues (${issueRecordCount})`}
            />
          </Tabs>
        </Box>
        <DialogContent
          sx={{
            bgcolor: 'background.default',
            px: { xs: 2, md: 4 },
            py: 3,
          }}
        >
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

          {workbenchTab === 'overview' ? (
            <Stack
              role="tabpanel"
              id={`commerce-intake-panel-overview-${accountGlobalId}`}
              aria-labelledby={`commerce-intake-tab-overview-${accountGlobalId}`}
              spacing={2.5}
            >
          <Card
            variant="outlined"
            sx={{ borderColor: 'primary.main', bgcolor: 'action.hover' }}
          >
            <CardContent sx={{ '&:last-child': { pb: 2 } }}>
              <Stack
                direction={{ xs: 'column', md: 'row' }}
                justifyContent="space-between"
                alignItems={{ md: 'center' }}
                spacing={1.5}
              >
                <Box>
                  <Typography
                    variant="overline"
                    color="primary.main"
                    fontWeight={700}
                  >
                    What to do next
                  </Typography>
                  <Typography fontWeight={700}>
                    {recommendedAction.label}
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    {recommendedAction.detail}
                  </Typography>
                </Box>
                <Button
                  variant="contained"
                  disabled={Boolean(pendingAction)}
                  onClick={() => {
                    if (!operatorCommandsAllowed) {
                      if (activationRecoveryAvailable) {
                        void initializeShadowActivation()
                      } else {
                        window.location.hash = 'operations'
                      }
                      return
                    }
                    setWorkbenchTab(recommendedAction.tab)
                  }}
                  sx={actionButtonSx}
                >
                  {!operatorCommandsAllowed && !activationRecoveryAvailable
                    ? 'Review Operations access'
                    : recommendedAction.label}
                </Button>
              </Stack>
            </CardContent>
          </Card>
          <Alert severity="info">
            {automaticProductCreationEnabled
              ? `Your verified ${providerLabel(provider)} connection authorizes automatic read-only product synchronization with no second approval. When product-read access, the development runtime, and the Operations product target are eligible, ClawPilot follows every catalog page and creates safe product records; only exceptions need review.`
              : `${providerLabel(provider)} product synchronization is paused. Resume it below when you want ClawPilot to continue reading catalog pages.`}{' '}
            It cannot change {providerLabel(provider)}, change an order,
            reserve inventory, or export fulfillment. Credentials and provider
            tokens are never returned here.
          </Alert>
          <Card variant="outlined">
            <CardContent sx={{ '&:last-child': { pb: 2 } }}>
              <Stack spacing={1}>
                <Stack
                  direction={{ xs: 'column', sm: 'row' }}
                  justifyContent="space-between"
                  alignItems={{ sm: 'center' }}
                  spacing={1}
                >
                  <Box>
                    <Typography variant="subtitle2" fontWeight={700}>
                      Automatic current-order staging
                    </Typography>
                    <Typography variant="body2" color="text.secondary">
                      {orderReconciliation?.status === 'running'
                        ? `ClawPilot is reading current ${providerLabel(provider)} orders now.`
                        : orderReconciliation?.status === 'succeeded'
                          ? `The latest read-only order check completed${
                            orderReconciliation.lastCompletedAt
                              ? ` ${formatDate(
                                orderReconciliation.lastCompletedAt,
                              )}`
                              : ''
                          }.`
                          : orderReconciliation?.status === 'failed'
                            ? `The latest read-only order check failed${
                              orderReconciliation.lastErrorCode
                                ? ` (${orderReconciliation.lastErrorCode})`
                                : ''
                            }. ${orderReconciliation.resetRequired
                              ? 'Review the connection and error, then explicitly restart automatic staging below. ClawPilot will not reuse the terminal continuation.'
                              : 'ClawPilot will retry automatically after its bounded backoff; only persistent failures require operator action.'}`
                            : `ClawPilot is ready to check current ${providerLabel(provider)} orders automatically when the verified order-read scope and Operations Shadow or Active mode are available.`}
                    </Typography>
                  </Box>
                  <Chip
                    size="small"
                    color={
                      orderReconciliation?.status === 'failed'
                        ? 'warning'
                        : orderReconciliation?.status === 'running'
                          ? 'info'
                          : orderReconciliation?.status === 'succeeded'
                            ? 'success'
                            : 'default'
                    }
                    label={humanize(orderReconciliation?.status || 'idle')}
                  />
                </Stack>
                <Stack direction="row" gap={0.75} flexWrap="wrap">
                  <Chip
                    size="small"
                    label={`${
                      orderReconciliation?.recordsSeen || 0
                    } provider records read`}
                  />
                  <Chip
                    size="small"
                    label={`${
                      orderReconciliation?.recordsHeld || 0
                    } held or rejected for review`}
                  />
                  {orderReconciliation?.resumable ? (
                    <Chip
                      size="small"
                      color="info"
                      label="More pages resume automatically"
                    />
                  ) : null}
                  <Chip
                    size="small"
                    label="0 provider writes"
                  />
                </Stack>
                <Typography variant="caption" color="text.secondary">
                  Staging preserves source order facts for review. It does not
                  create a ClawPilot order, reserve inventory, select packaging,
                  create a shipment, or write back to the provider.
                </Typography>
                {orderReconciliation?.status === 'failed' ? (
                  <Stack
                    direction={{ xs: 'column', sm: 'row' }}
                    spacing={1}
                  >
                    {orderReconciliation.resetRequired
                      && orderReconciliation.lastErrorCode
                      && orderReconciliation.lastStartedAt ? (
                        <Button
                          size="small"
                          variant="contained"
                          disabled={
                            Boolean(pendingAction)
                            || !operatorCommandsAllowed
                          }
                          onClick={() => void postCommand(
                            'reset-order-reconciliation',
                            `reset-order-reconciliation:${
                              orderReconciliation.lastStartedAt
                            }:${orderReconciliation.lastErrorCode}`,
                            {
                              confirmResetOrderReconciliation: true,
                              expectedLastErrorCode:
                                orderReconciliation.lastErrorCode,
                              expectedLastStartedAt:
                                orderReconciliation.lastStartedAt,
                              orderReconciliationResetReason:
                                'Operator reviewed the terminal read-only order staging failure and requested a fresh root session.',
                            },
                            'Automatic order staging was restarted with a fresh root session.',
                          )}
                        >
                          {pendingAction.startsWith(
                            'reset-order-reconciliation:',
                          )
                            ? 'Restarting…'
                            : 'Restart automatic staging'}
                        </Button>
                      ) : null}
                    <Button
                      size="small"
                      variant="outlined"
                      disabled={Boolean(pendingAction)}
                      onClick={() => setWorkbenchOpen(false)}
                    >
                      Review connection
                    </Button>
                    <Button
                      size="small"
                      disabled={Boolean(pendingAction)}
                      onClick={() => void reloadWorkflow()}
                    >
                      Reload status
                    </Button>
                  </Stack>
                ) : null}
              </Stack>
            </CardContent>
          </Card>
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
                label: '1 · Find',
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
                  : 'Read provider data safely',
              },
              {
                label: '2 · Review',
                value: `${blockerCount} order ${
                  blockerCount === 1 ? 'issue' : 'issues'
                }`,
                detail: `${totalUnresolvedProductCount} ${
                  totalUnresolvedProductCount === 1
                    ? 'product needs a decision'
                    : 'products need decisions'
                }`,
              },
              {
                label: '3 · Check',
                value: `${candidateCounts.ready} ready`,
                detail: 'Required details confirmed',
              },
              {
                label: '4 · Add',
                value: `${candidateCounts.promoted} added`,
                detail: 'Create the ClawPilot order',
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
                title: 'Products to review',
                detail: 'Find provider variants, then match, create, or skip each one.',
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
                title: 'Orders to review',
                detail: 'Find open orders, then check and add each approved order to ClawPilot.',
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
            </Stack>
          ) : null}

          {workbenchTab === 'issues' ? (
            <Stack
              role="tabpanel"
              id={`commerce-intake-panel-issues-${accountGlobalId}`}
              aria-labelledby={`commerce-intake-tab-issues-${accountGlobalId}`}
              spacing={2.5}
            >
              <Stack
                direction={{ xs: 'column', md: 'row' }}
                justifyContent="space-between"
                alignItems={{ md: 'flex-end' }}
                spacing={1.5}
              >
                <Box>
                  <Typography variant="h6" fontWeight={700}>
                    Provider issues
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    Review provider records that could not be staged safely.
                    Identical failures are summarized before individual
                    recovery actions.
                  </Typography>
                </Box>
                <Stack
                  direction={{ xs: 'column', sm: 'row' }}
                  spacing={1}
                  alignItems={{ sm: 'flex-end' }}
                >
                  <Button
                    variant="outlined"
                    startIcon={<FileDownloadRounded />}
                    disabled={rejections.length === 0}
                    onClick={downloadIssueSummaryCsv}
                    sx={actionButtonSx}
                  >
                    {rejectionReviewTruncated
                      ? 'Export loaded issues CSV'
                      : 'Export provider issues CSV'}
                  </Button>
                  <TextField
                    label="Search issues"
                    value={issueSearch}
                    onChange={(event) => {
                      setIssueSearch(event.target.value)
                      setIssuePage(0)
                    }}
                    sx={{ ...fieldSx, minWidth: { md: 320 } }}
                  />
                </Stack>
              </Stack>
              {rejectionReviewTruncated ? (
                <Alert severity="info">
                  Showing the newest {rejectionSummary?.returned ?? 0} of{' '}
                  {totalRejectionCount} current provider rejections. The issue
                  total includes every current provider identity; search,
                  recovery actions, and CSV export apply to the loaded subset.
                </Alert>
              ) : null}
              {candidateBlockerGroups.length ? (
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
                  {candidateBlockerGroups.map((group) => (
                    <Card key={group.code} variant="outlined">
                      <CardContent sx={{ '&:last-child': { pb: 2 } }}>
                        <Stack spacing={0.75}>
                          <Stack
                            direction="row"
                            justifyContent="space-between"
                            spacing={1}
                          >
                            <Typography fontWeight={700}>
                              {group.label}
                            </Typography>
                            <Chip
                              size="small"
                              color="warning"
                              label={`${group.count} ${
                                group.count === 1 ? 'order' : 'orders'
                              }`}
                            />
                          </Stack>
                          <Typography variant="body2" color="text.secondary">
                            {group.action}
                          </Typography>
                          <Button
                            size="small"
                            variant="text"
                            onClick={() => setWorkbenchTab('orders')}
                            sx={{ alignSelf: 'flex-start' }}
                          >
                            Review affected orders
                          </Button>
                          <Typography
                            variant="caption"
                            color="text.secondary"
                          >
                            Technical code: {group.code}
                          </Typography>
                        </Stack>
                      </CardContent>
                    </Card>
                  ))}
                </Box>
              ) : null}
              {rejectionGroups.length ? (
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
                  {rejectionGroups.map((group) => (
                    <Card
                      key={rejectionGroupKey(group)}
                      variant="outlined"
                    >
                      <CardContent sx={{ '&:last-child': { pb: 2 } }}>
                        <Stack spacing={0.75}>
                          <Stack
                            direction="row"
                            justifyContent="space-between"
                            spacing={1}
                          >
                            <Typography fontWeight={700}>
                              {rejectionTitle(group.code)}
                            </Typography>
                            <Chip
                              size="small"
                              color="warning"
                              label={`${group.count} ${
                                group.count === 1 ? 'record' : 'records'
                              }`}
                            />
                          </Stack>
                          <Typography variant="body2" color="text.secondary">
                            {group.message}
                          </Typography>
                          {provider === 'faire'
                          && group.code
                            === 'COMMERCE_ORDER_MONEY_INCOMPLETE' ? (
                            <Alert severity="info">
                              ClawPilot supports Faire&apos;s current
                              ExternalOrderV2 money fields. Use Retry all exact
                              orders below to restage these records with the
                              current adapter. Paid-shipping records can stage
                              as fulfillment-only candidates when exact
                              merchandise, discount, and tax evidence exists.
                              Missing shipping and total remain unavailable and
                              are never estimated.
                            </Alert>
                            ) : null}
                          {group.resourceType === 'order'
                          && group.code
                            === 'COMMERCE_ORDER_MONEY_INCOMPLETE' ? (
                            <Stack
                              direction={{ xs: 'column', sm: 'row' }}
                              alignItems={{ sm: 'center' }}
                              spacing={1}
                            >
                              <Button
                                variant="contained"
                                startIcon={<RefreshRounded />}
                                disabled={
                                  Boolean(pendingAction)
                                  || !operatorCommandsAllowed
                                }
                                onClick={() => {
                                  void retryOrderMoneyRejectionGroup(group)
                                }}
                                sx={actionButtonSx}
                              >
                                {pendingAction
                                  === 'bulk-retry-order-money'
                                && bulkRetryProgress?.groupKey
                                  === rejectionGroupKey(group)
                                  ? `Retrying ${
                                    bulkRetryProgress.completed
                                  } of ${bulkRetryProgress.total}…`
                                  : `Retry all exact orders (${group.count})`}
                              </Button>
                              <Typography
                                variant="caption"
                                color="text.secondary"
                              >
                                Re-reads only this visible matching group.
                                No provider data is changed.
                              </Typography>
                            </Stack>
                            ) : null}
                          <Typography
                            variant="caption"
                            color="text.secondary"
                          >
                            Technical code: {group.code}
                          </Typography>
                        </Stack>
                      </CardContent>
                    </Card>
                  ))}
                </Box>
              ) : null}
              {issueRecordCount > 0
              && candidateBlockerGroups.length === 0
              && rejectionGroups.length === 0 ? (
                <Alert severity="info">
                  No issues match the current search.
                </Alert>
                ) : null}
          {filteredRejections.length ? (
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
              {visibleRejections.map((rejection) => {
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
          ) : rejections.length === 0
          && candidateBlockerGroups.length === 0 ? (
            <Alert severity="success">
              No provider or order issues are waiting for review.
            </Alert>
          ) : null}
              {filteredRejections.length > workbenchPageSize ? (
                <TablePagination
                  component="div"
                  count={filteredRejections.length}
                  page={safeIssuePage}
                  onPageChange={(_event, page) => setIssuePage(page)}
                  rowsPerPage={workbenchPageSize}
                  rowsPerPageOptions={[workbenchPageSize]}
                  labelRowsPerPage="Issues per page"
                />
              ) : null}
            </Stack>
          ) : null}

          {workbenchTab === 'products' ? (
            <Stack
              role="tabpanel"
              id={`commerce-intake-panel-products-${accountGlobalId}`}
              aria-labelledby={`commerce-intake-tab-products-${accountGlobalId}`}
              spacing={2.5}
            >
          <Stack
            direction={{ xs: 'column', md: 'row' }}
            justifyContent="space-between"
            alignItems={{ md: 'flex-end' }}
            spacing={1.5}
          >
          <Box>
            <Typography variant="h6" fontWeight={700}>
              Products
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Match each provider variant to an existing product, create a new
              ClawPilot product, or skip it with an audited reason.
            </Typography>
          </Box>
            <Stack
              direction={{ xs: 'column', sm: 'row' }}
              spacing={1}
              alignItems={{ sm: 'flex-end' }}
              flexWrap="wrap"
            >
              <input
                ref={csvInputRef}
                hidden
                type="file"
                accept=".csv,text/csv"
                onChange={(event) => {
                  const file = event.target.files?.[0]
                  if (file) void previewProductDecisionCsv(file)
                }}
              />
              <Button
                variant="outlined"
                startIcon={<FileDownloadRounded />}
                disabled={unresolvedProductCount === 0}
                onClick={downloadProductReviewCsv}
                sx={actionButtonSx}
              >
                Download review CSV
              </Button>
              <Button
                variant="outlined"
                startIcon={<FileUploadRounded />}
                disabled={
                  Boolean(pendingAction)
                  || !operatorCommandsAllowed
                  || unresolvedProductCount === 0
                }
                onClick={() => csvInputRef.current?.click()}
                sx={actionButtonSx}
              >
                {pendingAction === 'preview-product-csv'
                  ? 'Checking CSV…'
                  : 'Import decisions'}
              </Button>
              <TextField
                select
                label="Show"
                value={productFilter}
                onChange={(event) => {
                  setProductFilter(
                    event.target.value as ProductReviewFilter,
                  )
                  setProductPage(0)
                }}
                sx={{ ...fieldSx, minWidth: { sm: 170 } }}
              >
                <MenuItem value="all">All products</MenuItem>
                <MenuItem value="needs_decision">Needs a decision</MenuItem>
                <MenuItem value="matched">Matched</MenuItem>
                <MenuItem value="skipped">Skipped</MenuItem>
              </TextField>
              <TextField
                label="Search products"
                value={productSearch}
                onChange={(event) => {
                  setProductSearch(event.target.value)
                  setProductPage(0)
                }}
                sx={{ ...fieldSx, minWidth: { md: 320 } }}
              />
            </Stack>
          </Stack>

          {productReviewTruncated && productCandidateSummary ? (
            <Alert
              severity={
                productCandidateSummary.unresolvedTruncated
                  ? 'warning'
                  : 'info'
              }
            >
              This review window shows {productCandidateSummary.returned} of{' '}
              {productCandidateSummary.total} current provider variants
              {productCandidateSummary.unresolved > 0
                ? `, including ${productCandidateSummary.unresolvedReturned} of ${productCandidateSummary.unresolved} that need a decision`
                : ''}. Automatic catalog sync processes the complete catalog;
              search, CSV, and bulk review actions on this screen apply only
              to the returned window.
            </Alert>
          ) : null}

          <Card
            variant="outlined"
            sx={{
              borderColor: automaticProductCreationEnabled
                ? 'success.main'
                : 'divider',
              backgroundColor: automaticProductCreationEnabled
                ? 'rgba(129,201,149,0.06)'
                : 'transparent',
            }}
          >
            <CardContent sx={{ '&:last-child': { pb: 2 } }}>
              <Stack spacing={1.25}>
                <Stack
                  direction={{ xs: 'column', md: 'row' }}
                  justifyContent="space-between"
                  alignItems={{ md: 'center' }}
                  spacing={1}
                >
                  <Box>
                    <Typography
                      variant="overline"
                      color="text.secondary"
                      fontWeight={700}
                    >
                      Product catalog
                    </Typography>
                    <Typography variant="subtitle1" fontWeight={700}>
                      Product catalog synchronization
                    </Typography>
                  </Box>
                  <Stack direction="row" gap={0.75} flexWrap="wrap">
                    <Chip
                      size="small"
                      color={
                        automaticProductCreationEnabled
                          ? 'success'
                          : 'default'
                      }
                      label={
                        pendingAction.startsWith(
                          'set-product-intake-policy:',
                        )
                          ? 'Saving…'
                          : `Catalog control: ${
                              automaticProductCreationEnabled
                                ? 'Resumed'
                                : 'Paused'
                            }`
                      }
                    />
                    <Chip
                      size="small"
                      color={
                        automaticProductCreationEnabled
                          ? catalogSyncColor(productCatalogSync)
                          : 'default'
                      }
                      variant="outlined"
                      label={
                        automaticProductCreationEnabled
                          ? catalogSyncLabel(productCatalogSync)
                          : 'Sync paused'
                      }
                    />
                  </Stack>
                </Stack>
                <FormControlLabel
                  sx={{
                    alignItems: 'flex-start',
                    m: 0,
                    gap: 1,
                  }}
                  control={(
                    <Switch
                      checked={automaticProductCreationEnabled}
                      disabled={
                        Boolean(pendingAction)
                        || (
                          !automaticProductCreationEnabled
                          && (
                            !operatorCommandsAllowed
                            || !connectionReady
                          )
                        )
                      }
                      onChange={(_event, checked) => {
                        void saveAutomaticProductCreationPolicy(checked)
                      }}
                      inputProps={{
                        'aria-label':
                          'Pause or resume product catalog sync',
                      }}
                    />
                  )}
                  label={(
                    <Box>
                      <Typography fontWeight={700}>
                        Pause or resume product catalog sync
                      </Typography>
                      <Typography variant="body2" color="text.secondary">
                        The verified sales-channel connection is the
                        authorization for automatic read-only catalog sync; no
                        second approval is required. When product-read access,
                        the development runtime, and the Operations product
                        target are eligible, ClawPilot queues a full
                        reconciliation. Pause stops future provider reads and
                        automatic creation; resume makes the connection
                        eligible to queue again. Existing products and mappings
                        remain unchanged while paused. A terminal sweep is not
                        retried by repairing eligibility alone; an authorized
                        operator must explicitly start a fresh reconciliation.
                        ClawPilot never writes to {providerLabel(provider)} or
                        changes an order.
                      </Typography>
                      <Typography
                        variant="caption"
                        color="text.secondary"
                        display="block"
                        sx={{ mt: 0.5 }}
                      >
                        Each sales channel keeps an exact provider-variant
                        mapping. Matching SKUs or titles are suggestions, not
                        automatic identity across Shopify and Faire. Potential
                        duplicates remain visible for an operator to resolve;
                        automation never guesses that two source records are
                        the same product.
                      </Typography>
                    </Box>
                  )}
                />
                <Stack direction="row" gap={0.75} flexWrap="wrap">
                  <Chip
                    size="small"
                    variant="outlined"
                    label={`Revision ${productIntakePolicyRevision}`}
                  />
                  <Chip
                    size="small"
                    variant="outlined"
                    label={`Updated ${formatDate(
                      productIntakePolicy?.updatedAt,
                    )}`}
                  />
                  <Chip
                    size="small"
                    variant="outlined"
                    label={`Policy ${
                      productIntakePolicy?.version || 'default'
                    }`}
                  />
                </Stack>
                <Alert
                  severity={
                    productCatalogSync?.status === 'dead'
                      ? 'error'
                      : (
                          productCatalogSync?.status === 'retrying'
                          || (
                            productCatalogSync?.status === 'completed'
                            && catalogSyncHasIssues(productCatalogSync)
                          )
                        )
                        ? 'warning'
                        : automaticProductCreationEnabled
                          ? 'success'
                          : 'info'
                  }
                >
                  {automaticProductCreationEnabled
                    ? catalogSyncDescription(productCatalogSync, provider)
                    : futureProductBehaviorMessage}
                </Alert>
                {automaticProductCreationEnabled
                && productCatalogSync?.terminalRecoveryRequired ? (
                  <Stack
                    direction={{ xs: 'column', sm: 'row' }}
                    alignItems={{ sm: 'center' }}
                    spacing={1}
                  >
                    <Button
                      variant="contained"
                      color="error"
                      startIcon={(
                        pendingAction.startsWith(
                          'reset-product-catalog-sync:',
                        )
                          ? <CircularProgress size={16} color="inherit" />
                          : <RefreshRounded />
                      )}
                      disabled={
                        Boolean(pendingAction)
                        || !operatorCommandsAllowed
                        || !connectionReady
                      }
                      onClick={() => {
                        void resetTerminalProductCatalogSync()
                      }}
                    >
                      {pendingAction.startsWith(
                        'reset-product-catalog-sync:',
                      )
                        ? 'Starting fresh…'
                        : 'Start fresh reconciliation'}
                    </Button>
                    <Typography variant="caption" color="text.secondary">
                      {!connectionReady
                        ? `Reconnect and verify ${providerLabel(provider)} first. Repairing the connection does not itself restart this terminal sweep.`
                        : !operatorCommandsAllowed
                          ? 'Set Operations to Shadow or Active first. Repairing eligibility does not itself restart this terminal sweep.'
                          : 'This confirmed action advances the policy fence, queues a new root read, and retains the terminal job as evidence.'}
                    </Typography>
                  </Stack>
                  ) : null}
                {automaticProductCreationEnabled && productCatalogSync ? (
                  <Stack direction="row" gap={0.75} flexWrap="wrap">
                    <Chip
                      size="small"
                      variant="outlined"
                      label={`${productCatalogSync.pageCount || 0} pages`}
                    />
                    <Chip
                      size="small"
                      variant="outlined"
                      label={`${productCatalogSync.providerRecordsSeen || 0} provider variants`}
                    />
                    <Chip
                      size="small"
                      variant="outlined"
                      label={`${productCatalogSync.productsCreated || 0} created`}
                    />
                    <Chip
                      size="small"
                      variant="outlined"
                      label={`${productCatalogSync.productsMapped || 0} matched`}
                    />
                    <Chip
                      size="small"
                      variant="outlined"
                      label={`${productCatalogSync.productsUnchanged || 0} unchanged`}
                    />
                    {productCatalogSync.status === 'dead' ? (
                      <Chip
                        size="small"
                        color="error"
                        variant="outlined"
                        label={`Terminal failures ${
                          productCatalogSync.sweepFailureCount || 0
                        }/${productCatalogSync.maxAttempts || 0}`}
                      />
                    ) : null}
                    <Chip
                      size="small"
                      variant="outlined"
                      label="0 orders changed"
                    />
                  </Stack>
                ) : null}
                {!automaticProductCreationEnabled
                && (!operatorCommandsAllowed || !connectionReady) ? (
                  <Typography variant="caption" color="text.secondary">
                    {!connectionReady
                      ? `Reconnect and verify ${providerLabel(provider)} before catalog sync can resume.`
                      : 'Configure the Operations product target in Shadow or Active before resumed catalog sync can run.'}
                    {' '}If the policy is already on, turning it off remains
                    available even when the connection or Operations is later
                    restricted.
                  </Typography>
                  ) : null}
              </Stack>
            </CardContent>
          </Card>

          {bulkNewProductCandidates.length > 0 ? (
            <Card
              variant="outlined"
              sx={{
                borderColor: 'primary.main',
                backgroundColor: 'rgba(168,199,250,0.05)',
              }}
            >
              <CardContent sx={{ '&:last-child': { pb: 2 } }}>
                <Stack spacing={1.25}>
                  <Stack
                    direction={{ xs: 'column', md: 'row' }}
                    justifyContent="space-between"
                    alignItems={{ md: 'center' }}
                    spacing={1.5}
                  >
                    <Box>
                      <Typography variant="subtitle1" fontWeight={700}>
                        {bulkInvalidProductCount > 0
                          ? 'Create the ready products in one reviewed action'
                          : 'Create the unmatched products in one reviewed action'}
                      </Typography>
                      <Typography variant="body2" color="text.secondary">
                        {bulkInvalidProductCount > 0
                          ? `ClawPilot can create and match ${
                              bulkCreatableProductCandidates.length
                            } ready ${
                              bulkCreatableProductCandidates.length === 1
                                ? 'product'
                                : 'products'
                            } now. The incomplete ${
                              bulkInvalidProductCount === 1
                                ? 'row stays'
                                : 'rows stay'
                            } in this review for correction.`
                          : 'ClawPilot will create and match every remaining product using the staged provider name, SKU, price, and currency.'}{' '}
                        Each included candidate uses its exact row version and
                        a replay-safe command.
                      </Typography>
                    </Box>
                    <Button
                      variant="contained"
                      startIcon={<AddCircleOutlineRounded />}
                      aria-label={
                        bulkInvalidProductCount > 0
                          ? 'Create ready products'
                          : 'Create all new products'
                      }
                      disabled={
                        Boolean(pendingAction)
                        || !operatorCommandsAllowed
                        || bulkCreatableProductCandidates.length === 0
                      }
                      onClick={() => {
                        void createAllNewCatalogProducts()
                      }}
                      sx={{
                        ...actionButtonSx,
                        flexShrink: 0,
                        minWidth: { sm: 230 },
                      }}
                    >
                      {pendingAction === 'bulk-create-products'
                        ? `Creating ${
                          bulkProductProgress?.completed || 0
                        } of ${
                          bulkProductProgress?.total
                          || bulkCreatableProductCandidates.length
                        }…`
                        : bulkInvalidProductCount > 0
                          ? `Create ready products (${
                              bulkCreatableProductCandidates.length
                            })`
                          : `Create all new products (${
                              bulkNewProductCandidates.length
                            })`}
                    </Button>
                  </Stack>
                  <Stack direction="row" gap={0.75} flexWrap="wrap">
                    <Chip
                      size="small"
                      color="info"
                      label={`${bulkNewProductCandidates.length} ${
                        bulkNewProductCandidates.length === 1
                          ? 'new product'
                          : 'new products'
                      }`}
                    />
                    {bulkInvalidProductCount > 0 ? (
                      <Chip
                        size="small"
                        color="success"
                        variant="outlined"
                        label={`${bulkCreatableProductCandidates.length} ready to create`}
                      />
                    ) : null}
                    {selectedExistingProductCount > 0 ? (
                      <Chip
                        size="small"
                        variant="outlined"
                        label={`${selectedExistingProductCount} selected for existing-product matching`}
                      />
                    ) : null}
                  </Stack>
                  {bulkInvalidProductCount > 0 ? (
                    <Alert severity="warning">
                      {bulkInvalidProductCount}{' '}
                      {bulkInvalidProductCount === 1
                        ? 'product needs'
                        : 'products need'}{' '}
                      a valid name, price, currency, and current row version
                      before being created.{' '}
                      {bulkCreatableProductCandidates.length > 0
                        ? 'These rows will be left for review and excluded from the ready-products action.'
                        : 'Correct the create fields in the product cards below before any product can be created.'}
                    </Alert>
                  ) : null}
                  <Typography variant="caption" color="text.secondary">
                    This action applies only to the products in this current
                    review and does not change the saved account policy.{' '}
                    {futureProductBehaviorMessage} Each created product gets
                    an exact mapping for this {providerLabel(provider)}{' '}
                    connection. SKU and title are suggestions, not automatic
                    cross-channel identity. Potential duplicates remain
                    reviewable instead of being silently combined.
                  </Typography>
                </Stack>
              </CardContent>
            </Card>
          ) : null}

          {csvImportPreview ? (
            <Card
              variant="outlined"
              sx={{
                borderColor: csvImportPreview.ok
                  ? 'success.main'
                  : 'warning.main',
              }}
            >
              <CardContent sx={{ '&:last-child': { pb: 2 } }}>
                <Stack spacing={1.25}>
                  <Stack
                    direction={{ xs: 'column', sm: 'row' }}
                    justifyContent="space-between"
                    spacing={1}
                  >
                    <Box>
                      <Typography fontWeight={700}>
                        CSV validation preview
                      </Typography>
                      <Typography
                        variant="body2"
                        color="text.secondary"
                        sx={{ overflowWrap: 'anywhere' }}
                      >
                        {csvImportFilename} · {csvImportPreview.totalRows}{' '}
                        {csvImportPreview.totalRows === 1 ? 'row' : 'rows'} ·{' '}
                        {csvImportPreview.decisions.length}{' '}
                        {csvImportPreview.decisions.length === 1
                          ? 'decision'
                          : 'decisions'} · {csvImportPreview.skippedRows} left
                        unchanged
                      </Typography>
                    </Box>
                    <Chip
                      size="small"
                      color={csvImportPreview.ok ? 'success' : 'warning'}
                      label={csvImportPreview.ok
                        ? 'Ready to apply'
                        : `${csvImportPreview.errors.length} ${
                          csvImportPreview.errors.length === 1
                            ? 'error'
                            : 'errors'
                        }`}
                    />
                  </Stack>
                  <Alert severity="info">
                    Only the <strong>action</strong> and corresponding decision
                    fields are applied. Every row must still match this
                    connection, its exact candidate ID, and its current row
                    version. Blank actions leave products unchanged.
                  </Alert>
                  {csvImportPreview.errors.length ? (
                    <Stack spacing={0.5}>
                      {csvImportPreview.errors.slice(0, 20).map((
                        rowError,
                        index,
                      ) => (
                        <Typography
                          key={`${rowError.rowNumber}:${rowError.column || ''}:${rowError.code}:${index}`}
                          variant="body2"
                          color="error"
                        >
                          {rowError.rowNumber
                            ? `Row ${rowError.rowNumber}`
                            : 'File'}
                          {rowError.column ? ` · ${rowError.column}` : ''}
                          : {rowError.message}
                        </Typography>
                      ))}
                      {csvImportPreview.errors.length > 20 ? (
                        <Typography variant="body2" color="error">
                          And {csvImportPreview.errors.length - 20} more
                          errors. Correct the file and import it again.
                        </Typography>
                      ) : null}
                    </Stack>
                  ) : null}
                  <Stack
                    direction={{ xs: 'column', sm: 'row' }}
                    spacing={1}
                  >
                    <Button
                      variant="contained"
                      disabled={
                        Boolean(pendingAction)
                        || !csvImportPreview.ok
                        || csvImportPreview.decisions.length === 0
                      }
                      onClick={() => void applyProductDecisionCsv()}
                      sx={actionButtonSx}
                    >
                      {pendingAction === 'apply-product-csv'
                        ? 'Applying decisions…'
                        : `Apply ${csvImportPreview.decisions.length} ${
                          csvImportPreview.decisions.length === 1
                            ? 'decision'
                            : 'decisions'
                        }`}
                    </Button>
                    <Button
                      variant="text"
                      disabled={Boolean(pendingAction)}
                      onClick={() => {
                        setCsvImportPreview(null)
                        setCsvImportFilename('')
                      }}
                      sx={actionButtonSx}
                    >
                      Clear preview
                    </Button>
                  </Stack>
                </Stack>
              </CardContent>
            </Card>
          ) : null}

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
              {filteredProductCandidates.length === 0 ? (
                <Alert severity="info">
                  No products match the current search and filter.
                </Alert>
              ) : null}
              {visibleProductCandidates.map((candidate) => {
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
                              {commerceProductDisplayName({
                                productTitle: candidate.productTitle,
                                variantTitle: candidate.variantTitle,
                                selectedOptions: candidate.selectedOptions,
                              })}
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
                            {candidate.providerTaxonomy ? (
                              <Typography
                                variant="caption"
                                color="text.secondary"
                                display="block"
                              >
                                {candidate.providerTaxonomy.scheme ===
                                'shopify_standard_product_taxonomy'
                                  ? 'Shopify category'
                                  : 'Faire product type'}
                                :{' '}
                                {candidate.providerTaxonomy.fullName
                                  || candidate.providerTaxonomy.name
                                  || candidate.providerTaxonomy.externalId
                                  || 'Unavailable'}
                              </Typography>
                            ) : null}
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
                              label={candidateStateLabel(candidate.state)}
                            />
                            <Chip
                              size="small"
                              variant="outlined"
                              color={productLifecycleColor(
                                candidate.normalizedStatus,
                              )}
                              label={`Source ${
                                candidate.normalizedStatus || 'unknown'
                              }`}
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
                                label={formatGrams(
                                  candidate.weightGrams as number,
                                  measurementSystem,
                                  { maximumFractionDigits: 3 },
                                )}
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
                            Matched to ClawPilot product{' '}
                            {candidate.productGlobalId}.
                          </Alert>
                        ) : candidate.state === 'failed' ? (
                          <Alert severity="info">
                            This provider revision was skipped:{' '}
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
                        ) : candidate.lastErrorCode ? (
                          <Alert severity="warning">
                            Automatic creation could not finish (
                            {candidate.lastErrorCode}). ClawPilot will retry this
                            current provider revision during the next catalog
                            reconciliation. You can also open{' '}
                            <strong>Choose product decision</strong> below to
                            resolve it now.
                          </Alert>
                        ) : (
                          <Alert severity="warning">
                            Open <strong>Choose product decision</strong> and
                            select one action. SKU and barcode are reference
                            details only; the provider variant remains the
                            connection identity.
                          </Alert>
                        )}

                        {!actionsLocked ? (
                          <Accordion
                            disableGutters
                            elevation={0}
                            sx={{
                              border: 1,
                              borderColor: 'divider',
                              borderRadius: '8px',
                              '&::before': { display: 'none' },
                            }}
                          >
                            <AccordionSummary
                              expandIcon={<ExpandMoreRounded />}
                              aria-controls={`product-decision-${candidate.globalId}`}
                            >
                              <Typography fontWeight={700}>
                                Choose product decision
                              </Typography>
                            </AccordionSummary>
                            <AccordionDetails
                              id={`product-decision-${candidate.globalId}`}
                            >
                              <Stack spacing={1.5}>
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
                                  : 'Match existing product'}
                              </Button>
                            </Stack>

                            <Divider>
                              <Typography
                                variant="caption"
                                color="text.secondary"
                              >
                                or create a new product
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
                                label={`Price (${draft.currency || 'currency'})`}
                                type="number"
                                value={draft.unitPriceMinor}
                                onChange={(event) => {
                                  updateCatalogProductDraft(candidate, {
                                    unitPriceMinor: event.target.value,
                                  })
                                }}
                                inputProps={{ min: 0, step: 'any' }}
                                helperText="Enter the normal customer-facing amount, such as 12.34."
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
                                : 'Create and match product'}
                            </Button>

                            <Divider>
                              <Typography
                                variant="caption"
                                color="text.secondary"
                              >
                                or skip this provider revision
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
                                label="Reason for skipping"
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
                                  : 'Skip this product'}
                              </Button>
                            </Box>
                              </Stack>
                            </AccordionDetails>
                          </Accordion>
                        ) : null}
                      </Stack>
                    </CardContent>
                  </Card>
                )
              })}
            </Stack>
          )}
              {filteredProductCandidates.length > workbenchPageSize ? (
                <TablePagination
                  component="div"
                  count={filteredProductCandidates.length}
                  page={safeProductPage}
                  onPageChange={(_event, page) => setProductPage(page)}
                  rowsPerPage={workbenchPageSize}
                  rowsPerPageOptions={[workbenchPageSize]}
                  labelRowsPerPage="Products per page"
                />
              ) : null}
            </Stack>
          ) : null}

          {workbenchTab === 'orders' ? (
            <Stack
              role="tabpanel"
              id={`commerce-intake-panel-orders-${accountGlobalId}`}
              aria-labelledby={`commerce-intake-tab-orders-${accountGlobalId}`}
              spacing={2.5}
            >
          <Stack
            direction={{ xs: 'column', md: 'row' }}
            justifyContent="space-between"
            alignItems={{ md: 'flex-end' }}
            spacing={1.5}
          >
          <Box>
            <Typography variant="h6" fontWeight={700}>
              Orders
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Fix required details, check each order, then explicitly add the
              approved order to ClawPilot.
            </Typography>
          </Box>
            <Stack
              direction={{ xs: 'column', sm: 'row' }}
              spacing={1}
              alignItems={{ sm: 'flex-end' }}
            >
              <Button
                variant="outlined"
                startIcon={<FileDownloadRounded />}
                disabled={candidates.length === 0}
                onClick={downloadOrderSummaryCsv}
                sx={actionButtonSx}
              >
                Export orders CSV
              </Button>
              <TextField
                select
                label="Show"
                value={orderFilter}
                onChange={(event) => {
                  setOrderFilter(event.target.value as OrderReviewFilter)
                  setOrderPage(0)
                }}
                sx={{ ...fieldSx, minWidth: { sm: 160 } }}
              >
                <MenuItem value="all">All orders</MenuItem>
                <MenuItem value="needs_review">Needs review</MenuItem>
                <MenuItem value="ready">Ready to add</MenuItem>
                <MenuItem value="added">Added</MenuItem>
                <MenuItem value="skipped">Skipped or expired</MenuItem>
              </TextField>
              <TextField
                label="Search orders"
                value={orderSearch}
                onChange={(event) => {
                  setOrderSearch(event.target.value)
                  setOrderPage(0)
                }}
                sx={{ ...fieldSx, minWidth: { md: 320 } }}
              />
            </Stack>
          </Stack>

          {!orderPagination && candidates.length === 0 ? (
            <Alert severity="info">
              Select <strong>Fetch operational orders</strong> to find orders
              for review. Nothing is added to ClawPilot until a ready order is
              explicitly approved.
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
              {filteredOrderCandidates.length === 0 ? (
                <Alert severity="info">
                  No orders match the current search and filter.
                </Alert>
              ) : null}
              {visibleOrderCandidates.map((candidate) => {
                const unavailableReason = candidateUnavailableReason(candidate)
                const candidateLocked = Boolean(unavailableReason)
                  || !operatorCommandsAllowed
                const refreshLocked = (
                  !Number.isInteger(candidate.rowVersion)
                  || candidate.state === 'promoted'
                  || candidate.state === 'expired'
                )
                const packPlanningLocked = (
                  !Number.isInteger(candidate.rowVersion)
                  || candidate.state === 'failed'
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
                      ? `${candidate.blockers.length} ${
                        candidate.blockers.length === 1 ? 'issue still needs' : 'issues still need'
                      } review.`
                      : 'Check the order successfully before adding it.')
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
                              label={candidateStateLabel(candidate.state)}
                            />
                            <Chip
                              size="small"
                              color={candidate.headerMoney?.state
                                === 'operational_incomplete'
                                ? 'warning'
                                : 'default'}
                              variant={candidate.headerMoney?.state
                                === 'operational_incomplete'
                                ? 'outlined'
                                : 'filled'}
                              label={candidate.headerMoney?.unavailableFields
                                .includes('total')
                                ? 'Header total unavailable'
                                : formatMoney(
                                  candidate.totalMinor,
                                  candidate.currency,
                                )}
                            />
                            {candidate.headerMoney?.unavailableFields
                              .includes('shipping') ? (
                              <Chip
                                size="small"
                                color="warning"
                                variant="outlined"
                                label="Shipping amount unavailable"
                              />
                              ) : null}
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
                            ClawPilot order {candidate.canonicalOrderGlobalId}
                            {' '}was created.
                          </Alert>
                        ) : null}
                        {candidate.checkoutRateReconciliation ? (
                          <Alert
                            severity={
                              candidate.checkoutRateReconciliation
                                .lineageRequired === false
                                ? 'info'
                                : candidate.checkoutRateReconciliation
                                .fulfillmentEligible
                                ? 'success'
                                : 'warning'
                            }
                          >
                            Shopify checkout quote{' '}
                            {candidate.checkoutRateReconciliation.outcome
                              ? humanize(
                                  candidate.checkoutRateReconciliation.outcome,
                                )
                              : 'Pending'}
                            {candidate.checkoutRateReconciliation
                              .receiptGlobalId
                              ? ` · receipt ${
                                  candidate.checkoutRateReconciliation
                                    .receiptGlobalId
                                }`
                              : ''}
                            {candidate.checkoutRateReconciliation
                              .lineageRequired === false
                              ? '. The selected Shopify shipping method does not require ClawPilot quote lineage.'
                              : !candidate.checkoutRateReconciliation
                                  .fulfillmentEligible
                                ? '. Warehouse release remains blocked until the immutable checkout quote lineage is matched.'
                                : '. Fulfillment lineage is verified.'}
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
                        {candidate.headerMoney?.state
                          === 'operational_incomplete' ? (
                          <Alert severity="warning">
                            The provider did not return exact{' '}
                            {candidate.headerMoney.unavailableFields
                              .map(humanize)
                              .join(' and ')}. ClawPilot can create fulfillment
                            demand only from confirmed remaining quantities and
                            order-time line prices. This order is blocked from
                            accounting and customer-charge use; missing
                            shipping or totals are never estimated.
                          </Alert>
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
                                const packagingMeasurementLabels =
                                  measurementUnits(
                                    packaging.measurementSystem,
                                  )
                                const selectedProduct = productCatalog.find(
                                  (product) => product.globalId
                                    === (draft.productGlobalId
                                      || line.productGlobalId),
                                )
                                const packageProfiles =
                                  selectedProduct?.packageProfiles || []
                                const manualPackageValid = [
                                  packaging.weight,
                                  packaging.length,
                                  packaging.width,
                                  packaging.height,
                                ].every((value) => positiveNumber(value))
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
                                            label={`Order price (${draft.currency || 'currency'})`}
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
                                            inputProps={{ min: 0, step: 'any' }}
                                            helperText="Required. Enter the amount shown on this order, such as 12.34. The current catalog price is never substituted."
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
                                          {line
                                            .commerceVariantPackMappingGlobalId ? (
                                              <Alert
                                                severity={
                                                  line.packageStatus === 'resolved'
                                                    ? 'success'
                                                    : 'info'
                                                }
                                              >
                                                {line.packProfilePackageLevel
                                                  ? `${humanize(
                                                      line.packProfilePackageLevel,
                                                    )} pack`
                                                  : 'Mapped pack'}
                                                {line
                                                  .packProfileBaseEachQuantity
                                                  ? ` · ${
                                                      line
                                                        .packProfileBaseEachQuantity
                                                    } base each`
                                                  : ''}
                                                {' · '}
                                                {
                                                  line
                                                    .commerceVariantPackMappingGlobalId
                                                }
                                                {line.packagingWeightSource
                                                  ? ` · weight from ${humanize(
                                                      line.packagingWeightSource,
                                                    ).toLowerCase()}`
                                                  : ' · package resolution still requires review'}
                                              </Alert>
                                            ) : null}
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
                                                          ? formatGrams(
                                                              profile.weightGrams,
                                                              measurementSystem,
                                                              { maximumFractionDigits: 3 },
                                                            )
                                                          : 'weight unavailable'} ·{' '}
                                                        {dimensionsLabel(
                                                          profile.dimensionsMm,
                                                          measurementSystem,
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
                                              ['weight', `Weight (${packagingMeasurementLabels.weight})`],
                                              ['length', `Length (${packagingMeasurementLabels.length})`],
                                              ['width', `Width (${packagingMeasurementLabels.length})`],
                                              ['height', `Height (${packagingMeasurementLabels.length})`],
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
                                                  min: 0.001,
                                                  step: 'any',
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
                                          <Typography variant="caption" color="text.secondary">
                                            Using {packaging.measurementSystem === 'imperial' ? 'Imperial' : 'Metric'} entry units fixed when this line was opened.
                                            ClawPilot converts these values once to canonical millimeters and grams when saved.
                                          </Typography>
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
                          {provider === 'shopify'
                          && candidate.state === 'promoted'
                          && candidate.checkoutRateReconciliation
                            ?.lineageRequired
                          && !candidate.checkoutRateReconciliation
                            .globalId ? (
                            <Button
                              variant="outlined"
                              startIcon={<CheckCircleOutlineRounded />}
                              disabled={
                                Boolean(pendingAction)
                                || !operatorCommandsAllowed
                              }
                              onClick={() => {
                                void postCommand(
                                  'reconcile-checkout-rate',
                                  `reconcile-checkout-rate:${
                                    candidate.globalId
                                  }`,
                                  {
                                    candidateGlobalId: candidate.globalId,
                                    rowVersion: candidate.rowVersion,
                                  },
                                  'Shopify checkout quote matching completed. Review the immutable result before warehouse release.',
                                )
                              }}
                              sx={actionButtonSx}
                            >
                              Match checkout quote
                            </Button>
                          ) : null}
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
                                'Order check completed. Review its current readiness before adding it.',
                              )
                            }}
                            sx={actionButtonSx}
                          >
                            Check order
                          </Button>
                          {candidate.requiresShipping !== false
                          && provider === 'shopify' ? (
                            <Button
                              variant="outlined"
                              startIcon={<Inventory2Rounded />}
                              disabled={
                                packPlanningLocked
                                || Boolean(pendingAction)
                                || !operatorCommandsAllowed
                                || !canManage
                              }
                              title={!canManage
                                ? 'Organization manager or administrator permission is required to plan packages and compare carrier rates.'
                                : candidate.state === 'promoted'
                                  ? 'Use current factual warehouse and packaging data to save operational pack facts for this ClawPilot order.'
                                  : undefined}
                              onClick={() => {
                                void openCartonizationPreview(candidate)
                              }}
                              sx={actionButtonSx}
                            >
                              Pack & compare rates
                            </Button>
                          ) : candidate.requiresShipping !== false ? (
                            <Button
                              variant="outlined"
                              startIcon={<Inventory2Rounded />}
                              disabled
                              title="Faire account-bound inventory reconciliation is not implemented yet."
                              sx={actionButtonSx}
                            >
                              Pack preview needs Faire inventory
                            </Button>
                          ) : null}
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
                                'Order added to ClawPilot. The provider was not changed.',
                              )
                            }}
                            sx={actionButtonSx}
                          >
                            Add order to ClawPilot
                          </Button>
                        </Stack>

                        {candidate.state !== 'ready'
                          && candidate.state !== 'promoted' ? (
                          <Typography
                            variant="caption"
                            color="text.secondary"
                          >
                            Cannot add this order yet: {promotionReason}
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
              {filteredOrderCandidates.length > workbenchPageSize ? (
                <TablePagination
                  component="div"
                  count={filteredOrderCandidates.length}
                  page={safeOrderPage}
                  onPageChange={(_event, page) => setOrderPage(page)}
                  rowsPerPage={workbenchPageSize}
                  rowsPerPageOptions={[workbenchPageSize]}
                  labelRowsPerPage="Orders per page"
                />
              ) : null}
            </Stack>
          ) : null}
        </Stack>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(cartonizationCandidate)}
        onClose={() => {
          if (!cartonizationLoading) setCartonizationCandidate(null)
        }}
        fullWidth
        maxWidth="md"
        aria-labelledby="cartonization-preview-title"
      >
        <DialogTitle id="cartonization-preview-title">
          <Stack direction="row" spacing={1} alignItems="center">
            <Inventory2Rounded color="primary" />
            <Box>
              <Typography variant="h6" fontWeight={700}>
                Pack and compare carrier rates
              </Typography>
              <Typography variant="caption" color="text.secondary">
                Order {cartonizationCandidate?.orderNumber
                  || cartonizationCandidate?.externalOrderId}
              </Typography>
            </Box>
          </Stack>
        </DialogTitle>
        <DialogContent dividers>
          <Stack spacing={2}>
            <Alert severity="info">
              {promotedWarehousePlanning
                ? `This order is already in ClawPilot as ${
                    cartonizationCandidate?.canonicalOrderGlobalId
                      || 'a canonical order'
                  }. Select its exact warehouse and current factual packaging, then save operational pack facts for warehouse planning. ClawPilot records reloadable plan evidence and read-only UPS and FedEx sandbox estimates; it does not buy postage, create a shipment, print, reserve inventory, or change Shopify.`
                : 'Start with the exact order, warehouse, inventory snapshot, and customer packaging recipe. You can run a fit-only preview or save a reloadable, read-only comparison of UPS and FedEx sandbox shipment rates covering every resulting package. Neither path buys postage, creates a shipment, prints, or changes inventory.'}
            </Alert>
            {!canManage ? (
              <Alert severity="warning">
                Organization manager or administrator permission is required
                {promotedWarehousePlanning
                  ? ' to save operational warehouse-planning evidence.'
                  : ' to run this preview.'}
              </Alert>
            ) : null}

            {cartonizationError ? (
              <Alert severity="error">{cartonizationError}</Alert>
            ) : null}
            {!cartonizationLoading
            && selectedCartonizationMaterialGlobalIds.length === 0 ? (
              <Button
                variant="contained"
                onClick={() => {
                  setCartonizationCandidate(null)
                  setWorkbenchOpen(false)
                  window.location.hash = '#operations/packaging-materials'
                }}
              >
                Complete packaging material setup
              </Button>
            ) : null}

            <Typography variant="overline" color="text.secondary">
              Step 1 · Select warehouse and packaging materials
            </Typography>
            <FormControl fullWidth sx={fieldSx}>
              <InputLabel>Warehouse</InputLabel>
              <Select
                label="Warehouse"
                value={selectedCartonizationWarehouseGlobalId}
                disabled={cartonizationLoading}
                onChange={(event) => {
                  setSelectedCartonizationWarehouseGlobalId(event.target.value)
                  setCartonizationPreview(null)
                  setCartonizationRateEvidence(null)
                }}
              >
                {cartonizationWarehouses
                  .filter((warehouse) => warehouse.status === 'active')
                  .map((warehouse) => (
                    <MenuItem
                      key={warehouse.globalId}
                      value={warehouse.globalId}
                    >
                      {warehouse.name} · {warehouse.globalId}
                    </MenuItem>
                  ))}
              </Select>
              <FormHelperText>
                The selected inventory run and carrier sender account must
                resolve to this exact active warehouse.
              </FormHelperText>
            </FormControl>

            <FormControl fullWidth sx={fieldSx}>
              <InputLabel>Packaging materials (1–8)</InputLabel>
              <Select
                multiple
                label="Packaging materials (1–8)"
                value={selectedCartonizationMaterialGlobalIds}
                disabled={cartonizationLoading}
                onChange={(event) => {
                  const value = typeof event.target.value === 'string'
                    ? event.target.value.split(',')
                    : event.target.value
                  const nextGlobalIds = Array.from(new Set(value)).slice(0, 8)
                  setSelectedCartonizationMaterialGlobalIds(nextGlobalIds)
                  setCartonizationPreview(null)
                  setCartonizationRateEvidence(null)
                  setSandboxParcelAssumptionsByMaterial((current) => (
                    Object.fromEntries(nextGlobalIds.map((globalId) => {
                      const material = cartonizationMaterials.find(
                        (candidate) => candidate.globalId === globalId,
                      ) || null
                      return [
                        globalId,
                        current[globalId]
                          || initialSandboxParcelAssumption(
                            material,
                            measurementSystem,
                          ),
                      ]
                    }))
                  ))
                  setSandboxAssumptionAcknowledged(false)
                }}
                renderValue={(selected) => selected.map((globalId) => (
                  cartonizationMaterials.find((material) => (
                    material.globalId === globalId
                  ))?.code || globalId
                )).join(', ')}
              >
                {cartonizationMaterials.map((material) => {
                  const selected = selectedCartonizationMaterialGlobalIds
                    .includes(material.globalId)
                  return (
                    <MenuItem
                      key={material.globalId}
                      value={material.globalId}
                      disabled={
                        !selected
                        && selectedCartonizationMaterialGlobalIds.length >= 8
                      }
                    >
                      <Checkbox checked={selected} />
                      <ListItemText
                        primary={`${material.code} · ${material.name}`}
                        secondary={`${packagingMaterialSummary(
                          material,
                          measurementSystem,
                        )} · ${
                          material.readiness.eligibleForCartonization
                            ? 'Optimizer ready'
                            : material.readiness.missing
                                .map(humanize)
                                .join(', ') || humanize(material.status)
                        }`}
                      />
                    </MenuItem>
                  )
                })}
              </Select>
              <FormHelperText>
                {promotedWarehousePlanning
                  ? 'Select one to eight materials. Saving operational facts requires each material to be active, stocked at this warehouse, and supported by factual exterior dimensions and tare.'
                  : 'Draft, uncosted, or out-of-stock materials remain selectable so the fit preview can return the exact corrective blocker. Reloadable rate evidence supports one to eight materials and binds each material to its own exterior dimensions and tare.'}
              </FormHelperText>
            </FormControl>

            {!promotedWarehousePlanning ? (
            <Box component="section" aria-labelledby="committed-inventory-title">
              <Typography variant="overline" color="text.secondary">
                Step 2 · Confirm inventory attribution
              </Typography>
              <Typography
                id="committed-inventory-title"
                variant="subtitle2"
                fontWeight={700}
                mb={0.5}
              >
                Inventory already committed to this exact order
              </Typography>
              <Alert severity="warning" variant="outlined" sx={{ mb: 1 }}>
                Default is zero. Shopify reports aggregate committed inventory,
                not which order owns it. Enter only the units you can attribute
                to this exact order; ClawPilot will never infer that allocation.
              </Alert>
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} mb={1}>
                <Button
                  size="small"
                  variant="outlined"
                  disabled={cartonizationLoading}
                  onClick={() => {
                    setAssumedCommittedByLine(Object.fromEntries(
                      (cartonizationCandidate?.lines || [])
                        .filter((line) => line.requiresShipping && line.quantity > 0)
                        .map((line) => [line.globalId, '0']),
                    ))
                    setCartonizationPreview(null)
                  }}
                >
                  Use ATP only
                </Button>
                <Button
                  size="small"
                  variant="outlined"
                  color="warning"
                  disabled={cartonizationLoading}
                  onClick={() => {
                    setAssumedCommittedByLine(Object.fromEntries(
                      (cartonizationCandidate?.lines || [])
                        .filter((line) => line.requiresShipping && line.quantity > 0)
                        .map((line) => [line.globalId, String(line.quantity)]),
                    ))
                    setCartonizationPreview(null)
                  }}
                >
                  Assert all remaining units
                </Button>
              </Stack>
              <Stack spacing={1}>
                {(cartonizationCandidate?.lines || [])
                  .filter((line) => line.requiresShipping && line.quantity > 0)
                  .map((line) => (
                    <TextField
                      key={line.globalId}
                      size="small"
                      type="number"
                      label={`${line.title} committed units`}
                      value={assumedCommittedByLine[line.globalId] || '0'}
                      disabled={cartonizationLoading}
                      inputProps={{
                        min: 0,
                        max: line.quantity,
                        step: 1,
                      }}
                      helperText={`Whole units from 0 to ${line.quantity}; zero uses Shopify ATP only.`}
                      onChange={(event) => {
                        setAssumedCommittedByLine((current) => ({
                          ...current,
                          [line.globalId]: event.target.value,
                        }))
                        setCartonizationPreview(null)
                      }}
                    />
                  ))}
              </Stack>
            </Box>
            ) : null}

            <Box
              component="section"
              aria-labelledby="operational-rating-title"
            >
              <Typography variant="overline" color="text.secondary">
                {promotedWarehousePlanning
                  ? 'Step 2 · Save warehouse planning evidence'
                  : 'Preferred path · Use current operational facts'}
              </Typography>
              <Typography
                id="operational-rating-title"
                variant="subtitle2"
                fontWeight={700}
                mb={0.5}
              >
                Save a factual pack plan with read-only sandbox carrier estimates
              </Typography>
              <Alert
                severity={operationalRateEvidenceReady ? 'success' : 'info'}
                variant="outlined"
                sx={{ mb: 1 }}
              >
                This path accepts no operator parcel, inventory, or minimum
                assumptions. It requires active current recipes and packaging,
                customer-confirmed, measured, or provider-rated exterior
                measurements, positive tare, and available packaging stock.
                Shopify orders use the provider commitment as a read-only
                preflight; the later Plan action locks the exact claim.
              </Alert>
              <Alert severity="warning" variant="outlined" sx={{ mb: 1.5 }}>
                Carrier reads still use UPS and FedEx sandbox accounts. This
                development/shadow evidence is not an executable production
                rate, postage purchase, label, shipment, or billed cost.
              </Alert>
              {operationalRateEvidenceReady ? (
                <Typography variant="body2" color="success.main">
                  The selected warehouse and packaging pass the current
                  operational-fact preflight.
                </Typography>
              ) : operationalMaterialBlockers.length > 0 ? (
                <Box
                  component="ul"
                  aria-label="Operational pack evidence blockers"
                  sx={{ my: 0, pl: 3 }}
                >
                  {operationalMaterialBlockers.map((blocker) => (
                    <Typography
                      component="li"
                      variant="body2"
                      color="text.secondary"
                      key={blocker}
                    >
                      {blocker}
                    </Typography>
                  ))}
                </Box>
              ) : (
                <Typography variant="body2" color="text.secondary">
                  Select one to eight packaging materials and an active
                  warehouse to evaluate this path.
                </Typography>
              )}
            </Box>

            {!promotedWarehousePlanning ? (
            <Box component="section" aria-labelledby="sandbox-rating-title">
              <Typography variant="overline" color="text.secondary">
                Step 3 · Compare UPS and FedEx without shipping
              </Typography>
              <Typography
                id="sandbox-rating-title"
                variant="subtitle2"
                fontWeight={700}
                mb={0.5}
              >
                Explicit sandbox parcel assumptions
              </Typography>
              <Alert severity="warning" variant="outlined" sx={{ mb: 1.5 }}>
                These values are used only for this saved sandbox comparison.
                They do not activate the packaging material or become customer
                master data. The evidence remains visibly watermarked until
                tare and rated exterior measurements are verified.
              </Alert>
              {selectedCartonizationMaterials.length > 0 ? (
                <Stack spacing={1.5} mb={1.5}>
                  <Typography variant="caption" color="text.secondary">
                    {selectedCartonizationMaterials.length} of 8 materials
                    selected. Confirm a rated exterior size and temporary tare
                    for every material before saving the comparison.
                  </Typography>
                  {selectedCartonizationMaterials.map((material) => {
                    const assumption =
                      sandboxParcelAssumptionsByMaterial[material.globalId]
                      || initialSandboxParcelAssumption(
                        material,
                        measurementSystem,
                      )
                    const units = measurementUnits(
                      assumption.measurementSystem,
                    )
                    const headingId =
                      `sandbox-rate-assumption-${material.globalId}`
                    return (
                      <Card
                        key={material.globalId}
                        variant="outlined"
                        component="section"
                        aria-labelledby={headingId}
                      >
                        <CardContent sx={{ '&:last-child': { pb: 2 } }}>
                          <Typography id={headingId} fontWeight={700}>
                            {material.code} · {material.name}
                          </Typography>
                          <Typography variant="body2" color="text.secondary">
                            Stored measurement:{' '}
                            {packagingMaterialSummary(
                              material,
                              measurementSystem,
                            )} · basis {
                              humanize(material.dimensionBasis)
                            } · evidence {
                              humanize(material.dimensionEvidenceType)
                            }
                          </Typography>
                          <Typography
                            variant="caption"
                            color="text.secondary"
                            sx={{
                              display: 'block',
                              overflowWrap: 'anywhere',
                              mb: 1,
                            }}
                          >
                            {material.dimensionEvidenceReference
                              || 'No evidence reference'}
                          </Typography>
                          <Box
                            sx={{
                              display: 'grid',
                              gridTemplateColumns: {
                                xs: '1fr',
                                sm: 'repeat(2, minmax(0, 1fr))',
                                md: 'repeat(4, minmax(0, 1fr))',
                              },
                              gap: 1,
                            }}
                          >
                            {([
                              ['length', 'length'],
                              ['width', 'width'],
                              ['height', 'height'],
                            ] as const).map(([field, label]) => (
                              <TextField
                                key={field}
                                fullWidth
                                size="small"
                                type="number"
                                label={`${material.code} rated exterior ${label} (${units.length})`}
                                value={assumption[field]}
                                disabled={cartonizationLoading}
                                inputProps={{ min: 0, step: 0.001 }}
                                onChange={(event) => {
                                  setSandboxParcelAssumptionsByMaterial(
                                    (current) => ({
                                      ...current,
                                      [material.globalId]: {
                                        ...(current[material.globalId]
                                          || assumption),
                                        [field]: event.target.value,
                                      },
                                    }),
                                  )
                                  setCartonizationRateEvidence(null)
                                  setSandboxAssumptionAcknowledged(false)
                                }}
                              />
                            ))}
                            <TextField
                              fullWidth
                              size="small"
                              type="number"
                              label={`${material.code} sandbox-only tare (${units.weight})`}
                              value={assumption.tareWeight}
                              disabled={cartonizationLoading}
                              inputProps={{ min: 0, step: 0.001 }}
                              helperText="Temporary rating assumption"
                              onChange={(event) => {
                                setSandboxParcelAssumptionsByMaterial(
                                  (current) => ({
                                    ...current,
                                    [material.globalId]: {
                                      ...(current[material.globalId]
                                        || assumption),
                                      tareWeight: event.target.value,
                                    },
                                  }),
                                )
                                setCartonizationRateEvidence(null)
                                setSandboxAssumptionAcknowledged(false)
                              }}
                            />
                          </Box>
                        </CardContent>
                      </Card>
                    )
                  })}
                </Stack>
              ) : (
                <Alert severity="info" sx={{ mb: 1.5 }}>
                  Select one to eight packaging materials to enter their
                  sandbox rate assumptions.
                </Alert>
              )}
              <FormControlLabel
                control={(
                  <Checkbox
                    checked={allowSandboxMinimumOverride}
                    disabled={cartonizationLoading}
                    onChange={(event) => {
                      setAllowSandboxMinimumOverride(event.target.checked)
                      setCartonizationRateEvidence(null)
                      setSandboxAssumptionAcknowledged(false)
                    }}
                  />
                )}
                label="For this sandbox proof only, allow a below-minimum customer recipe quantity"
              />
              <TextField
                fullWidth
                size="small"
                label="Why these sandbox assumptions are being used"
                value={sandboxAssumptionReason}
                disabled={cartonizationLoading}
                placeholder="Example: Test order is below the approved case minimum; dimensions came from the customer email and tare is test-only."
                sx={{ mt: 1 }}
                onChange={(event) => {
                  setSandboxAssumptionReason(event.target.value)
                  setCartonizationRateEvidence(null)
                  setSandboxAssumptionAcknowledged(false)
                }}
              />
              <FormControlLabel
                sx={{ alignItems: 'flex-start', mt: 1 }}
                control={(
                  <Checkbox
                    checked={sandboxAssumptionAcknowledged}
                    disabled={cartonizationLoading}
                    onChange={(event) => {
                      setSandboxAssumptionAcknowledged(event.target.checked)
                    }}
                  />
                )}
                label="I understand this is assumption-backed sandbox evidence, not executable shipping cost, postage, or approved packaging master data."
              />
            </Box>
            ) : (
              <Alert severity="warning" variant="outlined">
                Fit-only preview and assumption-backed sandbox comparison are
                unavailable after promotion. Warehouse planning must use the
                current provider inventory, product packing profiles, and
                factual packaging master data. Correct those records if needed,
                reopen this order, and select <strong>Save operational pack
                facts</strong>.
              </Alert>
            )}

            {cartonizationLoading ? (
              <Stack direction="row" spacing={1} alignItems="center">
                <CircularProgress size={20} />
                <Typography variant="body2">
                  Reading exact revisions and, when requested, obtaining
                  read-only UPS and FedEx sandbox rates…
                </Typography>
              </Stack>
            ) : null}

            {cartonizationRateEvidence ? (
              <Box component="section" aria-label="Saved carrier comparison">
                <Alert
                  severity={
                    cartonizationRateEvidence.evidenceMode === 'operational'
                      ? 'info'
                      : 'warning'
                  }
                  sx={{ mb: 1.5 }}
                >
                  {cartonizationRateEvidence.evidenceMode === 'operational'
                    ? 'OPERATIONAL PACK FACTS · READ-ONLY SANDBOX CARRIER ESTIMATES · DEV/SHADOW ONLY'
                    : 'ASSUMPTION-BACKED SANDBOX EVIDENCE · NOT EXECUTABLE OR ACTUAL BILLED COST'}
                </Alert>
                <Stack
                  direction={{ xs: 'column', sm: 'row' }}
                  justifyContent="space-between"
                  alignItems={{ sm: 'center' }}
                  spacing={1}
                  mb={1}
                >
                  <Box>
                    <Typography variant="subtitle1" fontWeight={700}>
                      Saved pack and carrier comparison
                    </Typography>
                    <Typography
                      variant="caption"
                      color="text.secondary"
                      sx={{ overflowWrap: 'anywhere' }}
                    >
                      {cartonizationRateEvidence.globalId} · Order {
                        cartonizationRateEvidence.candidateOrderNumber
                      } · {cartonizationRateEvidence.warehouse.name}
                    </Typography>
                  </Box>
                  <Chip
                    color={
                      cartonizationRateEvidence.status === 'succeeded'
                        ? 'success'
                        : cartonizationRateEvidence.status === 'partial'
                          ? 'warning'
                          : 'error'
                    }
                    label={humanize(cartonizationRateEvidence.status)}
                  />
                </Stack>
                <Card variant="outlined" sx={{ mb: 1.5 }}>
                  <CardContent sx={{ '&:last-child': { pb: 2 } }}>
                    <Typography variant="subtitle1" fontWeight={700}>
                      Shipment-level service options — one service applies to
                      all {cartonizationRateEvidence.packages.length} package{
                        cartonizationRateEvidence.packages.length === 1
                          ? ''
                          : 's'
                      }
                    </Typography>
                    <Alert severity="info" variant="outlined" sx={{ my: 1 }}>
                      Only the options below apply to the shipment. Each amount
                      is the whole-shipment total returned once by a
                      multi-package carrier request; repeated package evidence
                      references are not added together.
                    </Alert>
                    {cartonizationShipmentServiceOptions.length > 0 ? (
                      <Box
                        component="ul"
                        aria-label="Valid shipment-level carrier service options"
                        sx={{
                          display: 'grid',
                          gridTemplateColumns: {
                            xs: '1fr',
                            sm: 'repeat(2, minmax(0, 1fr))',
                          },
                          gap: 1,
                          listStyle: 'none',
                          m: 0,
                          p: 0,
                        }}
                      >
                        {cartonizationShipmentServiceOptions.map((option) => (
                          <Box
                            component="li"
                            key={[
                              option.provider,
                              option.serviceCode,
                              option.serviceName,
                              option.currency,
                            ].join(':')}
                            sx={{
                              border: '1px solid',
                              borderColor: 'divider',
                              borderRadius: 1,
                              p: 1,
                            }}
                          >
                            <Stack
                              direction="row"
                              justifyContent="space-between"
                              alignItems="flex-start"
                              spacing={1}
                            >
                              <Box>
                                <Typography fontWeight={700}>
                                  {carrierLabel(option.provider)} · {
                                    option.serviceName
                                  }
                                </Typography>
                                <Typography
                                  variant="caption"
                                  color="text.secondary"
                                >
                                  Service {option.serviceCode} · {
                                    option.currency
                                  }
                                </Typography>
                              </Box>
                              <Chip
                                size="small"
                                color="success"
                                label="Shipment option"
                              />
                            </Stack>
                            <Typography variant="h6" fontWeight={700}>
                              {formatShipmentRate(
                                option.amount,
                                option.currency,
                              )}
                            </Typography>
                            <Typography
                              variant="caption"
                              color="text.secondary"
                              display="block"
                              sx={{
                                overflowWrap: 'anywhere',
                                fontFamily: 'monospace',
                              }}
                            >
                              {option.rateEvidenceGlobalId}
                            </Typography>
                          </Box>
                        ))}
                      </Box>
                    ) : (
                      <Alert severity="warning">
                        No single carrier service and currency was returned by
                        one multi-package request for every physical package.
                        This evidence has no shipment-level service option.
                      </Alert>
                    )}
                  </CardContent>
                </Card>
                <Stack spacing={1}>
                  {cartonizationRateEvidence.packages.map((packagePlan) => (
                    <Card key={packagePlan.packageKey} variant="outlined">
                      <CardContent sx={{ '&:last-child': { pb: 2 } }}>
                        <Typography fontWeight={700}>
                          Package {packagePlan.packageKey} · {
                            packagePlan.packagingMaterialName
                          }
                        </Typography>
                        <Typography variant="body2" color="text.secondary">
                          Rated exterior {
                            formatDimensionsMm({
                              lengthMm:
                                packagePlan.ratedOuterDimensionsMm.length,
                              widthMm:
                                packagePlan.ratedOuterDimensionsMm.width,
                              heightMm:
                                packagePlan.ratedOuterDimensionsMm.height,
                            }, measurementSystem, {
                              maximumFractionDigits: 3,
                            })
                          } · content {
                            formatGrams(
                              packagePlan.contentWeightGrams,
                              measurementSystem,
                              { maximumFractionDigits: 3 },
                            )
                          } + tare {
                            formatGrams(
                              packagePlan.tareWeightGrams,
                              measurementSystem,
                              { maximumFractionDigits: 3 },
                            )
                          } = rated {
                            formatGrams(
                              packagePlan.ratedGrossWeightGrams,
                              measurementSystem,
                              { maximumFractionDigits: 3 },
                            )
                          }
                        </Typography>
                        <Divider sx={{ my: 1 }} />
                        {packagePlan.allocations.map((allocation) => (
                          <Typography
                            key={`${packagePlan.packageKey}:${allocation.lineGlobalId}`}
                            variant="body2"
                          >
                            {allocation.quantity} × {allocation.title}
                          </Typography>
                        ))}
                        <Box sx={{ mt: 1.5 }}>
                          <Typography
                            variant="caption"
                            color="text.secondary"
                            display="block"
                          >
                            Immutable carrier evidence references · supporting
                            parcel evidence only, not package-level choices
                          </Typography>
                          <Stack
                            component="ul"
                            direction={{ xs: 'column', sm: 'row' }}
                            spacing={1}
                            aria-label={`Carrier evidence references for package ${packagePlan.packageKey}`}
                            sx={{ listStyle: 'none', m: 0, mt: 0.5, p: 0 }}
                          >
                            {packagePlan.quotes.map((quote) => (
                              <Box
                                component="li"
                                key={`${packagePlan.packageKey}:${quote.provider}`}
                                sx={{
                                  flex: 1,
                                  minWidth: 0,
                                  borderLeft: '3px solid',
                                  borderColor: quote.status === 'succeeded'
                                    ? 'success.main'
                                    : 'error.main',
                                  pl: 1,
                                }}
                              >
                                <Typography variant="body2" fontWeight={700}>
                                  {carrierLabel(quote.provider)} · {
                                    quote.rateScope
                                      === 'multi_package_shipment'
                                      ? 'Multi-package shipment reference'
                                      : 'Legacy single-package rate evidence'
                                  } · {humanize(quote.status)}
                                </Typography>
                                <Typography
                                  variant="caption"
                                  color="text.secondary"
                                  sx={{
                                    display: 'block',
                                    overflowWrap: 'anywhere',
                                    fontFamily: 'monospace',
                                  }}
                                >
                                  {quote.rateEvidenceGlobalId}
                                </Typography>
                                {quote.rateScope === 'single_package' ? (
                                  <Box sx={{ mt: 0.75 }}>
                                    <Alert severity="warning" variant="outlined">
                                      Read-only historical package rates. They
                                      are not summed or offered as shipment
                                      service options.
                                    </Alert>
                                    <Stack
                                      component="ul"
                                      spacing={0.5}
                                      aria-label={`Legacy package rates from ${carrierLabel(quote.provider)}`}
                                      sx={{
                                        listStyle: 'none',
                                        m: 0,
                                        mt: 0.75,
                                        p: 0,
                                      }}
                                    >
                                      {quote.rates.map((rate) => (
                                        <Box
                                          component="li"
                                          key={[
                                            rate.serviceCode,
                                            rate.serviceName,
                                            rate.currency,
                                            rate.amount,
                                          ].join(':')}
                                          sx={{
                                            display: 'flex',
                                            justifyContent: 'space-between',
                                            gap: 1,
                                          }}
                                        >
                                          <Typography variant="body2">
                                            {rate.serviceName} · {
                                              rate.serviceCode
                                            }
                                          </Typography>
                                          <Typography
                                            variant="body2"
                                            fontWeight={700}
                                          >
                                            {Number.isFinite(
                                              Number(rate.amount),
                                            )
                                              ? formatShipmentRate(
                                                  Number(rate.amount),
                                                  rate.currency,
                                                )
                                              : `${rate.amount} ${rate.currency}`}
                                          </Typography>
                                        </Box>
                                      ))}
                                    </Stack>
                                  </Box>
                                ) : null}
                              </Box>
                            ))}
                          </Stack>
                        </Box>
                      </CardContent>
                    </Card>
                  ))}
                </Stack>
                <Stack
                  direction={{ xs: 'column', sm: 'row' }}
                  spacing={1}
                  mt={1.5}
                >
                  <Button
                    variant="contained"
                    onClick={openCartonizationRateEvidence}
                  >
                    Open reloadable evidence
                  </Button>
                  <Button
                    variant="outlined"
                    onClick={() => {
                      void copyCartonizationRateEvidenceLink()
                    }}
                  >
                    Copy evidence link
                  </Button>
                </Stack>
              </Box>
            ) : null}

            {cartonizationPreview ? (
              <>
                <Alert
                  severity={
                    cartonizationPreview.status === 'ready'
                      ? 'success'
                      : cartonizationPreview.status === 'infeasible'
                        ? 'warning'
                        : 'info'
                  }
                >
                  {cartonizationPreview.status === 'ready'
                    ? `Fit and material plan ready at ${cartonizationPreview.warehouse?.name || 'the selected warehouse'}.`
                    : cartonizationPreview.status === 'infeasible'
                      ? 'The selected facts are complete, but no selected material fits this order under the fixed-axis preview.'
                      : 'The preview stopped before optimization because exact required facts are missing.'}
                </Alert>

                <Card variant="outlined">
                  <CardContent sx={{ '&:last-child': { pb: 2 } }}>
                    <Typography variant="subtitle2" fontWeight={700} mb={0.5}>
                      Point-in-time inventory evidence
                    </Typography>
                    <Typography variant="caption" color="text.secondary" display="block">
                      Sync {cartonizationPreview.inventoryEvidence.syncRunGlobalId
                        || 'unavailable'} · provider fetched{' '}
                      {formatDate(
                        cartonizationPreview.inventoryEvidence.providerFetchedAt,
                      )}
                    </Typography>
                    <Stack spacing={0.5} mt={1}>
                      {cartonizationPreview.inventoryEvidence.products
                        .map((product) => (
                          <Typography
                            key={product.productGlobalId}
                            variant="body2"
                            sx={{ overflowWrap: 'anywhere' }}
                          >
                            {product.productGlobalId}: demand{' '}
                            {product.demandQuantity} · attributed to this order{' '}
                            {product.assumedCommittedQuantity} · eligible{' '}
                            {product.eligibleQuantity === null
                              ? `blocked until exactly one inventory position is resolved (${product.positionCount} found)`
                              : product.eligibleQuantity}
                          </Typography>
                        ))}
                      {cartonizationPreview.inventoryEvidence.positions
                        .filter((position) => (
                          cartonizationPreview.inventoryEvidence.products.some(
                            (product) => (
                              product.productGlobalId === position.productGlobalId
                            ),
                          )
                        ))
                        .map((position) => (
                          <Typography
                            key={position.positionGlobalId}
                            variant="caption"
                            color="text.secondary"
                            sx={{ overflowWrap: 'anywhere' }}
                          >
                            Position {position.positionGlobalId} · {
                              position.productGlobalId
                            } · ATP {position.atpQuantity} · provider committed{' '}
                            {position.providerCommittedQuantity}
                          </Typography>
                        ))}
                    </Stack>
                  </CardContent>
                </Card>

                {!cartonizationEvidenceSafe ? (
                  <Alert severity="error">
                    The preview response did not preserve the required read-only
                    evidence boundary, so no plan is displayed.
                  </Alert>
                ) : null}

                {cartonizationPreview.blockers.length > 0 ? (
                  <Stack spacing={1}>
                    <Typography variant="subtitle2" fontWeight={700}>
                      Required corrections
                    </Typography>
                    {cartonizationPreview.blockers.map((blocker) => (
                      <Alert key={`${blocker.code}:${blocker.entityGlobalId || ''}`} severity="warning">
                        <Typography fontWeight={700}>{blocker.title}</Typography>
                        <Typography variant="body2">{blocker.detail}</Typography>
                        <Typography variant="caption" display="block" sx={{ mt: 0.5 }}>
                          Next action: {blocker.action}
                        </Typography>
                        {blocker.entityType === 'line' ? (
                          <Button
                            size="small"
                            sx={{ mt: 1 }}
                            onClick={() => setCartonizationCandidate(null)}
                          >
                            Open this order&apos;s package fields
                          </Button>
                        ) : blocker.entityType === 'material' ? (
                          <Button
                            size="small"
                            sx={{ mt: 1 }}
                            onClick={() => {
                              setCartonizationCandidate(null)
                              setWorkbenchOpen(false)
                              window.location.hash = '#operations/packaging-materials'
                            }}
                          >
                            Fix packaging materials
                          </Button>
                        ) : blocker.entityType === 'inventory' ? (
                          <Button
                            size="small"
                            sx={{ mt: 1 }}
                            onClick={() => {
                              setCartonizationCandidate(null)
                              setWorkbenchOpen(false)
                              window.location.hash = '#operations/shopify-inventory'
                            }}
                          >
                            Open Shopify inventory
                          </Button>
                        ) : blocker.entityType === 'warehouse' ? (
                          <Button
                            size="small"
                            sx={{ mt: 1 }}
                            onClick={() => {
                              setCartonizationCandidate(null)
                              setWorkbenchOpen(false)
                              window.location.hash = '#operations/warehouses'
                            }}
                          >
                            Open warehouses
                          </Button>
                        ) : blocker.entityType === 'optimizer' ? (
                          <Button
                            size="small"
                            sx={{ mt: 1 }}
                            onClick={() => {
                              void runCartonizationPreview()
                            }}
                          >
                            Retry optimizer
                          </Button>
                        ) : (
                          <Button
                            size="small"
                            sx={{ mt: 1 }}
                            onClick={() => setCartonizationCandidate(null)}
                          >
                            Review sales channel
                          </Button>
                        )}
                      </Alert>
                    ))}
                  </Stack>
                ) : null}

                {cartonizationEvidenceSafe
                && cartonizationPreview.optimizer?.selectedPlan ? (
                  <Box component="section" aria-label="Optimized carton plan">
                    <Stack
                      direction={{ xs: 'column', sm: 'row' }}
                      justifyContent="space-between"
                      gap={1}
                      mb={1}
                    >
                      <Box>
                        <Typography variant="subtitle1" fontWeight={700}>
                          {cartonizationPreview.optimizer.selectedPlan.cartonCount === 1
                            ? 'One-shipment, one-package fit and material plan'
                            : `${cartonizationPreview.optimizer.selectedPlan.shipmentCount}-shipment, ${cartonizationPreview.optimizer.selectedPlan.cartonCount}-package multi-piece fit and material plan`}
                        </Typography>
                        <Typography variant="caption" color="text.secondary">
                          {cartonizationPreview.optimizer.method} · {
                            cartonizationPreview.optimizer.status
                          } · {cartonizationPreview.optimizer.durationMs} ms ·
                          {' '}estimated material-plan cost{' '}
                          {formatCommerceMoneyMajor(
                            cartonizationPreview.optimizer.selectedPlan
                              .estimatedTotalCostMinor,
                            cartonizationCandidate?.currency || 'USD',
                          )}
                        </Typography>
                      </Box>
                      <Chip
                        color="success"
                        variant="outlined"
                        label={`${
                          cartonizationPreview.optimizer.selectedPlan.shipmentCount
                        } ${
                          cartonizationPreview.optimizer.selectedPlan.shipmentCount === 1
                            ? 'shipment'
                            : 'shipments'
                        } · ${
                          cartonizationPreview.optimizer.selectedPlan.cartonCount
                        } ${
                          cartonizationPreview.optimizer.selectedPlan.cartonCount === 1
                            ? 'package'
                            : 'packages'
                        }`}
                      />
                    </Stack>
                    <Stack spacing={1}>
                      {cartonizationPreview.optimizer.selectedPlan.packages.map(
                        (packagePlan, index) => {
                          const material = cartonizationMaterials.find(
                            (candidate) => candidate.globalId === packagePlan.cartonGlobalId,
                          )
                          const volume = packagePlan.innerDimensionsMm.length
                            * packagePlan.innerDimensionsMm.width
                            * packagePlan.innerDimensionsMm.height
                          const utilization = volume > 0
                            ? Math.max(0, Math.min(
                                100,
                                (1 - packagePlan.unusedVolumeMm3 / volume) * 100,
                              ))
                            : 0
                          return (
                            <Card key={packagePlan.packageKey} variant="outlined">
                              <CardContent sx={{ '&:last-child': { pb: 2 } }}>
                                <Stack spacing={1}>
                                  <Stack
                                    direction={{ xs: 'column', sm: 'row' }}
                                    justifyContent="space-between"
                                    gap={1}
                                  >
                                    <Box>
                                      <Typography fontWeight={700}>
                                        Package {index + 1} · {
                                          material?.name || packagePlan.cartonGlobalId
                                        }
                                      </Typography>
                                      <Typography variant="caption" color="text.secondary">
                                        {formatDimensionsMm({
                                          lengthMm: packagePlan.innerDimensionsMm.length,
                                          widthMm: packagePlan.innerDimensionsMm.width,
                                          heightMm: packagePlan.innerDimensionsMm.height,
                                        }, measurementSystem, {
                                          maximumFractionDigits: 3,
                                        })} · {formatGrams(
                                          packagePlan.totalWeightGrams,
                                          measurementSystem,
                                          { maximumFractionDigits: 3 },
                                        )} packed · {utilization.toFixed(1)}% volume used
                                      </Typography>
                                    </Box>
                                    <Chip
                                      size="small"
                                      label={`${packagePlan.allocations.reduce(
                                        (sum, allocation) => sum + allocation.quantity,
                                        0,
                                      )} units`}
                                    />
                                  </Stack>
                                  <Divider />
                                  {packagePlan.allocations.map((allocation) => {
                                    const line = cartonizationCandidate?.lines?.find(
                                      (candidateLine) => (
                                        candidateLine.globalId === allocation.lineGlobalId
                                      ),
                                    )
                                    return (
                                      <Typography
                                        key={`${packagePlan.packageKey}:${allocation.lineGlobalId}`}
                                        variant="body2"
                                      >
                                        {allocation.quantity} × {line?.title
                                          || allocation.productGlobalId}
                                      </Typography>
                                    )
                                  })}
                                </Stack>
                              </CardContent>
                            </Card>
                          )
                        },
                      )}
                    </Stack>
                  </Box>
                ) : null}

                {cartonizationEvidenceSafe ? (
                  <>
                    <Alert severity="success" variant="outlined">
                      Evidence: {cartonizationPreview.evidence.databaseWrites}
                      {' '}database writes · {
                        cartonizationPreview.evidence.providerWrites
                      } provider writes · {cartonizationPreview.evidence.rateCalls}
                      {' '}rate calls · {cartonizationPreview.evidence.labelCalls}
                      {' '}label calls · {
                        cartonizationPreview.evidence.shipmentWrites
                      } shipment writes.
                    </Alert>
                    <Alert severity="info" variant="outlined">
                      This diagnostic optimizes fixed-axis physical fit and
                      packaging-material cost. Transport and handling cost are
                      excluded; it does not yet accept or persist a pack plan.
                      Packages from the same warehouse form one multi-piece
                      shipment. One selected carrier service must apply to every
                      package in that shipment. When pack-plan acceptance is
                      implemented, packing documents must remain grouped by
                      planned shipment.
                    </Alert>
                    <Accordion disableGutters>
                      <AccordionSummary expandIcon={<ExpandMoreRounded />}>
                        <Typography variant="subtitle2" fontWeight={700}>
                          Preview evidence
                        </Typography>
                      </AccordionSummary>
                      <AccordionDetails>
                        <Stack spacing={0.5}>
                          <Typography variant="caption" sx={{ overflowWrap: 'anywhere' }}>
                            Candidate revision {cartonizationPreview.candidateRowVersion}
                          </Typography>
                          <Typography variant="caption" sx={{ overflowWrap: 'anywhere' }}>
                            Optimizer input hash{' '}
                            {cartonizationPreview.optimizer?.inputHash || 'not run'}
                          </Typography>
                          <Typography variant="caption">
                            Rotation policy: fixed axes, conservative
                          </Typography>
                          <Typography variant="caption">
                            Inventory completed{' '}
                            {formatDate(
                              cartonizationPreview.inventoryEvidence.completedAt,
                            )}
                          </Typography>
                        </Stack>
                      </AccordionDetails>
                    </Accordion>
                  </>
                ) : null}
              </>
            ) : null}
          </Stack>
        </DialogContent>
        <DialogActions sx={{ flexWrap: 'wrap' }}>
          <Button
            onClick={() => setCartonizationCandidate(null)}
            disabled={cartonizationLoading}
          >
            Close
          </Button>
          <Button
            variant="outlined"
            title={promotedWarehousePlanning
              ? 'Fit-only preview is unavailable after promotion; use factual operational pack facts.'
              : undefined}
            startIcon={cartonizationLoading
              ? <CircularProgress size={16} color="inherit" />
              : <Inventory2Rounded />}
            disabled={
              promotedWarehousePlanning
              || cartonizationLoading
              || !canManage
              || !operatorCommandsAllowed
              || selectedCartonizationMaterialGlobalIds.length < 1
              || selectedCartonizationMaterialGlobalIds.length > 8
            }
            onClick={() => {
              void runCartonizationPreview()
            }}
          >
            Run fit-only preview
          </Button>
          <Button
            variant="outlined"
            color="warning"
            title={promotedWarehousePlanning
              ? 'Assumption-backed sandbox comparison is unavailable after promotion; correct master data and save operational pack facts.'
              : undefined}
            startIcon={cartonizationLoading
              ? <CircularProgress size={16} color="inherit" />
              : <Inventory2Rounded />}
            disabled={
              promotedWarehousePlanning
              || cartonizationLoading
              || !canManage
              || !operatorCommandsAllowed
              || selectedCartonizationMaterialGlobalIds.length < 1
              || selectedCartonizationMaterialGlobalIds.length > 8
              || !selectedCartonizationWarehouseGlobalId
              || !sandboxAssumptionAcknowledged
            }
            onClick={() => {
              void createCartonizationRateEvidence()
            }}
          >
            Save sandbox comparison
          </Button>
          <Button
            variant="contained"
            startIcon={cartonizationLoading
              ? <CircularProgress size={16} color="inherit" />
              : <Inventory2Rounded />}
            disabled={
              cartonizationLoading
              || !canManage
              || !operatorCommandsAllowed
              || !selectedCartonizationWarehouseGlobalId
              || !operationalRateEvidenceReady
            }
            onClick={() => {
              void createOperationalCartonizationRateEvidence()
            }}
          >
            Save operational pack facts
          </Button>
        </DialogActions>
      </Dialog>
    </>
  )
}
