'use client'

import { FormEvent, forwardRef, type MouseEvent as ReactMouseEvent, useCallback, useEffect, useRef, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  Drawer,
  FormControl,
  FormControlLabel,
  FormHelperText,
  IconButton,
  InputLabel,
  InputAdornment,
  ListItemText,
  MenuItem,
  Radio,
  RadioGroup,
  Select,
  Stack,
  Tab,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Tabs,
  TextField,
  Tooltip,
  Typography,
  useMediaQuery,
  useTheme,
} from '@mui/material'
import TabScrollButton, { type TabScrollButtonProps } from '@mui/material/TabScrollButton'
import AddRounded from '@mui/icons-material/AddRounded'
import CheckCircleRounded from '@mui/icons-material/CheckCircleRounded'
import AssignmentIndRounded from '@mui/icons-material/AssignmentIndRounded'
import CancelRounded from '@mui/icons-material/CancelRounded'
import CloseRounded from '@mui/icons-material/CloseRounded'
import HelpOutlineRounded from '@mui/icons-material/HelpOutlineRounded'
import ImportExportRounded from '@mui/icons-material/ImportExportRounded'
import Inventory2Rounded from '@mui/icons-material/Inventory2Rounded'
import LocalShippingRounded from '@mui/icons-material/LocalShippingRounded'
import MoveToInboxRounded from '@mui/icons-material/MoveToInboxRounded'
import OpenInNewRounded from '@mui/icons-material/OpenInNewRounded'
import PrintRounded from '@mui/icons-material/PrintRounded'
import RefreshRounded from '@mui/icons-material/RefreshRounded'
import ReplayRounded from '@mui/icons-material/ReplayRounded'
import SearchRounded from '@mui/icons-material/SearchRounded'
import ScienceRounded from '@mui/icons-material/ScienceRounded'
import TaskAltRounded from '@mui/icons-material/TaskAltRounded'
import WarningAmberRounded from '@mui/icons-material/WarningAmberRounded'
import WarehouseRounded from '@mui/icons-material/WarehouseRounded'
import type {
  CommerceActiveWriteCapability,
  OperationsActivationState,
  OperationsActivationUpdateResult,
  OperationsCommerceActivePreparationResult,
  OperationsCommerceActiveTransitionResult,
  OperationsCommerceFulfillmentRetryResult,
  OperationsExceptionListItem,
  OperationsExceptionStatus,
  OperationsExceptionUpdateResult,
  OperationsExternalFulfillmentReconciliationResult,
  OperationsImportedOrderRefreshConflict,
  OperationsImportedOrderLineRefreshConflict,
  OperationsImportedOrderRefreshResult,
  OperationsImportedOrderShipToUpdateResult,
  OperationsImportedOrderWorkingCopyDraft,
  OperationsImportedOrderWorkingCopy,
  OperationsOrderCommandResult,
  OperationsOrderDetail,
  OperationsOrderListItem,
  OperationsOrderReplanningCorrectionResult,
  OperationsOrderStatus,
  OperationsPackingSlipCommandResult,
  OperationsSandboxLabelCommandResult,
  OperationsShadowFulfillmentExecutionResult,
  OperationsShadowFulfillmentPreparation,
  OperationsShadowFulfillmentPreparationStage,
  OperationsShipmentCommandResult,
  OperationsWorkspace,
} from '@/lib/operations/types'
import type {
  CommerceStoreSyncDesiredState,
  CommerceStoreSyncPendingCommand,
  CommerceStoreSyncUpdateResult,
} from '@/lib/operations/commerceStoreSync'
import {
  CommerceStoreSyncHttpError,
  commerceStoreSyncControlMatchesCommand,
  commerceStoreSyncPendingResolution,
} from '@/lib/operations/commerceStoreSync'
import {
  type OneOffCarrierGroupCommandResult,
  type OneOffPackedRateRefresh,
  type OneOffShipmentExecutionState,
} from '@/lib/operations/oneOffShipments'
import { ONE_OFF_LIVE_POSTAGE_CONFIRMATION } from '@/lib/operations/oneOffShipmentConstants'
import GlCodingPanel from '@/components/operations/GlCodingPanel'
import CommerceImportsPanel from '@/components/operations/CommerceImportsPanel'
import PackagingMaterialsPanel from '@/components/operations/PackagingMaterialsPanel'
import PickManagementPanel from '@/components/operations/PickManagementPanel'
import PrinterConfigurationPanel from '@/components/operations/PrinterConfigurationPanel'
import PackRateReplayPanel from '@/components/operations/PackRateReplayPanel'
import CartonizationRateEvidencePanel from '@/components/operations/CartonizationRateEvidencePanel'
import CommerceOrderRevisionManagerPanel from '@/components/operations/CommerceOrderRevisionManagerPanel'
import ShopifyOrderManagementPanel from '@/components/operations/ShopifyOrderManagementPanel'
import ReceivingPanel from '@/components/operations/ReceivingPanel'
import WarehouseSetupPanel from '@/components/operations/WarehouseSetupPanel'
import OneOffShipmentDialog from '@/components/operations/OneOffShipmentDialog'
import ImportedOrderWorkingCopyDrawer from '@/components/operations/ImportedOrderWorkingCopyDrawer'
import OrderShipmentAddressEditor from '@/components/operations/OrderShipmentAddressEditor'
import OneOffShippingExecutionPanel from '@/components/operations/OneOffShippingExecutionPanel'
import ShadowOrderTrainingPanel, {
  type ShadowTrainingPlanTarget,
} from '@/components/operations/ShadowOrderTrainingPanel'
import { useMeasurementSystem } from '@/components/measurements/MeasurementSystemProvider'
import { useUserDateTime } from '@/components/timezone/UserDateTimeProvider'
import { formatDimensionsMm, formatGrams } from '@/lib/measurements'
import {
  commerceActiveInitialSelection,
  type CommerceActiveContinuation,
  type CommerceActiveInitialSelection,
} from '@/lib/operations/commerceActiveSelection'
import { SANDBOX_COMMERCE_E2E_CONFIRMATION } from '@/lib/operations/sandboxCommerceE2e'
import {
  SHOPIFY_TEST_STORE_CANONICAL_E2E_CONFIRMATION,
  SHOPIFY_TEST_STORE_FULFILLMENT_CONFIRMATION,
} from '@/lib/operations/shopifyTestStoreCanonicalE2e'
import { formatUserDateTime } from '@/lib/userDateTime'
import {
  packagingDimensionEvidenceReady,
  packagingRatedOuterEvidenceReady,
  type PackagingMaterial,
  type PackagingMaterialsWorkspace,
} from '@/lib/operations/packagingMaterials'
import type { OrderShipToDraft } from '@/lib/operations/orderShipTo'

type SandboxCommerceE2eAuthorizationResult = {
  authorizationGlobalId: string
  orderGlobalId: string
  externalOrderId: string
  state: 'active' | 'consumed' | 'revoked' | 'expired'
  reason: string
  authorizedBy: string
  authorizedAt: string
  expiresAt: string
  consumedAt: string | null
  consumedBy: string | null
}

type ShopifyTestStoreAuthorizationCommand = {
  orderGlobalId: string
  expectedRowVersion: number
  confirmationStatement:
    typeof SHOPIFY_TEST_STORE_CANONICAL_E2E_CONFIRMATION
  reason: string
  lifetimeMinutes: 120
  idempotencyKey: string
}

type ShopifyTestStoreFulfillmentCommand = {
  authorizationGlobalId: string
  orderGlobalId: string
  expectedRowVersion: number
  confirmationStatement: typeof SHOPIFY_TEST_STORE_FULFILLMENT_CONFIRMATION
  reason: string
  idempotencyKey: string
}

class ShopifyTestStoreCommandHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message)
    this.name = 'ShopifyTestStoreCommandHttpError'
  }
}

type ProviderOrderCancellationCommand = {
  orderGlobalId: string
  observationGlobalId: string
  readGlobalId: string
  expectedSourceHash: string
  expectedRevisionHash: string
  expectedRowVersion: number
  reason: string
}

type ProviderOrderCancellationResult = {
  dispositionGlobalId: string
  orderGlobalId: string
  observationGlobalId: string
  readGlobalId: string | null
  status: 'cancelled'
  previousRowVersion: number
  newRowVersion: number
  replayed: boolean
  providerReads: number
  providerWrites: 0
}

type OperationsPayload = {
  ok?: boolean
  error?: string
  code?: string
  operations?: OperationsWorkspace
  runtime?: {
    commerceFulfillmentRecoveryEnabled: boolean
  }
  result?:
    | OperationsExceptionUpdateResult
    | OperationsActivationUpdateResult
    | OperationsCommerceActivePreparationResult
    | OperationsCommerceActiveTransitionResult
    | OperationsExternalFulfillmentReconciliationResult
    | OperationsOrderReplanningCorrectionResult
    | OperationsOrderCommandResult
    | OperationsPackingSlipCommandResult
    | OperationsSandboxLabelCommandResult
    | SandboxCommerceE2eAuthorizationResult
    | OperationsShadowFulfillmentExecutionResult
    | OperationsShipmentCommandResult
    | OperationsCommerceFulfillmentRetryResult
    | ProviderOrderCancellationResult
    | CommerceStoreSyncUpdateResult
}

type ImportedOrderWorkbenchPayload = {
  ok?: boolean
  error?: string
  code?: string
  result?: OperationsImportedOrderShipToUpdateResult
  refreshResult?: OperationsImportedOrderRefreshResult
  order?: OperationsImportedOrderWorkingCopy | null
  orders?: OperationsImportedOrderWorkingCopy[]
  latestCandidateGlobalId?: string
  conflicts?: OperationsImportedOrderRefreshConflict[]
  lineConflicts?: OperationsImportedOrderLineRefreshConflict[]
}

type PendingImportedOrderSave = {
  candidateGlobalId: string
  expectedRowVersion: number
  fingerprint: string
  idempotencyKey: string
}

type PackagingMaterialsPayload = {
  ok?: boolean
  error?: string
  packagingMaterials?: PackagingMaterialsWorkspace
}

type PlanningEvidencePayload = {
  ok?: boolean
  error?: string
  code?: string
  evidence?: {
    globalId: string
    status: 'succeeded' | 'partial' | 'failed'
  }
}

type ShopifyPlanningAssignment = {
  version: 'shopify-order-planning-assignment-v1'
  status: 'ready' | 'unmapped' | 'provider_managed' | 'split' | 'not_open'
  accountGlobalId: string
  candidateGlobalId: string
  candidateRowVersion: number
  assignments: Array<{
    shopifyLocationId: string
    shopifyLocationName: string
    ownerType: 'merchant_managed' | 'fulfillment_service'
    fulfillmentService: null | {
      id: string
      serviceName: string
      type: string | null
    }
    fulfillmentOrderIds: string[]
    mapping: null | {
      globalId: string
      rowVersion: number
      warehouseGlobalId: string
      warehouseName: string
      locationGlobalId: string
      locationCode: string
    }
  }>
  selectedWarehouse: null | {
    globalId: string
    name: string
    mappingGlobalId: string
    mappingRowVersion: number
    shopifyLocationId: string
    shopifyLocationName: string
  }
  providerReads: 1
  providerWrites: 0
}

type ShopifyPlanningAssignmentPayload = {
  ok?: boolean
  error?: string
  code?: string
  assignment?: ShopifyPlanningAssignment
}

type OneOffExecutionPayload = {
  ok?: boolean
  error?: string
  code?: string
  state?: OneOffShipmentExecutionState
  result?: OneOffPackedRateRefresh | OneOffCarrierGroupCommandResult
}

export type OperationsView =
  | 'orders'
  | 'picking'
  | 'exceptions'
  | 'imports'
  | 'receiving'
  | 'warehouses'
  | 'packaging-materials'
  | 'replays'
  | 'carrier-invoices'
  | 'gl-coding'
  | 'printing'

const ORDER_STATUSES: Array<{ value: '' | OperationsOrderStatus; label: string }> = [
  { value: '', label: 'All statuses' },
  { value: 'imported', label: 'Imported' },
  { value: 'validated', label: 'Validated' },
  { value: 'held', label: 'Held' },
  { value: 'promised', label: 'Promised' },
  { value: 'reserved', label: 'Reserved' },
  { value: 'planned', label: 'Planned' },
  { value: 'released', label: 'Released' },
  { value: 'picking', label: 'Picking' },
  { value: 'packed', label: 'Packed' },
  { value: 'shipped', label: 'Shipped' },
  { value: 'cancelled', label: 'Cancelled' },
  { value: 'exception', label: 'Exception' },
]

const EXCEPTION_STATUSES: Array<{ value: '' | OperationsExceptionStatus; label: string }> = [
  { value: '', label: 'All exception statuses' },
  { value: 'open', label: 'Open' },
  { value: 'acknowledged', label: 'Acknowledged' },
  { value: 'resolved', label: 'Resolved' },
  { value: 'dismissed', label: 'Dismissed' },
]

const ACTIVATION_OPTIONS: Array<{
  value: OperationsActivationState
  label: string
  description: string
}> = [
  {
    value: 'disabled',
    label: 'Disabled',
    description: 'Emergency override for automatic commerce mirroring and activation-gated connected-order execution. Existing evidence remains viewable.',
  },
  {
    value: 'shadow',
    label: 'Shadow',
    description: 'Legacy execution-safety profile. Explicit Store sync choices remain independent.',
  },
  {
    value: 'read_only',
    label: 'Read only',
    description: 'Allows viewing, health checks, reconciliation, evidence export, and explicitly confirmed zero-provider-write corrections; Store sync remains independently controlled.',
  },
  {
    value: 'active',
    label: 'Active',
    description: 'Allows approved legacy execution commands. Store sync is controlled separately after an explicit choice.',
  },
  {
    value: 'frozen',
    label: 'Frozen',
    description: 'Emergency override for automatic commerce mirroring and activation-gated connected-order execution. Existing evidence remains viewable.',
  },
]

const CARTONIZATION_EVIDENCE_GLOBAL_ID = /^gcte(?:[0-9]{7}|[0-9a-v]{12})$/
const OPERATIONS_ORDER_GLOBAL_ID = /^gor(?:[0-9]{7}|[0-9a-v]{12})$/
const OPERATIONS_IMPORTED_ORDER_GLOBAL_ID = /^gcoc(?:[0-9]{7}|[0-9a-v]{12})$/
const OPERATIONS_ORDER_QUERY = 'operationsOrder'
// The legacy organization-wide activation workflow remains available to the
// server while per-connection Provider writes replaces it in the product UI.
// Do not expose this migration-era profile in the daily Orders workbench.
const LEGACY_COMMERCE_ACTIVATION_UI_VISIBLE = false
const COMMERCE_FULFILLMENT_RECONCILIATION_REQUIRED =
  'OPERATIONS_COMMERCE_EXPORT_RECONCILIATION_REQUIRED'
const COMMERCE_FULFILLMENT_AUTOMATIC_ATTEMPT_LIMIT = 8

function importedOrderDraftFingerprint(
  draft: OperationsImportedOrderWorkingCopyDraft,
) {
  return JSON.stringify(draft)
}

function isCommerceFulfillmentReconciliationPending(input: {
  provider: string
  state: string
  errorCode: string | null
  attempts: number
  recoveryRuntimeEnabled: boolean
}) {
  return input.recoveryRuntimeEnabled
    && (input.provider === 'shopify' || input.provider === 'faire')
    && input.state === 'failed'
    && input.errorCode === COMMERCE_FULFILLMENT_RECONCILIATION_REQUIRED
    && input.attempts < COMMERCE_FULFILLMENT_AUTOMATIC_ATTEMPT_LIMIT
}

type CommerceActiveAccountOption = {
  accountGlobalId: string
  displayName: string
  provider: 'shopify' | 'faire'
  environment: 'sandbox' | 'production'
  capabilities: Array<{
    capability: CommerceActiveWriteCapability
    selectable: boolean
    unavailableReason: 'not_implemented' | 'missing_scope' | null
    unavailableDetail: string | null
  }>
}

type CommerceActiveCatalogPayload = {
  ok?: boolean
  error?: string
  integrations?: {
    commerceActiveContinuation?: CommerceActiveContinuation | null
    accounts?: Array<{
      globalId: string
      displayName: string
      provider: 'shopify' | 'faire'
      environment: 'sandbox' | 'production'
      status: 'active' | 'disabled' | 'error'
      configured: boolean
      verificationStatus: 'unverified' | 'verified' | 'failed'
      configuration: Record<string, unknown>
    }>
  }
  catalog?: {
    providers?: Partial<Record<
      'shopify' | 'faire',
      {
        capabilityScopes?: Record<string, readonly string[]>
        implementation?: Record<
          string,
          'control_plane_implemented' | 'not_implemented'
        >
      }
    >>
  }
}

const COMMERCE_ACTIVE_WRITE_CAPABILITIES: Record<
  'shopify' | 'faire',
  readonly CommerceActiveWriteCapability[]
> = {
  shopify: [
    'catalog_publishing',
    'inventory_export',
    'inventory_transfer_synchronization',
    'inventory_shipment_synchronization',
    'location_administration',
    'customer_export',
    'order_creation',
    'order_update',
    'order_edit',
    'draft_order_synchronization',
    'refund_export',
    'fulfillment_export',
    'third_party_fulfillment_orchestration',
    'fulfillment_service',
    'tracking_export',
    'shipping_rate_callbacks',
    'return_export',
  ],
  faire: [
    'catalog_publishing',
    'inventory_export',
    'order_update',
    'fulfillment_export',
    'tracking_export',
  ],
}

const OperationsTabScrollButton = forwardRef<HTMLButtonElement, TabScrollButtonProps>(
  function OperationsTabScrollButton({ direction, disabled, onClick, ...props }, ref) {
    const label = direction === 'left'
      ? 'Scroll operations tabs left'
      : 'Scroll operations tabs right'

    return (
      <TabScrollButton
        {...props}
        ref={ref}
        component="button"
        type="button"
        direction={direction}
        disabled={disabled}
        onClick={disabled ? undefined : onClick}
        aria-label={label}
        aria-disabled={disabled}
        tabIndex={disabled ? -1 : 0}
        title={label}
      />
    )
  },
)

function pageOperationsTabs(event: ReactMouseEvent<HTMLDivElement>) {
  const target = event.target as HTMLElement
  const button = target.closest<HTMLButtonElement>(
    'button[aria-label="Scroll operations tabs left"], button[aria-label="Scroll operations tabs right"]',
  )
  if (!button || button.disabled || !event.currentTarget.contains(button)) return

  const scroller = event.currentTarget.querySelector<HTMLElement>('.MuiTabs-scroller')
  if (!scroller) return

  event.preventDefault()
  event.stopPropagation()
  scroller.scrollTo({
    left: button.getAttribute('aria-label')?.endsWith('left')
      ? 0
      : scroller.scrollWidth - scroller.clientWidth,
    behavior: 'auto',
  })
}

const controlSx = {
  minWidth: 0,
  '& .MuiInputBase-root': {
    minHeight: 40,
    borderRadius: '8px',
    backgroundColor: '#15151D',
  },
}

function displayStatus(status: string) {
  return status.replace(/[_.-]+/g, ' ').replace(/\b\w/g, (character) => character.toUpperCase())
}

function commerceActiveUnavailableLabel(
  option: CommerceActiveAccountOption['capabilities'][number],
) {
  const reason = option.unavailableReason
  if (reason === 'not_implemented') return 'Not implemented'
  if (reason === 'missing_scope') return 'Missing scope'
  return ''
}

function stringValues(value: unknown) {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : []
}

function commerceActiveAccountOptions(
  payload: CommerceActiveCatalogPayload,
): CommerceActiveAccountOption[] {
  const accounts = payload.integrations?.accounts || []
  const providers = payload.catalog?.providers || {}

  return accounts.flatMap((account) => {
    if (
      !account.configured
      || account.verificationStatus !== 'verified'
      || !['active', 'disabled'].includes(account.status)
    ) {
      return []
    }
    const grantedScopes = new Set(stringValues(account.configuration.grantedScopes))
    const provider = providers[account.provider]
    const capabilityScopes = provider?.capabilityScopes || {}
    const implementation = provider?.implementation || {}
    const capabilities = COMMERCE_ACTIVE_WRITE_CAPABILITIES[
      account.provider
    ].map((capability) => {
      const requiredScopes = capabilityScopes[capability]
      const implemented =
        implementation[capability] === 'control_plane_implemented'
      const scopeEligible = Boolean(
        requiredScopes?.length
        && requiredScopes.every((scope) => grantedScopes.has(scope)),
      )
      const unavailableReason = !implemented
        ? 'not_implemented' as const
        : !scopeEligible
          ? 'missing_scope' as const
          : null
      return {
        capability,
        selectable: implemented && scopeEligible,
        unavailableReason,
        unavailableDetail: null,
      }
    })

    return [{
      accountGlobalId: account.globalId,
      displayName: account.displayName,
      provider: account.provider,
      environment: account.environment,
      capabilities,
    }]
  }).sort((left, right) => (
    left.provider.localeCompare(right.provider)
    || left.displayName.localeCompare(right.displayName)
    || left.accountGlobalId.localeCompare(right.accountGlobalId)
  ))
}

function providerForCarrier(carrier: string): 'ups_rest' | 'fedex_rest' | null {
  const normalized = carrier.trim().toLowerCase()
  if (normalized === 'ups') return 'ups_rest'
  if (normalized === 'fedex' || normalized === 'fedex express') return 'fedex_rest'
  return null
}

function statusColor(status: string): 'default' | 'success' | 'warning' | 'error' | 'info' {
  if (status === 'shipped') return 'success'
  if (status === 'exception' || status === 'cancelled') return 'error'
  if (status === 'held') return 'warning'
  if (['released', 'picking', 'packed'].includes(status)) return 'info'
  return 'default'
}

function exceptionStatusColor(status: OperationsExceptionStatus): 'default' | 'success' | 'warning' | 'info' {
  if (status === 'resolved') return 'success'
  if (status === 'open') return 'warning'
  if (status === 'acknowledged') return 'info'
  return 'default'
}

function severityColor(severity: OperationsExceptionListItem['severity']): 'default' | 'warning' | 'error' {
  if (severity === 'critical' || severity === 'high') return 'error'
  if (severity === 'medium') return 'warning'
  return 'default'
}

function money(minor: string | null | undefined, currency = 'USD') {
  if (minor === null || minor === undefined || minor === '') {
    return 'Not available'
  }
  const value = Number(minor) / 100
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number.isFinite(value) ? value : 0)
}

function operationalPlanningMaterialBlockers(
  material: PackagingMaterial,
  warehouseGlobalId: string,
  requireStock = true,
) {
  const blockers: string[] = []
  const inner = material.innerDimensionsMm
  const ratedOuter = material.ratedOuterDimensionsMm
  if (material.status !== 'active') blockers.push('not active')
  if (
    !Number.isSafeInteger(inner.length)
    || Number(inner.length) < 1
    || !Number.isSafeInteger(inner.width)
    || Number(inner.width) < 1
    || !Number.isSafeInteger(inner.height)
    || Number(inner.height) < 1
  ) {
    blockers.push('usable inner dimensions missing')
  }
  if (
    material.dimensionBasis !== 'inner'
    || !packagingDimensionEvidenceReady({
      evidenceType: material.dimensionEvidenceType,
      evidenceReference: material.dimensionEvidenceReference,
      confirmedAt: material.dimensionConfirmedAt,
    })
  ) {
    blockers.push('factual inner evidence missing')
  }
  if (!ratedOuter.length || !ratedOuter.width || !ratedOuter.height) {
    blockers.push('rated exterior dimensions missing')
  }
  if (
    !packagingRatedOuterEvidenceReady({
      evidenceType: material.ratedOuterDimensionEvidenceType,
      evidenceReference: material.ratedOuterDimensionEvidenceReference,
      confirmedAt: material.ratedOuterDimensionConfirmedAt,
    })
  ) {
    blockers.push('factual exterior evidence missing')
  }
  if (!material.tareWeightGrams || material.tareWeightGrams <= 0) {
    blockers.push('tare weight missing')
  }
  const stock = material.stock.find((item) => (
    item.warehouseGlobalId === warehouseGlobalId
  ))
  if (
    requireStock
    && (
    !stock
    || stock.warehouseStatus !== 'active'
    || !stock.isAvailable
    || !stock.onHandQuantity
    || stock.onHandQuantity <= 0
    )
  ) {
    blockers.push('available warehouse stock missing')
  }
  return blockers
}

function metric(label: string, value: string | number, tone = 'text.primary') {
  return (
    <Box sx={{ minWidth: { xs: 'calc(50% - 8px)', sm: 112 }, py: 0.5 }}>
      <Typography variant="caption" color="text.secondary">{label}</Typography>
      <Typography fontSize="1.2rem" fontWeight={700} color={tone}>{value}</Typography>
    </Box>
  )
}

function DetailSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Box component="section">
      <Typography variant="overline" color="text.secondary">{title}</Typography>
      <Box sx={{ mt: 0.5 }}>{children}</Box>
    </Box>
  )
}

function shadowProviderName(provider: 'ups_rest' | 'fedex_rest') {
  return provider === 'ups_rest' ? 'UPS' : 'FedEx'
}

function ShadowPreparationStageCard({
  title,
  stage,
}: {
  title: string
  stage: OperationsShadowFulfillmentPreparationStage
}) {
  const { measurementSystem } = useMeasurementSystem()
  return (
    <Box
      sx={{
        minWidth: 0,
        p: 1.5,
        border: '1px solid rgba(255,255,255,0.12)',
        borderRadius: '8px',
      }}
    >
      <Typography fontWeight={700}>{title}</Typography>
      <Typography
        variant="caption"
        color="text.secondary"
        sx={{ overflowWrap: 'anywhere' }}
      >
        {stage.runGlobalId} · {stage.packageCount}{' '}
        {stage.packageCount === 1 ? 'package' : 'packages'}
      </Typography>
      <Box sx={{ mt: 1.25 }}>
        <Typography variant="caption" color="text.secondary">
          Selected whole-shipment rate
        </Typography>
        <Typography fontWeight={600} sx={{ overflowWrap: 'anywhere' }}>
          {shadowProviderName(stage.selectedRate.provider)} ·{' '}
          {stage.selectedRate.serviceName}
        </Typography>
        <Typography variant="body2" color="text.secondary">
          Carrier estimate {money(
            stage.selectedRate.carrierCostMinor,
            stage.selectedRate.currency,
          )} · Customer charge {money(
            stage.selectedRate.customerChargeMinor,
            stage.selectedRate.currency,
          )}
        </Typography>
      </Box>
      <Stack spacing={1} sx={{ mt: 1.5 }}>
        {stage.packages.map((item) => (
          <Box
            key={item.packageKey}
            sx={{
              minWidth: 0,
              p: 1.25,
              backgroundColor: 'rgba(255,255,255,0.035)',
              borderRadius: '6px',
            }}
          >
            <Stack
              direction={{ xs: 'column', sm: 'row' }}
              justifyContent="space-between"
              gap={0.5}
            >
              <Box sx={{ minWidth: 0 }}>
                <Typography variant="body2" fontWeight={700}>
                  Package {item.sequence}: {item.materialName}
                </Typography>
                <Typography
                  variant="caption"
                  color="text.secondary"
                  sx={{ overflowWrap: 'anywhere' }}
                >
                  {item.packageKey} · {item.materialCode}
                </Typography>
              </Box>
              <Box sx={{ minWidth: 0, textAlign: { sm: 'right' } }}>
                <Typography variant="body2">
                  {formatGrams(item.grossWeightGrams, measurementSystem, {
                    maximumFractionDigits: 3,
                  })}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  {formatDimensionsMm({
                    lengthMm: item.dimensionsMm.length,
                    widthMm: item.dimensionsMm.width,
                    heightMm: item.dimensionsMm.height,
                  }, measurementSystem, { maximumFractionDigits: 3 })}
                </Typography>
              </Box>
            </Stack>
            <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 0.75 }}>
              Content {formatGrams(item.contentWeightGrams, measurementSystem)} ·
              {' '}Tare {formatGrams(item.tareWeightGrams, measurementSystem)}
            </Typography>
            <Stack divider={<Divider flexItem />} sx={{ mt: 0.75 }}>
              {item.allocations.map((allocation) => (
                <Box
                  key={`${allocation.lineKey}:${allocation.productGlobalId}`}
                  sx={{
                    py: 0.5,
                    display: 'grid',
                    gridTemplateColumns: 'minmax(0, 1fr) auto',
                    gap: 1,
                  }}
                >
                  <Box sx={{ minWidth: 0 }}>
                    <Typography variant="caption" fontWeight={600}>
                      {allocation.title}
                    </Typography>
                    <Typography
                      variant="caption"
                      color="text.secondary"
                      display="block"
                      sx={{ overflowWrap: 'anywhere' }}
                    >
                      Provider variant {allocation.providerVariantId} ·{' '}
                      Stage product {allocation.productGlobalId} ·{' '}
                      {allocation.lineKey}
                    </Typography>
                  </Box>
                  <Typography variant="caption">{allocation.quantity} units</Typography>
                </Box>
              ))}
            </Stack>
          </Box>
        ))}
      </Stack>
    </Box>
  )
}

function ShadowFulfillmentPreparationPanel({
  preparation,
}: {
  preparation: OperationsShadowFulfillmentPreparation
}) {
  const dateTime = useUserDateTime()
  const effects = [
    ['Provider writes', preparation.effects.providerWriteCount],
    ['Postage purchases', preparation.effects.postagePurchaseCount],
    ['Label writes', preparation.effects.labelWriteCount],
    ['Commerce writes', preparation.effects.commerceWriteCount],
  ] as const
  return (
    <Stack spacing={1.5} data-testid="shadow-fulfillment-preparation">
      <Alert severity="success">
        Shadow preparation is durable. No shipment, tracking number, carrier
        label, postage purchase, commerce write, or final packing slip exists.
      </Alert>
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: 'minmax(0, 1fr)', sm: 'repeat(2, minmax(0, 1fr))' },
          gap: 1,
        }}
      >
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="caption" color="text.secondary">Execution</Typography>
          <Typography sx={{ overflowWrap: 'anywhere' }}>
            {preparation.executionGlobalId}
          </Typography>
        </Box>
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="caption" color="text.secondary">Shipment group</Typography>
          <Typography sx={{ overflowWrap: 'anywhere' }}>
            {preparation.shipmentGroupGlobalId}
          </Typography>
        </Box>
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="caption" color="text.secondary">Checkout receipt</Typography>
          <Typography sx={{ overflowWrap: 'anywhere' }}>
            {preparation.checkoutRateReceiptGlobalId}
          </Typography>
        </Box>
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="caption" color="text.secondary">Prepared</Typography>
          <Typography>
            {formatUserDateTime(preparation.preparedAt, dateTime, {
              year: 'numeric',
              month: 'short',
              day: 'numeric',
              hour: 'numeric',
              minute: '2-digit',
              fallback: 'Unknown',
            })}
          </Typography>
        </Box>
      </Box>
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: 'minmax(0, 1fr)', lg: 'repeat(2, minmax(0, 1fr))' },
          gap: 1.5,
        }}
      >
        <ShadowPreparationStageCard title="Checkout evidence" stage={preparation.checkout} />
        <ShadowPreparationStageCard
          title="Pre-label fulfillment evidence"
          stage={preparation.fulfillment}
        />
      </Box>
      <Box
        sx={{
          minWidth: 0,
          p: 1.5,
          border: '1px solid rgba(255,255,255,0.12)',
          borderRadius: '8px',
        }}
      >
        <Typography fontWeight={700}>Estimated variance</Typography>
        <Box
          sx={{
            mt: 1,
            display: 'grid',
            gridTemplateColumns: { xs: 'minmax(0, 1fr)', sm: 'repeat(2, minmax(0, 1fr))' },
            gap: 1,
          }}
        >
          <Box>
            <Typography variant="caption" color="text.secondary">Package-count change</Typography>
            <Typography>{preparation.variance.packageCountDelta}</Typography>
          </Box>
          <Box>
            <Typography variant="caption" color="text.secondary">Estimated carrier-cost change</Typography>
            <Typography>{money(
              preparation.variance.carrierCostVarianceMinor,
              preparation.fulfillment.selectedRate.currency,
            )}</Typography>
          </Box>
          <Box>
            <Typography variant="caption" color="text.secondary">Estimated checkout-charge variance</Typography>
            <Typography>{money(
              preparation.variance.estimatedCheckoutVarianceMinor,
              preparation.fulfillment.selectedRate.currency,
            )}</Typography>
          </Box>
          <Box>
            <Typography variant="caption" color="text.secondary">Changed evidence</Typography>
            <Typography variant="body2">
              {[
                preparation.variance.allocationChanged ? 'allocations' : '',
                preparation.variance.materialChanged ? 'materials' : '',
                preparation.variance.serviceChanged ? 'service' : '',
              ].filter(Boolean).join(', ') || 'None'}
            </Typography>
          </Box>
        </Box>
        {preparation.variance.causes.length > 0 && (
          <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 1, overflowWrap: 'anywhere' }}>
            Evidence causes: {preparation.variance.causes.join(', ')}
          </Typography>
        )}
      </Box>
      <Box>
        <Typography fontWeight={700}>Sandbox carrier attempts</Typography>
        <Stack spacing={0.75} sx={{ mt: 0.75 }}>
          {preparation.providerAttempts.map((attempt) => (
            <Box
              key={`${attempt.provider}:${attempt.carrierAccountGlobalId}`}
              sx={{
                minWidth: 0,
                p: 1.25,
                display: 'grid',
                gridTemplateColumns: 'minmax(0, 1fr) auto',
                gap: 1,
                border: '1px solid rgba(255,255,255,0.12)',
                borderRadius: '6px',
              }}
            >
              <Box sx={{ minWidth: 0 }}>
                <Typography variant="body2" fontWeight={700}>
                  {shadowProviderName(attempt.provider)} · {attempt.carrierAccountName}
                </Typography>
                <Typography
                  variant="caption"
                  color="text.secondary"
                  sx={{ overflowWrap: 'anywhere' }}
                >
                  {attempt.carrierAccountGlobalId} · {attempt.rateEvidenceGlobalId}
                  {attempt.failureCode ? ` · ${attempt.failureCode}` : ''}
                </Typography>
              </Box>
              <Stack alignItems="flex-end" spacing={0.5}>
                <Chip
                  size="small"
                  label={attempt.status}
                  color={attempt.status === 'succeeded' ? 'success' : 'warning'}
                />
                {attempt.selected && <Chip size="small" label="Selected" variant="outlined" />}
              </Stack>
            </Box>
          ))}
        </Stack>
      </Box>
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: 'repeat(2, minmax(0, 1fr))', sm: 'repeat(4, minmax(0, 1fr))' },
          gap: 1,
        }}
      >
        {effects.map(([label, count]) => (
          <Box
            key={label}
            sx={{
              minWidth: 0,
              p: 1,
              textAlign: 'center',
              border: '1px solid rgba(255,255,255,0.12)',
              borderRadius: '6px',
            }}
          >
            <Typography fontWeight={700}>{count}</Typography>
            <Typography variant="caption" color="text.secondary">{label}</Typography>
          </Box>
        ))}
      </Box>
    </Stack>
  )
}

function OrderDetailDrawer({
  order,
  sandboxCarrierAccounts,
  commerceFulfillmentRecoveryEnabled,
  activationState,
  canManage,
  canExecute,
  canPurchaseLivePostage,
  canAuthorizeSandboxE2e,
  oneOffExecutionState,
  oneOffExecutionLoading,
  oneOffExecutionError,
  open,
  busy,
  onClose,
  onPlan,
  trainingRefreshToken,
  onRelease,
  onReopenForReplanning,
  onConfirmPicks,
  onReconcileExternalFulfillment,
  onVerifyPack,
  onPrepareFulfillment,
  onGeneratePackingSlip,
  onPrintPackingSlip,
  onPrintLabel,
  onRetryLabel,
  onReprintLabel,
  onConfirmShipment,
  onRetryCommerceExport,
  onAuthorizeSandboxE2e,
  onConfirmShopifyTestFulfillment,
  onCreateSandboxLabel,
  onVoidSandboxLabel,
  onRefreshOneOffPackedRates,
  onReviewOneOffGroupPurchase,
  onVoidOneOffGroup,
  onOrderRevisionBusyChange,
  onOrderRevisionChanged,
  onReviewOrderRevisionRecovery,
  generatingPackingSlipPackageId,
  printingPackingSlipArtifactId,
  labelPrintBusyGlobalId,
}: {
  order: OperationsOrderDetail | null
  sandboxCarrierAccounts: OperationsWorkspace['shipping']['sandboxCarrierAccounts']
  commerceFulfillmentRecoveryEnabled: boolean
  activationState: OperationsActivationState
  canManage: boolean
  canExecute: boolean
  canPurchaseLivePostage: boolean
  canAuthorizeSandboxE2e: boolean
  oneOffExecutionState: OneOffShipmentExecutionState | null
  oneOffExecutionLoading: boolean
  oneOffExecutionError: string
  open: boolean
  busy: boolean
  onClose: () => void
  onPlan: (trainingTarget?: ShadowTrainingPlanTarget) => void
  trainingRefreshToken: number
  onRelease: () => void
  onReopenForReplanning: () => void
  onConfirmPicks: () => void
  onReconcileExternalFulfillment: () => void
  onVerifyPack: () => void
  onPrepareFulfillment: () => void
  onGeneratePackingSlip: (packageGlobalId: string) => void
  onPrintPackingSlip: (artifactGlobalId: string) => void
  onPrintLabel: (labelGlobalId: string) => void
  onRetryLabel: (labelGlobalId: string, printJobGlobalId: string) => void
  onReprintLabel: (labelGlobalId: string, printJobGlobalId: string) => void
  onConfirmShipment: () => void
  onRetryCommerceExport: (
    commerceExportGlobalId: string,
    reconciliationPending: boolean,
  ) => void
  onAuthorizeSandboxE2e: () => void
  onConfirmShopifyTestFulfillment: () => void
  onCreateSandboxLabel: (packageGlobalId?: string) => void
  onVoidSandboxLabel: () => void
  onRefreshOneOffPackedRates: () => void
  onReviewOneOffGroupPurchase: () => void
  onVoidOneOffGroup: () => void
  onOrderRevisionBusyChange: (busy: boolean) => void
  onOrderRevisionChanged: () => void | Promise<void>
  onReviewOrderRevisionRecovery: (exceptionGlobalId: string) => void | Promise<void>
  generatingPackingSlipPackageId: string | null
  printingPackingSlipArtifactId: string | null
  labelPrintBusyGlobalId: string | null
}) {
  const theme = useTheme()
  const mobile = useMediaQuery(theme.breakpoints.down('md'))
  const dateTime = useUserDateTime()
  const { measurementSystem } = useMeasurementSystem()
  const releaseAction = order?.availableActions?.find((item) => item.action === 'release_to_warehouse')
  const replanningAction = order?.availableActions?.find(
    (item) => item.action === 'reopen_for_replanning',
  )
  const confirmPicksAction = order?.availableActions?.find((item) => item.action === 'confirm_picks')
  const reconcileExternalFulfillmentAction = order?.availableActions?.find(
    (item) => item.action === 'reconcile_external_fulfillment',
  )
  const verifyPackAction = order?.availableActions?.find((item) => item.action === 'verify_pack')
  const confirmShipmentAction = order?.availableActions?.find((item) => item.action === 'confirm_shipment')
  const sandboxE2eAuthorization = order?.sandboxCommerceE2eAuthorization || null
  const canonicalShopifyTestLane = Boolean(
    order?.sourceProvider === 'shopify'
    && order.planningPreparation?.testOrder === true,
  )
  const canonicalShopifyAuthorization =
    sandboxE2eAuthorization?.authorityKind === 'shopify_test_store_canonical'
      ? sandboxE2eAuthorization
      : null
  const canPlanImportedOrder = Boolean(
    order?.status === 'imported'
    && order.sourceProvider
    && order.sourceProvider !== 'mock-commerce'
    && (!canonicalShopifyTestLane || Boolean(canonicalShopifyAuthorization))
  )
  const trainingProviderOrder = Boolean(
    order?.sourceProvider
    && ['shopify', 'faire'].includes(order.sourceProvider),
  )
  const nativeOneOff = order?.sourceProvider === 'clawpilot_native'
    && Boolean(order.oneOffShippingMode)
  const primaryAction = canPlanImportedOrder
    ? undefined
    : order?.status === 'released'
      ? order.shopifyExternalFulfillmentReconciliationRequired
        ? reconcileExternalFulfillmentAction
        : confirmPicksAction
      : order?.status === 'picking'
        ? verifyPackAction
        : order?.status === 'packed'
          ? confirmShipmentAction
          : order && !['shipped', 'cancelled'].includes(order.status)
            ? releaseAction
            : undefined
  const confirmingPicks = primaryAction?.action === 'confirm_picks'
  const reconcilingExternalFulfillment =
    primaryAction?.action === 'reconcile_external_fulfillment'
  const verifyingPack = primaryAction?.action === 'verify_pack'
  const preparingFulfillment = primaryAction?.action === 'prepare_fulfillment'
  const confirmingShipment = primaryAction?.action === 'confirm_shipment'
  const shipments = order?.shipments || []
  const trackingObservations = order?.trackingObservations || []
  const printArtifacts = order?.printArtifacts || []
  const labelPrintJobs = order?.labelPrintJobs || []
  const shippingLabels = order?.packages.flatMap((item) => (
    item.latestLabel ? [{ package: item, label: item.latestLabel }] : []
  )) || []
  const commerceExports = order?.commerceExports || []
  const labelAttempts = order?.labelAttempts || []
  const selectedRate = order?.rates.find((rate) => rate.selected) || null
  const selectedProvider = selectedRate ? providerForCarrier(selectedRate.carrier) : null
  const eligibleCarrierAccounts = selectedProvider
    ? sandboxCarrierAccounts.filter((account) => account.provider === selectedProvider)
    : []
  const activeLabel = order?.packages
    .map((item) => item.latestLabel)
    .find((label) => label?.status === 'created') || null
  const unresolvedAttempt = labelAttempts.find(
    (attempt) => attempt.state === 'prepared' || attempt.state === 'unknown',
  ) || null
  const createBlockedReason = !canExecute
      ? 'You do not have permission to purchase carrier labels.'
      : order?.shipmentShipTo.readiness !== 'carrier_ready'
        ? 'Add the missing ship-to details before creating a label.'
      : order?.shipmentShipTo.rerateRequired
        ? 'The ship-to changed after planning. Compare rates again before creating a label.'
      : order?.status !== 'packed'
        ? 'Verify package packing before creating a label.'
        : activeLabel
          ? 'Void the active label before creating another.'
          : unresolvedAttempt
            ? `Attempt ${unresolvedAttempt.globalId} requires reconciliation before another carrier command.`
            : !selectedRate
              ? 'Select a carrier rate before creating a label.'
              : !selectedProvider
                ? `${selectedRate.carrier} does not have a direct sandbox label adapter.`
                : eligibleCarrierAccounts.length === 0
                  ? `Connect and verify a sandbox ${selectedRate.carrier} account first.`
                  : null
  const authorizedPackageCreateBlockedReason = !canExecute
      ? 'You do not have permission to purchase carrier labels.'
      : order?.shipmentShipTo.readiness !== 'carrier_ready'
        ? 'Add the missing ship-to details before creating labels.'
      : order?.shipmentShipTo.rerateRequired
        ? 'The ship-to changed after planning. Compare rates again before creating labels.'
      : !sandboxE2eAuthorization
        ? 'Authorize this exact commerce test order before creating package-specific sandbox labels.'
        : order?.status !== 'packed'
          ? 'Verify every package before creating labels.'
          : unresolvedAttempt
            ? `Attempt ${unresolvedAttempt.globalId} requires reconciliation before another carrier command.`
            : !selectedRate
              ? 'Select a carrier rate before creating labels.'
              : !selectedProvider
                ? `${selectedRate.carrier} does not have a direct sandbox label adapter.`
                : eligibleCarrierAccounts.length === 0
                  ? `Connect and verify a sandbox ${selectedRate.carrier} account first.`
                  : null
  const authorizeSandboxE2eBlockedReason = !canAuthorizeSandboxE2e
    ? 'Only an authorized organization owner or administrator may authorize this test.'
    : !order?.sourceProvider
      || !['shopify', 'faire'].includes(order.sourceProvider)
      ? 'Sandbox commerce E2E authorization requires a Shopify or Faire order.'
      : canonicalShopifyTestLane
        && !['imported', 'planned', 'released', 'picking', 'packed'].includes(order.status)
        ? 'This Shopify test order is no longer at a resumable local stage.'
        : !canonicalShopifyTestLane && order.status !== 'packed'
          ? 'Verify every package before authorizing the test.'
        : shipments.length > 0
          ? 'This order already has shipment evidence.'
          : null
  const canonicalLabelsReady = Boolean(
    canonicalShopifyAuthorization
    && order?.status === 'packed'
    && order.packages.length > 0
    && order.packages.every((item) => (
      item.latestLabel?.status === 'created'
      && item.latestLabel.environment === 'sandbox'
      && Boolean(item.latestLabel.trackingNumber)
    )),
  )
  const voidBlockedReason = !canExecute
      ? 'You do not have permission to void carrier labels.'
      : unresolvedAttempt
        ? `Attempt ${unresolvedAttempt.globalId} requires reconciliation before a carrier command.`
        : null

  return (
    <Drawer
      anchor="right"
      open={open}
      onClose={onClose}
      PaperProps={{
        sx: {
          width: mobile ? '100%' : 'min(540px, 46vw)',
          maxWidth: '100vw',
          backgroundColor: '#17171F',
          backgroundImage: 'none',
          borderLeft: '1px solid rgba(255,255,255,0.1)',
        },
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1, px: { xs: 2, sm: 3 }, py: 2 }}>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography variant="h6" fontWeight={700} noWrap>{order ? `Order ${order.orderNumber}` : 'Order details'}</Typography>
          {order && (
            <Stack direction="row" spacing={1} alignItems="center" sx={{ mt: 0.75, flexWrap: 'wrap', rowGap: 0.75 }}>
              <Chip size="small" label={order.globalId} variant="outlined" />
              <Chip size="small" label={displayStatus(order.status)} color={statusColor(order.status)} />
            </Stack>
          )}
        </Box>
        <Tooltip title="Close order">
          <IconButton aria-label="Close order details" onClick={onClose}><CloseRounded /></IconButton>
        </Tooltip>
      </Box>
      <Divider />
      {!order ? (
        <Box sx={{ p: 4, display: 'flex', justifyContent: 'center' }}><CircularProgress size={28} /></Box>
      ) : (
        <Box sx={{
          minWidth: 0,
          px: { xs: 2, sm: 3 },
          py: 2.5,
          pb: 5,
          overflowX: 'hidden',
          overflowY: 'auto',
        }}>
          <Stack spacing={3}>
            {trainingProviderOrder && order && (
              <DetailSection title="Order training">
                <ShadowOrderTrainingPanel
                  orderGlobalId={order.globalId}
                  canExecute={canExecute}
                  disabled={busy}
                  refreshToken={trainingRefreshToken}
                  onPlan={onPlan}
                />
              </DetailSection>
            )}
            <DetailSection title="Overview">
              <Box sx={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 1.5 }}>
                <Box><Typography variant="caption" color="text.secondary">Customer</Typography><Typography>{order.customerName}</Typography><Typography variant="caption" color="#A8C7FA">{order.customerGlobalId}</Typography></Box>
                <Box><Typography variant="caption" color="text.secondary">Warehouse</Typography><Typography>{order.warehouseName || 'Unassigned'}</Typography></Box>
                <Box><Typography variant="caption" color="text.secondary">Promise</Typography><Typography>{formatUserDateTime(order.promisedDeliveryAt, dateTime, { year: 'numeric', month: 'short', day: 'numeric', fallback: 'Not promised' })}</Typography></Box>
                <Box><Typography variant="caption" color="text.secondary">Tracking</Typography><Typography sx={{ overflowWrap: 'anywhere' }}>{order.trackingNumber || 'Not shipped'}</Typography></Box>
              </Box>
            </DetailSection>

            <DetailSection title="Shipment details">
              <OrderShipmentAddressEditor
                key={`${order.globalId}:${order.rowVersion}:${order.shipmentShipTo.rowVersion}`}
                order={order}
                canManage={canManage}
                disabled={busy}
                onSaved={onOrderRevisionChanged}
              />
            </DetailSection>

            {order.sourceProvider === 'shopify' && (
              <DetailSection title="Provider writes">
                <ShopifyOrderManagementPanel
                  orderGlobalId={order.globalId}
                  orderRowVersion={order.rowVersion}
                  canManage={canManage}
                  disabled={busy}
                  onBusyChange={onOrderRevisionBusyChange}
                  onOrderChanged={onOrderRevisionChanged}
                />
              </DetailSection>
            )}

            {(order.sourceProvider === 'shopify' || order.sourceProvider === 'faire') && (
              <DetailSection title="Sales-channel revision">
                <CommerceOrderRevisionManagerPanel
                  orderGlobalId={order.globalId}
                  provider={order.sourceProvider}
                  orderRowVersion={order.rowVersion}
                  orderStatus={order.status}
                  canManage={canManage}
                  canExecute={canExecute}
                  disabled={busy}
                  onBusyChange={onOrderRevisionBusyChange}
                  onOrderChanged={onOrderRevisionChanged}
                  onReviewRecovery={onReviewOrderRevisionRecovery}
                />
              </DetailSection>
            )}

            <DetailSection title="Financial plan">
              <Box sx={{ display: 'flex', flexWrap: 'wrap', columnGap: 2, rowGap: 0.5 }}>
                {metric('Expected cost', money(order.expectedCostMinor, order.currency))}
                {metric('Expected revenue', money(order.expectedRevenueMinor, order.currency))}
                {metric('Expected margin', money(order.expectedMarginMinor, order.currency), Number(order.expectedMarginMinor || 0) >= 0 ? '#81C784' : '#EF9A9A')}
              </Box>
            </DetailSection>

            <DetailSection title="Order control">
              <Box sx={{ display: 'grid', gridTemplateColumns: { xs: 'repeat(2, minmax(0, 1fr))', sm: 'repeat(3, minmax(0, 1fr))' }, gap: 1, mb: 1.5 }}>
                <Box><Typography variant="caption" color="text.secondary">Plan</Typography><Typography>{displayStatus(order.planStatus || 'not planned')}</Typography></Box>
                <Box><Typography variant="caption" color="text.secondary">Wave</Typography><Typography>{displayStatus(order.waveStatus || 'not released')}</Typography></Box>
                <Box><Typography variant="caption" color="text.secondary">Picks ready</Typography><Typography>{order.readyPickTaskCount} / {order.pickTaskCount}</Typography></Box>
                <Box><Typography variant="caption" color="text.secondary">Picks complete</Typography><Typography>{order.pickedPickTaskCount} / {order.pickTaskCount}</Typography></Box>
                <Box><Typography variant="caption" color="text.secondary">Packages packed</Typography><Typography>{order.packedPackageCount} / {order.packageCount}</Typography></Box>
                <Box><Typography variant="caption" color="text.secondary">Version</Typography><Typography>{order.rowVersion}</Typography></Box>
              </Box>
              {canPlanImportedOrder && (
                <Stack spacing={0.75} sx={{ mb: 1.5 }}>
                  <Tooltip title={canExecute
                    ? 'Accept reviewed cartonization evidence into the canonical warehouse plan'
                    : 'You do not have permission to plan warehouse work'}>
                    <span>
                      <Button
                        fullWidth
                        variant="contained"
                        startIcon={busy
                          ? <CircularProgress size={16} />
                          : <Inventory2Rounded />}
                        disabled={!canExecute || busy}
                        onClick={() => onPlan()}
                      >
                        {busy ? 'Preparing' : 'Prepare order'}
                      </Button>
                    </span>
                  </Tooltip>
                  <Typography variant="caption" color="text.secondary">
                    Planning accepts immutable cartonization evidence. It does not
                    purchase postage, create a label, or confirm a shipment.
                  </Typography>
                </Stack>
              )}
              {primaryAction?.blockedReason && <Alert severity="info" sx={{ mb: 1.5 }}>{primaryAction.blockedReason}</Alert>}
              {primaryAction && (
                <Tooltip title={primaryAction.blockedReason || (reconcilingExternalFulfillment
                  ? 'Read exact live Shopify fulfillment authority, then cancel stale unpicked warehouse work without writing to Shopify or notifying the customer again'
                  : confirmingPicks
                    ? 'Confirm every ready pick task and complete the released wave'
                  : verifyingPack
                    ? 'Verify the carton plan and record package-level billing evidence'
                    : preparingFulfillment
                      ? 'Rerate the exact sealed packages with UPS and FedEx and store zero-write Shadow evidence'
                      : confirmingShipment
                        ? 'Consume reserved inventory, create the shipment and packing slip, seed tracking, and export fulfillment'
                        : 'Create a released warehouse wave and ready pick tasks')}>
                  <span>
                    <Button
                      fullWidth
                      variant="contained"
                      startIcon={busy
                        ? <CircularProgress size={16} />
                        : reconcilingExternalFulfillment
                          ? <ReplayRounded />
                          : confirmingPicks
                            ? <TaskAltRounded />
                          : verifyingPack
                            ? <Inventory2Rounded />
                            : preparingFulfillment
                              ? <ScienceRounded />
                              : confirmingShipment
                                ? <LocalShippingRounded />
                                : <WarehouseRounded />}
                      disabled={!primaryAction.enabled || busy}
                      onClick={reconcilingExternalFulfillment
                        ? onReconcileExternalFulfillment
                        : confirmingPicks
                          ? onConfirmPicks
                        : verifyingPack
                          ? onVerifyPack
                          : preparingFulfillment
                            ? onPrepareFulfillment
                            : confirmingShipment
                              ? onConfirmShipment
                              : onRelease}
                    >
                      {busy
                        ? reconcilingExternalFulfillment
                          ? 'Reconciling fulfillment'
                          : confirmingPicks
                            ? 'Confirming picks'
                          : verifyingPack
                            ? 'Verifying packages'
                            : preparingFulfillment
                              ? 'Preparing shipment'
                              : confirmingShipment
                                ? 'Confirming shipment'
                                : 'Releasing'
                        : primaryAction.label}
                    </Button>
                  </span>
                </Tooltip>
              )}
              {replanningAction && (
                <Stack spacing={0.75} sx={{ mt: primaryAction ? 1.25 : 0 }}>
                  <Tooltip title={replanningAction.blockedReason
                    || replanningAction.consequenceSummary
                    || 'Cancel an unreleased local plan and return the order to Imported'}>
                    <span>
                      <Button
                        fullWidth
                        variant="outlined"
                        color="warning"
                        startIcon={<ReplayRounded />}
                        disabled={!replanningAction.enabled || busy}
                        onClick={onReopenForReplanning}
                      >
                        {replanningAction.label}
                      </Button>
                    </span>
                  </Tooltip>
                  {replanningAction.blockedReason && (
                    <Typography variant="caption" color="text.secondary">
                      {replanningAction.blockedReason}
                    </Typography>
                  )}
                </Stack>
              )}
            </DetailSection>

            <DetailSection title={`Lines (${order.lines.length})`}>
              <Stack divider={<Divider flexItem />}>
                {order.lines.map((line) => (
                  <Box key={line.globalId} sx={{ py: 1.25, display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: 1 }}>
                    <Box sx={{ minWidth: 0 }}>
                      <Typography fontWeight={600}>{line.productName}</Typography>
                      <Typography variant="caption" color="text.secondary">{line.productGlobalId} · {line.channelSku}</Typography>
                    </Box>
                    <Box sx={{ textAlign: 'right' }}>
                      <Typography>{line.quantity} units</Typography>
                      <Typography variant="caption" color="text.secondary">{line.reservedQuantity} reserved · {displayStatus(line.pickStatus || 'not started')}</Typography>
                    </Box>
                  </Box>
                ))}
              </Stack>
            </DetailSection>

            <DetailSection title={`Packages (${order.packages.length})`}>
              {order.packages.length ? (
                <Stack spacing={1.5}>
                  {order.packages.map((item) => {
                    const contents = item.contents || []
                    const artifact = printArtifacts.find(
                      (candidate) => (
                        candidate.documentKind === 'pack_work_instruction'
                        && candidate.packageGlobalId === item.globalId
                        && !candidate.shipmentGlobalId
                      ),
                    )
                    const legacyArtifact = printArtifacts.find(
                      (candidate) => (
                        candidate.documentKind
                          === 'legacy_prelabel_packing_list'
                        && candidate.packageGlobalId === item.globalId
                        && !candidate.shipmentGlobalId
                      ),
                    )
                    const canGenerate = (
                      canExecute
                      && order.status === 'packed'
                      && ['packed', 'labeled'].includes(item.status)
                      && contents.length > 0
                    )
                    const generating = generatingPackingSlipPackageId === item.globalId
                    const printing = artifact
                      ? printingPackingSlipArtifactId === artifact.globalId
                      : false
                    return (
                      <Box
                        key={item.globalId}
                        sx={{
                          p: 1.5,
                          border: '1px solid rgba(255,255,255,0.12)',
                          borderRadius: '8px',
                        }}
                      >
                        <Stack
                          direction="row"
                          justifyContent="space-between"
                          alignItems="flex-start"
                          gap={2}
                        >
                          <Box>
                            <Stack direction="row" spacing={1} alignItems="center">
                              <Typography fontWeight={700}>
                                Package {item.packageNumber} of {order.packages.length}
                              </Typography>
                              <Chip
                                size="small"
                                label={displayStatus(item.status)}
                                color={item.status === 'planned' ? 'default' : 'success'}
                              />
                            </Stack>
                            <Typography variant="caption" color="text.secondary">
                              {item.globalId}
                            </Typography>
                          </Box>
                          <Box sx={{ textAlign: 'right' }}>
                            <Typography>
                              {formatGrams(item.weightGrams, measurementSystem, {
                                maximumFractionDigits: 3,
                              })}
                            </Typography>
                            <Typography variant="caption" color="text.secondary">
                              {formatDimensionsMm({
                                lengthMm: item.dimensionsMm.length,
                                widthMm: item.dimensionsMm.width,
                                heightMm: item.dimensionsMm.height,
                              }, measurementSystem, { maximumFractionDigits: 3 })}
                            </Typography>
                          </Box>
                        </Stack>

                        <Box sx={{ mt: 1.5 }}>
                          <Typography variant="caption" color="text.secondary">
                            Exact contents
                          </Typography>
                          {contents.length > 0 ? (
                            <Stack divider={<Divider flexItem />}>
                              {contents.map((content) => (
                                <Box
                                  key={content.globalId}
                                  sx={{
                                    py: 0.75,
                                    display: 'grid',
                                    gridTemplateColumns: 'minmax(0, 1fr) auto',
                                    gap: 1,
                                  }}
                                >
                                  <Box sx={{ minWidth: 0 }}>
                                    <Typography variant="body2" fontWeight={600}>
                                      {content.productName}
                                    </Typography>
                                    <Typography variant="caption" color="text.secondary">
                                      {content.productGlobalId} · {content.channelSku || 'No SKU'}
                                    </Typography>
                                  </Box>
                                  <Typography variant="body2" fontWeight={700}>
                                    {content.quantity}
                                  </Typography>
                                </Box>
                              ))}
                            </Stack>
                          ) : (
                            <Alert severity="warning" sx={{ mt: 0.75 }}>
                              Exact carton allocation is unavailable. Pack Work Instruction generation is blocked so ClawPilot cannot produce an incomplete warehouse instruction.
                            </Alert>
                          )}
                        </Box>

                        <Box sx={{ mt: 1.5 }}>
                          {legacyArtifact && (
                            <Alert severity="warning" sx={{ mb: 1 }}>
                              Legacy pre-label packing list {legacyArtifact.globalId} is retained for audit only. It is not a warned Pack Work Instruction or a final tracking-bound packing slip.
                            </Alert>
                          )}
                          {artifact ? (
                            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
                              {artifact.contentUrl && (
                                <Button
                                  component="a"
                                  href={artifact.contentUrl}
                                  download
                                  size="small"
                                  variant="outlined"
                                  startIcon={<OpenInNewRounded />}
                                >
                                  Download Pack Work Instruction
                                </Button>
                              )}
                              <Button
                                size="small"
                                variant="contained"
                                startIcon={printing
                                  ? <CircularProgress size={16} />
                                  : <PrintRounded />}
                                disabled={busy || printing || !canExecute || !order.warehouseId}
                                onClick={() => onPrintPackingSlip(artifact.globalId)}
                              >
                                {printing ? 'Queueing' : 'Print Pack Work Instruction'}
                              </Button>
                            </Stack>
                          ) : (
                            <Tooltip
                              title={canGenerate
                                ? 'Create a provisional package-specific warehouse instruction without purchasing postage or calling a carrier'
                                : 'Verify packing and exact package contents before generating this Pack Work Instruction'}
                            >
                              <span>
                                <Button
                                  size="small"
                                  variant="outlined"
                                  startIcon={generating
                                    ? <CircularProgress size={16} />
                                    : <PrintRounded />}
                                  disabled={busy || generating || !canGenerate}
                                  onClick={() => onGeneratePackingSlip(item.globalId)}
                                >
                                  {generating ? 'Generating' : 'Generate Pack Work Instruction'}
                                </Button>
                              </span>
                            </Tooltip>
                          )}
                          <Typography
                            variant="caption"
                            color="text.secondary"
                            display="block"
                            sx={{ mt: 0.75 }}
                          >
                            Provisional pre-label instruction for this physical package only. It is not a final packing slip and has no carrier label or tracking number.
                          </Typography>
                        </Box>
                      </Box>
                    )
                  })}
                </Stack>
              ) : (
                <Typography variant="body2" color="text.secondary">
                  No package plan has been created.
                </Typography>
              )}
            </DetailSection>

            {(activationState === 'shadow' || order.fulfillmentPreparation) && (
              <DetailSection title="Shadow shipment preparation">
                {order.fulfillmentPreparation ? (
                  <ShadowFulfillmentPreparationPanel
                    preparation={order.fulfillmentPreparation}
                  />
                ) : (
                  <Alert severity="info">
                    No durable pre-label shipment preparation exists yet. When
                    eligible, use Prepare shipment in Shadow to rerate the exact
                    sealed packages with UPS and FedEx without creating a
                    shipment, tracking number, carrier label, postage purchase,
                    commerce write, or final packing slip.
                  </Alert>
                )}
              </DetailSection>
            )}

            <DetailSection title="Carrier rates">
              {order.rates.length ? <Stack divider={<Divider flexItem />}>
                {order.rates.map((rate) => (
                  <Box key={rate.globalId} sx={{ py: 1.25, display: 'flex', alignItems: 'center', gap: 1.25 }}>
                    {rate.selected ? <CheckCircleRounded color="success" fontSize="small" /> : <Box sx={{ width: 20 }} />}
                    <Box sx={{ flex: 1, minWidth: 0 }}><Typography fontWeight={rate.selected ? 700 : 500}>{rate.carrier} · {rate.serviceName}</Typography><Typography variant="caption" color="text.secondary">Arrives {formatUserDateTime(rate.estimatedDeliveryAt, dateTime, { year: 'numeric', month: 'short', day: 'numeric', fallback: 'Unknown' })}</Typography></Box>
                    <Box sx={{ textAlign: 'right' }}><Typography>{rate.customerChargeMinor === null ? 'Checkout charge unknown' : money(rate.customerChargeMinor, order.currency)}</Typography><Typography variant="caption" color="text.secondary">Cost {money(rate.internalCostMinor, order.currency)}</Typography></Box>
                  </Box>
                ))}
              </Stack> : <Typography variant="body2" color="text.secondary">No carrier rates have been recorded.</Typography>}
            </DetailSection>

            {(
              canonicalShopifyTestLane
              || (
                ['shopify', 'faire'].includes(order.sourceProvider || '')
                && order.status === 'packed'
              )
            ) && (
              <DetailSection title={canonicalShopifyTestLane
                ? 'Verified Shopify test-store workflow'
                : 'Authorized sandbox commerce E2E'}>
                {sandboxE2eAuthorization ? (
                  <Stack spacing={1.25}>
                    <Alert
                      severity="success"
                      data-testid="sandbox-commerce-e2e-authorization-active"
                    >
                      Exact-order authorization{' '}
                      {sandboxE2eAuthorization.authorizationGlobalId} is current until{' '}
                      {formatUserDateTime(
                        sandboxE2eAuthorization.expiresAt,
                        dateTime,
                        {
                          year: 'numeric',
                          month: 'short',
                          day: 'numeric',
                          hour: 'numeric',
                          minute: '2-digit',
                          fallback: sandboxE2eAuthorization.expiresAt,
                        },
                      )}. {canonicalShopifyAuthorization
                        ? 'Local plan, release, pick, pack, and sandbox-label steps are available only for this verified Shopify test order. Provider writes must also be On before fulfillment is sent to Shopify.'
                        : `It permits only this order's package-specific sandbox labels and reserved-inventory consumption. Provider writes must be On before ${order.sourceProvider === 'faire' ? 'Faire' : 'Shopify'} fulfillment or tracking is sent.`}
                    </Alert>
                    {canonicalShopifyAuthorization && order.status === 'packed' && (
                      canonicalShopifyAuthorization.fulfillmentConfirmedAt ? (
                        <Alert
                          severity="success"
                          data-testid="shopify-test-store-fulfillment-confirmed"
                        >
                          The exact sandbox label and tracking snapshot was confirmed at{' '}
                          {formatUserDateTime(
                            canonicalShopifyAuthorization.fulfillmentConfirmedAt,
                            dateTime,
                            {
                              year: 'numeric',
                              month: 'short',
                              day: 'numeric',
                              hour: 'numeric',
                              minute: '2-digit',
                              fallback:
                                canonicalShopifyAuthorization.fulfillmentConfirmedAt,
                            },
                          )}. Shopify customer notification is locked off.
                        </Alert>
                      ) : (
                        <Tooltip title={canonicalLabelsReady
                          ? 'Review the exact sandbox labels and explicitly confirm Shopify fulfillment'
                          : 'Create one current sandbox label for every exact package first'}>
                          <span>
                            <Button
                              fullWidth
                              variant="contained"
                              color="warning"
                              startIcon={<WarningAmberRounded />}
                              disabled={busy || !canonicalLabelsReady}
                              onClick={onConfirmShopifyTestFulfillment}
                              data-testid="review-shopify-test-store-fulfillment"
                            >
                              Review and confirm Shopify fulfillment
                            </Button>
                          </span>
                        </Tooltip>
                      )
                    )}
                  </Stack>
                ) : (
                  <Stack spacing={1.25}>
                    <Alert severity="warning">
                      {canonicalShopifyTestLane
                        ? `Authorize this exact provider-verified Shopify test order before starting or resuming its ${displayStatus(order.status)} local workflow. This does not enable unrelated orders, production postage, or customer notification.`
                        : `This test path creates non-tracking sandbox labels and then performs real ClawPilot inventory and ${order.sourceProvider === 'faire' ? 'Faire' : 'Shopify'} fulfillment writes for this exact order. It does not authorize any other order or production carrier purchase.`}
                    </Alert>
                    <Tooltip
                      title={authorizeSandboxE2eBlockedReason
                        || 'Review and authorize this exact commerce test order'}
                    >
                      <span>
                        <Button
                          fullWidth
                          variant="outlined"
                          color="warning"
                          startIcon={<WarningAmberRounded />}
                          disabled={busy || Boolean(authorizeSandboxE2eBlockedReason)}
                          onClick={onAuthorizeSandboxE2e}
                          data-testid={canonicalShopifyTestLane
                            ? 'authorize-shopify-test-store-canonical-e2e'
                            : 'authorize-sandbox-commerce-e2e'}
                        >
                          {canonicalShopifyTestLane && order.status !== 'imported'
                            ? 'Renew or resume verified test order'
                            : canonicalShopifyTestLane
                              ? 'Authorize verified test order'
                              : 'Authorize exact-order E2E test'}
                        </Button>
                      </span>
                    </Tooltip>
                  </Stack>
                )}
              </DetailSection>
            )}

            <DetailSection title="Shipping execution">
              <Stack spacing={1.5}>
                {nativeOneOff ? (
                  <OneOffShippingExecutionPanel
                    order={order}
                    state={oneOffExecutionState}
                    loading={oneOffExecutionLoading}
                    error={oneOffExecutionError}
                    canManage={canManage}
                    canExecute={canExecute}
                    canPurchaseLivePostage={canPurchaseLivePostage}
                    busy={busy}
                    onRefreshPackedRates={onRefreshOneOffPackedRates}
                    onReviewPurchase={onReviewOneOffGroupPurchase}
                    onVoidGroup={onVoidOneOffGroup}
                  />
                ) : (
                  <>
                {unresolvedAttempt && (
                  <Alert severity="error">
                    Carrier attempt {unresolvedAttempt.globalId} is {unresolvedAttempt.state}. Do not retry this
                    purchase or void. Reconcile the carrier result first so ClawPilot cannot create a duplicate label.
                  </Alert>
                )}
                {sandboxE2eAuthorization ? (
                  <Stack spacing={1.25} data-testid="sandbox-commerce-e2e-packages">
                    <Alert severity="info">
                      Create one sandbox label for each exact package. When all{' '}
                      {order.packages.length} packages are labeled, Confirm shipment
                      will consume the reserved inventory and write every tracking
                      number to {order.sourceProvider === 'faire'
                        ? 'Faire'
                        : 'Shopify'} under authorization{' '}
                      {sandboxE2eAuthorization.authorizationGlobalId}.
                    </Alert>
                    {order.packages.map((item) => {
                      const packageLabel = item.latestLabel?.status === 'created'
                        ? item.latestLabel
                        : null
                      return (
                        <Box
                          key={item.globalId}
                          sx={{
                            p: 1.5,
                            border: packageLabel
                              ? '1px solid rgba(129,199,132,0.35)'
                              : '1px solid rgba(255,255,255,0.12)',
                            borderRadius: '8px',
                          }}
                        >
                          <Stack spacing={1.25}>
                            <Stack
                              direction="row"
                              justifyContent="space-between"
                              alignItems="flex-start"
                              gap={1.5}
                            >
                              <Box sx={{ minWidth: 0 }}>
                                <Typography fontWeight={700}>
                                  Package {item.packageNumber} of {order.packages.length}
                                </Typography>
                                <Typography variant="caption" color="text.secondary">
                                  {item.globalId}
                                </Typography>
                              </Box>
                              <Chip
                                size="small"
                                color={packageLabel ? 'success' : 'default'}
                                label={packageLabel ? 'Sandbox label ready' : 'Label required'}
                              />
                            </Stack>
                            {packageLabel ? (
                              <Box>
                                <Typography sx={{ overflowWrap: 'anywhere' }}>
                                  {packageLabel.trackingNumber}
                                </Typography>
                                <Typography variant="caption" color="text.secondary">
                                  {packageLabel.carrier} {packageLabel.serviceCode}
                                  {' · '}{packageLabel.globalId}
                                </Typography>
                              </Box>
                            ) : (
                              <Tooltip
                                title={authorizedPackageCreateBlockedReason
                                  || `Create the sandbox label for package ${item.packageNumber}`}
                              >
                                <span>
                                  <Button
                                    fullWidth
                                    variant="contained"
                                    size="small"
                                    startIcon={<LocalShippingRounded />}
                                    disabled={busy || Boolean(authorizedPackageCreateBlockedReason)}
                                    onClick={() => onCreateSandboxLabel(item.globalId)}
                                    data-testid={`create-sandbox-label-${item.globalId}`}
                                  >
                                    Create package {item.packageNumber} sandbox label
                                  </Button>
                                </span>
                              </Tooltip>
                            )}
                          </Stack>
                        </Box>
                      )
                    })}
                  </Stack>
                ) : (
                  <>
                    {activeLabel ? (
                      <Box sx={{ p: 1.5, border: '1px solid rgba(129,199,132,0.35)', borderRadius: '8px' }}>
                        <Stack direction="row" justifyContent="space-between" alignItems="flex-start" gap={1.5}>
                          <Box sx={{ minWidth: 0 }}>
                            <Stack direction="row" spacing={1} alignItems="center" sx={{ flexWrap: 'wrap', rowGap: 0.75 }}>
                              <Typography fontWeight={700}>{activeLabel.carrier} {activeLabel.serviceCode}</Typography>
                              <Chip size="small" color="success" label="Active label" />
                              <Chip size="small" variant="outlined" label={displayStatus(activeLabel.environment)} />
                            </Stack>
                            <Typography sx={{ mt: 0.75, overflowWrap: 'anywhere' }}>{activeLabel.trackingNumber}</Typography>
                            <Typography variant="caption" color="text.secondary">
                              {activeLabel.globalId}
                              {activeLabel.createAttemptGlobalId ? ` · Purchase ${activeLabel.createAttemptGlobalId}` : ''}
                            </Typography>
                          </Box>
                          <Tooltip title={voidBlockedReason || 'Void through the same sandbox account used to purchase this label'}>
                            <span>
                              <Button
                                color="error"
                                variant="outlined"
                                size="small"
                                startIcon={<CancelRounded />}
                                disabled={busy || Boolean(voidBlockedReason)}
                                onClick={onVoidSandboxLabel}
                              >
                                Void
                              </Button>
                            </span>
                          </Tooltip>
                        </Stack>
                      </Box>
                    ) : (
                      <Alert severity={createBlockedReason ? 'info' : 'warning'}>
                        {createBlockedReason
                          || 'Sandbox execution uses the fixed John Doe test shipment. Create the label, inspect the print evidence, then void it immediately.'}
                      </Alert>
                    )}
                    {!activeLabel && (
                      <Tooltip title={createBlockedReason || 'Purchase a sandbox label and route its print job'}>
                        <span>
                          <Button
                            fullWidth
                            variant="contained"
                            startIcon={<LocalShippingRounded />}
                            disabled={busy || Boolean(createBlockedReason)}
                            onClick={() => onCreateSandboxLabel()}
                          >
                            Create sandbox label
                          </Button>
                        </span>
                      </Tooltip>
                    )}
                  </>
                )}
                  {labelAttempts.length > 0 && (
                  <Box>
                    <Typography variant="caption" color="text.secondary">Carrier command evidence</Typography>
                    <Stack divider={<Divider flexItem />}>
                      {labelAttempts.map((attempt) => (
                        <Box key={attempt.globalId} sx={{ py: 1, display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: 1 }}>
                          <Box sx={{ minWidth: 0 }}>
                            <Typography variant="body2" fontWeight={600}>
                              {displayStatus(attempt.action)} · {attempt.globalId}
                            </Typography>
                            <Typography variant="caption" color="text.secondary">
                              {displayStatus(attempt.provider)} · {displayStatus(attempt.environment)}
                              {attempt.errorCode ? ` · ${attempt.errorCode}` : ''}
                            </Typography>
                          </Box>
                          <Chip
                            size="small"
                            label={displayStatus(attempt.state)}
                            color={attempt.state === 'succeeded' ? 'success' : attempt.state === 'failed' ? 'error' : 'warning'}
                          />
                        </Box>
                      ))}
                    </Stack>
                  </Box>
                  )}
                  </>
                )}
              </Stack>
            </DetailSection>

            <DetailSection title="Shipment evidence">
              {shipments.length === 0
                && trackingObservations.length === 0
                && printArtifacts.length === 0
                && shippingLabels.length === 0
                && commerceExports.length === 0 ? (
                  <Typography variant="body2" color="text.secondary">
                    Confirmed shipment, tracking, packing-slip, and commerce-export evidence will appear here.
                  </Typography>
                ) : (
                  <Stack spacing={2}>
                    {shipments.length > 0 && (
                      <Box>
                        <Typography variant="caption" color="text.secondary">Shipments</Typography>
                        <Stack divider={<Divider flexItem />}>
                          {shipments.map((shipment) => (
                            <Box
                              key={shipment.globalId}
                              sx={{
                                py: 1.25,
                                display: 'grid',
                                gridTemplateColumns: 'minmax(0, 1fr) auto',
                                gap: 1.5,
                              }}
                            >
                              <Box sx={{ minWidth: 0 }}>
                                <Typography fontWeight={700}>
                                  {shipment.carrier} · {shipment.serviceCode}
                                </Typography>
                                <Typography sx={{ overflowWrap: 'anywhere' }}>
                                  {shipment.trackingNumber}
                                </Typography>
                                <Typography variant="caption" color="text.secondary">
                                  {shipment.globalId} · Shipped {formatUserDateTime(
                                    shipment.shippedAt,
                                    dateTime,
                                    {
                                      year: 'numeric',
                                      month: 'short',
                                      day: 'numeric',
                                      hour: 'numeric',
                                      minute: '2-digit',
                                      fallback: 'Unknown',
                                    },
                                  )}
                                </Typography>
                              </Box>
                              <Chip
                                size="small"
                                label={displayStatus(shipment.status)}
                                color={shipment.status === 'exception'
                                  ? 'error'
                                  : shipment.status === 'delivered'
                                    ? 'success'
                                    : 'info'}
                              />
                            </Box>
                          ))}
                        </Stack>
                      </Box>
                    )}

                    {shippingLabels.length > 0 ? (
                      <Box data-testid="order-shipping-labels">
                        <Typography variant="caption" color="text.secondary">
                          Shipping labels
                        </Typography>
                        <Stack divider={<Divider flexItem />}>
                          {shippingLabels.map(({ package: item, label }) => {
                            const jobs = labelPrintJobs.filter(
                              (job) => job.sourceLabelGlobalId === label.globalId,
                            )
                            const pendingJob = jobs.find(
                              (job) => job.status === 'queued' || job.status === 'claimed',
                            ) || null
                            const deliveredJob = jobs.find(
                              (job) => job.status === 'delivered',
                            ) || null
                            const failedJob = jobs.find(
                              (job) => job.status === 'failed',
                            ) || null
                            const busyLabel = labelPrintBusyGlobalId === label.globalId
                            const canPrint = Boolean(
                              canExecute
                              && order.warehouseId
                              && label.status === 'created',
                            )
                            const actionBlockedReason = !canExecute
                              ? 'Warehouse execution access is required to print labels.'
                              : !order.warehouseId
                                ? 'The order has no fulfillment warehouse for printer routing.'
                                : label.status !== 'created'
                                  ? 'Inactive or voided carrier labels cannot be printed.'
                                  : pendingJob
                                    ? `Print job ${pendingJob.globalId} is already ${pendingJob.status}.`
                                    : jobs.length > 0 && !deliveredJob && !failedJob
                                      ? 'Review the existing print job in Printing before authorizing another physical copy.'
                                      : null
                            return (
                              <Box
                                key={label.globalId}
                                sx={{
                                  py: 1.25,
                                  display: 'grid',
                                  gridTemplateColumns: 'minmax(0, 1fr) auto',
                                  gap: 1.5,
                                  alignItems: 'center',
                                }}
                              >
                                <Box sx={{ minWidth: 0 }}>
                                  <Typography fontWeight={700}>
                                    Package {item.packageNumber} · {label.carrier} {label.serviceCode}
                                  </Typography>
                                  <Typography sx={{ overflowWrap: 'anywhere' }}>
                                    {label.trackingNumber}
                                  </Typography>
                                  <Typography variant="caption" color="text.secondary">
                                    {label.globalId} · {displayStatus(label.environment)}
                                    {jobs[0]
                                      ? ` · Latest print ${jobs[0].globalId} (${displayStatus(jobs[0].status)})`
                                      : ' · Not yet printed from ClawPilot'}
                                  </Typography>
                                  <Typography variant="caption" color="text.secondary" display="block">
                                    Reprints reuse this stored label document and never purchase new postage.
                                  </Typography>
                                </Box>
                                <Tooltip title={actionBlockedReason || (
                                  deliveredJob
                                    ? 'Create a new audited print job from the original label bytes'
                                    : failedJob
                                      ? 'Retry the failed print job from the same immutable label; no carrier call, postage purchase, or tracking change'
                                    : 'Queue the stored carrier label to the configured warehouse printer'
                                )}>
                                  <span>
                                    <Button
                                      size="small"
                                      variant="contained"
                                      startIcon={busyLabel
                                        ? <CircularProgress size={16} />
                                        : deliveredJob
                                          ? <ReplayRounded />
                                          : failedJob
                                            ? <ReplayRounded />
                                          : <PrintRounded />}
                                      disabled={
                                        busy
                                        || busyLabel
                                        || !canPrint
                                        || Boolean(actionBlockedReason)
                                      }
                                      onClick={() => {
                                        if (deliveredJob) {
                                          onReprintLabel(label.globalId, deliveredJob.globalId)
                                        } else if (failedJob) {
                                          onRetryLabel(label.globalId, failedJob.globalId)
                                        } else {
                                          onPrintLabel(label.globalId)
                                        }
                                      }}
                                      data-testid={`order-label-print-${label.globalId}`}
                                    >
                                      {busyLabel
                                        ? 'Queueing'
                                        : deliveredJob
                                          ? 'Reprint label'
                                          : failedJob
                                            ? 'Retry label'
                                          : pendingJob
                                            ? 'Print queued'
                                            : jobs.length > 0
                                              ? 'Review print job'
                                              : 'Print label'}
                                    </Button>
                                  </span>
                                </Tooltip>
                              </Box>
                            )
                          })}
                        </Stack>
                      </Box>
                    ) : shipments.length > 0 ? (
                      <Alert severity="warning">
                        Tracking and shipment evidence are available, but the original carrier-label document was not imported into ClawPilot. Reprint is unavailable until that exact label artifact is retrieved from the shipping provider or uploaded; ClawPilot will not buy a replacement label automatically.
                      </Alert>
                    ) : null}

                    {printArtifacts.length > 0 && (
                      <Box>
                        <Typography variant="caption" color="text.secondary">Documents</Typography>
                        <Stack divider={<Divider flexItem />}>
                          {printArtifacts.map((artifact) => (
                            <Box
                              key={artifact.globalId}
                              sx={{
                                py: 1.25,
                                display: 'grid',
                                gridTemplateColumns: 'minmax(0, 1fr) auto',
                                gap: 1.5,
                                alignItems: 'center',
                              }}
                            >
                              <Box sx={{ minWidth: 0 }}>
                                <Typography fontWeight={600}>
                                  {artifact.documentKind === 'final_packing_slip'
                                    ? 'Final tracking-bound packing slip'
                                    : artifact.documentKind === 'pack_work_instruction'
                                      ? 'Pack Work Instruction'
                                      : artifact.documentKind
                                          === 'legacy_prelabel_packing_list'
                                        ? 'Legacy pre-label packing list'
                                        : displayStatus(artifact.documentType)}
                                </Typography>
                                <Typography variant="caption" color="text.secondary">
                                  {artifact.globalId} · {artifact.format} · {displayStatus(artifact.media)}
                                </Typography>
                              </Box>
                              {artifact.contentUrl ? (
                                <Button
                                  component="a"
                                  href={artifact.contentUrl}
                                  target="_blank"
                                  rel="noreferrer"
                                  size="small"
                                  variant="outlined"
                                  startIcon={<OpenInNewRounded />}
                                >
                                  Open
                                </Button>
                              ) : (
                                <Chip size="small" variant="outlined" label="Unavailable" />
                              )}
                            </Box>
                          ))}
                        </Stack>
                      </Box>
                    )}

                    {trackingObservations.length > 0 && (
                      <Box>
                        <Typography variant="caption" color="text.secondary">Tracking history</Typography>
                        <Stack divider={<Divider flexItem />}>
                          {trackingObservations.map((observation) => (
                            <Box key={observation.globalId} sx={{ py: 1.25 }}>
                              <Stack direction="row" justifyContent="space-between" alignItems="flex-start" gap={1.5}>
                                <Box sx={{ minWidth: 0 }}>
                                  <Typography fontWeight={600}>{displayStatus(observation.status)}</Typography>
                                  <Typography variant="caption" color="text.secondary">
                                    {displayStatus(observation.provider)} · {displayStatus(observation.source)}
                                    {observation.location ? ` · ${observation.location}` : ''}
                                  </Typography>
                                </Box>
                                <Typography variant="caption" color="text.secondary" sx={{ whiteSpace: 'nowrap' }}>
                                  {formatUserDateTime(observation.observedAt, dateTime, {
                                    month: 'short',
                                    day: 'numeric',
                                    hour: 'numeric',
                                    minute: '2-digit',
                                    fallback: 'Unknown',
                                  })}
                                </Typography>
                              </Stack>
                            </Box>
                          ))}
                        </Stack>
                      </Box>
                    )}

                    {commerceExports.length > 0 && (
                      <Box>
                        <Typography variant="caption" color="text.secondary">Commerce fulfillment export</Typography>
                        <Stack divider={<Divider flexItem />}>
                          {commerceExports.map((fulfillmentExport) => {
                            const reconciliationPending =
                              isCommerceFulfillmentReconciliationPending({
                                ...fulfillmentExport,
                                recoveryRuntimeEnabled:
                                  commerceFulfillmentRecoveryEnabled,
                              })
                            return <Box
                              key={fulfillmentExport.globalId}
                              data-testid={reconciliationPending
                                ? 'commerce-fulfillment-reconciliation-pending'
                                : undefined}
                              sx={{
                                py: 1.25,
                                display: 'grid',
                                gridTemplateColumns: 'minmax(0, 1fr) auto',
                                gap: 1.5,
                              }}
                            >
                              <Box sx={{ minWidth: 0 }}>
                                <Typography fontWeight={600}>
                                  {displayStatus(fulfillmentExport.provider)}
                                </Typography>
                                <Typography variant="caption" color="text.secondary" display="block">
                                  {fulfillmentExport.globalId}
                                  {fulfillmentExport.providerReference
                                    ? ` · ${fulfillmentExport.providerReference}`
                                    : ''}
                                </Typography>
                                <Typography variant="caption" color="text.secondary" display="block">
                                  {fulfillmentExport.customerNotification.mode === 'provider_managed'
                                    ? 'Retailer notification is provider-managed.'
                                    : fulfillmentExport.customerNotification.notifyCustomer
                                      ? `Customer notification requested · ${displayStatus(fulfillmentExport.customerNotification.source)}`
                                      : `Customer notification not requested · ${displayStatus(fulfillmentExport.customerNotification.source)}`}
                                  {' '}· {fulfillmentExport.attempts} processing attempt{fulfillmentExport.attempts === 1 ? '' : 's'}
                                </Typography>
                                {(fulfillmentExport.errorCode || fulfillmentExport.errorMessage) && (
                                  <Typography
                                    variant="caption"
                                    color={reconciliationPending ? 'warning.main' : 'error.main'}
                                    display="block"
                                  >
                                    {[fulfillmentExport.errorCode, fulfillmentExport.errorMessage]
                                      .filter(Boolean)
                                      .join(' · ')}
                                  </Typography>
                                )}
                              </Box>
                              <Stack spacing={0.75} alignItems="flex-end">
                                <Chip
                                  size="small"
                                  label={reconciliationPending
                                    ? 'Reconciliation pending'
                                    : displayStatus(fulfillmentExport.state)}
                                  color={reconciliationPending
                                    ? 'warning'
                                    : fulfillmentExport.state === 'succeeded'
                                    ? 'success'
                                    : fulfillmentExport.state === 'failed'
                                      ? 'error'
                                      : fulfillmentExport.state === 'unsupported'
                                        ? 'default'
                                        : 'warning'}
                                />
                                {['queued', 'processing', 'failed'].includes(
                                  fulfillmentExport.state,
                                ) ? (
                                  <Button
                                    size="small"
                                    variant="outlined"
                                    startIcon={<ReplayRounded />}
                                    disabled={busy || !canExecute}
                                    onClick={() => onRetryCommerceExport(
                                      fulfillmentExport.globalId,
                                      reconciliationPending,
                                    )}
                                  >
                                    {reconciliationPending ? 'Check now' : 'Retry / reconcile'}
                                  </Button>
                                ) : null}
                              </Stack>
                            </Box>
                          })}
                        </Stack>
                      </Box>
                    )}
                  </Stack>
                )}
            </DetailSection>

            <DetailSection title="Billable events">
              {order.billableEvents.length ? <Stack divider={<Divider flexItem />}>
                {order.billableEvents.map((event) => (
                  <Box key={event.globalId} sx={{ py: 1.25, display: 'flex', justifyContent: 'space-between', gap: 2 }}>
                    <Box><Typography>{displayStatus(event.type)}</Typography><Typography variant="caption" color="text.secondary">{event.globalId} · {displayStatus(event.status)}</Typography></Box>
                    <Typography fontWeight={700}>{money(event.amountMinor, order.currency)}</Typography>
                  </Box>
                ))}
              </Stack> : <Typography variant="body2" color="text.secondary">No billable events have accrued.</Typography>}
            </DetailSection>

            <DetailSection title="Event history">
              {order.events.length ? <Stack divider={<Divider flexItem />}>
                {order.events.map((event) => (
                  <Box key={event.globalId} sx={{ py: 1.25 }}>
                    <Stack direction="row" justifyContent="space-between" gap={2}>
                      <Typography fontWeight={600}>{displayStatus(event.type)}</Typography>
                      <Typography variant="caption" color="text.secondary" sx={{ whiteSpace: 'nowrap' }}>{formatUserDateTime(event.occurredAt, dateTime, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', fallback: 'Unknown' })}</Typography>
                    </Stack>
                    <Typography variant="caption" color="text.secondary">{event.globalId}</Typography>
                  </Box>
                ))}
              </Stack> : <Typography variant="body2" color="text.secondary">No domain events have been recorded.</Typography>}
            </DetailSection>
          </Stack>
        </Box>
      )}
    </Drawer>
  )
}

function ExceptionDetailDrawer({
  exception,
  open,
  canManage,
  canExecute,
  busy,
  onClose,
  onTransition,
  onAcceptProviderCancellation,
  onOpenOrder,
}: {
  exception: OperationsExceptionListItem | null
  open: boolean
  canManage: boolean
  canExecute: boolean
  busy: boolean
  onClose: () => void
  onTransition: (status: OperationsExceptionStatus) => void
  onAcceptProviderCancellation: (input: ProviderOrderCancellationCommand) => void
  onOpenOrder: (orderGlobalId: string) => void
}) {
  const theme = useTheme()
  const mobile = useMediaQuery(theme.breakpoints.down('md'))
  const dateTime = useUserDateTime()
  const [cancellationOpen, setCancellationOpen] = useState(false)
  const [cancellationReason, setCancellationReason] = useState(
    'Accept the exact provider cancellation for this unstarted imported order',
  )
  const recommendedAction = typeof exception?.details.recommendedAction === 'string'
    ? exception.details.recommendedAction
    : ''
  const evidence = exception?.details.evidence ?? exception?.details
  const evidenceText = evidence && typeof evidence === 'object' && Object.keys(evidence).length > 0
    ? JSON.stringify(evidence, null, 2)
    : ''
  const providerRevisionException = exception?.exceptionType === 'commerce_order_revision_required'
  const transitions: Array<{ status: OperationsExceptionStatus; label: string }> = providerRevisionException
    ? exception?.status === 'open'
      ? [{ status: 'acknowledged', label: 'Acknowledge' }]
      : [{ status: 'open', label: 'Reopen' }]
    : exception?.status === 'open'
      ? [{ status: 'acknowledged', label: 'Acknowledge' }, { status: 'resolved', label: 'Resolve' }, { status: 'dismissed', label: 'Dismiss' }]
      : exception?.status === 'acknowledged'
        ? [{ status: 'resolved', label: 'Resolve' }, { status: 'open', label: 'Reopen' }, { status: 'dismissed', label: 'Dismiss' }]
        : [{ status: 'open', label: 'Reopen' }]
  const observedRowVersion = Number(exception?.details.canonicalRowVersion)
  const providerCancellationCommand = (
    providerRevisionException
    && exception?.details.cancellationDispositionAvailable === true
    && exception.details.materialState === 'provider_cancelled'
    && typeof exception.orderGlobalId === 'string'
    && typeof exception.details.observationGlobalId === 'string'
    && typeof exception.details.readGlobalId === 'string'
    && typeof exception.details.sourceHash === 'string'
    && typeof exception.details.revisionHash === 'string'
    && Number.isSafeInteger(observedRowVersion)
    && observedRowVersion >= 0
  ) ? {
      orderGlobalId: exception.orderGlobalId,
      observationGlobalId: exception.details.observationGlobalId,
      readGlobalId: exception.details.readGlobalId,
      expectedSourceHash: exception.details.sourceHash,
      expectedRevisionHash: exception.details.revisionHash,
      expectedRowVersion: observedRowVersion,
    } : null

  return (
    <Drawer
      anchor="right"
      open={open}
      onClose={onClose}
      PaperProps={{
        sx: {
          width: mobile ? '100%' : 'min(520px, 44vw)',
          maxWidth: '100vw',
          backgroundColor: '#17171F',
          backgroundImage: 'none',
          borderLeft: '1px solid rgba(255,255,255,0.1)',
        },
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1, px: { xs: 2, sm: 3 }, py: 2 }}>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography variant="h6" fontWeight={700}>{exception?.title || 'Exception details'}</Typography>
          {exception && (
            <Stack direction="row" spacing={1} alignItems="center" sx={{ mt: 0.75, flexWrap: 'wrap', rowGap: 0.75 }}>
              <Chip size="small" label={exception.globalId} variant="outlined" />
              <Chip size="small" label={displayStatus(exception.severity)} color={severityColor(exception.severity)} />
              <Chip size="small" label={displayStatus(exception.status)} color={exceptionStatusColor(exception.status)} />
            </Stack>
          )}
        </Box>
        <Tooltip title="Close exception">
          <IconButton aria-label="Close exception details" onClick={onClose}><CloseRounded /></IconButton>
        </Tooltip>
      </Box>
      <Divider />
      {!exception ? (
        <Box sx={{ p: 4, display: 'flex', justifyContent: 'center' }}><CircularProgress size={28} /></Box>
      ) : (
        <Box sx={{ px: { xs: 2, sm: 3 }, py: 2.5, pb: 5, overflowY: 'auto' }}>
          <Stack spacing={3}>
            <DetailSection title="Context">
              <Stack spacing={1.25}>
                <Box><Typography variant="caption" color="text.secondary">Type</Typography><Typography>{displayStatus(exception.exceptionType)}</Typography></Box>
                <Box><Typography variant="caption" color="text.secondary">Customer</Typography><Typography>{exception.customerName || 'Not linked'}</Typography>{exception.customerGlobalId && <Typography variant="caption" color="#A8C7FA">{exception.customerGlobalId}</Typography>}</Box>
                <Box><Typography variant="caption" color="text.secondary">Assigned to</Typography><Typography>{exception.assignedTo || 'Unassigned'}</Typography></Box>
                <Box><Typography variant="caption" color="text.secondary">Opened</Typography><Typography>{formatUserDateTime(exception.createdAt, dateTime, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', fallback: 'Unknown' })}</Typography></Box>
              </Stack>
              {exception.orderGlobalId && (
                <Button
                  variant="outlined"
                  startIcon={<OpenInNewRounded />}
                  sx={{ mt: 2 }}
                  onClick={() => onOpenOrder(exception.orderGlobalId || '')}
                >
                  Open order {exception.orderNumber || exception.orderGlobalId}
                </Button>
              )}
            </DetailSection>
            <DetailSection title="Recommended action">
              <Typography color={recommendedAction ? 'text.primary' : 'text.secondary'}>{recommendedAction || 'No recommended action has been recorded.'}</Typography>
            </DetailSection>
            <DetailSection title="Evidence">
              {evidenceText ? (
                <Box component="pre" sx={{ m: 0, p: 1.5, borderRadius: '6px', backgroundColor: '#111118', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: '0.78rem', color: 'text.secondary' }}>{evidenceText}</Box>
              ) : <Typography color="text.secondary">No supporting evidence has been recorded.</Typography>}
            </DetailSection>
            {canManage && (
              <DetailSection title="Disposition">
                <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} flexWrap="wrap" useFlexGap>
                  {providerCancellationCommand && (
                    <Button
                      variant="contained"
                      color="error"
                      disabled={busy || !canExecute}
                      startIcon={<CancelRounded />}
                      onClick={() => setCancellationOpen(true)}
                    >
                      Accept provider cancellation
                    </Button>
                  )}
                  {transitions.map((transition) => (
                    <Button
                      key={transition.status}
                      variant={transition.status === 'resolved' ? 'contained' : 'outlined'}
                      color={transition.status === 'dismissed' ? 'inherit' : 'primary'}
                      disabled={busy}
                      startIcon={transition.status === 'resolved' ? <TaskAltRounded /> : transition.status === 'open' ? <ReplayRounded /> : undefined}
                      onClick={() => onTransition(transition.status)}
                    >
                      {transition.label}
                    </Button>
                  ))}
                </Stack>
                {providerRevisionException && !providerCancellationCommand && (
                  <Alert severity="warning" sx={{ mt: 1.5 }}>
                    This revision cannot be resolved manually. Refresh exact provider evidence or review the order outside this bounded cancellation workflow.
                  </Alert>
                )}
              </DetailSection>
            )}
          </Stack>
        </Box>
      )}
      <Dialog
        open={cancellationOpen}
        onClose={() => { if (!busy) setCancellationOpen(false) }}
        fullWidth
        maxWidth="sm"
      >
        <DialogTitle>Accept provider cancellation?</DialogTitle>
        <DialogContent dividers>
          <Stack spacing={2}>
            <Alert severity="warning">
              ClawPilot will cancel this order locally only if it is still imported and has no plan, reservation, pick, package, label, shipment, or fulfillment export evidence. No Shopify or Faire write will occur.
            </Alert>
            <TextField
              label="Manager reason"
              value={cancellationReason}
              onChange={(event) => setCancellationReason(event.target.value)}
              multiline
              minRows={3}
              inputProps={{ maxLength: 500 }}
              helperText="Recorded with the immutable provider revision disposition."
              fullWidth
              required
            />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button disabled={busy} onClick={() => setCancellationOpen(false)}>Keep order</Button>
          <Button
            color="error"
            variant="contained"
            disabled={busy || !providerCancellationCommand || cancellationReason.trim().length < 10}
            onClick={() => {
              if (!providerCancellationCommand) return
              onAcceptProviderCancellation({
                ...providerCancellationCommand,
                reason: cancellationReason.trim(),
              })
            }}
          >
            {busy ? 'Checking exact evidence…' : 'Cancel unstarted order'}
          </Button>
        </DialogActions>
      </Dialog>
    </Drawer>
  )
}

function OperationsGuide({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>Operations guide</DialogTitle>
      <DialogContent dividers>
        <Stack spacing={2.5}>
          <Box><Typography fontWeight={700}>1. Import and validate</Typography><Typography color="text.secondary">Orders enter through a commerce adapter. ClawPilot reuses provider mappings or a unique CRM identity match, creates a customer only when no match exists, and sends ambiguous matches to review.</Typography></Box>
          <Box><Typography fontWeight={700}>2. Promise and reserve</Typography><Typography color="text.secondary">ClawPilot selects a feasible warehouse, reserves customer-owned inventory, cartonizes the order, compares rates, and records the promise.</Typography></Box>
          <Box><Typography fontWeight={700}>3. Release and execute</Typography><Typography color="text.secondary">Review the plan, reservations, packages, rates, cost, revenue, and margin before release. Release creates a wave and ready pick tasks. Pick confirmation completes the wave, and package verification records packing evidence and contract fees.</Typography></Box>
          <Box><Typography fontWeight={700}>4. Label, print, and void</Typography><Typography color="text.secondary">Authorized managers may purchase a label only through a verified sandbox UPS or FedEx account. ClawPilot records the provider attempt before the call, stores the result, routes the label to the configured printer, and requires the original account when voiding. Prepared or unknown attempts must be reconciled before retrying.</Typography></Box>
          <Box><Typography fontWeight={700}>5. Reconcile revenue</Typography><Typography color="text.secondary">Contract directives create immutable billable events for order handling, picks, packing, freight, storage, and special services.</Typography></Box>
          <Alert severity="info">Hosted orders enter through approved commerce integrations. Sandbox label execution always uses the fixed John Doe test fixture between 101 Jegs Place and Massachusetts Maritime Academy. Deterministic mock adapters remain isolated to automated tests.</Alert>
        </Stack>
      </DialogContent>
      <DialogActions><Button onClick={onClose}>Done</Button></DialogActions>
    </Dialog>
  )
}

export default function OperationsSection({
  initialView = 'orders',
}: {
  initialView?: OperationsView
}) {
  const theme = useTheme()
  const mobile = useMediaQuery(theme.breakpoints.down('md'))
  const dateTime = useUserDateTime()
  const [workspace, setWorkspace] = useState<OperationsWorkspace | null>(null)
  const [commerceFulfillmentRecoveryEnabled, setCommerceFulfillmentRecoveryEnabled] =
    useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [view, setView] = useState<OperationsView>(initialView)
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState<'' | OperationsOrderStatus>('')
  const [exceptionStatus, setExceptionStatus] = useState<'' | OperationsExceptionStatus>('')
  const [selectedGlobalId, setSelectedGlobalId] = useState<string | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [selectedImportedGlobalId, setSelectedImportedGlobalId] =
    useState<string | null>(null)
  const [importedDrawerOpen, setImportedDrawerOpen] = useState(false)
  const [savingImportedOrder, setSavingImportedOrder] = useState(false)
  const [refreshingImportedOrder, setRefreshingImportedOrder] = useState(false)
  const [importedOrderError, setImportedOrderError] = useState('')
  const pendingImportedOrderSave = useRef<PendingImportedOrderSave | null>(null)
  const pendingImportedOrderAccept = useRef<PendingImportedOrderSave | null>(null)
  const [selectedExceptionGlobalId, setSelectedExceptionGlobalId] = useState<string | null>(null)
  const [exceptionDrawerOpen, setExceptionDrawerOpen] = useState(false)
  const [updatingException, setUpdatingException] = useState(false)
  const [orderRevisionBusy, setOrderRevisionBusy] = useState(false)
  const [guideOpen, setGuideOpen] = useState(false)
  const [oneOffShipmentOpen, setOneOffShipmentOpen] = useState(false)
  const [updatingActivation, setUpdatingActivation] = useState(false)
  const [updatingStoreSyncAccount, setUpdatingStoreSyncAccount] = useState('')
  const pendingStoreSyncCommands = useRef(
    new Map<string, CommerceStoreSyncPendingCommand>(),
  )
  const [commerceActiveOpen, setCommerceActiveOpen] = useState(false)
  const [commerceActivePending, setCommerceActivePending] = useState<
    '' | 'loading' | 'preparing' | 'activating'
  >('')
  const [commerceActiveError, setCommerceActiveError] = useState('')
  const [commerceActiveAccounts, setCommerceActiveAccounts] = useState<
    CommerceActiveAccountOption[]
  >([])
  const [commerceActiveSelectionEvidence, setCommerceActiveSelectionEvidence] =
    useState<(
      Omit<CommerceActiveInitialSelection, 'selections'> & {
        continuation: CommerceActiveContinuation | null
      }
    ) | null>(null)
  const [
    commerceActiveSelections,
    setCommerceActiveSelections,
  ] = useState<Record<string, CommerceActiveWriteCapability[]>>({})
  const [
    commerceActivePreparation,
    setCommerceActivePreparation,
  ] = useState<OperationsCommerceActivePreparationResult | null>(null)
  const [commerceActiveConfirmed, setCommerceActiveConfirmed] = useState(false)
  const [commerceActiveReason, setCommerceActiveReason] = useState(
    'Activate the reviewed Shopify and Faire provider-write cohort',
  )
  const [commerceActivePrepareKey, setCommerceActivePrepareKey] = useState('')
  const [commerceActiveActivateKey, setCommerceActiveActivateKey] = useState('')
  const [planOpen, setPlanOpen] = useState(false)
  const [shadowTrainingPlanTarget, setShadowTrainingPlanTarget] =
    useState<ShadowTrainingPlanTarget | null>(null)
  const [shadowTrainingRefreshToken, setShadowTrainingRefreshToken] =
    useState(0)
  const [planPreparationLoading, setPlanPreparationLoading] = useState(false)
  const [planPackagingWorkspace, setPlanPackagingWorkspace] =
    useState<PackagingMaterialsWorkspace | null>(null)
  const [planShopifyAssignment, setPlanShopifyAssignment] =
    useState<ShopifyPlanningAssignment | null>(null)
  const [planWarehouseGlobalId, setPlanWarehouseGlobalId] = useState('')
  const [planMaterialGlobalIds, setPlanMaterialGlobalIds] = useState<string[]>([])
  const [creatingPlanEvidence, setCreatingPlanEvidence] = useState(false)
  const [planEvidenceIdempotencyKey, setPlanEvidenceIdempotencyKey] = useState('')
  const [
    planCartonizationEvidenceGlobalId,
    setPlanCartonizationEvidenceGlobalId,
  ] = useState('')
  const [planReason, setPlanReason] = useState(
    'Accept the reviewed cartonization evidence as the canonical warehouse plan',
  )
  const [planIdempotencyKey, setPlanIdempotencyKey] = useState('')
  const [planError, setPlanError] = useState('')
  const [planningOrder, setPlanningOrder] = useState(false)
  const [releaseOpen, setReleaseOpen] = useState(false)
  const [releaseReason, setReleaseReason] = useState('Release the reviewed plan to warehouse execution')
  const [releaseIdempotencyKey, setReleaseIdempotencyKey] = useState('')
  const [releasingOrder, setReleasingOrder] = useState(false)
  const [replanningCorrectionOpen, setReplanningCorrectionOpen] = useState(false)
  const [replanningCorrectionReason, setReplanningCorrectionReason] = useState('')
  const [replanningCorrectionConfirmed, setReplanningCorrectionConfirmed] =
    useState(false)
  const [replanningCorrectionIdempotencyKey, setReplanningCorrectionIdempotencyKey] =
    useState('')
  const [reopeningForReplanning, setReopeningForReplanning] = useState(false)
  const [confirmPicksOpen, setConfirmPicksOpen] = useState(false)
  const [confirmPicksReason, setConfirmPicksReason] = useState('Confirm all ready pick tasks for the released wave')
  const [confirmPicksIdempotencyKey, setConfirmPicksIdempotencyKey] = useState('')
  const [confirmingPicks, setConfirmingPicks] = useState(false)
  const [externalFulfillmentOpen, setExternalFulfillmentOpen] = useState(false)
  const [externalFulfillmentReason, setExternalFulfillmentReason] = useState(
    'Reconcile exact Shopify fulfillment and cancel stale unpicked warehouse work',
  )
  const [externalFulfillmentIdempotencyKey, setExternalFulfillmentIdempotencyKey] =
    useState('')
  const [reconcilingExternalFulfillment, setReconcilingExternalFulfillment] =
    useState(false)
  const [verifyPackOpen, setVerifyPackOpen] = useState(false)
  const [verifyPackReason, setVerifyPackReason] = useState('Verify the carton plan after all warehouse picks are complete')
  const [verifyPackIdempotencyKey, setVerifyPackIdempotencyKey] = useState('')
  const [verifyingPack, setVerifyingPack] = useState(false)
  const [prepareFulfillmentOpen, setPrepareFulfillmentOpen] = useState(false)
  const [prepareFulfillmentReason, setPrepareFulfillmentReason] = useState(
    'Rerate the exact sealed packages and retain zero-write Shadow evidence',
  )
  const [
    prepareFulfillmentIdempotencyKey,
    setPrepareFulfillmentIdempotencyKey,
  ] = useState('')
  const [preparingFulfillment, setPreparingFulfillment] = useState(false)
  const [confirmShipmentOpen, setConfirmShipmentOpen] = useState(false)
  const [confirmShipmentReason, setConfirmShipmentReason] = useState(
    'Confirm the packed order and create shipment evidence',
  )
  const [confirmShipmentIdempotencyKey, setConfirmShipmentIdempotencyKey] = useState('')
  const [confirmingShipment, setConfirmingShipment] = useState(false)
  const [customerNotificationOverride, setCustomerNotificationOverride] =
    useState<boolean | null>(null)
  const [customerNotificationOverrideReason, setCustomerNotificationOverrideReason] =
    useState('')
  const [commerceExportRetryOpen, setCommerceExportRetryOpen] = useState(false)
  const [commerceExportRetryGlobalId, setCommerceExportRetryGlobalId] = useState('')
  const [commerceExportRetryReason, setCommerceExportRetryReason] = useState(
    'Retry the same immutable commerce fulfillment export after operator review',
  )
  const [commerceExportReconciliationPending, setCommerceExportReconciliationPending] =
    useState(false)
  const [commerceExportRetryIdempotencyKey, setCommerceExportRetryIdempotencyKey] =
    useState('')
  const [retryingCommerceExport, setRetryingCommerceExport] = useState(false)
  const [sandboxE2eAuthorizationOpen, setSandboxE2eAuthorizationOpen] = useState(false)
  const [sandboxE2eAuthorizationConfirmed, setSandboxE2eAuthorizationConfirmed] = useState(false)
  const [sandboxE2eConfirmationText, setSandboxE2eConfirmationText] = useState('')
  const [sandboxE2eAuthorizationReason, setSandboxE2eAuthorizationReason] = useState(
    'Authorized end-to-end validation for this exact commerce test order',
  )
  const [authorizingSandboxE2e, setAuthorizingSandboxE2e] = useState(false)
  const pendingShopifyTestStoreAuthorization =
    useRef<ShopifyTestStoreAuthorizationCommand | null>(null)
  const [shopifyTestFulfillmentOpen, setShopifyTestFulfillmentOpen] = useState(false)
  const [shopifyTestFulfillmentText, setShopifyTestFulfillmentText] = useState('')
  const [shopifyTestFulfillmentReason, setShopifyTestFulfillmentReason] = useState(
    'Reviewed the exact sandbox labels and tracking snapshot for Shopify test fulfillment',
  )
  const [confirmingShopifyTestFulfillment, setConfirmingShopifyTestFulfillment] =
    useState(false)
  const pendingShopifyTestStoreFulfillment =
    useRef<ShopifyTestStoreFulfillmentCommand | null>(null)
  const [createLabelOpen, setCreateLabelOpen] = useState(false)
  const [createLabelReason, setCreateLabelReason] = useState('Purchase a sandbox label for pack-to-ship validation')
  const [createLabelIdempotencyKey, setCreateLabelIdempotencyKey] = useState('')
  const [carrierAccountGlobalId, setCarrierAccountGlobalId] = useState('')
  const [createLabelPackageGlobalId, setCreateLabelPackageGlobalId] = useState('')
  const [creatingLabel, setCreatingLabel] = useState(false)
  const [voidLabelOpen, setVoidLabelOpen] = useState(false)
  const [voidLabelReason, setVoidLabelReason] = useState('Void the sandbox label after validation')
  const [voidLabelIdempotencyKey, setVoidLabelIdempotencyKey] = useState('')
  const [voidingLabel, setVoidingLabel] = useState(false)
  const [oneOffExecutionState, setOneOffExecutionState] =
    useState<OneOffShipmentExecutionState | null>(null)
  const [oneOffExecutionLoading, setOneOffExecutionLoading] = useState(false)
  const [oneOffExecutionError, setOneOffExecutionError] = useState('')
  const [oneOffGroupAction, setOneOffGroupAction] = useState<'' | 'refresh' | 'purchase' | 'void'>('')
  const [oneOffGroupPurchaseOpen, setOneOffGroupPurchaseOpen] = useState(false)
  const [oneOffGroupPurchaseOfferGlobalId, setOneOffGroupPurchaseOfferGlobalId] = useState('')
  const [oneOffGroupPurchaseReason, setOneOffGroupPurchaseReason] = useState(
    'Purchase the reviewed fresh rate for the exact complete packed shipment group',
  )
  const [oneOffGroupPurchaseConfirmed, setOneOffGroupPurchaseConfirmed] = useState(false)
  const [oneOffGroupPurchaseIdempotencyKey, setOneOffGroupPurchaseIdempotencyKey] = useState('')
  const [oneOffGroupVoidOpen, setOneOffGroupVoidOpen] = useState(false)
  const [oneOffGroupVoidReason, setOneOffGroupVoidReason] = useState(
    'Cancel the exact complete one-off carrier shipment group before shipment confirmation',
  )
  const [oneOffGroupVoidIdempotencyKey, setOneOffGroupVoidIdempotencyKey] = useState('')
  const [
    generatingPackingSlipPackageId,
    setGeneratingPackingSlipPackageId,
  ] = useState<string | null>(null)
  const [
    printingPackingSlipArtifactId,
    setPrintingPackingSlipArtifactId,
  ] = useState<string | null>(null)
  const [labelPrintBusyGlobalId, setLabelPrintBusyGlobalId] =
    useState<string | null>(null)
  const [labelReprintOpen, setLabelReprintOpen] = useState(false)
  const [labelReprintLabelGlobalId, setLabelReprintLabelGlobalId] = useState('')
  const [labelReprintJobGlobalId, setLabelReprintJobGlobalId] = useState('')
  const [labelReprintReason, setLabelReprintReason] = useState('')
  const [labelReprintIdempotencyKey, setLabelReprintIdempotencyKey] = useState('')

  useEffect(() => {
    const pendingOrderGlobalId = new URL(window.location.href).searchParams
      .get(OPERATIONS_ORDER_QUERY)?.trim() || ''
    setView(initialView)
    setSearch('')
    if (
      initialView === 'orders'
      && OPERATIONS_ORDER_GLOBAL_ID.test(pendingOrderGlobalId)
    ) {
      setSelectedGlobalId(pendingOrderGlobalId)
      setDrawerOpen(true)
      setSelectedImportedGlobalId(null)
      setImportedDrawerOpen(false)
    } else if (
      initialView === 'orders'
      && OPERATIONS_IMPORTED_ORDER_GLOBAL_ID.test(pendingOrderGlobalId)
    ) {
      setSelectedGlobalId(null)
      setDrawerOpen(false)
      setSelectedImportedGlobalId(pendingOrderGlobalId)
      setImportedDrawerOpen(true)
    } else {
      setSelectedGlobalId(null)
      setDrawerOpen(false)
      setSelectedImportedGlobalId(null)
      setImportedDrawerOpen(false)
    }
    setSelectedExceptionGlobalId(null)
    setExceptionDrawerOpen(false)
  }, [initialView])

  const loadWorkspace = useCallback(async (orderGlobalId?: string | null, signal?: AbortSignal) => {
    setLoading(true)
    setError('')
    const params = new URLSearchParams()
    if (search.trim()) params.set('search', search.trim())
    if (view === 'orders' && status) params.set('status', status)
    if (view === 'exceptions' && exceptionStatus) params.set('exceptionStatus', exceptionStatus)
    if (orderGlobalId) params.set('order', orderGlobalId)
    try {
      const response = await fetch(`/api/operations?${params.toString()}`, { cache: 'no-store', signal })
      const payload = await response.json().catch(() => ({})) as OperationsPayload
      if (!response.ok || !payload.operations) throw new Error(payload.error || 'Operations data is unavailable')
      setWorkspace(payload.operations)
      setCommerceFulfillmentRecoveryEnabled(
        payload.runtime?.commerceFulfillmentRecoveryEnabled === true,
      )
      return payload.operations
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === 'AbortError') return null
      setError(caught instanceof Error ? caught.message : 'Operations data is unavailable')
      return null
    } finally {
      if (!signal?.aborted) setLoading(false)
    }
  }, [exceptionStatus, search, status, view])

  const loadOneOffExecutionState = useCallback(async (
    orderGlobalId: string,
    signal?: AbortSignal,
  ) => {
    setOneOffExecutionState((current) => (
      current?.orderGlobalId === orderGlobalId ? current : null
    ))
    setOneOffExecutionLoading(true)
    setOneOffExecutionError('')
    try {
      const params = new URLSearchParams({ orderGlobalId })
      const response = await fetch(
        `/api/operations/one-off-shipments?${params.toString()}`,
        { cache: 'no-store', signal },
      )
      const payload = await response.json().catch(() => ({})) as OneOffExecutionPayload
      if (!response.ok || !payload.ok || !payload.state) {
        throw new Error(`${payload.error || 'One-off shipment-group state is unavailable'}${payload.code ? ` [${payload.code}]` : ''}`)
      }
      setOneOffExecutionState(payload.state)
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === 'AbortError') return
      setOneOffExecutionError(caught instanceof Error
        ? caught.message
        : 'One-off shipment-group state is unavailable')
    } finally {
      if (!signal?.aborted) setOneOffExecutionLoading(false)
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      void loadWorkspace(selectedGlobalId, controller.signal)
    }, search ? 250 : 0)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [loadWorkspace, search, selectedGlobalId])

  useEffect(() => {
    if (!importedDrawerOpen || !selectedImportedGlobalId) return
    const selected = workspace?.importedOrders.find((order) => (
      order.candidateGlobalId === selectedImportedGlobalId
    ))
    if (!selected || selected.resolutionDetailsLoaded) return
    const controller = new AbortController()
    const loadDetails = async () => {
      try {
        const params = new URLSearchParams({
          candidate: selected.candidateGlobalId,
        })
        const response = await fetch(
          `/api/operations/order-workbench?${params.toString()}`,
          { cache: 'no-store', signal: controller.signal },
        )
        const payload = await response.json().catch(() => ({})) as
          ImportedOrderWorkbenchPayload
        const detailed = payload.orders?.[0]
        if (!response.ok || !payload.ok || !detailed) {
          throw new Error(payload.error || 'Editable order details are unavailable')
        }
        setWorkspace((current) => current ? {
          ...current,
          importedOrders: current.importedOrders.map((order) => (
            order.candidateGlobalId === detailed.candidateGlobalId
              ? detailed
              : order
          )),
        } : current)
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === 'AbortError') return
        setImportedOrderError(caught instanceof Error
          ? caught.message
          : 'Editable order details are unavailable')
      }
    }
    void loadDetails()
    return () => controller.abort()
  }, [
    importedDrawerOpen,
    selectedImportedGlobalId,
    workspace?.importedOrders,
  ])

  const chooseOrder = (order: OperationsOrderListItem) => {
    setSelectedImportedGlobalId(null)
    setImportedDrawerOpen(false)
    setImportedOrderError('')
    setSelectedGlobalId(order.globalId)
    setDrawerOpen(true)
  }

  const chooseImportedOrder = (order: OperationsImportedOrderWorkingCopy) => {
    setSearch('')
    setStatus('')
    setSelectedGlobalId(null)
    setDrawerOpen(false)
    setSelectedImportedGlobalId(order.candidateGlobalId)
    setImportedDrawerOpen(true)
    setImportedOrderError('')
    const nextUrl = new URL(window.location.href)
    nextUrl.searchParams.set(OPERATIONS_ORDER_QUERY, order.candidateGlobalId)
    window.history.replaceState(window.history.state, '', nextUrl)
  }

  const closeDrawer = () => {
    setDrawerOpen(false)
    setSelectedGlobalId(null)
    const nextUrl = new URL(window.location.href)
    if (nextUrl.searchParams.has(OPERATIONS_ORDER_QUERY)) {
      nextUrl.searchParams.delete(OPERATIONS_ORDER_QUERY)
      window.history.replaceState(window.history.state, '', nextUrl)
    }
    setOneOffExecutionState(null)
    setOneOffExecutionError('')
    setOneOffGroupPurchaseOpen(false)
    setOneOffGroupVoidOpen(false)
  }

  const closeImportedDrawer = () => {
    if (savingImportedOrder) return
    setImportedDrawerOpen(false)
    setSelectedImportedGlobalId(null)
    setImportedOrderError('')
    const nextUrl = new URL(window.location.href)
    if (nextUrl.searchParams.has(OPERATIONS_ORDER_QUERY)) {
      nextUrl.searchParams.delete(OPERATIONS_ORDER_QUERY)
      window.history.replaceState(window.history.state, '', nextUrl)
    }
  }

  const openAcceptedImportedOrder = async (
    orderNumber: string,
    canonicalOrderGlobalId: string,
  ) => {
    setImportedDrawerOpen(false)
    setSelectedImportedGlobalId(null)
    setImportedOrderError('')
    setSearch('')
    setStatus('')
    const nextUrl = new URL(window.location.href)
    nextUrl.searchParams.set(
      OPERATIONS_ORDER_QUERY,
      canonicalOrderGlobalId,
    )
    window.history.replaceState(window.history.state, '', nextUrl)
    await loadWorkspace(canonicalOrderGlobalId)
    setSelectedGlobalId(canonicalOrderGlobalId)
    setDrawerOpen(true)
    setNotice(`Order ${orderNumber} imported`)
  }

  const saveImportedOrderDraft = async (
    draft: OperationsImportedOrderWorkingCopyDraft,
  ) => {
    const order = workspace?.importedOrders.find(
      (candidate) => candidate.candidateGlobalId === selectedImportedGlobalId,
    )
    if (!order || savingImportedOrder) return
    const fingerprint = importedOrderDraftFingerprint(draft)
    const retained = pendingImportedOrderSave.current
    const pending = retained
      && retained.candidateGlobalId === order.candidateGlobalId
      && retained.expectedRowVersion === order.rowVersion
      && retained.fingerprint === fingerprint
      ? retained
      : {
          candidateGlobalId: order.candidateGlobalId,
          expectedRowVersion: order.rowVersion,
          fingerprint,
          idempotencyKey: crypto.randomUUID(),
        }
    pendingImportedOrderSave.current = pending
    setSavingImportedOrder(true)
    setImportedOrderError('')
    try {
      const response = await fetch('/api/operations/order-workbench', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': pending.idempotencyKey,
        },
        body: JSON.stringify({
          candidateGlobalId: pending.candidateGlobalId,
          expectedRowVersion: pending.expectedRowVersion,
          shipTo: draft.shipTo,
          resolution: draft.resolution,
        }),
      })
      const payload = await response.json().catch(() => ({})) as ImportedOrderWorkbenchPayload
      if (!response.ok || !payload.ok || !payload.result) {
        const rejected = response.status >= 400 && response.status < 500
        if (rejected) pendingImportedOrderSave.current = null
        throw new Error(payload.error || 'Order changes could not be saved')
      }
      pendingImportedOrderSave.current = null
      const canonicalOrderGlobalId = payload.result.canonicalOrderGlobalId
      if (canonicalOrderGlobalId) {
        await openAcceptedImportedOrder(
          order.orderNumber,
          canonicalOrderGlobalId,
        )
        return
      }
      if (!payload.order) {
        throw new Error('Saved order could not be reloaded')
      }
      const savedOrder = payload.order
      setWorkspace((current) => current ? {
        ...current,
        importedOrders: current.importedOrders.map((candidate) => (
          candidate.candidateGlobalId === savedOrder.candidateGlobalId
            ? savedOrder
            : candidate
        )),
      } : current)
      setNotice(`Order ${savedOrder.orderNumber} saved locally`)
    } catch (caught) {
      setImportedOrderError(caught instanceof Error
        ? caught.message
        : 'Order changes could not be saved')
    } finally {
      setSavingImportedOrder(false)
    }
  }

  const acceptImportedOrder = async () => {
    const order = workspace?.importedOrders.find(
      (candidate) => candidate.candidateGlobalId === selectedImportedGlobalId,
    )
    if (!order || savingImportedOrder) return
    const retained = pendingImportedOrderAccept.current
    const pending = retained
      && retained.candidateGlobalId === order.candidateGlobalId
      && retained.expectedRowVersion === order.rowVersion
      ? retained
      : {
          candidateGlobalId: order.candidateGlobalId,
          expectedRowVersion: order.rowVersion,
          fingerprint: 'accept',
          idempotencyKey: crypto.randomUUID(),
        }
    pendingImportedOrderAccept.current = pending
    setSavingImportedOrder(true)
    setImportedOrderError('')
    try {
      const response = await fetch('/api/operations/order-workbench', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': pending.idempotencyKey,
        },
        body: JSON.stringify({
          action: 'accept',
          candidateGlobalId: pending.candidateGlobalId,
          expectedRowVersion: pending.expectedRowVersion,
        }),
      })
      const payload = await response.json().catch(() => ({})) as
        ImportedOrderWorkbenchPayload
      if (!response.ok || !payload.ok || !payload.result) {
        if (response.status >= 400 && response.status < 500) {
          pendingImportedOrderAccept.current = null
        }
        throw new Error(payload.error || 'Order could not be imported')
      }
      pendingImportedOrderAccept.current = null
      if (payload.result.canonicalOrderGlobalId) {
        await openAcceptedImportedOrder(
          order.orderNumber,
          payload.result.canonicalOrderGlobalId,
        )
        return
      }
      if (!payload.order) {
        throw new Error('Imported order result could not be reloaded')
      }
      const retainedOrder = payload.order
      setWorkspace((current) => current ? {
        ...current,
        importedOrders: current.importedOrders.map((candidate) => (
          candidate.candidateGlobalId === retainedOrder.candidateGlobalId
            ? retainedOrder
            : candidate
        )),
      } : current)
      setNotice(`Order ${retainedOrder.orderNumber} still needs information`)
    } catch (caught) {
      setImportedOrderError(caught instanceof Error
        ? caught.message
        : 'Order could not be imported')
    } finally {
      setSavingImportedOrder(false)
    }
  }

  const refreshImportedOrder = async (conflictResolution?: {
    latestCandidateGlobalId: string
    resolutions: Partial<
      Record<keyof OrderShipToDraft, 'local' | 'provider'>
    >
    lineResolutions: Record<string, 'provider'>
  }) => {
    const order = workspace?.importedOrders.find(
      (candidate) => candidate.candidateGlobalId === selectedImportedGlobalId,
    )
    if (!order || refreshingImportedOrder || savingImportedOrder) return null
    setRefreshingImportedOrder(true)
    setImportedOrderError('')
    try {
      const response = await fetch('/api/operations/order-workbench', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': crypto.randomUUID(),
        },
        body: JSON.stringify({
          action: 'refresh',
          candidateGlobalId: order.candidateGlobalId,
          expectedRowVersion: order.rowVersion,
          ...(conflictResolution
            ? {
                latestCandidateGlobalId:
                  conflictResolution.latestCandidateGlobalId,
                resolutions: conflictResolution.resolutions,
                lineResolutions: conflictResolution.lineResolutions,
              }
            : {}),
        }),
      })
      const payload = await response.json().catch(() => ({})) as
        ImportedOrderWorkbenchPayload
      if (
        response.status === 409
        && payload.code === 'OPERATIONS_IMPORTED_ORDER_REFRESH_CONFLICT'
        && payload.latestCandidateGlobalId
        && Array.isArray(payload.conflicts)
        && Array.isArray(payload.lineConflicts)
      ) {
        return {
          latestCandidateGlobalId: payload.latestCandidateGlobalId,
          conflicts: payload.conflicts,
          lineConflicts: payload.lineConflicts,
        }
      }
      if (
        !response.ok
        || !payload.ok
        || !payload.order
        || !payload.refreshResult
      ) {
        throw new Error(payload.error || 'Order could not be refreshed')
      }
      const refreshed = payload.order
      setWorkspace((current) => {
        if (!current) return current
        let inserted = false
        const importedOrders = current.importedOrders.flatMap((candidate) => {
          if (
            candidate.candidateGlobalId !== order.candidateGlobalId
            && candidate.candidateGlobalId !== refreshed.candidateGlobalId
          ) return [candidate]
          if (inserted) return []
          inserted = true
          return [refreshed]
        })
        if (!inserted) importedOrders.unshift(refreshed)
        return { ...current, importedOrders }
      })
      setSelectedImportedGlobalId(refreshed.candidateGlobalId)
      const nextUrl = new URL(window.location.href)
      nextUrl.searchParams.set(
        OPERATIONS_ORDER_QUERY,
        refreshed.candidateGlobalId,
      )
      window.history.replaceState(window.history.state, '', nextUrl)
      setNotice(
        payload.refreshResult.status === 'rebased'
          ? payload.refreshResult.preservedLineDrafts.length
            ? `Order ${refreshed.orderNumber} refreshed; saved item matches were preserved`
            : `Order ${refreshed.orderNumber} refreshed; review provider item changes`
          : `Order ${refreshed.orderNumber} is current`,
      )
      return null
    } catch (caught) {
      setImportedOrderError(caught instanceof Error
        ? caught.message
        : 'Order could not be refreshed')
      return null
    } finally {
      setRefreshingImportedOrder(false)
    }
  }

  const chooseException = (exception: OperationsExceptionListItem) => {
    setSelectedExceptionGlobalId(exception.globalId)
    setExceptionDrawerOpen(true)
  }

  const reviewOrderRevisionRecovery = async (exceptionGlobalId: string) => {
    const orderGlobalId = selectedGlobalId
    const matchesExactRecovery = (item: OperationsExceptionListItem) => (
      item.globalId === exceptionGlobalId
      && item.orderGlobalId === orderGlobalId
      && item.exceptionType === 'commerce_order_revision_required'
      && (item.status === 'open' || item.status === 'acknowledged')
    )
    const loadedException = workspace?.exceptions.find(matchesExactRecovery)
    if (loadedException) {
      chooseException(loadedException)
      return
    }
    if (!orderGlobalId) return

    setOrderRevisionBusy(true)
    setError('')
    try {
      const params = new URLSearchParams({
        search: exceptionGlobalId,
        order: orderGlobalId,
      })
      const response = await fetch(
        `/api/operations?${params.toString()}`,
        { cache: 'no-store' },
      )
      const payload = await response.json().catch(() => ({})) as OperationsPayload
      if (!response.ok || !payload.operations) {
        throw new Error(payload.error || 'The exact recovery case is unavailable')
      }
      const exactException = payload.operations.exceptions.find(matchesExactRecovery)
      if (!exactException) {
        throw new Error('The exact recovery case is no longer open for this order')
      }
      setWorkspace((current) => current ? {
        ...current,
        exceptions: [
          exactException,
          ...current.exceptions.filter((item) => item.globalId !== exceptionGlobalId),
        ],
      } : payload.operations || null)
      chooseException(exactException)
    } catch (caught) {
      setError(caught instanceof Error
        ? caught.message
        : 'The exact recovery case is unavailable')
    } finally {
      setOrderRevisionBusy(false)
    }
  }

  const closeExceptionDrawer = () => {
    setExceptionDrawerOpen(false)
    setSelectedExceptionGlobalId(null)
  }

  const openExceptionOrder = (orderGlobalId: string) => {
    closeExceptionDrawer()
    setImportedDrawerOpen(false)
    setSelectedImportedGlobalId(null)
    setImportedOrderError('')
    setView('orders')
    setSelectedGlobalId(orderGlobalId)
    setDrawerOpen(true)
  }

  const openPickingOrder = (orderGlobalId: string) => {
    if (!OPERATIONS_ORDER_GLOBAL_ID.test(orderGlobalId)) return
    setImportedDrawerOpen(false)
    setSelectedImportedGlobalId(null)
    setImportedOrderError('')
    const nextUrl = new URL(window.location.href)
    nextUrl.searchParams.set(OPERATIONS_ORDER_QUERY, orderGlobalId)
    window.history.replaceState(window.history.state, '', nextUrl)
    if (view === 'orders') {
      setSearch('')
      setStatus('')
      setSelectedGlobalId(orderGlobalId)
      setDrawerOpen(true)
      return
    }
    window.location.hash = 'operations'
  }

  const loadPlanPreparation = async (
    order: OperationsOrderDetail,
    localTraining = false,
  ) => {
    if (!order.planningPreparation) {
      setPlanError(
        'This imported order is missing its promoted sales-channel candidate. Refresh the order or reopen Commerce imports.',
      )
      return
    }
    setPlanPreparationLoading(true)
    try {
      const packagingRequest = fetch('/api/operations/packaging-materials', {
        cache: 'no-store',
      })
      const assignmentRequest = order.sourceProvider === 'shopify'
        && !localTraining
        ? fetch(
            '/api/integrations/commerce/intake/planning-assignment',
            {
              method: 'POST',
              cache: 'no-store',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                action: 'inspect',
                accountGlobalId: order.planningPreparation.accountGlobalId,
                candidateGlobalId: order.planningPreparation.candidateGlobalId,
                expectedCandidateRowVersion:
                  order.planningPreparation.candidateRowVersion,
              }),
            },
          )
        : null
      const [response, assignmentResponse] = await Promise.all([
        packagingRequest,
        assignmentRequest,
      ])
      const payload = await response.json().catch(() => ({})) as
        PackagingMaterialsPayload
      if (!response.ok || !payload.ok || !payload.packagingMaterials) {
        throw new Error(
          payload.error || 'Packaging materials could not be loaded',
        )
      }
      const packaging = payload.packagingMaterials
      let assignment: ShopifyPlanningAssignment | null = null
      if (assignmentResponse) {
        const assignmentPayload = await assignmentResponse.json()
          .catch(() => ({})) as ShopifyPlanningAssignmentPayload
        if (!assignmentResponse.ok || !assignmentPayload.assignment) {
          throw new Error(
            `${assignmentPayload.error
              || 'Shopify fulfillment routing could not be inspected'}${
              assignmentPayload.code ? ` [${assignmentPayload.code}]` : ''
            }`,
          )
        }
        assignment = assignmentPayload.assignment
      }
      const warehouseGlobalId = assignment?.status === 'ready'
        ? assignment.selectedWarehouse?.globalId || ''
        : packaging.warehouses.find(
            (warehouse) => warehouse.status === 'active',
          )?.globalId || ''
      const operationalMaterials = warehouseGlobalId
        ? packaging.materials.filter((material) => (
            operationalPlanningMaterialBlockers(
              material,
              warehouseGlobalId,
              !localTraining,
            ).length === 0
          ))
        : []
      setPlanPackagingWorkspace(packaging)
      setPlanShopifyAssignment(assignment)
      setPlanWarehouseGlobalId(warehouseGlobalId)
      setPlanMaterialGlobalIds(
        operationalMaterials[0] ? [operationalMaterials[0].globalId] : [],
      )
      if (!localTraining && assignment?.status === 'provider_managed') {
        const providerLocation = assignment.assignments[0]
        setPlanError(
          `Shopify assigned this order to ${
            providerLocation?.shopifyLocationName || 'an app-managed location'
          }${providerLocation?.fulfillmentService?.serviceName
            ? ` (${providerLocation.fulfillmentService.serviceName})`
            : ''}. This provider-managed fulfillment order cannot be planned as ClawPilot warehouse work.`,
        )
      } else if (!localTraining && assignment?.status === 'unmapped') {
        setPlanError(
          `Shopify assigned this order to ${
            assignment.assignments[0]?.shopifyLocationName || 'an unmapped location'
          }. Map that Shopify location to a ClawPilot warehouse before cartonization.`,
        )
      } else if (!localTraining && assignment?.status === 'split') {
        setPlanError(
          'Shopify split this order across more than one fulfillment location. Split-warehouse planning is not available yet.',
        )
      } else if (!localTraining && assignment?.status === 'not_open') {
        setPlanError(
          'Shopify has no untouched open fulfillment assignment that ClawPilot can plan.',
        )
      } else if (!warehouseGlobalId) {
        setPlanError('Configure an active warehouse before preparing this order.')
      } else if (!operationalMaterials.length) {
        setPlanError(
          localTraining
            ? 'No active packaging has factual exterior dimensions and tare for training.'
            : 'No active stocked packaging has factual exterior dimensions and tare for this warehouse.',
        )
      }
    } catch (caught) {
      setPlanError(
        caught instanceof Error
          ? caught.message
          : 'Packaging materials could not be loaded',
      )
    } finally {
      setPlanPreparationLoading(false)
    }
  }

  const openPlan = (trainingTarget?: ShadowTrainingPlanTarget) => {
    const sealedTrainingEvidence = (
      trainingTarget?.cartonizationEvidenceGlobalId || ''
    ).trim().toLowerCase()
    setShadowTrainingPlanTarget(trainingTarget || null)
    setPlanCartonizationEvidenceGlobalId(sealedTrainingEvidence)
    setPlanPackagingWorkspace(null)
    setPlanShopifyAssignment(null)
    setPlanWarehouseGlobalId('')
    setPlanMaterialGlobalIds([])
    setPlanPreparationLoading(false)
    setPlanEvidenceIdempotencyKey(
      `operations-rate-plan:${detail?.globalId || 'order'}:${crypto.randomUUID()}`,
    )
    setPlanReason(trainingTarget
      ? 'Rate, cartonize, and accept the local-only training plan'
      : 'Rate, cartonize, and accept the reviewed warehouse plan')
    setPlanIdempotencyKey(
      `${trainingTarget ? 'shadow-training-plan' : 'operations-plan'}:${detail?.globalId || 'order'}:${crypto.randomUUID()}`,
    )
    setPlanError('')
    setPlanOpen(true)
    if (detail && !sealedTrainingEvidence) {
      void loadPlanPreparation(detail, Boolean(trainingTarget))
    }
  }

  const closePlan = () => {
    if (planningOrder || creatingPlanEvidence) return
    setPlanOpen(false)
    setPlanPackagingWorkspace(null)
    setPlanShopifyAssignment(null)
    setPlanWarehouseGlobalId('')
    setPlanMaterialGlobalIds([])
    setPlanCartonizationEvidenceGlobalId('')
    setShadowTrainingPlanTarget(null)
    setPlanEvidenceIdempotencyKey('')
    setPlanIdempotencyKey('')
    setPlanError('')
  }

  const createPlanEvidence = async () => {
    const preparation = detail?.planningPreparation
    const selectedMaterials = planPackagingWorkspace?.materials.filter(
      (material) => planMaterialGlobalIds.includes(material.globalId),
    ) || []
    if (
      !detail
      || !preparation
      || !planWarehouseGlobalId
      || selectedMaterials.length < 1
      || selectedMaterials.length > 8
      || !planEvidenceIdempotencyKey
    ) return
    const blocker = selectedMaterials.flatMap((material) => (
      operationalPlanningMaterialBlockers(
        material,
        planWarehouseGlobalId,
        !shadowTrainingPlanTarget,
      )
        .map((reason) => `${material.code}: ${reason}`)
    ))[0]
    if (blocker) {
      setPlanError(blocker)
      return
    }
    setCreatingPlanEvidence(true)
    setPlanCartonizationEvidenceGlobalId('')
    setPlanError('')
    try {
      const response = await fetch(
        '/api/integrations/commerce/intake/cartonization-rate-evidence',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            evidenceMode: 'operational',
            accountGlobalId: preparation.accountGlobalId,
            candidateGlobalId: preparation.candidateGlobalId,
            expectedCandidateRowVersion: preparation.candidateRowVersion,
            warehouseGlobalId: planWarehouseGlobalId,
            shadowTraining: shadowTrainingPlanTarget
              ? {
                  runGlobalId: shadowTrainingPlanTarget.runGlobalId,
                  expectedRowVersion:
                    shadowTrainingPlanTarget.expectedRowVersion,
                }
              : undefined,
            selectedMaterials: selectedMaterials.map((material) => ({
              materialGlobalId: material.globalId,
              expectedRowVersion: material.rowVersion,
            })),
            sandboxE2eAuthorizationGlobalId:
              detail.sandboxCommerceE2eAuthorization?.authorityKind
                === 'shopify_test_store_canonical'
                ? detail.sandboxCommerceE2eAuthorization.authorizationGlobalId
                : undefined,
            idempotencyKey: planEvidenceIdempotencyKey,
          }),
        },
      )
      const payload = await response.json().catch(() => ({})) as
        PlanningEvidencePayload
      if (
        !response.ok
        || !payload.ok
        || !payload.evidence
        || payload.evidence.status === 'failed'
      ) {
        throw new Error(
          `${payload.error || 'Cartonization and carrier rating failed'}${
            payload.code ? ` [${payload.code}]` : ''
          }`,
        )
      }
      setPlanCartonizationEvidenceGlobalId(payload.evidence.globalId)
    } catch (caught) {
      setPlanEvidenceIdempotencyKey(
        `operations-rate-plan:${detail.globalId}:${crypto.randomUUID()}`,
      )
      setPlanError(
        caught instanceof Error
          ? caught.message
          : 'Cartonization and carrier rating failed',
      )
    } finally {
      setCreatingPlanEvidence(false)
    }
  }

  const planOrder = async (event: FormEvent) => {
    event.preventDefault()
    const evidenceGlobalId = planCartonizationEvidenceGlobalId.trim().toLowerCase()
    if (
      !detail
      || !CARTONIZATION_EVIDENCE_GLOBAL_ID.test(evidenceGlobalId)
      || !planReason.trim()
      || !planIdempotencyKey
    ) return
    setPlanningOrder(true)
    setPlanError('')
    setError('')
    setNotice('')
    try {
      if (shadowTrainingPlanTarget) {
        const response = await fetch('/api/operations/training', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': planIdempotencyKey,
          },
          body: JSON.stringify({
            action: 'plan',
            runGlobalId: shadowTrainingPlanTarget.runGlobalId,
            cartonizationEvidenceGlobalId: evidenceGlobalId,
            expectedRowVersion: shadowTrainingPlanTarget.expectedRowVersion,
            reason: planReason.trim(),
          }),
        })
        const payload = await response.json().catch(() => ({})) as {
          ok?: boolean
          error?: string
          code?: string
          run?: {
            globalId: string
            state: string
            packages: unknown[]
          }
        }
        if (!response.ok || !payload.ok || payload.run?.state !== 'planned') {
          throw new Error(
            `${payload.error || 'Training order could not be prepared'}${
              payload.code ? ` [${payload.code}]` : ''
            }`,
          )
        }
        setPlanOpen(false)
        setPlanPackagingWorkspace(null)
        setPlanShopifyAssignment(null)
        setPlanWarehouseGlobalId('')
        setPlanMaterialGlobalIds([])
        setPlanCartonizationEvidenceGlobalId('')
        setShadowTrainingPlanTarget(null)
        setPlanEvidenceIdempotencyKey('')
        setPlanIdempotencyKey('')
        setPlanError('')
        setNotice(
          `Training run ${payload.run.globalId} prepared ${payload.run.packages.length} local-only ${
            payload.run.packages.length === 1 ? 'package' : 'packages'
          } from ${evidenceGlobalId}. No store write, inventory mutation, postage, label, or shipment was created.`,
        )
        setShadowTrainingRefreshToken((current) => current + 1)
        return
      }
      const response = await fetch('/api/operations', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': planIdempotencyKey,
        },
        body: JSON.stringify({
          action: 'plan-order',
          orderGlobalId: detail.globalId,
          cartonizationEvidenceGlobalId: evidenceGlobalId,
          expectedRowVersion: detail.rowVersion,
          reason: planReason.trim(),
          sandboxE2eAuthorizationGlobalId:
            detail.sandboxCommerceE2eAuthorization?.authorityKind
              === 'shopify_test_store_canonical'
              ? detail.sandboxCommerceE2eAuthorization.authorizationGlobalId
              : undefined,
        }),
      })
      const payload = await response.json() as OperationsPayload
      if (
        !response.ok
        || !payload.result
        || !('orderGlobalId' in payload.result)
        || !('rowVersion' in payload.result)
        || payload.result.orderStatus !== 'planned'
      ) {
        throw new Error(payload.error || 'Order could not be planned')
      }

      const result = payload.result as OperationsOrderCommandResult & Record<string, unknown>
      const textResult = (value: unknown) => (
        typeof value === 'string' && value.trim() ? value.trim() : null
      )
      const integerResult = (value: unknown) => {
        const parsed = Number(value)
        return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null
      }
      const minorResult = (value: unknown) => {
        if (
          typeof value === 'number'
          && Number.isSafeInteger(value)
        ) return String(value)
        if (
          typeof value === 'string'
          && /^-?\d+$/.test(value.trim())
        ) return value.trim()
        return null
      }
      const resultEvidenceGlobalId = (
        textResult(result.cartonizationEvidenceGlobalId) || evidenceGlobalId
      )
      const fulfillmentPlanGlobalId = textResult(result.fulfillmentPlanGlobalId)
      const packageCount = integerResult(result.packageCount)
      const carrier = textResult(result.carrier)
      const service = (
        textResult(result.serviceName)
        || textResult(result.serviceCode)
      )
      const currency = textResult(result.currency) || detail.currency
      const selectedCostMinor = minorResult(result.carrierCostMinor)
      const checkoutChargeMinor = minorResult(result.checkoutShippingChargeMinor)
      const estimatedVarianceMinor = minorResult(result.checkoutVarianceMinor)
      const evidence: string[] = []
      if (fulfillmentPlanGlobalId) evidence.push(`plan ${fulfillmentPlanGlobalId}`)
      if (packageCount !== null) {
        evidence.push(`${packageCount} ${packageCount === 1 ? 'package' : 'packages'}`)
      }
      if (carrier || service) {
        evidence.push([carrier, service].filter(Boolean).join(' '))
      }
      if (selectedCostMinor !== null) {
        evidence.push(`carrier estimate ${money(selectedCostMinor, currency)}`)
      }
      if (checkoutChargeMinor !== null) {
        evidence.push(`checkout charge ${money(checkoutChargeMinor, currency)}`)
      }
      if (estimatedVarianceMinor !== null) {
        evidence.push(`estimated variance ${money(estimatedVarianceMinor, currency)}`)
      }

      setPlanOpen(false)
      setPlanPackagingWorkspace(null)
      setPlanShopifyAssignment(null)
      setPlanWarehouseGlobalId('')
      setPlanMaterialGlobalIds([])
      setPlanCartonizationEvidenceGlobalId('')
      setShadowTrainingPlanTarget(null)
      setPlanEvidenceIdempotencyKey('')
      setPlanIdempotencyKey('')
      setPlanError('')
      setNotice(
        `Order ${result.orderGlobalId} was planned from ${resultEvidenceGlobalId}`
        + `${evidence.length ? ` · ${evidence.join(' · ')}` : ''}. `
        + 'No label or shipment was created.',
      )
      await loadWorkspace(result.orderGlobalId)
    } catch (caught) {
      const message = caught instanceof Error
        ? caught.message
        : 'Order could not be planned'
      setPlanError(message)
      setError(message)
    } finally {
      setPlanningOrder(false)
    }
  }

  const openRelease = () => {
    setReleaseReason('Release the reviewed plan to warehouse execution')
    setReleaseIdempotencyKey(`operations-release:${detail?.globalId || 'order'}:${crypto.randomUUID()}`)
    setReleaseOpen(true)
  }

  const closeRelease = () => {
    if (releasingOrder) return
    setReleaseOpen(false)
    setReleaseIdempotencyKey('')
  }

  const releaseOrder = async (event: FormEvent) => {
    event.preventDefault()
    if (!detail || !releaseReason.trim() || !releaseIdempotencyKey) return
    setReleasingOrder(true)
    setError('')
    setNotice('')
    try {
      const response = await fetch('/api/operations', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': releaseIdempotencyKey,
        },
        body: JSON.stringify({
          action: 'release-order',
          orderGlobalId: detail.globalId,
          expectedRowVersion: detail.rowVersion,
          reason: releaseReason.trim(),
          sandboxE2eAuthorizationGlobalId:
            detail.sandboxCommerceE2eAuthorization?.authorityKind
              === 'shopify_test_store_canonical'
              ? detail.sandboxCommerceE2eAuthorization.authorizationGlobalId
              : undefined,
        }),
      })
      const payload = await response.json() as OperationsPayload
      if (!response.ok || !payload.result || !('orderGlobalId' in payload.result) || !('rowVersion' in payload.result)) {
        throw new Error(payload.error || 'Order could not be released')
      }
      setReleaseOpen(false)
      setReleaseIdempotencyKey('')
      setNotice(`Order ${payload.result.orderGlobalId} was released to warehouse execution.`)
      await loadWorkspace(payload.result.orderGlobalId)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Order could not be released')
    } finally {
      setReleasingOrder(false)
    }
  }

  const openReplanningCorrection = () => {
    const action = detail?.availableActions.find(
      (item) => item.action === 'reopen_for_replanning',
    )
    if (!detail || !action?.enabled) return
    setReplanningCorrectionReason('')
    setReplanningCorrectionConfirmed(false)
    setReplanningCorrectionIdempotencyKey(
      `operations-replanning:${detail.globalId}:${crypto.randomUUID()}`,
    )
    setReplanningCorrectionOpen(true)
  }

  const closeReplanningCorrection = () => {
    if (reopeningForReplanning) return
    setReplanningCorrectionOpen(false)
    setReplanningCorrectionReason('')
    setReplanningCorrectionConfirmed(false)
    setReplanningCorrectionIdempotencyKey('')
  }

  const reopenForReplanning = async (event: FormEvent) => {
    event.preventDefault()
    const action = detail?.availableActions.find(
      (item) => item.action === 'reopen_for_replanning',
    )
    const reason = replanningCorrectionReason.trim()
    if (
      !detail
      || !action?.enabled
      || !action.expectedPlanGlobalId
      || !Number.isSafeInteger(action.expectedPlanVersion)
      || !action.expectedCorrectionFingerprint
      || reason.length < 8
      || !replanningCorrectionConfirmed
      || !replanningCorrectionIdempotencyKey
    ) return
    setReopeningForReplanning(true)
    setError('')
    setNotice('')
    try {
      const response = await fetch('/api/operations', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': replanningCorrectionIdempotencyKey,
        },
        body: JSON.stringify({
          action: 'reopen-order-for-replanning',
          orderGlobalId: detail.globalId,
          expectedRowVersion: detail.rowVersion,
          expectedPlanGlobalId: action.expectedPlanGlobalId,
          expectedPlanVersion: action.expectedPlanVersion,
          expectedCorrectionFingerprint:
            action.expectedCorrectionFingerprint,
          reason,
        }),
      })
      const payload = await response.json().catch(() => ({})) as OperationsPayload
      if (
        !response.ok
        || !payload.result
        || !('correctionGlobalId' in payload.result)
        || payload.result.orderStatus !== 'imported'
      ) {
        throw new Error(
          `${payload.error || 'Order could not be reopened for replanning'}${
            payload.code ? ` [${payload.code}]` : ''
          }`,
        )
      }
      const result = payload.result as OperationsOrderReplanningCorrectionResult
      setReplanningCorrectionOpen(false)
      setReplanningCorrectionReason('')
      setReplanningCorrectionConfirmed(false)
      setReplanningCorrectionIdempotencyKey('')
      setNotice(
        `Order ${result.orderGlobalId} returned to Imported under correction ${
          result.correctionGlobalId
        }. Plan ${result.cancelledPlanGlobalId} was retained as cancelled; no carrier or storefront call was made.`,
      )
      await loadWorkspace(result.orderGlobalId)
    } catch (caught) {
      setError(caught instanceof Error
        ? caught.message
        : 'Order could not be reopened for replanning')
    } finally {
      setReopeningForReplanning(false)
    }
  }

  const openConfirmPicks = () => {
    setConfirmPicksReason('Confirm all ready pick tasks for the released wave')
    setConfirmPicksIdempotencyKey(`operations-picks:${detail?.globalId || 'order'}:${crypto.randomUUID()}`)
    setConfirmPicksOpen(true)
  }

  const closeConfirmPicks = () => {
    if (confirmingPicks) return
    setConfirmPicksOpen(false)
    setConfirmPicksIdempotencyKey('')
  }

  const confirmPicks = async (event: FormEvent) => {
    event.preventDefault()
    if (!detail || !confirmPicksReason.trim() || !confirmPicksIdempotencyKey) return
    setConfirmingPicks(true)
    setError('')
    setNotice('')
    try {
      const response = await fetch('/api/operations', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': confirmPicksIdempotencyKey,
        },
        body: JSON.stringify({
          action: 'confirm-picks',
          orderGlobalId: detail.globalId,
          expectedRowVersion: detail.rowVersion,
          reason: confirmPicksReason.trim(),
          sandboxE2eAuthorizationGlobalId:
            detail.sandboxCommerceE2eAuthorization?.authorityKind
              === 'shopify_test_store_canonical'
              ? detail.sandboxCommerceE2eAuthorization.authorizationGlobalId
              : undefined,
        }),
      })
      const payload = await response.json() as OperationsPayload
      if (!response.ok || !payload.result || !('orderGlobalId' in payload.result) || !('rowVersion' in payload.result)) {
        throw new Error(payload.error || 'Warehouse picks could not be confirmed')
      }
      setConfirmPicksOpen(false)
      setConfirmPicksIdempotencyKey('')
      setNotice(`All picks for order ${payload.result.orderGlobalId} were confirmed.`)
      await loadWorkspace(payload.result.orderGlobalId)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Warehouse picks could not be confirmed')
    } finally {
      setConfirmingPicks(false)
    }
  }

  const openExternalFulfillmentReconciliation = () => {
    setExternalFulfillmentReason(
      'Reconcile exact Shopify fulfillment and cancel stale unpicked warehouse work',
    )
    setExternalFulfillmentIdempotencyKey(
      `operations-shopify-external-fulfillment:${detail?.globalId || 'order'}:${crypto.randomUUID()}`,
    )
    setExternalFulfillmentOpen(true)
  }

  const closeExternalFulfillmentReconciliation = () => {
    if (reconcilingExternalFulfillment) return
    setExternalFulfillmentOpen(false)
    setExternalFulfillmentIdempotencyKey('')
  }

  const reconcileExternalFulfillment = async (event: FormEvent) => {
    event.preventDefault()
    if (
      !detail
      || !externalFulfillmentReason.trim()
      || !externalFulfillmentIdempotencyKey
    ) return
    setReconcilingExternalFulfillment(true)
    setError('')
    setNotice('')
    try {
      const response = await fetch('/api/operations', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': externalFulfillmentIdempotencyKey,
        },
        body: JSON.stringify({
          action: 'reconcile-external-fulfillment',
          orderGlobalId: detail.globalId,
          expectedRowVersion: detail.rowVersion,
          reason: externalFulfillmentReason.trim(),
        }),
      })
      const payload = await response.json() as OperationsPayload
      if (
        !response.ok
        || !payload.result
        || !('reconciliationGlobalId' in payload.result)
        || !('providerFulfillmentName' in payload.result)
      ) {
        throw new Error(
          payload.error || 'Shopify fulfillment could not be reconciled',
        )
      }
      setExternalFulfillmentOpen(false)
      setExternalFulfillmentIdempotencyKey('')
      setNotice(
        `Shopify ${payload.result.providerFulfillmentName} was reconciled as ${payload.result.reconciliationGlobalId}. Stale unpicked warehouse work was cancelled; ClawPilot made no Shopify write and sent no customer notification.`,
      )
      await loadWorkspace(payload.result.orderGlobalId)
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : 'Shopify fulfillment could not be reconciled',
      )
    } finally {
      setReconcilingExternalFulfillment(false)
    }
  }

  const openVerifyPack = () => {
    setVerifyPackReason('Verify the carton plan after all warehouse picks are complete')
    setVerifyPackIdempotencyKey(`operations-pack:${detail?.globalId || 'order'}:${crypto.randomUUID()}`)
    setVerifyPackOpen(true)
  }

  const closeVerifyPack = () => {
    if (verifyingPack) return
    setVerifyPackOpen(false)
    setVerifyPackIdempotencyKey('')
  }

  const verifyPack = async (event: FormEvent) => {
    event.preventDefault()
    if (!detail || !verifyPackReason.trim() || !verifyPackIdempotencyKey) return
    setVerifyingPack(true)
    setError('')
    setNotice('')
    try {
      const response = await fetch('/api/operations', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': verifyPackIdempotencyKey,
        },
        body: JSON.stringify({
          action: 'verify-pack',
          orderGlobalId: detail.globalId,
          expectedRowVersion: detail.rowVersion,
          reason: verifyPackReason.trim(),
          sandboxE2eAuthorizationGlobalId:
            detail.sandboxCommerceE2eAuthorization?.authorityKind
              === 'shopify_test_store_canonical'
              ? detail.sandboxCommerceE2eAuthorization.authorizationGlobalId
              : undefined,
        }),
      })
      const payload = await response.json() as OperationsPayload
      if (!response.ok || !payload.result || !('orderGlobalId' in payload.result) || !('rowVersion' in payload.result)) {
        throw new Error(payload.error || 'Packages could not be verified')
      }
      setVerifyPackOpen(false)
      setVerifyPackIdempotencyKey('')
      setNotice(`Packages for order ${payload.result.orderGlobalId} were verified. No label or shipment was created.`)
      await loadWorkspace(payload.result.orderGlobalId)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Packages could not be verified')
    } finally {
      setVerifyingPack(false)
    }
  }

  const openPrepareFulfillment = () => {
    setPrepareFulfillmentReason(
      'Rerate the exact sealed packages and retain zero-write Shadow evidence',
    )
    setPrepareFulfillmentIdempotencyKey(
      `operations-shadow-fulfillment:${detail?.globalId || 'order'}:${crypto.randomUUID()}`,
    )
    setPrepareFulfillmentOpen(true)
  }

  const closePrepareFulfillment = () => {
    if (preparingFulfillment) return
    setPrepareFulfillmentOpen(false)
    setPrepareFulfillmentIdempotencyKey('')
  }

  const prepareFulfillment = async (event: FormEvent) => {
    event.preventDefault()
    if (
      !detail
      || !prepareFulfillmentReason.trim()
      || !prepareFulfillmentIdempotencyKey
    ) return
    setPreparingFulfillment(true)
    setError('')
    setNotice('')
    try {
      const response = await fetch('/api/operations', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': prepareFulfillmentIdempotencyKey,
        },
        body: JSON.stringify({
          action: 'prepare-shipment-execution',
          orderGlobalId: detail.globalId,
          expectedRowVersion: detail.rowVersion,
          reason: prepareFulfillmentReason.trim(),
        }),
      })
      const payload = await response.json() as OperationsPayload
      if (
        !response.ok
        || !payload.result
        || !('fulfillmentExecutionGlobalId' in payload.result)
        || !('shipmentGroupGlobalId' in payload.result)
      ) {
        throw new Error(payload.error || 'Shadow shipment preparation failed')
      }
      const result = payload.result
      setPrepareFulfillmentOpen(false)
      setPrepareFulfillmentIdempotencyKey('')
      setNotice(
        `Shadow preparation ${result.fulfillmentExecutionGlobalId} stored `
        + `${result.packageCount} exact package${result.packageCount === 1 ? '' : 's'} `
        + `and ${result.providerAttempts.length} carrier attempt${result.providerAttempts.length === 1 ? '' : 's'}. `
        + 'No shipment, tracking number, label, postage, commerce write, or final packing slip was created.',
      )
      await loadWorkspace(result.orderGlobalId)
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : 'Shadow shipment preparation failed',
      )
    } finally {
      setPreparingFulfillment(false)
    }
  }

  const generatePackingSlip = async (packageGlobalId: string) => {
    if (!detail || generatingPackingSlipPackageId) return
    setGeneratingPackingSlipPackageId(packageGlobalId)
    setError('')
    setNotice('')
    try {
      const response = await fetch('/api/operations', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': (
            `operations-package-work-instruction-v1:${detail.globalId}:${packageGlobalId}:${detail.rowVersion}`
          ),
        },
        body: JSON.stringify({
          action: 'generate-packing-slip',
          orderGlobalId: detail.globalId,
          packageGlobalId,
          expectedRowVersion: detail.rowVersion,
          sandboxE2eAuthorizationGlobalId:
            detail.sandboxCommerceE2eAuthorization?.authorityKind
              === 'shopify_test_store_canonical'
              ? detail.sandboxCommerceE2eAuthorization.authorizationGlobalId
              : undefined,
        }),
      })
      const payload = await response.json() as OperationsPayload
      if (
        !response.ok
        || !payload.result
        || !('packingSlipArtifactGlobalId' in payload.result)
        || !('packageGlobalId' in payload.result)
      ) {
        throw new Error(payload.error || 'Pack Work Instruction could not be generated')
      }
      const result = payload.result
      setNotice(result.documentKind === 'pack_work_instruction'
        ? `Pack Work Instruction ${result.packingSlipArtifactGlobalId} was generated for package ${result.packageNumber}. It is provisional and no carrier action was performed.`
        : `Legacy pre-label packing list ${result.packingSlipArtifactGlobalId} was replayed for package ${result.packageNumber}. Generate the warned Pack Work Instruction with the current workflow.`)
      await loadWorkspace(result.orderGlobalId)
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : 'Pack Work Instruction could not be generated',
      )
    } finally {
      setGeneratingPackingSlipPackageId(null)
    }
  }

  const printPackingSlip = async (artifactGlobalId: string) => {
    if (!detail?.warehouseId || printingPackingSlipArtifactId) return
    setPrintingPackingSlipArtifactId(artifactGlobalId)
    setError('')
    setNotice('')
    try {
      const response = await fetch('/api/operations/print-jobs', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': `operations-package-packing-list-print:${artifactGlobalId}`,
        },
        body: JSON.stringify({
          action: 'enqueue-packing-slip-artifact',
          warehouseId: detail.warehouseId,
          sourceArtifactGlobalId: artifactGlobalId,
        }),
      })
      const payload = await response.json() as {
        ok?: boolean
        error?: string
        job?: { globalId?: string }
      }
      if (!response.ok || !payload.job?.globalId) {
        throw new Error(payload.error || 'Pack Work Instruction could not be queued for printing')
      }
      setNotice(
        `Pack Work Instruction ${artifactGlobalId} was queued as print job ${payload.job.globalId}.`,
      )
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : 'Pack Work Instruction could not be queued for printing',
      )
    } finally {
      setPrintingPackingSlipArtifactId(null)
    }
  }

  const printShippingLabel = async (labelGlobalId: string) => {
    if (!detail?.warehouseId || labelPrintBusyGlobalId) return
    setLabelPrintBusyGlobalId(labelGlobalId)
    setError('')
    setNotice('')
    try {
      const response = await fetch('/api/operations/print-jobs', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': `operations-shipping-label-print:${labelGlobalId}`,
        },
        body: JSON.stringify({
          action: 'enqueue-label',
          warehouseId: detail.warehouseId,
          sourceLabelGlobalId: labelGlobalId,
          media: 'label_4x6',
        }),
      })
      const payload = await response.json() as {
        ok?: boolean
        error?: string
        job?: { globalId?: string }
      }
      if (!response.ok || !payload.job?.globalId) {
        throw new Error(payload.error || 'Shipping label could not be queued for printing')
      }
      setNotice(
        `Shipping label ${labelGlobalId} was queued as print job ${payload.job.globalId}.`,
      )
      await loadWorkspace(detail.globalId)
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : 'Shipping label could not be queued for printing',
      )
    } finally {
      setLabelPrintBusyGlobalId(null)
    }
  }

  const openLabelReprint = (
    labelGlobalId: string,
    printJobGlobalId: string,
  ) => {
    setLabelReprintLabelGlobalId(labelGlobalId)
    setLabelReprintJobGlobalId(printJobGlobalId)
    setLabelReprintReason(
      `Reprint shipping label for order ${detail?.orderNumber || detail?.globalId || ''}`.trim(),
    )
    setLabelReprintIdempotencyKey(
      `operations-shipping-label-reprint:${printJobGlobalId}:${crypto.randomUUID()}`,
    )
    setLabelReprintOpen(true)
  }

  const retryShippingLabel = async (
    labelGlobalId: string,
    printJobGlobalId: string,
  ) => {
    if (!detail || labelPrintBusyGlobalId) return
    setLabelPrintBusyGlobalId(labelGlobalId)
    setError('')
    setNotice('')
    try {
      const response = await fetch('/api/operations/print-jobs', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': `operations-shipping-label-retry:${printJobGlobalId}:${crypto.randomUUID()}`,
        },
        body: JSON.stringify({
          action: 'retry-job',
          jobGlobalId: printJobGlobalId,
          reason: `Retry failed shipping label for order ${detail.orderNumber || detail.globalId}`,
        }),
      })
      const payload = await response.json() as {
        ok?: boolean
        error?: string
        job?: { globalId?: string }
      }
      if (!response.ok || !payload.job?.globalId) {
        throw new Error(payload.error || 'Shipping-label print job could not be retried')
      }
      setNotice(`Print job ${payload.job.globalId} was queued for another bounded attempt.`)
      await loadWorkspace(detail.globalId)
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : 'Shipping-label print job could not be retried',
      )
    } finally {
      setLabelPrintBusyGlobalId(null)
    }
  }

  const closeLabelReprint = () => {
    if (labelPrintBusyGlobalId) return
    setLabelReprintOpen(false)
    setLabelReprintLabelGlobalId('')
    setLabelReprintJobGlobalId('')
    setLabelReprintReason('')
    setLabelReprintIdempotencyKey('')
  }

  const reprintShippingLabel = async (event: FormEvent) => {
    event.preventDefault()
    if (
      !detail
      || !labelReprintLabelGlobalId
      || !labelReprintJobGlobalId
      || !labelReprintReason.trim()
      || !labelReprintIdempotencyKey
      || labelPrintBusyGlobalId
    ) return
    setLabelPrintBusyGlobalId(labelReprintLabelGlobalId)
    setError('')
    setNotice('')
    try {
      const response = await fetch('/api/operations/print-jobs', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': labelReprintIdempotencyKey,
        },
        body: JSON.stringify({
          action: 'reprint-job',
          jobGlobalId: labelReprintJobGlobalId,
          reason: labelReprintReason.trim(),
        }),
      })
      const payload = await response.json() as {
        ok?: boolean
        error?: string
        job?: { globalId?: string }
      }
      if (!response.ok || !payload.job?.globalId) {
        throw new Error(payload.error || 'Shipping label reprint could not be queued')
      }
      setNotice(
        `Shipping label ${labelReprintLabelGlobalId} was queued for reprint as ${payload.job.globalId}.`,
      )
      setLabelReprintOpen(false)
      setLabelReprintLabelGlobalId('')
      setLabelReprintJobGlobalId('')
      setLabelReprintReason('')
      setLabelReprintIdempotencyKey('')
      await loadWorkspace(detail.globalId)
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : 'Shipping label reprint could not be queued',
      )
    } finally {
      setLabelPrintBusyGlobalId(null)
    }
  }

  const openConfirmShipment = () => {
    setConfirmShipmentReason('Confirm the packed order and create shipment evidence')
    setCustomerNotificationOverride(null)
    setCustomerNotificationOverrideReason('')
    setConfirmShipmentIdempotencyKey(
      `operations-shipment:${detail?.globalId || 'order'}:${crypto.randomUUID()}`,
    )
    setConfirmShipmentOpen(true)
  }

  const closeConfirmShipment = () => {
    if (confirmingShipment) return
    setConfirmShipmentOpen(false)
    setConfirmShipmentIdempotencyKey('')
    setCustomerNotificationOverride(null)
    setCustomerNotificationOverrideReason('')
  }

  const confirmShipment = async (event: FormEvent) => {
    event.preventDefault()
    if (!detail || !confirmShipmentReason.trim() || !confirmShipmentIdempotencyKey) return
    setConfirmingShipment(true)
    setError('')
    setNotice('')
    try {
      const response = await fetch('/api/operations', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': confirmShipmentIdempotencyKey,
        },
        body: JSON.stringify({
          action: 'confirm-shipment',
          orderGlobalId: detail.globalId,
          expectedRowVersion: detail.rowVersion,
          reason: confirmShipmentReason.trim(),
          sandboxE2eAuthorizationGlobalId:
            detail.sandboxCommerceE2eAuthorization?.authorizationGlobalId,
          expectedNotificationPolicyRevision:
            detail.fulfillmentNotificationPolicy?.mode === 'clawpilot_explicit'
              ? detail.fulfillmentNotificationPolicy.revision
              : undefined,
          customerNotificationOverride:
            customerNotificationOverride === null
              ? undefined
              : customerNotificationOverride,
          customerNotificationOverrideReason:
            customerNotificationOverride === null
              ? undefined
              : customerNotificationOverrideReason.trim(),
        }),
      })
      const payload = await response.json() as OperationsPayload
      if (!response.ok || !payload.result || !('shipmentGlobalId' in payload.result)) {
        throw new Error(payload.error || 'Shipment could not be confirmed')
      }
      const result = payload.result
      const exportSummary = result.commerceExportState === 'succeeded'
        ? `Commerce fulfillment export ${result.commerceExportGlobalId} succeeded.`
        : result.commerceExportState === 'unsupported'
          ? `Commerce fulfillment export ${result.commerceExportGlobalId} is unsupported for this provider.`
          : `Commerce fulfillment export ${result.commerceExportGlobalId} did not complete immediately; its current status is shown below.`
      const printSummary = result.printWarning
        ? result.printWarning
        : result.printJobGlobalId
          ? `Print job ${result.printJobGlobalId} was routed.`
          : 'No print job was required.'
      setConfirmShipmentOpen(false)
      setConfirmShipmentIdempotencyKey('')
      setNotice(
        `Shipment ${result.shipmentGlobalId} was confirmed with tracking ${result.trackingNumber}. `
        + `Packing slip ${result.packingSlipArtifactGlobalId} was created. ${exportSummary} ${printSummary}`,
      )
      await loadWorkspace(result.orderGlobalId)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Shipment could not be confirmed')
    } finally {
      setConfirmingShipment(false)
    }
  }

  const openCommerceExportRetry = (
    commerceExportGlobalId: string,
    reconciliationPending: boolean,
  ) => {
    setCommerceExportRetryGlobalId(commerceExportGlobalId)
    setCommerceExportRetryReason(
      reconciliationPending
        ? 'Check the same immutable commerce fulfillment export while safe reconciliation is pending'
        : 'Retry the same immutable commerce fulfillment export after operator review',
    )
    setCommerceExportReconciliationPending(reconciliationPending)
    setCommerceExportRetryIdempotencyKey(
      `operations-commerce-export-retry:${commerceExportGlobalId}:${crypto.randomUUID()}`,
    )
    setCommerceExportRetryOpen(true)
  }

  const closeCommerceExportRetry = () => {
    if (retryingCommerceExport) return
    setCommerceExportRetryOpen(false)
    setCommerceExportRetryGlobalId('')
    setCommerceExportRetryIdempotencyKey('')
    setCommerceExportReconciliationPending(false)
  }

  const retryCommerceExport = async (event: FormEvent) => {
    event.preventDefault()
    if (
      !detail
      || !commerceExportRetryGlobalId
      || commerceExportRetryReason.trim().length < 10
      || !commerceExportRetryIdempotencyKey
    ) return
    setRetryingCommerceExport(true)
    setError('')
    setNotice('')
    try {
      const response = await fetch('/api/operations', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': commerceExportRetryIdempotencyKey,
        },
        body: JSON.stringify({
          action: 'retry-commerce-fulfillment-export',
          commerceExportGlobalId: commerceExportRetryGlobalId,
          reason: commerceExportRetryReason.trim(),
        }),
      })
      const payload = await response.json() as OperationsPayload
      if (
        !response.ok
        || !payload.result
        || !('commerceExportGlobalId' in payload.result)
        || !('state' in payload.result)
      ) {
        throw new Error(payload.error || 'Commerce fulfillment export could not be retried')
      }
      const result = payload.result as OperationsCommerceFulfillmentRetryResult
      setCommerceExportRetryOpen(false)
      setCommerceExportRetryGlobalId('')
      setCommerceExportRetryIdempotencyKey('')
      setCommerceExportReconciliationPending(false)
      setNotice(result.errorCode === COMMERCE_FULFILLMENT_RECONCILIATION_REQUIRED
        ? `Reconciliation remains pending for commerce fulfillment export ${result.commerceExportGlobalId}; its current status is shown below. The original immutable notification decision was preserved.`
        : `Commerce fulfillment export ${result.commerceExportGlobalId} finished with ${
          displayStatus(result.state)
        }. The original immutable notification decision was preserved.`)
      await loadWorkspace(detail.globalId)
    } catch (caught) {
      setError(caught instanceof Error
        ? caught.message
        : 'Commerce fulfillment export could not be retried')
    } finally {
      setRetryingCommerceExport(false)
    }
  }

  const openSandboxE2eAuthorization = () => {
    if (!detail) return
    pendingShopifyTestStoreAuthorization.current = null
    setSandboxE2eAuthorizationConfirmed(false)
    setSandboxE2eConfirmationText('')
    setSandboxE2eAuthorizationReason(
      `Authorized end-to-end validation for ${detail.sourceProvider === 'faire'
        ? 'Faire'
        : 'Shopify'} test order ${detail.orderNumber}`,
    )
    setSandboxE2eAuthorizationOpen(true)
  }

  const closeSandboxE2eAuthorization = () => {
    if (authorizingSandboxE2e) return
    pendingShopifyTestStoreAuthorization.current = null
    setSandboxE2eAuthorizationOpen(false)
    setSandboxE2eAuthorizationConfirmed(false)
    setSandboxE2eConfirmationText('')
  }

  const authorizeSandboxE2e = async (event: FormEvent) => {
    event.preventDefault()
    const canonicalShopifyTestLane = Boolean(
      detail?.sourceProvider === 'shopify',
    )
    if (
      !detail
      || (
        canonicalShopifyTestLane
          ? sandboxE2eConfirmationText
            !== SHOPIFY_TEST_STORE_CANONICAL_E2E_CONFIRMATION
          : !sandboxE2eAuthorizationConfirmed
      )
      || !sandboxE2eAuthorizationReason.trim()
    ) return
    setAuthorizingSandboxE2e(true)
    setError('')
    setNotice('')
    const canonicalCommand = canonicalShopifyTestLane
      ? pendingShopifyTestStoreAuthorization.current || {
          orderGlobalId: detail.globalId,
          expectedRowVersion: detail.rowVersion,
          confirmationStatement:
            SHOPIFY_TEST_STORE_CANONICAL_E2E_CONFIRMATION,
          reason: sandboxE2eAuthorizationReason.trim(),
          lifetimeMinutes: 120 as const,
          idempotencyKey:
            `shopify-test-store-authorize:${crypto.randomUUID()}`,
        }
      : null
    if (canonicalCommand) {
      pendingShopifyTestStoreAuthorization.current = canonicalCommand
    }
    try {
      const response = await fetch('/api/operations', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(canonicalCommand
            ? { 'Idempotency-Key': canonicalCommand.idempotencyKey }
            : {}),
        },
        body: JSON.stringify(canonicalCommand ? {
          action: 'authorize-shopify-test-store-canonical-e2e',
          orderGlobalId: canonicalCommand.orderGlobalId,
          expectedRowVersion: canonicalCommand.expectedRowVersion,
          confirmationStatement: canonicalCommand.confirmationStatement,
          reason: canonicalCommand.reason,
          lifetimeMinutes: canonicalCommand.lifetimeMinutes,
        } : {
          action: 'authorize-sandbox-commerce-e2e',
          orderGlobalId: detail.globalId,
          confirmationStatement: SANDBOX_COMMERCE_E2E_CONFIRMATION,
          reason: sandboxE2eAuthorizationReason.trim(),
          lifetimeMinutes: 120,
        }),
      })
      const payload = await response.json().catch(() => ({})) as OperationsPayload
      if (
        !response.ok
        || !payload.result
        || !('authorizationGlobalId' in payload.result)
      ) {
        throw new ShopifyTestStoreCommandHttpError(
          payload.error || 'Sandbox commerce E2E authorization failed',
          response.status,
          payload.code,
        )
      }
      const result = payload.result
      pendingShopifyTestStoreAuthorization.current = null
      setSandboxE2eAuthorizationOpen(false)
      setSandboxE2eAuthorizationConfirmed(false)
      setSandboxE2eConfirmationText('')
      setNotice(
        `Exact-order sandbox E2E authorization ${result.authorizationGlobalId} is active until ${result.expiresAt}.`,
      )
      await loadWorkspace(result.orderGlobalId)
    } catch (caught) {
      if (canonicalCommand) {
        const message = caught instanceof Error
          ? caught.message
          : 'Shopify test-store authorization failed'
        const refreshed = await loadWorkspace(canonicalCommand.orderGlobalId)
          .catch(() => null)
        const refreshedAuthorization =
          refreshed?.selectedOrder?.sandboxCommerceE2eAuthorization
        if (
          refreshedAuthorization?.authorityKind
            === 'shopify_test_store_canonical'
        ) {
          pendingShopifyTestStoreAuthorization.current = null
          setSandboxE2eAuthorizationOpen(false)
          setSandboxE2eConfirmationText('')
          setNotice(
            `The exact authorization response was reconciled. Authorization ${refreshedAuthorization.authorizationGlobalId} is current until ${refreshedAuthorization.expiresAt}.`,
          )
          setError('')
        } else if (
          caught instanceof ShopifyTestStoreCommandHttpError
          && caught.status < 500
        ) {
          pendingShopifyTestStoreAuthorization.current = null
          setError(
            `${message}${caught.code ? ` [${caught.code}]` : ''} Current order state was refreshed. Review it before authorizing again.`,
          )
        } else {
          setError(
            `${message} The response is uncertain; the exact authorization command is retained for retry.`,
          )
        }
      } else {
        setError(caught instanceof Error
          ? caught.message
          : 'Sandbox commerce E2E authorization failed')
      }
    } finally {
      setAuthorizingSandboxE2e(false)
    }
  }

  const openShopifyTestFulfillment = () => {
    if (!detail?.sandboxCommerceE2eAuthorization) return
    pendingShopifyTestStoreFulfillment.current = null
    setShopifyTestFulfillmentText('')
    setShopifyTestFulfillmentReason(
      `Reviewed the exact sandbox labels and tracking snapshot for Shopify test order ${detail.orderNumber}`,
    )
    setShopifyTestFulfillmentOpen(true)
  }

  const closeShopifyTestFulfillment = () => {
    if (confirmingShopifyTestFulfillment) return
    pendingShopifyTestStoreFulfillment.current = null
    setShopifyTestFulfillmentOpen(false)
    setShopifyTestFulfillmentText('')
  }

  const confirmShopifyTestFulfillment = async (event: FormEvent) => {
    event.preventDefault()
    const authorization = detail?.sandboxCommerceE2eAuthorization
    if (
      !detail
      || authorization?.authorityKind !== 'shopify_test_store_canonical'
      || shopifyTestFulfillmentText !== SHOPIFY_TEST_STORE_FULFILLMENT_CONFIRMATION
      || shopifyTestFulfillmentReason.trim().length < 8
    ) return
    setConfirmingShopifyTestFulfillment(true)
    setError('')
    setNotice('')
    const command = pendingShopifyTestStoreFulfillment.current || {
      authorizationGlobalId: authorization.authorizationGlobalId,
      orderGlobalId: detail.globalId,
      expectedRowVersion: detail.rowVersion,
      confirmationStatement: SHOPIFY_TEST_STORE_FULFILLMENT_CONFIRMATION,
      reason: shopifyTestFulfillmentReason.trim(),
      idempotencyKey: `shopify-test-store-fulfillment:${crypto.randomUUID()}`,
    }
    pendingShopifyTestStoreFulfillment.current = command
    try {
      const response = await fetch('/api/operations', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': command.idempotencyKey,
        },
        body: JSON.stringify({
          action: 'confirm-shopify-test-store-e2e-fulfillment',
          authorizationGlobalId: command.authorizationGlobalId,
          orderGlobalId: command.orderGlobalId,
          expectedRowVersion: command.expectedRowVersion,
          confirmationStatement: command.confirmationStatement,
          reason: command.reason,
        }),
      })
      const payload = await response.json().catch(() => ({})) as OperationsPayload
      if (
        !response.ok
        || !payload.result
        || !('authorizationGlobalId' in payload.result)
      ) {
        throw new ShopifyTestStoreCommandHttpError(
          payload.error || 'Shopify test fulfillment confirmation failed',
          response.status,
          payload.code,
        )
      }
      pendingShopifyTestStoreFulfillment.current = null
      setShopifyTestFulfillmentOpen(false)
      setShopifyTestFulfillmentText('')
      setNotice(
        'The exact sandbox label and tracking snapshot is confirmed. Shopify customer notification is locked off; Confirm shipment now requires this same evidence.',
      )
      await loadWorkspace(detail.globalId)
    } catch (caught) {
      const message = caught instanceof Error
        ? caught.message
        : 'Shopify test fulfillment confirmation failed'
      const refreshed = await loadWorkspace(command.orderGlobalId)
        .catch(() => null)
      const refreshedAuthorization =
        refreshed?.selectedOrder?.sandboxCommerceE2eAuthorization
      if (
        refreshedAuthorization?.authorityKind
          === 'shopify_test_store_canonical'
        && refreshedAuthorization.fulfillmentConfirmedAt
      ) {
        pendingShopifyTestStoreFulfillment.current = null
        setShopifyTestFulfillmentOpen(false)
        setShopifyTestFulfillmentText('')
        setNotice(
          'The exact fulfillment-confirmation response was reconciled. Customer notification remains locked off.',
        )
        setError('')
      } else if (
        caught instanceof ShopifyTestStoreCommandHttpError
        && caught.status < 500
      ) {
        pendingShopifyTestStoreFulfillment.current = null
        setError(
          `${message}${caught.code ? ` [${caught.code}]` : ''} Current order state was refreshed. Review the exact labels before confirming again.`,
        )
      } else {
        setError(
          `${message} The response is uncertain; the exact fulfillment-confirmation command is retained for retry.`,
        )
      }
    } finally {
      setConfirmingShopifyTestFulfillment(false)
    }
  }

  const openCreateLabel = (packageGlobalId?: string) => {
    const selectedRate = detail?.rates.find((rate) => rate.selected)
    const provider = selectedRate ? providerForCarrier(selectedRate.carrier) : null
    const account = workspace?.shipping?.sandboxCarrierAccounts.find(
      (item) => item.provider === provider,
    )
    setCarrierAccountGlobalId(account?.globalId || '')
    setCreateLabelPackageGlobalId(packageGlobalId || '')
    setCreateLabelReason(packageGlobalId
      ? `Create the authorized sandbox E2E label for package ${packageGlobalId}`
      : 'Purchase a sandbox label for pack-to-ship validation')
    setCreateLabelIdempotencyKey(
      `operations-label-create:${detail?.globalId || 'order'}:${packageGlobalId || 'single'}:${crypto.randomUUID()}`,
    )
    setCreateLabelOpen(true)
  }

  const closeCreateLabel = () => {
    if (creatingLabel) return
    setCreateLabelOpen(false)
    setCreateLabelIdempotencyKey('')
    setCarrierAccountGlobalId('')
    setCreateLabelPackageGlobalId('')
  }

  const createSandboxLabel = async (event: FormEvent) => {
    event.preventDefault()
    const selectedRate = detail?.rates.find((rate) => rate.selected)
    if (
      !detail
      || !selectedRate
      || !createLabelReason.trim()
      || !createLabelIdempotencyKey
      || !carrierAccountGlobalId
      || (createLabelPackageGlobalId && !detail.sandboxCommerceE2eAuthorization)
    ) return
    setCreatingLabel(true)
    setError('')
    setNotice('')
    try {
      const response = await fetch('/api/operations', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': createLabelIdempotencyKey,
        },
        body: JSON.stringify({
          action: 'create-sandbox-label',
          orderGlobalId: detail.globalId,
          expectedRowVersion: detail.rowVersion,
          reason: createLabelReason.trim(),
          carrierRateGlobalId: selectedRate.globalId,
          carrierAccountGlobalId,
          packageGlobalId: createLabelPackageGlobalId || undefined,
          sandboxE2eAuthorizationGlobalId: createLabelPackageGlobalId
            ? detail.sandboxCommerceE2eAuthorization?.authorizationGlobalId
            : undefined,
        }),
      })
      const payload = await response.json() as OperationsPayload
      if (!response.ok || !payload.result || !('labelGlobalId' in payload.result)) {
        throw new Error(payload.error || 'Sandbox label could not be created')
      }
      const result = payload.result
      setCreateLabelOpen(false)
      setCreateLabelIdempotencyKey('')
      setCarrierAccountGlobalId('')
      setCreateLabelPackageGlobalId('')
      setNotice(
        result.printWarning
          ? `Sandbox label ${result.labelGlobalId} was created with tracking ${result.trackingNumber}. ${result.printWarning}`
          : `Sandbox label ${result.labelGlobalId} was created with tracking ${result.trackingNumber}${result.printJobGlobalId ? ` and print job ${result.printJobGlobalId}` : ''}.`,
      )
      await loadWorkspace(result.orderGlobalId)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Sandbox label could not be created')
    } finally {
      setCreatingLabel(false)
    }
  }

  const openVoidLabel = () => {
    setVoidLabelReason('Void the sandbox label after validation')
    setVoidLabelIdempotencyKey(`operations-label-void:${detail?.globalId || 'order'}:${crypto.randomUUID()}`)
    setVoidLabelOpen(true)
  }

  const closeVoidLabel = () => {
    if (voidingLabel) return
    setVoidLabelOpen(false)
    setVoidLabelIdempotencyKey('')
  }

  const voidSandboxLabel = async (event: FormEvent) => {
    event.preventDefault()
    if (!detail || !voidLabelReason.trim() || !voidLabelIdempotencyKey) return
    setVoidingLabel(true)
    setError('')
    setNotice('')
    try {
      const response = await fetch('/api/operations', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': voidLabelIdempotencyKey,
        },
        body: JSON.stringify({
          action: 'void-sandbox-label',
          orderGlobalId: detail.globalId,
          expectedRowVersion: detail.rowVersion,
          reason: voidLabelReason.trim(),
        }),
      })
      const payload = await response.json() as OperationsPayload
      if (!response.ok || !payload.result || !('labelGlobalId' in payload.result)) {
        throw new Error(payload.error || 'Sandbox label could not be voided')
      }
      const result = payload.result
      setVoidLabelOpen(false)
      setVoidLabelIdempotencyKey('')
      setNotice(`Sandbox label ${result.labelGlobalId} and tracking ${result.trackingNumber} were voided.`)
      await loadWorkspace(result.orderGlobalId)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Sandbox label could not be voided')
    } finally {
      setVoidingLabel(false)
    }
  }

  const oneOffGroupPurchasePermissionsReady = () => Boolean(
    capabilities?.canManage
    && capabilities.canExecute
    && (
      detail?.oneOffShippingMode !== 'live'
      || capabilities.canPurchaseLivePostage === true
    )
  )

  const oneOffGroupVoidPermissionsReady = () => Boolean(
    capabilities?.canManage && capabilities.canExecute
  )

  const refreshOneOffPackedRates = async () => {
    if (
      !detail
      || !oneOffExecutionState
      || oneOffExecutionState.orderGlobalId !== detail.globalId
      || !oneOffGroupPurchasePermissionsReady()
    ) return
    setOneOffGroupAction('refresh')
    setOneOffExecutionError('')
    setError('')
    setNotice('')
    try {
      const requestIdempotencyKey = `operations-one-off-packed-rate:${detail.globalId}:${crypto.randomUUID()}`
      const response = await fetch('/api/operations/one-off-shipments', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': requestIdempotencyKey,
        },
        body: JSON.stringify({
          action: 'refresh-packed-rates',
          orderGlobalId: detail.globalId,
          expectedRowVersion: oneOffExecutionState.rowVersion,
        }),
      })
      const payload = await response.json().catch(() => ({})) as OneOffExecutionPayload
      if (
        !response.ok
        || !payload.ok
        || !payload.result
        || !('quote' in payload.result)
      ) {
        throw new Error(`${payload.error || 'Packed-group rates could not be refreshed'}${payload.code ? ` [${payload.code}]` : ''}`)
      }
      const result = payload.result
      setOneOffExecutionState((current) => current
        && current.orderGlobalId === result.orderGlobalId ? {
          ...current,
          rowVersion: result.rowVersion,
          packedRate: {
            quoteGlobalId: result.quote.globalId,
            requestIdempotencyKey,
            expiresAt: result.quote.expiresAt,
            status: result.quote.status,
            consumed: false,
            offers: result.quote.offers,
          },
        } : current)
      setNotice(
        `Fresh rates for all ${result.packageCount} packed parcels are ready. `
        + `${result.quote.offers.length} matching ${result.quote.offers.length === 1 ? 'offer expires' : 'offers expire'} at ${new Date(result.quote.expiresAt).toLocaleString()}.`,
      )
    } catch (caught) {
      setOneOffExecutionError(caught instanceof Error
        ? caught.message
        : 'Packed-group rates could not be refreshed')
    } finally {
      setOneOffGroupAction('')
    }
  }

  const openOneOffGroupPurchase = () => {
    if (
      !detail
      || oneOffExecutionState?.orderGlobalId !== detail.globalId
    ) return
    const offers = oneOffExecutionState?.packedRate?.offers || []
    const lowest = [...offers].sort((left, right) => left.amountMinor - right.amountMinor)[0]
    setOneOffGroupPurchaseOfferGlobalId(lowest?.globalId || '')
    setOneOffGroupPurchaseReason(
      `Purchase the reviewed fresh rate for all ${oneOffExecutionState?.packageCount || 0} exact packed parcels as one carrier shipment group`,
    )
    setOneOffGroupPurchaseConfirmed(false)
    setOneOffGroupPurchaseIdempotencyKey(
      `operations-one-off-group-purchase:${detail?.globalId || 'order'}:${crypto.randomUUID()}`,
    )
    setOneOffGroupPurchaseOpen(true)
  }

  const closeOneOffGroupPurchase = () => {
    if (oneOffGroupAction === 'purchase') return
    setOneOffGroupPurchaseOpen(false)
    setOneOffGroupPurchaseConfirmed(false)
    setOneOffGroupPurchaseIdempotencyKey('')
  }

  const purchaseOneOffCarrierGroup = async (event: FormEvent) => {
    event.preventDefault()
    const packedRate = oneOffExecutionState?.packedRate
    if (
      !detail
      || !oneOffExecutionState
      || oneOffExecutionState.orderGlobalId !== detail.globalId
      || !packedRate
      || packedRate.consumed
      || new Date(packedRate.expiresAt).getTime() <= Date.now()
      || !oneOffGroupPurchaseOfferGlobalId
      || !oneOffGroupPurchaseConfirmed
      || !oneOffGroupPurchaseIdempotencyKey
      || oneOffGroupPurchaseReason.trim().length < 10
      || !oneOffGroupPurchasePermissionsReady()
    ) return
    setOneOffGroupAction('purchase')
    setOneOffExecutionError('')
    setError('')
    setNotice('')
    try {
      const response = await fetch('/api/operations/one-off-shipments', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': oneOffGroupPurchaseIdempotencyKey,
        },
        body: JSON.stringify({
          action: 'purchase-group',
          orderGlobalId: detail.globalId,
          purchaseQuoteGlobalId: packedRate.quoteGlobalId,
          selectedOfferGlobalId: oneOffGroupPurchaseOfferGlobalId,
          expectedRowVersion: oneOffExecutionState.rowVersion,
          reason: oneOffGroupPurchaseReason.trim(),
          ...(detail.oneOffShippingMode === 'live'
            ? { confirmation: ONE_OFF_LIVE_POSTAGE_CONFIRMATION }
            : {}),
        }),
      })
      const payload = await response.json().catch(() => ({})) as OneOffExecutionPayload
      if (
        !response.ok
        || !payload.ok
        || !payload.result
        || !('groupAttemptGlobalId' in payload.result)
      ) {
        throw new Error(`${payload.error || 'The whole-shipment carrier group could not be purchased'}${payload.code ? ` [${payload.code}]` : ''}`)
      }
      const result = payload.result
      setOneOffGroupPurchaseOpen(false)
      setOneOffGroupPurchaseConfirmed(false)
      setOneOffGroupPurchaseIdempotencyKey('')
      const printWarnings = result.labels.filter((label) => label.printWarning).length
      setNotice(
        `${result.executionMode === 'live' ? 'LIVE' : 'TEST'} carrier group ${result.groupAttemptGlobalId} `
        + `returned all ${result.labels.length} package labels. Master tracking ${result.masterTrackingNumber}.`
        + (printWarnings ? ` ${printWarnings} print ${printWarnings === 1 ? 'job needs' : 'jobs need'} attention.` : ''),
      )
      await Promise.all([
        loadWorkspace(result.orderGlobalId),
        loadOneOffExecutionState(result.orderGlobalId),
      ])
    } catch (caught) {
      setOneOffExecutionError(caught instanceof Error
        ? caught.message
        : 'The whole-shipment carrier group could not be purchased')
    } finally {
      setOneOffGroupAction('')
    }
  }

  const openOneOffGroupVoid = () => {
    if (
      !detail
      || oneOffExecutionState?.orderGlobalId !== detail.globalId
    ) return
    const closeSample = oneOffExecutionState.carrierGroup?.lifecycleMode
      === 'local_sample_close'
    setOneOffGroupVoidReason(closeSample
      ? 'Close the complete UPS TEST sample group locally after validation with zero provider writes'
      : 'Void the exact complete one-off carrier shipment group before shipment confirmation')
    setOneOffGroupVoidIdempotencyKey(
      `operations-one-off-group-void:${detail?.globalId || 'order'}:${crypto.randomUUID()}`,
    )
    setOneOffGroupVoidOpen(true)
  }

  const closeOneOffGroupVoid = () => {
    if (oneOffGroupAction === 'void') return
    setOneOffGroupVoidOpen(false)
    setOneOffGroupVoidIdempotencyKey('')
  }

  const voidOneOffCarrierGroup = async (event: FormEvent) => {
    event.preventDefault()
    if (
      !detail
      || !oneOffExecutionState
      || oneOffExecutionState.orderGlobalId !== detail.globalId
      || !oneOffGroupVoidIdempotencyKey
      || oneOffGroupVoidReason.trim().length < 10
      || !oneOffGroupVoidPermissionsReady()
    ) return
    setOneOffGroupAction('void')
    setOneOffExecutionError('')
    setError('')
    setNotice('')
    try {
      const response = await fetch('/api/operations/one-off-shipments', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': oneOffGroupVoidIdempotencyKey,
        },
        body: JSON.stringify({
          action: 'void-group',
          orderGlobalId: detail.globalId,
          expectedRowVersion: oneOffExecutionState.rowVersion,
          reason: oneOffGroupVoidReason.trim(),
        }),
      })
      const payload = await response.json().catch(() => ({})) as OneOffExecutionPayload
      if (
        !response.ok
        || !payload.ok
        || !payload.result
        || !('groupAttemptGlobalId' in payload.result)
      ) {
        throw new Error(`${payload.error || 'The whole-shipment carrier group could not be cancelled'}${payload.code ? ` [${payload.code}]` : ''}`)
      }
      const result = payload.result
      setOneOffGroupVoidOpen(false)
      setOneOffGroupVoidIdempotencyKey('')
      setNotice(result.action === 'close_sample'
        ? `TEST carrier group ${result.groupAttemptGlobalId} was closed locally with all ${result.labels.length} labels retired and no carrier write.`
        : `Carrier group ${result.groupAttemptGlobalId} and all ${result.labels.length} package labels were voided together.`)
      await Promise.all([
        loadWorkspace(result.orderGlobalId),
        loadOneOffExecutionState(result.orderGlobalId),
      ])
    } catch (caught) {
      setOneOffExecutionError(caught instanceof Error
        ? caught.message
        : 'The whole-shipment carrier group could not be cancelled')
    } finally {
      setOneOffGroupAction('')
    }
  }

  const transitionException = async (nextStatus: OperationsExceptionStatus) => {
    if (!selectedExceptionGlobalId) return
    setUpdatingException(true)
    setError('')
    try {
      const response = await fetch('/api/operations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'update-exception',
          exceptionGlobalId: selectedExceptionGlobalId,
          status: nextStatus,
        }),
      })
      const payload = await response.json() as OperationsPayload
      if (!response.ok || !payload.result || !('exception' in payload.result)) {
        throw new Error(payload.error || 'Exception could not be updated')
      }
      const result = payload.result
      setWorkspace((current) => current ? {
        ...current,
        exceptions: current.exceptions.map((item) => (
          item.globalId === result.exception.globalId ? result.exception : item
        )),
      } : current)
      closeExceptionDrawer()
      await loadWorkspace()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Exception could not be updated')
    } finally {
      setUpdatingException(false)
    }
  }

  const acceptProviderOrderCancellation = async (
    command: ProviderOrderCancellationCommand,
  ) => {
    setUpdatingException(true)
    setError('')
    setNotice('')
    try {
      const response = await fetch('/api/operations', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': `operations-provider-cancel:${command.readGlobalId}`,
        },
        body: JSON.stringify({
          action: 'accept-provider-order-cancellation',
          ...command,
        }),
      })
      const payload = await response.json() as OperationsPayload
      if (
        !response.ok
        || !payload.result
        || !('dispositionGlobalId' in payload.result)
      ) {
        throw new Error(`${payload.error || 'Provider cancellation could not be accepted'}${payload.code ? ` [${payload.code}]` : ''}`)
      }
      const result = payload.result
      closeExceptionDrawer()
      setNotice(
        `${result.orderGlobalId} is cancelled from exact provider evidence (${result.dispositionGlobalId}). No provider write occurred.`,
      )
      await loadWorkspace()
    } catch (caught) {
      setError(caught instanceof Error
        ? caught.message
        : 'Provider cancellation could not be accepted')
    } finally {
      setUpdatingException(false)
    }
  }

  const commerceActiveIdempotencyKey = (phase: 'prepare' | 'activate') => (
    `operations-commerce-active-${phase}:${window.crypto.randomUUID()}`
  )

  const closeCommerceActive = () => {
    if (
      commerceActivePending === 'preparing'
      || commerceActivePending === 'activating'
    ) return
    setCommerceActiveOpen(false)
  }

  const openCommerceActiveWorkflow = async () => {
    if (!workspace || workspace.activation.state !== 'shadow') {
      setError('Operations must be in Shadow before provider writes can be activated.')
      return
    }
    setCommerceActiveOpen(true)
    setCommerceActivePending('loading')
    setCommerceActiveError('')
    setCommerceActiveAccounts([])
    setCommerceActiveSelections({})
    setCommerceActiveSelectionEvidence(null)
    setCommerceActivePreparation(null)
    setCommerceActiveConfirmed(false)
    setCommerceActivePrepareKey(commerceActiveIdempotencyKey('prepare'))
    setCommerceActiveActivateKey(commerceActiveIdempotencyKey('activate'))
    try {
      const response = await fetch('/api/integrations/commerce', {
        cache: 'no-store',
      })
      const payload = await response.json() as CommerceActiveCatalogPayload
      if (!response.ok || !payload.integrations || !payload.catalog) {
        throw new Error(payload.error || 'Commerce integration accounts are unavailable')
      }
      const accounts = commerceActiveAccountOptions(payload)
      if (accounts.length === 0) {
        throw new Error(
          'No verified Shopify or Faire account is available for provider-write review.',
        )
      }
      setCommerceActiveAccounts(accounts)
      const continuation =
        payload.integrations.commerceActiveContinuation || null
      const initialSelection = commerceActiveInitialSelection({
        accounts,
        continuation,
        expectedShadowActivationRevision: workspace.activation.revision,
      })
      setCommerceActiveSelections(initialSelection.selections)
      setCommerceActiveSelectionEvidence({
        continuation,
        preservationBlockers: initialSelection.preservationBlockers,
        preservedShopifyAccountCount:
          initialSelection.preservedShopifyAccountCount,
        preservedShopifyCapabilityCount:
          initialSelection.preservedShopifyCapabilityCount,
        faireDefaultedAccountCount:
          initialSelection.faireDefaultedAccountCount,
      })
    } catch (caught) {
      setCommerceActiveError(
        caught instanceof Error
          ? caught.message
          : 'Commerce integration accounts are unavailable',
      )
    } finally {
      setCommerceActivePending('')
    }
  }

  const editCommerceActiveSelection = (
    accountGlobalId: string,
    capability: CommerceActiveWriteCapability,
    selected: boolean,
  ) => {
    setCommerceActiveSelections((current) => {
      const capabilities = current[accountGlobalId] || []
      return {
        ...current,
        [accountGlobalId]: selected
          ? [...new Set([...capabilities, capability])].sort()
          : capabilities.filter((entry) => entry !== capability),
      }
    })
    setCommerceActivePreparation(null)
    setCommerceActiveConfirmed(false)
    setCommerceActiveError('')
    setCommerceActivePrepareKey(commerceActiveIdempotencyKey('prepare'))
    setCommerceActiveActivateKey(commerceActiveIdempotencyKey('activate'))
  }

  const returnToCommerceActiveSelection = () => {
    setCommerceActivePreparation(null)
    setCommerceActiveConfirmed(false)
    setCommerceActiveError('')
    setCommerceActivePrepareKey(commerceActiveIdempotencyKey('prepare'))
    setCommerceActiveActivateKey(commerceActiveIdempotencyKey('activate'))
  }

  const prepareCommerceActive = async () => {
    if (!workspace || workspace.activation.state !== 'shadow') {
      setCommerceActiveError(
        'Operations activation changed. Return to Shadow and restart this review.',
      )
      return
    }
    const selectedAccounts = commerceActiveAccounts.flatMap((account) => {
      const capabilities = commerceActiveSelections[account.accountGlobalId] || []
      return capabilities.length > 0
        ? [{ accountGlobalId: account.accountGlobalId, capabilities }]
        : []
    })
    if (selectedAccounts.length === 0) {
      setCommerceActiveError(
        'Select at least one provider-write capability before preparing the review.',
      )
      return
    }
    setCommerceActivePending('preparing')
    setCommerceActiveError('')
    try {
      const response = await fetch('/api/operations', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': commerceActivePrepareKey,
        },
        body: JSON.stringify({
          action: 'prepare-commerce-active-authorization',
          expectedActivationState: workspace.activation.state,
          expectedActivationRevision: workspace.activation.revision,
          selectedAccounts,
        }),
      })
      const payload = await response.json() as OperationsPayload
      if (
        !response.ok
        || !payload.result
        || !('preparationGlobalId' in payload.result)
      ) {
        throw new Error(payload.error || 'Active provider-write review could not be prepared')
      }
      setCommerceActivePreparation(payload.result)
      setCommerceActiveConfirmed(false)
    } catch (caught) {
      setCommerceActiveError(
        caught instanceof Error
          ? caught.message
          : 'Active provider-write review could not be prepared',
      )
    } finally {
      setCommerceActivePending('')
    }
  }

  const activateCommerce = async () => {
    if (!commerceActivePreparation || !commerceActiveConfirmed) return
    setCommerceActivePending('activating')
    setUpdatingActivation(true)
    setCommerceActiveError('')
    setError('')
    try {
      const response = await fetch('/api/operations', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': commerceActiveActivateKey,
        },
        body: JSON.stringify({
          action: 'activate-commerce-with-authorization',
          preparationGlobalId: commerceActivePreparation.preparationGlobalId,
          expectedCohortHash: commerceActivePreparation.cohortHash,
          confirmActiveProviderWrites: true,
          reason: commerceActiveReason.trim(),
        }),
      })
      const payload = await response.json() as OperationsPayload
      if (
        !response.ok
        || !payload.result
        || !('transition' in payload.result)
      ) {
        throw new Error(payload.error || 'Operations provider writes could not be activated')
      }
      const result = payload.result
      setCommerceActiveOpen(false)
      setNotice(
        `Operations is Active at revision ${result.transition.revision}. Authorization ${result.authorization.authorizationGlobalId} and transition ${result.transition.transitionGlobalId} preserve the exact reviewed provider-write cohort.`,
      )
      await loadWorkspace(selectedGlobalId)
    } catch (caught) {
      setCommerceActiveError(
        caught instanceof Error
          ? caught.message
          : 'Operations provider writes could not be activated',
      )
    } finally {
      setCommerceActivePending('')
      setUpdatingActivation(false)
    }
  }

  const updateActivation = async (state: Exclude<OperationsActivationState, 'active'>) => {
    if (!workspace || state === workspace.activation.state) return
    setUpdatingActivation(true)
    setError('')
    try {
      const response = await fetch('/api/operations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'update-activation',
          state,
          reason: `Changed from ${workspace.activation.state} in the Operations workbench`,
          expectedCurrentState: workspace.activation.state,
          expectedCurrentRevision: workspace.activation.revision,
        }),
      })
      const payload = await response.json() as OperationsPayload
      if (!response.ok || !payload.result || !('dataPipeline' in payload.result)) {
        throw new Error(payload.error || 'Operations activation could not be updated')
      }
      await loadWorkspace(selectedGlobalId)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Operations activation could not be updated')
    } finally {
      setUpdatingActivation(false)
    }
  }

  const requestActivationChange = (state: OperationsActivationState) => {
    if (!workspace || state === workspace.activation.state) return
    if (state === 'active') {
      void openCommerceActiveWorkflow()
      return
    }
    void updateActivation(state)
  }

  const updateStoreSync = async (
    accountGlobalId: string,
    desiredState: CommerceStoreSyncDesiredState,
  ) => {
    const control = workspace?.storeSync.find(
      (candidate) => candidate.accountGlobalId === accountGlobalId,
    )
    if (
      !workspace
      || !control
      || (desiredState === control.desiredState && control.explicitChoice)
    ) return
    const retainedCommand = pendingStoreSyncCommands.current.get(
      accountGlobalId,
    )
    if (retainedCommand && retainedCommand.desiredState !== desiredState) {
      setError(
        'A prior Store sync response is uncertain. Retry that exact change or reload before issuing a different change.',
      )
      return
    }
    const command: CommerceStoreSyncPendingCommand = retainedCommand || {
      accountGlobalId,
      desiredState,
      expectedDesiredState: control.desiredState,
      expectedRevision: control.revision,
      reason: desiredState === control.desiredState
        ? `Confirmed ${desiredState} as an independent Store sync choice in the Operations workbench`
        : `Changed Store sync from ${control.desiredState} to ${desiredState} in the Operations workbench`,
      idempotencyKey: `store-sync:${crypto.randomUUID()}`,
    }
    pendingStoreSyncCommands.current.set(accountGlobalId, command)
    setUpdatingStoreSyncAccount(accountGlobalId)
    setError('')
    try {
      const response = await fetch('/api/operations', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': command.idempotencyKey,
        },
        body: JSON.stringify({
          action: 'update-commerce-store-sync',
          accountGlobalId: command.accountGlobalId,
          desiredState: command.desiredState,
          expectedDesiredState: command.expectedDesiredState,
          expectedRevision: command.expectedRevision,
          reason: command.reason,
        }),
      })
      const payload = await response.json() as OperationsPayload
      if (!response.ok) {
        throw new CommerceStoreSyncHttpError(
          response.status,
          payload.error || 'Store sync could not be updated',
          payload.code,
        )
      }
      if (!payload.result || !('control' in payload.result)) {
        throw new Error(payload.error || 'Store sync could not be updated')
      }
      if (!commerceStoreSyncControlMatchesCommand(
        payload.result.control,
        command,
      )) {
        throw new Error('Store sync returned a response for a different command')
      }
      pendingStoreSyncCommands.current.delete(accountGlobalId)
      setNotice(
        `${payload.result.control.displayName} Store sync is ${payload.result.control.effectiveState}. ${payload.result.control.effectiveReasonLabel}`,
      )
      await loadWorkspace(selectedGlobalId)
    } catch (caught) {
      const refreshed = await loadWorkspace(selectedGlobalId).catch(() => null)
      const reconciled = refreshed?.storeSync.find(
        (candidate) => candidate.accountGlobalId === accountGlobalId,
      )
      const resolution = commerceStoreSyncPendingResolution(
        reconciled,
        command,
        caught,
      )
      if (resolution === 'applied' && reconciled) {
        pendingStoreSyncCommands.current.delete(accountGlobalId)
        setNotice(
          `${reconciled.displayName} Store sync is ${reconciled.effectiveState}. ${reconciled.effectiveReasonLabel}`,
        )
        setError('')
      } else if (resolution === 'definitive_rejection') {
        pendingStoreSyncCommands.current.delete(accountGlobalId)
        setError(
          `${caught instanceof Error ? caught.message : 'Store sync could not be updated'} Current Store sync state was refreshed. Review it before trying again.`,
        )
      } else {
        setError(
          `${caught instanceof Error ? caught.message : 'Store sync could not be updated'} The exact command is retained for retry.`,
        )
      }
    } finally {
      setUpdatingStoreSyncAccount('')
    }
  }

  const openCreatedOneOffShipment = async (result: {
    orderGlobalId: string
    packageCount: number
    createdProductGlobalIds: string[]
  }) => {
    setView('orders')
    setSearch('')
    setStatus('')
    setImportedDrawerOpen(false)
    setSelectedImportedGlobalId(null)
    setImportedOrderError('')
    setSelectedGlobalId(result.orderGlobalId)
    setDrawerOpen(true)
    setNotice(
      `One-off shipment ${result.orderGlobalId} was planned with ${result.packageCount} ${result.packageCount === 1 ? 'parcel' : 'parcels'}`
      + `${result.createdProductGlobalIds.length ? ` and ${result.createdProductGlobalIds.length} new ${result.createdProductGlobalIds.length === 1 ? 'product' : 'products'}` : ''}. `
      + 'No postage, label, tracking number, wave, or picker assignment was created.',
    )
    await loadWorkspace(result.orderGlobalId)
  }

  const commerceActiveSelectedAccountCount = Object.values(
    commerceActiveSelections,
  ).filter((entries) => entries.length > 0).length
  const commerceActiveSelectedCapabilityCount = Object.values(
    commerceActiveSelections,
  ).reduce((total, entries) => total + entries.length, 0)
  const capabilities = workspace?.capabilities
  const detail = workspace?.selectedOrder?.globalId === selectedGlobalId ? workspace.selectedOrder : null
  const importedDetail = workspace?.importedOrders.find(
    (order) => order.candidateGlobalId === selectedImportedGlobalId,
  ) || null
  const visibleImportedOrders = !status || status === 'imported'
    ? workspace?.importedOrders || []
    : []
  const visibleOrderCount = (workspace?.orders.length || 0) + visibleImportedOrders.length
  const planEvidenceValid = CARTONIZATION_EVIDENCE_GLOBAL_ID.test(
    planCartonizationEvidenceGlobalId.trim().toLowerCase(),
  )
  const detailSelectedRate = detail?.rates.find((rate) => rate.selected) || null
  const detailCreateLabelPackage = detail?.packages.find(
    (item) => item.globalId === createLabelPackageGlobalId,
  ) || null
  const detailSelectedProvider = detailSelectedRate
    ? providerForCarrier(detailSelectedRate.carrier)
    : null
  const eligibleSandboxCarrierAccounts = detailSelectedProvider
    ? workspace?.shipping?.sandboxCarrierAccounts.filter(
        (account) => account.provider === detailSelectedProvider,
      ) || []
    : []
  const detailNativeOneOff = detail?.sourceProvider === 'clawpilot_native'
    && Boolean(detail.oneOffShippingMode)
  const oneOffPackedOffers = oneOffExecutionState?.packedRate?.offers || []
  const oneOffGroupSelectedOffer = oneOffPackedOffers.find(
    (offer) => offer.globalId === oneOffGroupPurchaseOfferGlobalId,
  ) || null
  const oneOffPackedRateExpired = Boolean(
    oneOffExecutionState?.packedRate
    && new Date(oneOffExecutionState.packedRate.expiresAt).getTime() <= Date.now(),
  )
  const oneOffPackedRateConsumed = Boolean(oneOffExecutionState?.packedRate?.consumed)

  useEffect(() => {
    if (!drawerOpen || !detailNativeOneOff || !detail?.globalId) {
      setOneOffExecutionState(null)
      setOneOffExecutionError('')
      return
    }
    const controller = new AbortController()
    void loadOneOffExecutionState(detail.globalId, controller.signal)
    return () => controller.abort()
  }, [
    detail?.globalId,
    detail?.rowVersion,
    detailNativeOneOff,
    drawerOpen,
    loadOneOffExecutionState,
  ])

  const selectedException = workspace?.exceptions.find((item) => item.globalId === selectedExceptionGlobalId) || null
  const summary = workspace?.summary
  const empty = !loading && (
    view === 'orders'
      ? visibleOrderCount === 0
      : view === 'exceptions'
        ? workspace?.exceptions.length === 0
        : false
  )
  const mainWorkspaceView = view === 'orders' || view === 'exceptions'
  const heading = view === 'carrier-invoices'
    ? 'Carrier invoicing'
    : view === 'gl-coding'
      ? 'Shipment pricing & GL'
    : view === 'printing'
      ? 'Print orchestration'
      : view === 'imports'
        ? 'Commerce imports'
      : view === 'receiving'
        ? 'Inbound receiving'
      : view === 'warehouses'
        ? 'Warehouse network'
      : view === 'packaging-materials'
        ? 'Packaging materials'
      : view === 'replays'
        ? 'Pack & rate replay'
      : view === 'picking'
        ? 'Picking control'
      : 'Order Workbench'
  const subheading = view === 'carrier-invoices'
    ? 'Import carrier bills and preserve account, shipment-match, and actual-cost evidence'
    : view === 'gl-coding'
      ? 'Assign charges to the responsible shipper, review MUD pricing, and approve reconciliation and GL outputs'
    : view === 'printing'
      ? 'Warehouse printers, document media, defaults, and fallbacks'
      : view === 'imports'
        ? 'Review Shopify and Faire products, orders, and import issues before they enter Operations'
      : view === 'receiving'
        ? 'Expected receipts, inspection, directed putaway, and inventory ledger posting'
      : view === 'warehouses'
        ? 'Facilities, inbound staging, storage bins, fulfillment locations, and returns'
      : view === 'packaging-materials'
        ? 'Cartons, mailers, warehouse stock, reorder readiness, and optimizer evidence'
      : view === 'replays'
        ? 'Replay historical orders through checkout estimation and fulfillment execution using recorded carrier responses'
      : view === 'picking'
        ? 'Current picker assignments, evidence progress, manager interventions, and completed work'
      : `Distributed fulfillment${workspace ? ` · CRM: ${workspace.dataPipeline.name}` : ''}`

  return (
    <Box
      data-testid="operations-workbench"
      sx={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        minWidth: 0,
        overflowX: 'hidden',
        overflowY: mainWorkspaceView ? { xs: 'auto', md: 'hidden' } : 'hidden',
        WebkitOverflowScrolling: 'touch',
        overscrollBehaviorY: 'contain',
      }}
    >
      <Box sx={{ px: { xs: 2, md: 3 }, pt: { xs: 2, md: 2.5 }, pb: 1.5, borderBottom: '1px solid rgba(255,255,255,0.07)', flexShrink: 0 }}>
        <Stack direction={{ xs: 'column', sm: 'row' }} justifyContent="space-between" alignItems={{ xs: 'stretch', sm: 'center' }} gap={1.5}>
          <Box>
            <Stack direction="row" spacing={1} alignItems="center">
              <Typography variant="h5" fontWeight={700}>{heading}</Typography>
              {LEGACY_COMMERCE_ACTIVATION_UI_VISIBLE
                && mainWorkspaceView
                && workspace && (
                <Chip
                  size="small"
                  label={displayStatus(workspace.activation.state)}
                  color={workspace.activation.state === 'active' ? 'success' : workspace.activation.state === 'shadow' ? 'info' : 'default'}
                  variant="outlined"
                />
              )}
            </Stack>
            <Typography variant="body2" color="text.secondary">{subheading}</Typography>
          </Box>
          <Stack direction="row" spacing={1} alignItems="center" sx={{ flexWrap: 'wrap', rowGap: 1 }}>
            {view === 'orders'
              && workspace?.capabilities.canManage
              && workspace.capabilities.canExecute && (
              <Button
                size="small"
                variant="contained"
                startIcon={<AddRounded />}
                onClick={() => setOneOffShipmentOpen(true)}
              >
                Create one-off shipment
              </Button>
            )}
            <Tooltip title="Operations guide"><IconButton aria-label="Open operations guide" onClick={() => setGuideOpen(true)}><HelpOutlineRounded /></IconButton></Tooltip>
            {mainWorkspaceView && (
              <Tooltip title="Refresh orders"><span><IconButton aria-label="Refresh operations" disabled={loading} onClick={() => void loadWorkspace(selectedGlobalId)}><RefreshRounded /></IconButton></span></Tooltip>
            )}
          </Stack>
        </Stack>

        {mainWorkspaceView && workspace && workspace.storeSync.length > 0 && (
          <Stack
            data-testid="commerce-store-sync-summary"
            spacing={1}
            sx={{ mt: 2 }}
          >
            <Typography variant="overline" color="text.secondary">
              Store sync · new provider catalog, order, image, and inventory
              mirroring; existing mirrored data remains available
            </Typography>
            {workspace.storeSync.map((control) => (
              <Stack
                key={control.accountGlobalId}
                data-testid={`commerce-store-sync-${control.accountGlobalId}`}
                direction={{ xs: 'column', sm: 'row' }}
                alignItems={{ xs: 'stretch', sm: 'center' }}
                justifyContent="space-between"
                gap={1}
                sx={{
                  border: '1px solid rgba(255,255,255,0.09)',
                  borderRadius: 1.5,
                  px: 1.5,
                  py: 1.25,
                  minWidth: 0,
                }}
              >
                <Box sx={{ minWidth: 0 }}>
                  <Stack direction="row" gap={0.75} alignItems="center" flexWrap="wrap">
                    <Typography variant="body2" fontWeight={700}>
                      {control.displayName}
                    </Typography>
                    <Chip
                      size="small"
                      variant="outlined"
                      label={`${displayStatus(control.provider)} · ${displayStatus(control.environment)}`}
                    />
                  </Stack>
                  <Typography
                    variant="caption"
                    color="text.secondary"
                    sx={{ display: 'block', mt: 0.25 }}
                  >
                    Desired: {displayStatus(control.desiredState)} · Effective: {displayStatus(control.effectiveState)}
                    {' · '}{control.explicitChoice ? 'Independent choice' : 'Legacy-derived default'}
                  </Typography>
                  <Typography
                    variant="caption"
                    color={control.effectiveState === 'running' ? 'success.light' : 'warning.light'}
                    sx={{ display: 'block' }}
                  >
                    {control.effectiveReason}: {control.effectiveReasonLabel}
                  </Typography>
                </Box>
                <Stack gap={0.75} sx={{ minWidth: { xs: '100%', sm: 180 } }}>
                  <TextField
                    select
                    size="small"
                    label="Desired Store sync"
                    value={control.desiredState}
                    onChange={(event) => void updateStoreSync(
                      control.accountGlobalId,
                      event.target.value as CommerceStoreSyncDesiredState,
                    )}
                    disabled={
                      !workspace.capabilities.canActivate
                      || updatingStoreSyncAccount === control.accountGlobalId
                    }
                    inputProps={{
                      'aria-label': `${control.displayName} desired Store sync`,
                    }}
                    sx={{ ...controlSx, minWidth: { xs: '100%', sm: 180 } }}
                  >
                    <MenuItem value="running">Running</MenuItem>
                    <MenuItem value="paused">Paused</MenuItem>
                  </TextField>
                  {!control.explicitChoice && (
                    <Button
                      size="small"
                      variant="outlined"
                      disabled={
                        !workspace.capabilities.canActivate
                        || updatingStoreSyncAccount === control.accountGlobalId
                      }
                      onClick={() => void updateStoreSync(
                        control.accountGlobalId,
                        control.desiredState,
                      )}
                    >
                      Make independent
                    </Button>
                  )}
                </Stack>
              </Stack>
            ))}
          </Stack>
        )}

        {LEGACY_COMMERCE_ACTIVATION_UI_VISIBLE
          && mainWorkspaceView
          && workspace?.capabilities.canActivate && (
          <Stack
            data-testid="operations-advanced-safety"
            direction={{ xs: 'column', sm: 'row' }}
            alignItems={{ xs: 'stretch', sm: 'center' }}
            justifyContent="space-between"
            gap={1}
            sx={{ mt: 1.5 }}
          >
            <Box>
              <Typography variant="caption" fontWeight={700}>
                Advanced safety · legacy execution profile
              </Typography>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                Disabled and Frozen override automatic commerce mirroring and
                activation-gated connected-order execution. Shadow, Read only,
                and Active no longer determine Store sync after an independent
                choice; existing mirrored data and local evidence remain viewable.
              </Typography>
            </Box>
            <TextField
              select
              size="small"
              label="Advanced safety"
              value={workspace.activation.state}
              onChange={(event) => requestActivationChange(
                event.target.value as OperationsActivationState,
              )}
              disabled={updatingActivation}
              inputProps={{ 'aria-label': 'Advanced Operations safety mode' }}
              SelectProps={{
                renderValue: (selected) => ACTIVATION_OPTIONS.find(
                  (option) => option.value === selected,
                )?.label || displayStatus(String(selected)),
                MenuProps: {
                  variant: 'menu',
                  anchorOrigin: { vertical: 'bottom', horizontal: 'right' },
                  transformOrigin: { vertical: 'top', horizontal: 'right' },
                  marginThreshold: 12,
                  disablePortal: false,
                  PaperProps: {
                    sx: {
                      mt: 0.75,
                      width: 'min(340px, calc(100vw - 24px))',
                      maxHeight: 'min(360px, calc(100dvh - 24px))',
                      overflowY: 'auto',
                      overscrollBehavior: 'contain',
                    },
                  },
                  MenuListProps: {
                    'aria-label': 'Advanced Operations safety statuses',
                    sx: { p: 0.5 },
                  },
                },
              }}
              sx={{ ...controlSx, minWidth: { xs: '100%', sm: 180 } }}
            >
              {ACTIVATION_OPTIONS.map((option) => (
                <MenuItem
                  key={option.value}
                  value={option.value}
                  disabled={
                    option.value === 'active'
                    && workspace.activation.state !== 'shadow'
                    && workspace.activation.state !== 'active'
                  }
                  sx={{
                    minHeight: 58,
                    alignItems: 'flex-start',
                    borderRadius: 1,
                    px: 1.25,
                    py: 1,
                    whiteSpace: 'normal',
                  }}
                >
                  <Box sx={{ minWidth: 0 }}>
                    <Typography variant="body2" fontWeight={700}>
                      {option.label}
                    </Typography>
                    <Typography
                      variant="caption"
                      color="text.secondary"
                      sx={{ display: 'block', lineHeight: 1.35 }}
                    >
                      {option.description}
                    </Typography>
                  </Box>
                </MenuItem>
              ))}
            </TextField>
          </Stack>
        )}

        {mainWorkspaceView && summary && (
          <Box sx={{ display: 'flex', flexWrap: 'wrap', columnGap: { xs: 2, sm: 3.5 }, rowGap: 0.25, mt: 2 }}>
            {metric('Open orders', summary.openOrders)}
            {metric('Exceptions', summary.exceptions, summary.exceptions ? '#EF9A9A' : 'text.primary')}
            {metric('Due soon', summary.dueSoon, summary.dueSoon ? '#FFB74D' : 'text.primary')}
            {metric('Shipped today', summary.shippedToday, '#81C784')}
            {metric('Available units', summary.availableUnits)}
            {metric('Reserved units', summary.reservedUnits)}
            {metric('Unbilled', money(summary.unbilledMinor))}
          </Box>
        )}
        <Box
          data-testid="operations-tab-navigation"
          onClickCapture={pageOperationsTabs}
          sx={{ mt: 1.25, minWidth: 0, maxWidth: '100%', overflow: 'hidden' }}
        >
          <Tabs
            value={view}
            onChange={(_, next:
              OperationsView) => {
              setView(next)
              setSearch('')
              closeDrawer()
              if (!savingImportedOrder) {
                setImportedDrawerOpen(false)
                setSelectedImportedGlobalId(null)
                setImportedOrderError('')
              }
              closeExceptionDrawer()
              window.location.hash = next === 'orders'
                ? 'operations'
                : `operations/${next}`
            }}
            variant="scrollable"
            scrollButtons="auto"
            allowScrollButtonsMobile
            slots={{ scrollButtons: OperationsTabScrollButton }}
            aria-label="Operations workbench view"
            sx={{
              width: '100%',
              minWidth: 0,
              minHeight: 42,
              '& .MuiTabs-scroller': {
                overscrollBehaviorX: 'contain',
                touchAction: 'pan-x',
              },
              '& .MuiTab-root': {
                flexShrink: 0,
                minWidth: 'max-content',
                minHeight: 42,
                maxWidth: 'none',
                px: { xs: 1.5, sm: 2 },
                whiteSpace: 'nowrap',
              },
              '@media (min-width:600px) and (max-width:899.95px)': {
                '& .MuiTab-root': {
                  px: 0.75,
                  fontSize: '0.72rem',
                },
                '& .MuiTab-iconWrapper': {
                  display: 'none',
                },
              },
              '& .MuiTabs-scrollButtons': {
                alignSelf: 'stretch',
                width: { xs: 36, sm: 40 },
                minWidth: { xs: 36, sm: 40 },
                borderRadius: 0,
                color: '#A8C7FA',
                backgroundColor: '#111118',
                '&:hover': { backgroundColor: '#1B1B24' },
                '&.Mui-disabled': {
                  opacity: 0.32,
                  color: 'text.disabled',
                },
                '&.Mui-focusVisible': {
                  outline: '2px solid #A8C7FA',
                  outlineOffset: -2,
                },
              },
            }}
          >
            <Tab value="orders" label={`Orders${workspace ? ` (${visibleOrderCount})` : ''}`} />
            <Tab
              value="picking"
              icon={<AssignmentIndRounded fontSize="small" />}
              iconPosition="start"
              label="Picking"
            />
            <Tab value="exceptions" label={`Exceptions${workspace ? ` (${workspace.summary.exceptions})` : ''}`} />
            <Tab
              value="imports"
              icon={<ImportExportRounded fontSize="small" />}
              iconPosition="start"
              label="Commerce imports"
            />
            <Tab
              value="receiving"
              icon={<MoveToInboxRounded fontSize="small" />}
              iconPosition="start"
              label={`Receiving${workspace ? ` (${workspace.inboundReceipts?.length || 0})` : ''}`}
            />
            <Tab value="warehouses" icon={<WarehouseRounded fontSize="small" />} iconPosition="start" label="Warehouses" />
            <Tab value="packaging-materials" icon={<Inventory2Rounded fontSize="small" />} iconPosition="start" label="Packaging materials" />
            <Tab value="replays" icon={<ScienceRounded fontSize="small" />} iconPosition="start" label="Pack & rate replay" />
            <Tab value="carrier-invoices" label="Carrier invoicing" />
            <Tab value="gl-coding" label="Shipment pricing & GL" />
            <Tab value="printing" icon={<PrintRounded fontSize="small" />} iconPosition="start" label="Printing" />
          </Tabs>
        </Box>
      </Box>

      {mainWorkspaceView && (
        <Box sx={{ px: { xs: 2, md: 3 }, py: 1.5, display: 'flex', flexWrap: 'wrap', gap: 1.25, flexShrink: 0 }}>
          <TextField
            size="small"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={view === 'orders' ? 'Search order, Global ID, or customer' : 'Search exception, order, or customer'}
            inputProps={{ 'aria-label': view === 'orders' ? 'Search operations orders' : 'Search operations exceptions' }}
            InputProps={{ startAdornment: <InputAdornment position="start"><SearchRounded fontSize="small" /></InputAdornment> }}
            sx={{ ...controlSx, flex: '1 1 280px', maxWidth: 440 }}
          />
          {view === 'orders' ? (
            <TextField
              select
              size="small"
              value={status}
              onChange={(event) => setStatus(event.target.value as '' | OperationsOrderStatus)}
              inputProps={{ 'aria-label': 'Filter orders by status' }}
              sx={{ ...controlSx, flex: '0 1 180px', minWidth: 150 }}
            >
              {ORDER_STATUSES.map((option) => <MenuItem key={option.value || 'all'} value={option.value}>{option.label}</MenuItem>)}
            </TextField>
          ) : (
            <TextField
              select
              size="small"
              value={exceptionStatus}
              onChange={(event) => setExceptionStatus(event.target.value as '' | OperationsExceptionStatus)}
              inputProps={{ 'aria-label': 'Filter exceptions by status' }}
              sx={{ ...controlSx, flex: '0 1 210px', minWidth: 180 }}
            >
              {EXCEPTION_STATUSES.map((option) => <MenuItem key={option.value || 'all'} value={option.value}>{option.label}</MenuItem>)}
            </TextField>
          )}
        </Box>
      )}

      {mainWorkspaceView && error && <Alert severity="error" onClose={() => setError('')} sx={{ mx: { xs: 2, md: 3 }, mb: 1.5 }}>{error}</Alert>}
      {mainWorkspaceView && notice && <Alert severity="success" onClose={() => setNotice('')} sx={{ mx: { xs: 2, md: 3 }, mb: 1.5 }}>{notice}</Alert>}
      {mainWorkspaceView && !loading && workspace && !workspace.configured && (
        <Alert severity="info" sx={{ mx: { xs: 2, md: 3 }, mb: 1.5 }}>Connect an approved commerce provider and configure an active warehouse to begin importing orders.</Alert>
      )}
      {(view === 'receiving' || view === 'warehouses') && error && (
        <Alert severity="error" onClose={() => setError('')} sx={{ mx: { xs: 2, md: 3 }, mt: 1.5 }}>
          {error}
        </Alert>
      )}

      <Box
        data-testid="operations-workspace-content"
        sx={mainWorkspaceView
          ? {
              flex: { xs: '0 0 auto', md: 1 },
              minHeight: { xs: 'auto', md: 0 },
              overflow: { xs: 'visible', md: 'auto' },
              WebkitOverflowScrolling: 'touch',
            }
          : {
              flex: 1,
              minHeight: 0,
              overflow: 'auto',
              WebkitOverflowScrolling: 'touch',
            }}
      >
        {view === 'picking' ? (
          <PickManagementPanel
            canManage={Boolean(workspace?.capabilities.canManage)}
            canExecute={Boolean(
              workspace?.capabilities.canManage
              && workspace.capabilities.canExecute
            )}
            onOpenOrder={openPickingOrder}
          />
        ) : view === 'imports' ? (
          <CommerceImportsPanel onOpenOrder={openPickingOrder} />
        ) : view === 'receiving' ? (
          <ReceivingPanel workspace={workspace} onRefresh={async () => {
            await loadWorkspace()
          }} />
        ) : view === 'warehouses' ? (
          <WarehouseSetupPanel
            workspace={workspace}
            onRefresh={async () => {
              await loadWorkspace()
            }}
            onNavigate={(next) => setView(next)}
          />
        ) : view === 'packaging-materials' ? (
          <PackagingMaterialsPanel />
        ) : view === 'replays' ? (
          <PackRateReplayPanel />
        ) : view === 'carrier-invoices' ? (
          <GlCodingPanel mode="carrier-invoices" />
        ) : view === 'gl-coding' ? (
          <GlCodingPanel mode="shipment-pricing" />
        ) : view === 'printing' ? (
          <PrinterConfigurationPanel />
        ) : loading && !workspace ? (
          <Box sx={{ height: '100%', display: 'grid', placeItems: 'center' }}><CircularProgress size={30} /></Box>
        ) : empty ? (
          <Box sx={{ py: 10, px: 3, textAlign: 'center' }}>
            {view === 'orders'
              ? <Inventory2Rounded sx={{ fontSize: 36, color: 'text.disabled' }} />
              : <WarningAmberRounded sx={{ fontSize: 36, color: 'text.disabled' }} />}
            <Typography sx={{ mt: 1 }} fontWeight={600}>No matching {view}</Typography>
          </Box>
        ) : view === 'exceptions' && mobile ? (
          <Stack divider={<Divider flexItem />}>
            {workspace?.exceptions.map((exception) => (
              <Box
                key={exception.globalId}
                component="button"
                type="button"
                onClick={() => chooseException(exception)}
                sx={{
                  appearance: 'none', border: 0, background: 'transparent', color: 'inherit', textAlign: 'left',
                  px: 2, py: 1.75, width: '100%', cursor: 'pointer',
                  '&:active': { backgroundColor: 'rgba(168,199,250,0.08)' },
                }}
              >
                <Stack direction="row" justifyContent="space-between" alignItems="flex-start" gap={1.5}>
                  <Box sx={{ minWidth: 0 }}>
                    <Typography fontWeight={700}>{exception.title}</Typography>
                    <Typography variant="body2" color="text.secondary" noWrap>{exception.customerName || exception.orderNumber || displayStatus(exception.exceptionType)}</Typography>
                  </Box>
                  <Chip size="small" label={displayStatus(exception.severity)} color={severityColor(exception.severity)} />
                </Stack>
                <Stack direction="row" justifyContent="space-between" alignItems="flex-end" gap={1.5} sx={{ mt: 1.25 }}>
                  <Box sx={{ minWidth: 0 }}>
                    <Typography variant="caption" color="#A8C7FA">{exception.globalId}</Typography>
                    <Typography variant="caption" color="text.secondary" display="block" noWrap>{exception.orderNumber ? `Order ${exception.orderNumber}` : 'No order linked'}</Typography>
                  </Box>
                  <Chip size="small" label={displayStatus(exception.status)} color={exceptionStatusColor(exception.status)} />
                </Stack>
              </Box>
            ))}
          </Stack>
        ) : view === 'exceptions' ? (
          <TableContainer sx={{ height: '100%' }}>
            <Table stickyHeader size="small" aria-label="Operations exceptions">
              <TableHead>
                <TableRow>
                  <TableCell>Severity</TableCell><TableCell>Exception</TableCell><TableCell>Order</TableCell><TableCell>Customer</TableCell><TableCell>Status</TableCell><TableCell>Updated</TableCell><TableCell padding="checkbox" />
                </TableRow>
              </TableHead>
              <TableBody>
                {workspace?.exceptions.map((exception) => (
                  <TableRow key={exception.globalId} hover onClick={() => chooseException(exception)} sx={{ cursor: 'pointer' }}>
                    <TableCell><Chip size="small" label={displayStatus(exception.severity)} color={severityColor(exception.severity)} /></TableCell>
                    <TableCell><Typography fontWeight={600}>{exception.title}</Typography><Typography variant="caption" color="#A8C7FA">{exception.globalId} · {displayStatus(exception.exceptionType)}</Typography></TableCell>
                    <TableCell>{exception.orderNumber || '—'}</TableCell>
                    <TableCell><Typography>{exception.customerName || '—'}</Typography>{exception.customerGlobalId && <Typography variant="caption" color="text.secondary">{exception.customerGlobalId}</Typography>}</TableCell>
                    <TableCell><Chip size="small" label={displayStatus(exception.status)} color={exceptionStatusColor(exception.status)} /></TableCell>
                    <TableCell>{formatUserDateTime(exception.updatedAt, dateTime, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', fallback: '—' })}</TableCell>
                    <TableCell padding="checkbox"><Tooltip title="Open exception"><IconButton size="small" aria-label={`Open exception ${exception.globalId}`}><OpenInNewRounded fontSize="small" /></IconButton></Tooltip></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        ) : mobile ? (
          <Stack divider={<Divider flexItem />}>
            {visibleImportedOrders.map((order) => (
              <Box
                key={order.candidateGlobalId}
                component="button"
                type="button"
                data-testid={`imported-order-${order.candidateGlobalId}`}
                onClick={() => chooseImportedOrder(order)}
                sx={{
                  appearance: 'none', border: 0, background: 'transparent', color: 'inherit', textAlign: 'left',
                  px: 2, py: 1.75, width: '100%', cursor: 'pointer',
                  '&:active': { backgroundColor: 'rgba(168,199,250,0.08)' },
                }}
              >
                <Stack direction="row" justifyContent="space-between" alignItems="flex-start" gap={1.5}>
                  <Box sx={{ minWidth: 0 }}>
                    <Typography fontWeight={700} noWrap>Order {order.orderNumber}</Typography>
                    <Typography variant="body2" color="text.secondary" noWrap>
                      {order.customerName || 'Customer not provided'}
                    </Typography>
                  </Box>
                  <Chip
                    size="small"
                    label={order.needsInfo ? 'Needs info' : 'Imported'}
                    color={order.needsInfo ? 'warning' : 'info'}
                  />
                </Stack>
                <Stack direction="row" justifyContent="space-between" alignItems="flex-end" gap={1.5} sx={{ mt: 1.25 }}>
                  <Box sx={{ minWidth: 0 }}>
                    <Typography variant="caption" color="#A8C7FA">
                      Imported from {displayStatus(order.provider)}
                    </Typography>
                    <Typography variant="caption" color="text.secondary" display="block" noWrap>
                      {displayStatus(order.provider)} · {order.integrationAccountName} · {order.lineCount}{' '}
                      {order.lineCount === 1 ? 'line' : 'lines'}
                    </Typography>
                  </Box>
                  <Typography variant="caption" fontWeight={700}>Local draft</Typography>
                </Stack>
              </Box>
            ))}
            {workspace?.orders.map((order) => (
              <Box
                key={order.globalId}
                component="button"
                type="button"
                onClick={() => chooseOrder(order)}
                sx={{
                  appearance: 'none', border: 0, background: 'transparent', color: 'inherit', textAlign: 'left',
                  px: 2, py: 1.75, width: '100%', cursor: 'pointer',
                  '&:active': { backgroundColor: 'rgba(168,199,250,0.08)' },
                }}
              >
                <Stack direction="row" justifyContent="space-between" alignItems="flex-start" gap={1.5}>
                  <Box sx={{ minWidth: 0 }}>
                    <Typography fontWeight={700} noWrap>Order {order.orderNumber}</Typography>
                    <Typography variant="body2" color="text.secondary" noWrap>{order.customerName}</Typography>
                  </Box>
                  <Chip size="small" label={displayStatus(order.status)} color={statusColor(order.status)} />
                </Stack>
                <Stack direction="row" justifyContent="space-between" alignItems="flex-end" gap={1.5} sx={{ mt: 1.25 }}>
                  <Box sx={{ minWidth: 0 }}>
                    <Typography variant="caption" color="#A8C7FA">{order.globalId}</Typography>
                    <Typography variant="caption" color="text.secondary" display="block" noWrap>{order.warehouseName || 'Unassigned'} · {order.lineCount} {order.lineCount === 1 ? 'line' : 'lines'}</Typography>
                  </Box>
                  <Typography fontWeight={700}>{money(order.expectedRevenueMinor)}</Typography>
                </Stack>
              </Box>
            ))}
          </Stack>
        ) : (
          <TableContainer sx={{ height: '100%' }}>
            <Table stickyHeader size="small" aria-label="Operations orders">
              <TableHead>
                <TableRow>
                  <TableCell>Order</TableCell><TableCell>Customer</TableCell><TableCell>Status</TableCell><TableCell>Warehouse</TableCell><TableCell>Promise</TableCell><TableCell align="right">Lines</TableCell><TableCell align="right">Revenue</TableCell><TableCell>Tracking</TableCell><TableCell padding="checkbox" />
                </TableRow>
              </TableHead>
              <TableBody>
                {visibleImportedOrders.map((order) => (
                  <TableRow
                    key={order.candidateGlobalId}
                    data-testid={`imported-order-${order.candidateGlobalId}`}
                    hover
                    onClick={() => chooseImportedOrder(order)}
                    sx={{ cursor: 'pointer' }}
                  >
                    <TableCell>
                      <Typography fontWeight={600}>{order.orderNumber}</Typography>
                      <Typography variant="caption" color="#A8C7FA">
                        Imported from {displayStatus(order.provider)}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Typography>{order.customerName || '—'}</Typography>
                      <Typography variant="caption" color="text.secondary">
                        {displayStatus(order.provider)} · {order.integrationAccountName}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Chip
                        size="small"
                        label={order.needsInfo ? 'Needs info' : 'Imported'}
                        color={order.needsInfo ? 'warning' : 'info'}
                      />
                    </TableCell>
                    <TableCell>—</TableCell>
                    <TableCell>—</TableCell>
                    <TableCell align="right">{order.lineCount}</TableCell>
                    <TableCell align="right">—</TableCell>
                    <TableCell>—</TableCell>
                    <TableCell padding="checkbox">
                      <Tooltip title="Open imported order">
                        <IconButton size="small" aria-label={`Open imported order ${order.orderNumber}`}>
                          <OpenInNewRounded fontSize="small" />
                        </IconButton>
                      </Tooltip>
                    </TableCell>
                  </TableRow>
                ))}
                {workspace?.orders.map((order) => (
                  <TableRow key={order.globalId} hover onClick={() => chooseOrder(order)} sx={{ cursor: 'pointer' }}>
                    <TableCell><Typography fontWeight={600}>{order.orderNumber}</Typography><Typography variant="caption" color="#A8C7FA">{order.globalId}</Typography></TableCell>
                    <TableCell><Typography>{order.customerName}</Typography><Typography variant="caption" color="text.secondary">{order.customerGlobalId}</Typography></TableCell>
                    <TableCell><Chip size="small" label={displayStatus(order.status)} color={statusColor(order.status)} /></TableCell>
                    <TableCell>{order.warehouseName || '—'}</TableCell>
                    <TableCell>{formatUserDateTime(order.promisedDeliveryAt, dateTime, { year: 'numeric', month: 'short', day: 'numeric', fallback: '—' })}</TableCell>
                    <TableCell align="right">{order.lineCount}</TableCell>
                    <TableCell align="right">{money(order.expectedRevenueMinor)}</TableCell>
                    <TableCell sx={{ maxWidth: 150 }}><Typography variant="body2" noWrap>{order.trackingNumber || '—'}</Typography></TableCell>
                    <TableCell padding="checkbox"><Tooltip title="Open order"><IconButton size="small" aria-label={`Open order ${order.orderNumber}`}><OpenInNewRounded fontSize="small" /></IconButton></Tooltip></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        )}
      </Box>

      <ImportedOrderWorkingCopyDrawer
        key={importedDetail
          ? `${importedDetail.candidateGlobalId}:${importedDetail.rowVersion}:${
              importedDetail.resolutionDetailsLoaded ? 'details' : 'summary'
            }`
          : 'no-imported-order'}
        open={importedDrawerOpen}
        order={importedDetail}
        canManage={Boolean(capabilities?.canManage)}
        saving={savingImportedOrder}
        refreshing={refreshingImportedOrder}
        error={importedOrderError}
        onClose={closeImportedDrawer}
        onSave={saveImportedOrderDraft}
        onAccept={acceptImportedOrder}
        onRefresh={refreshImportedOrder}
      />
      <OrderDetailDrawer
        order={detail}
        sandboxCarrierAccounts={workspace?.shipping?.sandboxCarrierAccounts || []}
        commerceFulfillmentRecoveryEnabled={commerceFulfillmentRecoveryEnabled}
        activationState={workspace?.activation.state || 'disabled'}
        canManage={Boolean(capabilities?.canManage)}
        canExecute={Boolean(capabilities?.canManage && capabilities.canExecute)}
        canPurchaseLivePostage={Boolean(
          workspace?.capabilities.canPurchaseLivePostage,
        )}
        canAuthorizeSandboxE2e={Boolean(
          capabilities?.canActivate
          && capabilities.canManage
          && capabilities.canExecute
        )}
        oneOffExecutionState={oneOffExecutionState}
        oneOffExecutionLoading={oneOffExecutionLoading}
        oneOffExecutionError={oneOffExecutionError}
        open={drawerOpen}
        busy={
          planningOrder
          || planPreparationLoading
          || creatingPlanEvidence
          || releasingOrder
          || reopeningForReplanning
          || confirmingPicks
          || reconcilingExternalFulfillment
          || verifyingPack
          || preparingFulfillment
          || confirmingShipment
          || retryingCommerceExport
          || authorizingSandboxE2e
          || confirmingShopifyTestFulfillment
          || creatingLabel
          || voidingLabel
          || orderRevisionBusy
          || Boolean(oneOffGroupAction)
          || Boolean(generatingPackingSlipPackageId)
          || Boolean(printingPackingSlipArtifactId)
          || Boolean(labelPrintBusyGlobalId)
        }
        onClose={closeDrawer}
        trainingRefreshToken={shadowTrainingRefreshToken}
        onPlan={openPlan}
        onRelease={openRelease}
        onReopenForReplanning={openReplanningCorrection}
        onConfirmPicks={openConfirmPicks}
        onReconcileExternalFulfillment={
          openExternalFulfillmentReconciliation
        }
        onVerifyPack={openVerifyPack}
        onPrepareFulfillment={openPrepareFulfillment}
        onGeneratePackingSlip={(packageGlobalId) => {
          void generatePackingSlip(packageGlobalId)
        }}
        onPrintPackingSlip={(artifactGlobalId) => {
          void printPackingSlip(artifactGlobalId)
        }}
        onPrintLabel={(labelGlobalId) => {
          void printShippingLabel(labelGlobalId)
        }}
        onRetryLabel={(labelGlobalId, printJobGlobalId) => {
          void retryShippingLabel(labelGlobalId, printJobGlobalId)
        }}
        onReprintLabel={openLabelReprint}
        onConfirmShipment={openConfirmShipment}
        onRetryCommerceExport={openCommerceExportRetry}
        onAuthorizeSandboxE2e={openSandboxE2eAuthorization}
        onConfirmShopifyTestFulfillment={openShopifyTestFulfillment}
        onCreateSandboxLabel={openCreateLabel}
        onVoidSandboxLabel={openVoidLabel}
        onRefreshOneOffPackedRates={() => {
          void refreshOneOffPackedRates()
        }}
        onReviewOneOffGroupPurchase={openOneOffGroupPurchase}
        onVoidOneOffGroup={openOneOffGroupVoid}
        onOrderRevisionBusyChange={setOrderRevisionBusy}
        onOrderRevisionChanged={async () => {
          await loadWorkspace(detail?.globalId || selectedGlobalId)
        }}
        onReviewOrderRevisionRecovery={reviewOrderRevisionRecovery}
        generatingPackingSlipPackageId={generatingPackingSlipPackageId}
        printingPackingSlipArtifactId={printingPackingSlipArtifactId}
        labelPrintBusyGlobalId={labelPrintBusyGlobalId}
      />
      <ExceptionDetailDrawer
        key={selectedExceptionGlobalId || 'no-exception'}
        exception={selectedException}
        open={exceptionDrawerOpen}
        canManage={Boolean(capabilities?.canManage)}
        canExecute={Boolean(capabilities?.canExecute)}
        busy={updatingException}
        onClose={closeExceptionDrawer}
        onTransition={(nextStatus) => void transitionException(nextStatus)}
        onAcceptProviderCancellation={(command) => {
          void acceptProviderOrderCancellation(command)
        }}
        onOpenOrder={openExceptionOrder}
      />
      <OperationsGuide open={guideOpen} onClose={() => setGuideOpen(false)} />
      <OneOffShipmentDialog
        open={oneOffShipmentOpen}
        onClose={() => setOneOffShipmentOpen(false)}
        onCreated={openCreatedOneOffShipment}
      />

      <Dialog
        open={LEGACY_COMMERCE_ACTIVATION_UI_VISIBLE && commerceActiveOpen}
        onClose={closeCommerceActive}
        fullWidth
        maxWidth="md"
      >
        <DialogTitle>Activate commerce provider writes</DialogTitle>
        <DialogContent dividers>
          <Stack spacing={2}>
            <Alert severity="warning">
              Active mode permits the exact reviewed Shopify and Faire accounts to perform the
              selected provider writes. Operations remains in Shadow until you complete the
              separate authorization step.
            </Alert>
            {commerceActiveError && (
              <Alert severity="error">{commerceActiveError}</Alert>
            )}
            {commerceActivePending === 'loading' ? (
              <Stack direction="row" spacing={1.5} alignItems="center" sx={{ py: 4 }}>
                <CircularProgress size={22} />
                <Typography>Loading verified commerce accounts and provider scopes…</Typography>
              </Stack>
            ) : !commerceActivePreparation ? (
              <>
                <Box>
                  <Typography fontWeight={700}>1. Select the exact write cohort</Typography>
                  <Typography variant="body2" color="text.secondary">
                    A capability is selectable only when ClawPilot implements its provider-write
                    effect and the verified account retains every required provider scope.
                    Shopify checkout-rate callbacks also require that store&apos;s exact registered
                    CarrierService. Clear every capability for an account to exclude it.
                  </Typography>
                </Box>
                {commerceActiveSelectionEvidence?.preservationBlockers.length ? (
                  <Alert severity="error">
                    <Typography variant="body2" fontWeight={700}>
                      The prior Shopify provider-write authority cannot be preserved safely.
                    </Typography>
                    {commerceActiveSelectionEvidence.preservationBlockers.map((blocker) => (
                      <Typography key={blocker} variant="body2">
                        {blocker}
                      </Typography>
                    ))}
                  </Alert>
                ) : commerceActiveSelectionEvidence?.continuation ? (
                  <Alert severity="info">
                    Preserved {commerceActiveSelectionEvidence.preservedShopifyCapabilityCount}{' '}
                    Shopify claim
                    {commerceActiveSelectionEvidence.preservedShopifyCapabilityCount === 1
                      ? ''
                      : 's'} across{' '}
                    {commerceActiveSelectionEvidence.preservedShopifyAccountCount} account
                    {commerceActiveSelectionEvidence.preservedShopifyAccountCount === 1
                      ? ''
                      : 's'} from Active revision{' '}
                    {commerceActiveSelectionEvidence.continuation.sourceActivationRevision}.
                    Eligible Faire accounts default only to order update, fulfillment export,
                    and tracking export. Review any manual change before preparing.
                  </Alert>
                ) : commerceActiveSelectionEvidence ? (
                  <Alert severity="info">
                    No immediately preceding Active Shopify cohort was found for this Shadow
                    revision, so Shopify provider writes start unselected. Eligible Faire accounts
                    default only to order update, fulfillment export, and tracking export.
                  </Alert>
                ) : null}
                {commerceActiveAccounts.map((account) => (
                  <Box
                    key={account.accountGlobalId}
                    sx={{
                      border: '1px solid',
                      borderColor: 'divider',
                      borderRadius: 1.5,
                      p: 2,
                    }}
                  >
                    <Stack
                      direction={{ xs: 'column', sm: 'row' }}
                      justifyContent="space-between"
                      gap={0.5}
                    >
                      <Box>
                        <Typography fontWeight={700}>{account.displayName}</Typography>
                        <Typography variant="body2" color="text.secondary">
                          {displayStatus(account.provider)} · {displayStatus(account.environment)}
                        </Typography>
                      </Box>
                      <Typography variant="caption" color="#A8C7FA">
                        {account.accountGlobalId}
                      </Typography>
                    </Stack>
                    <Box
                      sx={{
                        mt: 1,
                        display: 'grid',
                        gridTemplateColumns: {
                          xs: '1fr',
                          sm: 'repeat(2, minmax(0, 1fr))',
                        },
                        columnGap: 2,
                      }}
                    >
                      {account.capabilities.map((option) => (
                        <FormControlLabel
                          key={option.capability}
                          disabled={!option.selectable}
                          control={(
                            <Checkbox
                              disabled={!option.selectable}
                              checked={
                                commerceActiveSelections[
                                  account.accountGlobalId
                                ]?.includes(option.capability) || false
                              }
                              onChange={(event) => editCommerceActiveSelection(
                                account.accountGlobalId,
                                option.capability,
                                event.target.checked,
                              )}
                            />
                          )}
                          label={(
                            <Stack direction="row" spacing={1} alignItems="center">
                              <span>{displayStatus(option.capability)}</span>
                              {option.unavailableReason && (
                                <Tooltip
                                  title={option.unavailableDetail
                                    || commerceActiveUnavailableLabel(option)}
                                >
                                  <Chip
                                    size="small"
                                    variant="outlined"
                                    label={commerceActiveUnavailableLabel(option)}
                                  />
                                </Tooltip>
                              )}
                            </Stack>
                          )}
                        />
                      ))}
                    </Box>
                  </Box>
                ))}
                {commerceActiveAccounts.every((account) => (
                  account.capabilities.every((option) => !option.selectable)
                )) && (
                  <Alert severity="warning">
                    These verified accounts currently have no ClawPilot-implemented provider
                    writes with a complete scope grant. Provider-supported capabilities remain
                    visible for planning, but cannot be selected or authorized.
                  </Alert>
                )}
                <Alert severity="info">
                  Preparing this review performs no credential decryption, provider request, or
                  provider write. It records the exact accounts, credential generations, granted
                  scopes, capabilities, Shadow revision, and cohort hash for your review.
                </Alert>
                <Typography variant="body2" color="text.secondary">
                  Selected: {commerceActiveSelectedAccountCount} account
                  {commerceActiveSelectedAccountCount === 1 ? '' : 's'} ·{' '}
                  {commerceActiveSelectedCapabilityCount} provider-write capabilit
                  {commerceActiveSelectedCapabilityCount === 1 ? 'y' : 'ies'}
                </Typography>
              </>
            ) : (
              <>
                <Box>
                  <Typography fontWeight={700}>2. Review and explicitly authorize</Typography>
                  <Typography variant="body2" color="text.secondary">
                    This immutable preparation is the only cohort that the server will activate.
                    Any account, credential, scope, capability, or Shadow-revision drift fails
                    closed.
                  </Typography>
                </Box>
                <Box
                  sx={{
                    border: '1px solid',
                    borderColor: 'divider',
                    borderRadius: 1.5,
                    p: 2,
                  }}
                >
                  <Stack spacing={0.75}>
                    <Typography variant="body2">
                      Preparation: <Box component="span" color="#A8C7FA">
                        {commerceActivePreparation.preparationGlobalId}
                      </Box>
                    </Typography>
                    <Typography variant="body2">
                      Activation: Shadow revision{' '}
                      {commerceActivePreparation.expectedActivationRevision} → Active revision{' '}
                      {commerceActivePreparation.targetActivationRevision}
                    </Typography>
                    <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>
                      Cohort SHA-256: {commerceActivePreparation.cohortHash}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      Prepared by {commerceActivePreparation.preparedBy} ({commerceActivePreparation.preparedRole})
                      {' '}at {formatUserDateTime(
                        commerceActivePreparation.preparedAt,
                        dateTime,
                        {
                          year: 'numeric',
                          month: 'short',
                          day: 'numeric',
                          hour: 'numeric',
                          minute: '2-digit',
                          fallback: commerceActivePreparation.preparedAt,
                        },
                      )}
                    </Typography>
                  </Stack>
                </Box>
                {commerceActivePreparation.accounts.map((account) => (
                  <Box
                    key={account.accountGlobalId}
                    sx={{
                      border: '1px solid',
                      borderColor: 'divider',
                      borderRadius: 1.5,
                      p: 2,
                    }}
                  >
                    <Stack
                      direction={{ xs: 'column', sm: 'row' }}
                      justifyContent="space-between"
                      gap={0.5}
                    >
                      <Typography fontWeight={700}>
                        {displayStatus(account.provider)} · {account.accountGlobalId}
                      </Typography>
                      <Chip
                        size="small"
                        label={displayStatus(account.environment)}
                        variant="outlined"
                      />
                    </Stack>
                    <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                      Provider identity {account.externalAccountId} · credential generation{' '}
                      {account.credentialGeneration} · {displayStatus(account.authMode)}
                    </Typography>
                    <Typography variant="body2" sx={{ mt: 1 }}>
                      Provider-write capabilities
                    </Typography>
                    <Stack direction="row" gap={0.75} flexWrap="wrap" useFlexGap sx={{ mt: 0.5 }}>
                      {account.writeCapabilities.map((capability) => (
                        <Chip
                          key={capability}
                          size="small"
                          color="warning"
                          variant="outlined"
                          label={displayStatus(capability)}
                        />
                      ))}
                    </Stack>
                    <Typography variant="body2" sx={{ mt: 1 }}>
                      Provider-reported granted scopes
                    </Typography>
                    <Stack direction="row" gap={0.75} flexWrap="wrap" useFlexGap sx={{ mt: 0.5 }}>
                      {account.grantedScopes.map((scope) => (
                        <Chip key={scope} size="small" label={scope} />
                      ))}
                    </Stack>
                  </Box>
                ))}
                <TextField
                  required
                  multiline
                  minRows={2}
                  label="Activation reason"
                  value={commerceActiveReason}
                  onChange={(event) => setCommerceActiveReason(event.target.value)}
                  inputProps={{ maxLength: 500 }}
                  helperText={`${commerceActiveReason.trim().length}/500 · Recorded with the immutable transition`}
                />
                <FormControlLabel
                  sx={{ alignItems: 'flex-start' }}
                  control={(
                    <Checkbox
                      checked={commerceActiveConfirmed}
                      onChange={(event) => setCommerceActiveConfirmed(event.target.checked)}
                    />
                  )}
                  label="I authorize ClawPilot to move Operations from Shadow to Active for exactly the reviewed accounts and provider-write capabilities."
                />
                <Alert severity="error">
                  Authorizing creates a five-minute, single-use{' '}
                  <strong>commerce-active-transition-v1</strong> authorization and immediately
                  consumes it under the same locked transition. A stale or changed cohort is not
                  activated.
                </Alert>
              </>
            )}
          </Stack>
        </DialogContent>
        <DialogActions>
          {commerceActivePreparation && (
            <Button
              onClick={returnToCommerceActiveSelection}
              disabled={commerceActivePending === 'activating'}
            >
              Back
            </Button>
          )}
          <Box sx={{ flex: 1 }} />
          <Button
            onClick={closeCommerceActive}
            disabled={
              commerceActivePending === 'preparing'
              || commerceActivePending === 'activating'
            }
          >
            Cancel
          </Button>
          {!commerceActivePreparation ? (
            <Button
              variant="contained"
              onClick={() => void prepareCommerceActive()}
              disabled={
                Boolean(commerceActivePending)
                || Boolean(
                  commerceActiveSelectionEvidence?.preservationBlockers.length,
                )
                || commerceActiveSelectedAccountCount === 0
                || commerceActiveSelectedCapabilityCount === 0
              }
              startIcon={
                commerceActivePending === 'preparing'
                  ? <CircularProgress size={16} />
                  : <ScienceRounded />
              }
            >
              {commerceActivePending === 'preparing'
                ? 'Preparing review'
                : 'Prepare exact review'}
            </Button>
          ) : (
            <Button
              variant="contained"
              color="error"
              onClick={() => void activateCommerce()}
              disabled={
                commerceActivePending === 'activating'
                || !commerceActiveConfirmed
                || !commerceActiveReason.trim()
              }
              startIcon={
                commerceActivePending === 'activating'
                  ? <CircularProgress size={16} />
                  : <WarningAmberRounded />
              }
            >
              {commerceActivePending === 'activating'
                ? 'Authorizing and activating'
                : 'Authorize and activate'}
            </Button>
          )}
        </DialogActions>
      </Dialog>

      <Dialog open={planOpen} onClose={closePlan} fullWidth maxWidth="md">
        <Box component="form" onSubmit={planOrder}>
          <DialogTitle>
            {shadowTrainingPlanTarget
              ? 'Prepare local training simulation'
              : 'Prepare and plan imported order'}
          </DialogTitle>
          <DialogContent dividers>
            <Stack spacing={2}>
              <Alert severity="info">
                {shadowTrainingPlanTarget?.cartonizationEvidenceGlobalId ? (
                  <>
                    This run already owns exact sealed cartonization and sandbox-rate
                    evidence. Review and reuse that frozen evidence to create only the
                    local training overlay. No new carrier request, commerce-provider
                    request, reservation, inventory change, warehouse wave, operational
                    package, shipment, label, postage, or store write is made.
                  </>
                ) : shadowTrainingPlanTarget ? (
                  <>
                    Select factual warehouse and packaging inputs for the local
                    simulation of {detail?.orderNumber || 'this imported order'}.
                    ClawPilot will cartonize and compare read-only rates, then copy
                    the sealed facts into the training overlay only. This creates
                    zero canonical reservations, inventory changes, warehouse
                    waves, operational packages, shipments, labels, postage, or
                    store writes.
                  </>
                ) : (
                  <>
                    Select the fulfillment warehouse and factual packaging for{' '}
                    {detail?.orderNumber || 'this imported order'}. ClawPilot will
                    cartonize the order, compare read-only UPS and FedEx rates, and
                    retain immutable evidence before creating the warehouse plan.
                    Nothing here purchases postage, creates a label, releases a wave,
                    or assigns a picker.
                  </>
                )}
              </Alert>
              {planError && (
                <Alert severity="error" onClose={() => setPlanError('')}>
                  {planError}
                </Alert>
              )}
              {shadowTrainingPlanTarget?.cartonizationEvidenceGlobalId ? (
                <>
                  <Typography variant="overline" color="text.secondary">
                    Step 1 · Review the exact sealed training evidence
                  </Typography>
                  <CartonizationRateEvidencePanel
                    evidenceGlobalId={planCartonizationEvidenceGlobalId}
                  />
                  <Alert severity="info" variant="outlined">
                    This evidence is reused exactly as sealed. Continuing does not
                    rerun cartonization or contact a carrier or commerce provider.
                  </Alert>
                </>
              ) : planPreparationLoading ? (
                <Stack direction="row" spacing={1.5} alignItems="center" sx={{ py: 2 }}>
                  <CircularProgress size={22} />
                  <Typography>Loading warehouses and factual packaging…</Typography>
                </Stack>
              ) : planPackagingWorkspace ? (
                <>
                  {planShopifyAssignment ? (
                    <Alert
                      severity={planShopifyAssignment.status === 'ready'
                        ? 'success'
                        : planShopifyAssignment.status === 'provider_managed'
                          ? 'info'
                          : 'warning'}
                      variant="outlined"
                      action={planShopifyAssignment.status === 'unmapped' ? (
                        <Button
                          size="small"
                          onClick={() => {
                            closePlan()
                            setView('imports')
                          }}
                        >
                          Map location
                        </Button>
                      ) : undefined}
                    >
                      {shadowTrainingPlanTarget
                        ? `Shopify currently assigns this order to ${
                          planShopifyAssignment.assignments[0]
                            ?.shopifyLocationName || 'an external location'
                        }. Training remains local-only, so you may select factual ClawPilot warehouse inputs without changing that assignment.`
                        : planShopifyAssignment.status === 'ready'
                        ? `Shopify assigned this order to ${
                          planShopifyAssignment.selectedWarehouse
                            ?.shopifyLocationName
                        }, mapped to ${
                          planShopifyAssignment.selectedWarehouse?.name
                        }. The exact mapped warehouse is selected.`
                        : planShopifyAssignment.status === 'provider_managed'
                          ? `Shopify assigned this order to ${
                            planShopifyAssignment.assignments[0]
                              ?.shopifyLocationName
                          }, managed by ${
                            planShopifyAssignment.assignments[0]
                              ?.fulfillmentService?.serviceName
                              || 'another fulfillment app'
                          }. ClawPilot will not create local warehouse work for it.`
                          : planShopifyAssignment.status === 'unmapped'
                            ? `Shopify assigned this order to ${
                              planShopifyAssignment.assignments[0]
                                ?.shopifyLocationName
                            }, which has no ClawPilot warehouse mapping.`
                            : planShopifyAssignment.status === 'split'
                              ? `Shopify assigned this order across ${
                                planShopifyAssignment.assignments.length
                              } locations; split-location planning is not available yet.`
                              : 'Shopify has no untouched open fulfillment assignment for this order.'}
                    </Alert>
                  ) : null}
                  <Typography variant="overline" color="text.secondary">
                    Step 1 · Choose fulfillment facts
                  </Typography>
                  <FormControl fullWidth>
                    <InputLabel id="order-planning-warehouse-label">Warehouse</InputLabel>
                    <Select
                      id="order-planning-warehouse"
                      labelId="order-planning-warehouse-label"
                      label="Warehouse"
                      value={planWarehouseGlobalId}
                      disabled={
                        creatingPlanEvidence
                        || planEvidenceValid
                        || Boolean(
                          planShopifyAssignment && !shadowTrainingPlanTarget
                        )
                      }
                      onChange={(event) => {
                        const warehouseGlobalId = event.target.value
                        const eligible = planPackagingWorkspace.materials.filter(
                          (material) => operationalPlanningMaterialBlockers(
                            material,
                            warehouseGlobalId,
                            !shadowTrainingPlanTarget,
                          ).length === 0,
                        )
                        setPlanWarehouseGlobalId(warehouseGlobalId)
                        setPlanMaterialGlobalIds(
                          eligible[0] ? [eligible[0].globalId] : [],
                        )
                        setPlanCartonizationEvidenceGlobalId('')
                        setPlanEvidenceIdempotencyKey(
                          `operations-rate-plan:${detail?.globalId || 'order'}:${crypto.randomUUID()}`,
                        )
                        setPlanError(eligible.length
                          ? ''
                          : 'No factual stocked packaging is ready at this warehouse.')
                      }}
                    >
                      {planPackagingWorkspace.warehouses
                        .filter((warehouse) => warehouse.status === 'active')
                        .map((warehouse) => (
                          <MenuItem key={warehouse.globalId} value={warehouse.globalId}>
                            {warehouse.name} · {warehouse.globalId}
                          </MenuItem>
                        ))}
                    </Select>
                    <FormHelperText>
                      {shadowTrainingPlanTarget
                        ? 'Training selection is local-only and does not change the provider fulfillment location.'
                        : planShopifyAssignment?.status === 'ready'
                        ? 'Locked to Shopify’s current exact fulfillment assignment and active location mapping.'
                        : 'Inventory and carrier sender accounts must resolve to this warehouse.'}
                    </FormHelperText>
                  </FormControl>
                  <FormControl fullWidth>
                    <InputLabel id="order-planning-materials-label">
                      Packaging materials (1–8)
                    </InputLabel>
                    <Select
                      id="order-planning-materials"
                      labelId="order-planning-materials-label"
                      multiple
                      label="Packaging materials (1–8)"
                      value={planMaterialGlobalIds}
                      disabled={creatingPlanEvidence || planEvidenceValid}
                      onChange={(event) => {
                        const values = typeof event.target.value === 'string'
                          ? event.target.value.split(',')
                          : event.target.value
                        setPlanMaterialGlobalIds(
                          Array.from(new Set(values)).slice(0, 8),
                        )
                        setPlanCartonizationEvidenceGlobalId('')
                        setPlanEvidenceIdempotencyKey(
                          `operations-rate-plan:${detail?.globalId || 'order'}:${crypto.randomUUID()}`,
                        )
                        setPlanError('')
                      }}
                      renderValue={(selected) => selected.map((globalId) => (
                        planPackagingWorkspace.materials.find(
                          (material) => material.globalId === globalId,
                        )?.code || globalId
                      )).join(', ')}
                    >
                      {planPackagingWorkspace.materials.map((material) => {
                        const blockers = operationalPlanningMaterialBlockers(
                          material,
                          planWarehouseGlobalId,
                          !shadowTrainingPlanTarget,
                        )
                        const selected = planMaterialGlobalIds.includes(material.globalId)
                        return (
                          <MenuItem
                            key={material.globalId}
                            value={material.globalId}
                            disabled={blockers.length > 0 || (
                              !selected && planMaterialGlobalIds.length >= 8
                            )}
                          >
                            <Checkbox checked={selected} />
                            <ListItemText
                              primary={`${material.code} · ${material.name}`}
                              secondary={blockers.length
                                ? blockers.join(', ')
                                : 'Operationally ready'}
                            />
                          </MenuItem>
                        )
                      })}
                    </Select>
                    <FormHelperText>
                      {shadowTrainingPlanTarget
                        ? 'Training requires active materials with factual exterior dimensions and tare; stock is shown for context but is not consumed.'
                        : 'Only active, stocked materials with factual exterior dimensions and tare can be rated.'}
                    </FormHelperText>
                  </FormControl>
                  {!planEvidenceValid ? (
                    <Button
                      type="button"
                      variant="contained"
                      startIcon={creatingPlanEvidence
                        ? <CircularProgress size={16} color="inherit" />
                        : <ScienceRounded />}
                      disabled={
                        creatingPlanEvidence
                        || !planWarehouseGlobalId
                        || planMaterialGlobalIds.length < 1
                        || planMaterialGlobalIds.length > 8
                        || Boolean(
                          !shadowTrainingPlanTarget
                          &&
                          planShopifyAssignment
                          && planShopifyAssignment.status !== 'ready'
                        )
                      }
                      onClick={() => void createPlanEvidence()}
                    >
                      {creatingPlanEvidence
                        ? 'Cartonizing and rating'
                        : 'Run cartonization and compare rates'}
                    </Button>
                  ) : (
                    <>
                      <Typography variant="overline" color="text.secondary">
                        Step 2 · Review the carton plan and carrier rates
                      </Typography>
                      <CartonizationRateEvidencePanel
                        evidenceGlobalId={planCartonizationEvidenceGlobalId}
                      />
                      <Alert severity="info" variant="outlined">
                        Confirming the plan uses the lowest-cost whole-shipment
                        service that meets the requested delivery time. The
                        selected service and all alternatives remain in the audit record.
                      </Alert>
                    </>
                  )}
                </>
              ) : null}
              <Typography variant="overline" color="text.secondary">
                Step 3 · Record the planning decision
              </Typography>
              <TextField
                required
                multiline
                minRows={3}
                label="Planning reason"
                value={planReason}
                onChange={(event) => {
                  setPlanReason(event.target.value)
                  setPlanError('')
                }}
                inputProps={{ maxLength: 500 }}
                helperText={`${planReason.trim().length}/500 · Recorded in the audit history`}
              />
            </Stack>
          </DialogContent>
          <DialogActions>
            <Button
              onClick={closePlan}
              disabled={planningOrder || creatingPlanEvidence}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant="contained"
              disabled={
                planningOrder
                || creatingPlanEvidence
                || !planEvidenceValid
                || !planReason.trim()
              }
              startIcon={planningOrder
                ? <CircularProgress size={16} />
                : <Inventory2Rounded />}
            >
              {planningOrder
                ? shadowTrainingPlanTarget
                  ? 'Preparing simulation'
                  : 'Planning order'
                : shadowTrainingPlanTarget
                  ? 'Confirm local training plan'
                  : 'Confirm warehouse plan'}
            </Button>
          </DialogActions>
        </Box>
      </Dialog>

      <Dialog
        open={labelReprintOpen}
        onClose={closeLabelReprint}
        fullWidth
        maxWidth="sm"
      >
        <Box component="form" onSubmit={reprintShippingLabel}>
          <DialogTitle>Reprint shipping label</DialogTitle>
          <DialogContent dividers>
            <Stack spacing={2}>
              <Alert severity="info">
                This creates a new audited print job from the original immutable label document. It does not call the carrier, buy postage, create tracking, or replace the shipment label.
              </Alert>
              <Box>
                <Typography variant="caption" color="text.secondary">
                  Source label
                </Typography>
                <Typography>{labelReprintLabelGlobalId}</Typography>
                <Typography variant="caption" color="text.secondary">
                  Acknowledged print job {labelReprintJobGlobalId}
                </Typography>
              </Box>
              <TextField
                fullWidth
                multiline
                minRows={3}
                label="Reprint reason"
                value={labelReprintReason}
                onChange={(event) => setLabelReprintReason(event.target.value)}
                inputProps={{ maxLength: 500 }}
                helperText="Required for the immutable print audit trail"
              />
            </Stack>
          </DialogContent>
          <DialogActions>
            <Button onClick={closeLabelReprint} disabled={Boolean(labelPrintBusyGlobalId)}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant="contained"
              startIcon={labelPrintBusyGlobalId
                ? <CircularProgress size={16} />
                : <ReplayRounded />}
              disabled={
                Boolean(labelPrintBusyGlobalId)
                || !labelReprintReason.trim()
              }
            >
              {labelPrintBusyGlobalId ? 'Queueing' : 'Queue reprint'}
            </Button>
          </DialogActions>
        </Box>
      </Dialog>

      <Dialog open={releaseOpen} onClose={closeRelease} fullWidth maxWidth="sm">
        <Box component="form" onSubmit={releaseOrder}>
          <DialogTitle>Release order to warehouse</DialogTitle>
          <DialogContent dividers>
            <Stack spacing={2}>
              <Alert severity="warning">
                This creates a released warehouse wave and ready pick tasks for {detail?.orderNumber || 'this order'}. The order version and readiness checks are repeated when you confirm.
              </Alert>
              <TextField
                required
                autoFocus
                multiline
                minRows={3}
                label="Release reason"
                value={releaseReason}
                onChange={(event) => setReleaseReason(event.target.value)}
                inputProps={{ maxLength: 500 }}
                helperText={`${releaseReason.trim().length}/500 · Recorded in the audit history`}
              />
            </Stack>
          </DialogContent>
          <DialogActions>
            <Button onClick={closeRelease} disabled={releasingOrder}>Cancel</Button>
            <Button
              type="submit"
              variant="contained"
              disabled={releasingOrder || !releaseReason.trim()}
              startIcon={releasingOrder ? <CircularProgress size={16} /> : <WarehouseRounded />}
            >
              {releasingOrder ? 'Releasing' : 'Confirm release'}
            </Button>
          </DialogActions>
        </Box>
      </Dialog>

      <Dialog
        open={replanningCorrectionOpen}
        onClose={closeReplanningCorrection}
        fullWidth
        maxWidth="sm"
      >
        <Box component="form" onSubmit={reopenForReplanning}>
          <DialogTitle>Reopen order for replanning?</DialogTitle>
          <DialogContent dividers>
            <Stack spacing={2}>
              <Alert severity="warning">
                {detail?.availableActions.find(
                  (item) => item.action === 'reopen_for_replanning',
                )?.consequenceSummary
                  || 'Only a planned order that has not been released to picker devices can be reopened.'}
              </Alert>
              <Alert severity="info">
                Shopify or Faire remains authoritative for the order facts.
                This does not edit the sales-channel order, call a carrier,
                void a label, or reverse physical work.
              </Alert>
              <TextField
                required
                autoFocus
                multiline
                minRows={3}
                label="Correction reason"
                value={replanningCorrectionReason}
                onChange={(event) => setReplanningCorrectionReason(event.target.value)}
                inputProps={{ minLength: 8, maxLength: 500 }}
                helperText={`${replanningCorrectionReason.trim().length}/500 · Minimum 8 characters · Retained in the immutable correction ledger`}
              />
              <FormControlLabel
                control={(
                  <Checkbox
                    checked={replanningCorrectionConfirmed}
                    onChange={(event) => setReplanningCorrectionConfirmed(
                      event.target.checked,
                    )}
                  />
                )}
                label="I reviewed this exact unreleased plan and want to return the order to Imported."
              />
            </Stack>
          </DialogContent>
          <DialogActions>
            <Button
              onClick={closeReplanningCorrection}
              disabled={reopeningForReplanning}
            >
              Keep current plan
            </Button>
            <Button
              type="submit"
              variant="contained"
              color="warning"
              disabled={
                reopeningForReplanning
                || replanningCorrectionReason.trim().length < 8
                || !replanningCorrectionConfirmed
              }
              startIcon={reopeningForReplanning
                ? <CircularProgress size={16} />
                : <ReplayRounded />}
            >
              {reopeningForReplanning
                ? 'Reopening order'
                : 'Confirm operational correction'}
            </Button>
          </DialogActions>
        </Box>
      </Dialog>

      <Dialog open={confirmPicksOpen} onClose={closeConfirmPicks} fullWidth maxWidth="sm">
        <Box component="form" onSubmit={confirmPicks}>
          <DialogTitle>Confirm warehouse picks</DialogTitle>
          <DialogContent dividers>
            <Stack spacing={2}>
              <Alert severity="warning">
                This confirms all {detail?.readyPickTaskCount || 0} ready pick tasks and completes the released wave for {detail?.orderNumber || 'this order'}. Inventory reservations remain in place until shipment.
              </Alert>
              <TextField
                required
                autoFocus
                multiline
                minRows={3}
                label="Pick confirmation reason"
                value={confirmPicksReason}
                onChange={(event) => setConfirmPicksReason(event.target.value)}
                inputProps={{ maxLength: 500 }}
                helperText={`${confirmPicksReason.trim().length}/500 · Recorded in the audit history`}
              />
            </Stack>
          </DialogContent>
          <DialogActions>
            <Button onClick={closeConfirmPicks} disabled={confirmingPicks}>Cancel</Button>
            <Button
              type="submit"
              variant="contained"
              disabled={confirmingPicks || !confirmPicksReason.trim()}
              startIcon={confirmingPicks ? <CircularProgress size={16} /> : <TaskAltRounded />}
            >
              {confirmingPicks ? 'Confirming picks' : 'Confirm picks'}
            </Button>
          </DialogActions>
        </Box>
      </Dialog>

      <Dialog
        open={externalFulfillmentOpen}
        onClose={closeExternalFulfillmentReconciliation}
        fullWidth
        maxWidth="sm"
      >
        <Box component="form" onSubmit={reconcileExternalFulfillment}>
          <DialogTitle>Reconcile Shopify fulfillment</DialogTitle>
          <DialogContent dividers>
            <Stack spacing={2}>
              <Alert severity="warning">
                ClawPilot will read the live Shopify order and proceed only if
                one exact successful fulfillment covers every released line at
                the released location. It will then cancel the wholly unpicked
                wave and plan and release their provider and packaging claims.
              </Alert>
              <Alert severity="info">
                This command does not write to Shopify, create a ClawPilot
                shipment or fulfillment export, or send another customer
                notification.
              </Alert>
              <TextField
                required
                autoFocus
                multiline
                minRows={3}
                label="Reconciliation reason"
                value={externalFulfillmentReason}
                onChange={(event) => setExternalFulfillmentReason(event.target.value)}
                inputProps={{ maxLength: 500 }}
                helperText={`${externalFulfillmentReason.trim().length}/500 · Recorded with immutable Shopify evidence`}
              />
            </Stack>
          </DialogContent>
          <DialogActions>
            <Button
              onClick={closeExternalFulfillmentReconciliation}
              disabled={reconcilingExternalFulfillment}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant="contained"
              color="warning"
              disabled={
                reconcilingExternalFulfillment
                || !externalFulfillmentReason.trim()
              }
              startIcon={
                reconcilingExternalFulfillment
                  ? <CircularProgress size={16} />
                  : <ReplayRounded />
              }
            >
              {reconcilingExternalFulfillment
                ? 'Reconciling fulfillment'
                : 'Confirm reconciliation'}
            </Button>
          </DialogActions>
        </Box>
      </Dialog>

      <Dialog open={verifyPackOpen} onClose={closeVerifyPack} fullWidth maxWidth="sm">
        <Box component="form" onSubmit={verifyPack}>
          <DialogTitle>Verify warehouse packages</DialogTitle>
          <DialogContent dividers>
            <Stack spacing={2}>
              <Alert severity="warning">
                This marks all {detail?.plannedPackageCount || 0} planned packages as packed for {detail?.orderNumber || 'this order'} and accrues versioned contract pack fees. Inventory reservations remain active. No label is purchased and no shipment is created.
              </Alert>
              <TextField
                required
                autoFocus
                multiline
                minRows={3}
                label="Package verification reason"
                value={verifyPackReason}
                onChange={(event) => setVerifyPackReason(event.target.value)}
                inputProps={{ maxLength: 500 }}
                helperText={`${verifyPackReason.trim().length}/500 · Recorded in the audit history`}
              />
            </Stack>
          </DialogContent>
          <DialogActions>
            <Button onClick={closeVerifyPack} disabled={verifyingPack}>Cancel</Button>
            <Button
              type="submit"
              variant="contained"
              disabled={verifyingPack || !verifyPackReason.trim()}
              startIcon={verifyingPack ? <CircularProgress size={16} /> : <Inventory2Rounded />}
            >
              {verifyingPack ? 'Verifying packages' : 'Confirm package verification'}
            </Button>
          </DialogActions>
        </Box>
      </Dialog>

      <Dialog
        open={prepareFulfillmentOpen}
        onClose={closePrepareFulfillment}
        fullWidth
        maxWidth="sm"
      >
        <Box component="form" onSubmit={prepareFulfillment}>
          <DialogTitle>Prepare shipment in Shadow</DialogTitle>
          <DialogContent dividers>
            <Stack spacing={2}>
              <Alert severity="warning">
                This rerates every exact sealed package as one shipment with the
                exact TEST accounts selected in the Shopify callback setup. It
                stores immutable checkout, pre-label fulfillment, variance, and
                carrier-attempt evidence only.
              </Alert>
              <Alert severity="info">
                No shipment, tracking number, carrier label, postage purchase,
                commerce write, or final packing slip will be created.
              </Alert>
              <TextField
                required
                autoFocus
                multiline
                minRows={3}
                label="Shadow preparation reason"
                value={prepareFulfillmentReason}
                onChange={(event) => setPrepareFulfillmentReason(event.target.value)}
                inputProps={{ maxLength: 500 }}
                helperText={`${prepareFulfillmentReason.trim().length}/500 · Recorded in the audit history`}
              />
            </Stack>
          </DialogContent>
          <DialogActions>
            <Button
              onClick={closePrepareFulfillment}
              disabled={preparingFulfillment}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant="contained"
              disabled={
                preparingFulfillment
                || !prepareFulfillmentReason.trim()
              }
              startIcon={
                preparingFulfillment
                  ? <CircularProgress size={16} />
                  : <ScienceRounded />
              }
            >
              {preparingFulfillment ? 'Preparing shipment' : 'Prepare in Shadow'}
            </Button>
          </DialogActions>
        </Box>
      </Dialog>

      <Dialog
        open={sandboxE2eAuthorizationOpen}
        onClose={closeSandboxE2eAuthorization}
        fullScreen={mobile}
        fullWidth
        maxWidth="sm"
      >
        <Box component="form" onSubmit={authorizeSandboxE2e}>
          <DialogTitle>
            {detail?.sourceProvider === 'shopify'
              ? detail.status === 'imported'
                ? 'Authorize verified Shopify test order'
                : 'Renew or resume verified Shopify test order'
              : 'Authorize exact-order sandbox E2E test'}
          </DialogTitle>
          <DialogContent dividers>
            <Stack spacing={2}>
              <Alert severity="error">
                {detail?.sourceProvider === 'shopify'
                  ? `ClawPilot will freshly query Shopify and must positively receive test=true for exact order ${detail?.orderNumber || 'this order'} (${detail?.globalId || 'unknown'}). Authority stays bound to this account, credential generation, candidate source, and local order revision. It expires after two hours and never permits production postage or customer notification.`
                  : `This authority is limited to ${detail?.sourceProvider === 'faire' ? 'Faire' : 'Shopify'} order ${detail?.orderNumber || 'this order'} (${detail?.globalId || 'unknown'}). It permits non-tracking sandbox labels followed by real reserved inventory consumption and ${detail?.sourceProvider === 'faire' ? 'Faire' : 'Shopify'} fulfillment/tracking writeback. The authorization expires after two hours and is consumed by a successful shipment confirmation.`}
              </Alert>
              <Box
                sx={{
                  p: 1.5,
                  border: '1px solid rgba(255,255,255,0.16)',
                  borderRadius: '8px',
                }}
              >
                <Typography variant="body2">
                  {detail?.sourceProvider === 'shopify'
                    ? SHOPIFY_TEST_STORE_CANONICAL_E2E_CONFIRMATION
                    : SANDBOX_COMMERCE_E2E_CONFIRMATION}
                </Typography>
              </Box>
              {detail?.sourceProvider === 'shopify' ? (
                <TextField
                  required
                  multiline
                  minRows={4}
                  label="Type the exact authorization statement"
                  value={sandboxE2eConfirmationText}
                  onChange={(event) => setSandboxE2eConfirmationText(event.target.value)}
                  helperText={sandboxE2eConfirmationText
                    === SHOPIFY_TEST_STORE_CANONICAL_E2E_CONFIRMATION
                    ? 'Exact statement matched'
                    : 'Copy the statement above exactly; whitespace and punctuation must match.'}
                  inputProps={{
                    'data-testid': 'shopify-test-store-authorization-statement',
                  }}
                />
              ) : (
                <FormControlLabel
                  control={(
                    <Checkbox
                      checked={sandboxE2eAuthorizationConfirmed}
                      onChange={(event) => {
                        setSandboxE2eAuthorizationConfirmed(event.target.checked)
                      }}
                      data-testid="sandbox-commerce-e2e-confirmation"
                    />
                  )}
                  label="I understand and explicitly authorize this exact order-bound test."
                />
              )}
              <TextField
                required
                multiline
                minRows={3}
                label="Authorization reason"
                value={sandboxE2eAuthorizationReason}
                onChange={(event) => setSandboxE2eAuthorizationReason(event.target.value)}
                inputProps={{ maxLength: 500 }}
                helperText={`${sandboxE2eAuthorizationReason.trim().length}/500 · Recorded with the exact authorization`}
              />
            </Stack>
          </DialogContent>
          <DialogActions>
            <Button
              onClick={closeSandboxE2eAuthorization}
              disabled={authorizingSandboxE2e}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant="contained"
              color="warning"
              disabled={
                authorizingSandboxE2e
                || (
                  detail?.sourceProvider === 'shopify'
                    ? sandboxE2eConfirmationText
                      !== SHOPIFY_TEST_STORE_CANONICAL_E2E_CONFIRMATION
                    : !sandboxE2eAuthorizationConfirmed
                )
                || !sandboxE2eAuthorizationReason.trim()
              }
              startIcon={authorizingSandboxE2e
                ? <CircularProgress size={16} />
                : <WarningAmberRounded />}
              data-testid="confirm-sandbox-commerce-e2e-authorization"
            >
              {authorizingSandboxE2e
                ? 'Verifying with Shopify'
                : 'Authorize this exact order'}
            </Button>
          </DialogActions>
        </Box>
      </Dialog>

      <Dialog
        open={shopifyTestFulfillmentOpen}
        onClose={closeShopifyTestFulfillment}
        fullScreen={mobile}
        fullWidth
        maxWidth="sm"
      >
        <Box component="form" onSubmit={confirmShopifyTestFulfillment}>
          <DialogTitle>Confirm exact Shopify test fulfillment</DialogTitle>
          <DialogContent dividers>
            <Stack spacing={2}>
              <Alert severity="error">
                This is the second owner/admin confirmation. ClawPilot will
                freeze the exact sorted package, sandbox-label, and tracking
                snapshot for {detail?.orderNumber || 'this order'}. Confirm
                shipment will fail closed if a label is voided, replaced, or
                changed. Shopify customer notification remains forcibly off.
              </Alert>
              <Box
                sx={{
                  p: 1.5,
                  border: '1px solid rgba(255,255,255,0.16)',
                  borderRadius: '8px',
                }}
              >
                <Typography variant="body2">
                  {SHOPIFY_TEST_STORE_FULFILLMENT_CONFIRMATION}
                </Typography>
              </Box>
              <TextField
                required
                multiline
                minRows={4}
                label="Type the exact fulfillment statement"
                value={shopifyTestFulfillmentText}
                onChange={(event) => setShopifyTestFulfillmentText(event.target.value)}
                helperText={shopifyTestFulfillmentText
                  === SHOPIFY_TEST_STORE_FULFILLMENT_CONFIRMATION
                  ? 'Exact statement matched'
                  : 'Copy the statement above exactly; whitespace and punctuation must match.'}
                inputProps={{
                  'data-testid': 'shopify-test-store-fulfillment-statement',
                }}
              />
              <TextField
                required
                multiline
                minRows={3}
                label="Fulfillment confirmation reason"
                value={shopifyTestFulfillmentReason}
                onChange={(event) => setShopifyTestFulfillmentReason(event.target.value)}
                inputProps={{ maxLength: 500 }}
                helperText={`${shopifyTestFulfillmentReason.trim().length}/500 · Stored with the immutable label snapshot`}
              />
            </Stack>
          </DialogContent>
          <DialogActions>
            <Button
              onClick={closeShopifyTestFulfillment}
              disabled={confirmingShopifyTestFulfillment}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant="contained"
              color="warning"
              disabled={
                confirmingShopifyTestFulfillment
                || shopifyTestFulfillmentText
                  !== SHOPIFY_TEST_STORE_FULFILLMENT_CONFIRMATION
                || shopifyTestFulfillmentReason.trim().length < 8
              }
              startIcon={confirmingShopifyTestFulfillment
                ? <CircularProgress size={16} />
                : <WarningAmberRounded />}
              data-testid="confirm-shopify-test-store-fulfillment"
            >
              {confirmingShopifyTestFulfillment
                ? 'Confirming exact evidence'
                : 'Confirm exact sandbox tracking'}
            </Button>
          </DialogActions>
        </Box>
      </Dialog>

      <Dialog open={confirmShipmentOpen} onClose={closeConfirmShipment} fullWidth maxWidth="sm">
        <Box component="form" onSubmit={confirmShipment}>
          <DialogTitle>Confirm shipment</DialogTitle>
          <DialogContent dividers>
            <Stack spacing={2}>
              <Alert severity="warning">
                This consumes the reserved inventory, marks the order, package, and fulfillment
                plan as shipped, creates immutable shipment and packing-slip evidence, seeds
                tracking, and attempts the commerce fulfillment export for
                {' '}{detail?.orderNumber || 'this order'}. The order version and shipment
                readiness checks are repeated when you confirm. For Shopify and Faire,
                the exact connection&apos;s Provider writes control must still be On and
                bound to its current credential and scopes.
              </Alert>
              {detail?.sandboxCommerceE2eAuthorization && (
                <Alert severity="error" data-testid="sandbox-commerce-e2e-confirm-shipment-warning">
                  Authorized sandbox E2E execution is active under{' '}
                  {detail.sandboxCommerceE2eAuthorization.authorizationGlobalId}.
                  Confirming will consume that one-time authorization and send
                  every package&apos;s sandbox tracking number to{' '}
                  {detail.sourceProvider === 'faire' ? 'Faire' : 'Shopify'} even though
                  those labels will not track with the carrier.{' '}
                  {detail.sourceProvider === 'faire'
                    ? 'Faire may send a processing email when a NEW order is accepted, and submitting these tracking details triggers Faire\'s shipment email. Verify this test order uses a controlled recipient.'
                    : 'Shopify customer notification is forcibly disabled for this test and cannot be overridden.'}
                </Alert>
              )}
              {detail?.fulfillmentNotificationPolicy?.mode === 'provider_managed' ? (
                <Alert severity="info">
                  Faire may send a processing email when a NEW order is accepted, and submitting
                  shipment tracking triggers Faire&apos;s shipment email. Use a controlled recipient
                  for test orders. ClawPilot will attempt the separate fulfillment export, but
                  does not expose a retailer-notification override.
                </Alert>
              ) : !detail?.fulfillmentNotificationPolicy
                || detail.fulfillmentNotificationPolicy.mode === 'unavailable' ? (
                <Alert severity="info">
                  This commerce provider does not expose a ClawPilot customer-notification
                  policy. Shipment confirmation remains fail-closed and will not request a
                  customer notification.
                </Alert>
              ) : detail?.sandboxCommerceE2eAuthorization ? null : detail ? (
                <>
                  <TextField
                    select
                    label="Shopify customer notification"
                    value={customerNotificationOverride === null ? 'default' : 'override'}
                    onChange={(event) => {
                      if (event.target.value === 'default') {
                        setCustomerNotificationOverride(null)
                        setCustomerNotificationOverrideReason('')
                      } else {
                        setCustomerNotificationOverride(
                          !detail.fulfillmentNotificationPolicy.notifyCustomerDefault,
                        )
                        setCustomerNotificationOverrideReason('')
                      }
                    }}
                  >
                    <MenuItem value="default">
                      Use ClawPilot connection default — {detail.fulfillmentNotificationPolicy.notifyCustomerDefault
                        ? 'request customer notification'
                        : 'do not request customer notification'}
                    </MenuItem>
                    <MenuItem value="override">
                      Per-order exception — {detail.fulfillmentNotificationPolicy.notifyCustomerDefault
                        ? 'do not request customer notification'
                        : 'request customer notification'}
                    </MenuItem>
                  </TextField>
                  {customerNotificationOverride !== null ? (
                    <TextField
                      required
                      multiline
                      minRows={2}
                      label="Customer notification exception reason"
                      value={customerNotificationOverrideReason}
                      onChange={(event) => (
                        setCustomerNotificationOverrideReason(event.target.value)
                      )}
                      inputProps={{ maxLength: 500 }}
                      helperText={`${customerNotificationOverrideReason.trim().length}/500 · Audited with this order only`}
                    />
                  ) : null}
                  <Typography variant="caption" color="text.secondary">
                    ClawPilot connection policy revision{' '}
                    {detail.fulfillmentNotificationPolicy.revision} is rechecked transactionally
                    and frozen into the immutable export.
                  </Typography>
                </>
              ) : null}
              <Alert severity="info">
                Packing-slip printing uses the active configured printer route and its approved
                fallback automatically. A print warning will be recorded without rolling back a
                valid shipment.
              </Alert>
              <TextField
                required
                autoFocus
                multiline
                minRows={3}
                label="Shipment confirmation reason"
                value={confirmShipmentReason}
                onChange={(event) => setConfirmShipmentReason(event.target.value)}
                inputProps={{ maxLength: 500 }}
                helperText={`${confirmShipmentReason.trim().length}/500 · Recorded in the audit history`}
              />
            </Stack>
          </DialogContent>
          <DialogActions>
            <Button onClick={closeConfirmShipment} disabled={confirmingShipment}>Cancel</Button>
            <Button
              type="submit"
              variant="contained"
              disabled={
                confirmingShipment
                || !confirmShipmentReason.trim()
                || (
                  customerNotificationOverride !== null
                  && customerNotificationOverrideReason.trim().length < 10
                )
              }
              startIcon={confirmingShipment ? <CircularProgress size={16} /> : <LocalShippingRounded />}
            >
              {confirmingShipment ? 'Confirming shipment' : 'Confirm shipment'}
            </Button>
          </DialogActions>
        </Box>
      </Dialog>

      <Dialog
        open={commerceExportRetryOpen}
        onClose={closeCommerceExportRetry}
        fullWidth
        maxWidth="sm"
      >
        <Box component="form" onSubmit={retryCommerceExport}>
          <DialogTitle>
            {commerceExportReconciliationPending
              ? 'Check commerce fulfillment reconciliation'
              : 'Retry commerce fulfillment export'}
          </DialogTitle>
          <DialogContent dividers>
            <Stack spacing={2}>
              <Alert severity="warning">
                {commerceExportReconciliationPending
                  ? `Safe reconciliation is pending for export ${
                    commerceExportRetryGlobalId || 'evidence'
                  }. Checking it reuses the existing export and immutable customer-notification decision.`
                  : `This retries export ${
                    commerceExportRetryGlobalId || 'evidence'
                  } in place after operator review. It does not create another shipment or export, and it reuses the immutable customer-notification decision captured at shipment confirmation.`}
                {' '}A recent processing attempt must age out before it can be reclaimed safely.
                Once a durable Shopify provider attempt exists, every check is read-only and
                cannot send a second fulfillment or customer notification.
              </Alert>
              <TextField
                required
                autoFocus
                multiline
                minRows={3}
                label={commerceExportReconciliationPending ? 'Check reason' : 'Retry reason'}
                value={commerceExportRetryReason}
                onChange={(event) => setCommerceExportRetryReason(event.target.value)}
                inputProps={{ maxLength: 500 }}
                helperText={`${commerceExportRetryReason.trim().length}/500 · Recorded in audit history`}
              />
            </Stack>
          </DialogContent>
          <DialogActions>
            <Button onClick={closeCommerceExportRetry} disabled={retryingCommerceExport}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant="contained"
              disabled={
                retryingCommerceExport
                || commerceExportRetryReason.trim().length < 10
              }
              startIcon={retryingCommerceExport
                ? <CircularProgress size={16} />
                : <ReplayRounded />}
            >
              {retryingCommerceExport
                ? 'Checking export'
                : commerceExportReconciliationPending
                  ? 'Check now'
                  : 'Retry / reconcile export'}
            </Button>
          </DialogActions>
        </Box>
      </Dialog>

      <Dialog
        open={oneOffGroupPurchaseOpen}
        onClose={closeOneOffGroupPurchase}
        fullWidth
        maxWidth="sm"
      >
        <Box component="form" onSubmit={purchaseOneOffCarrierGroup}>
          <DialogTitle>
            Review whole-shipment purchase
          </DialogTitle>
          <DialogContent dividers>
            <Stack spacing={2}>
              <Alert severity={detail?.oneOffShippingMode === 'live' ? 'error' : 'info'}>
                <Typography fontWeight={800}>
                  {detail?.oneOffShippingMode === 'live'
                    ? 'LIVE · one production carrier charge'
                    : 'TEST · carrier sandbox only'}
                </Typography>
                This submits all {oneOffExecutionState?.packageCount || 0} exact packed parcels as
                one carrier shipment. Success requires a complete package-label set. There is no
                per-package purchase or cancellation path.
              </Alert>

              {oneOffExecutionError && (
                <Alert severity="error">{oneOffExecutionError}</Alert>
              )}

              {oneOffPackedRateExpired && (
                <Alert severity="warning">
                  This packed rate has expired. Close this dialog and refresh the complete group.
                </Alert>
              )}
              {oneOffPackedRateConsumed && (
                <Alert severity="warning">
                  This packed rate was already consumed by a carrier-group attempt. Close this
                  dialog and refresh the complete group before another purchase.
                </Alert>
              )}

              <Box>
                <Typography variant="caption" color="text.secondary">
                  Planning selection
                </Typography>
                <Typography>
                  {oneOffExecutionState
                    ? `${oneOffExecutionState.planning.serviceName} · ${money(String(oneOffExecutionState.planning.amountMinor), oneOffExecutionState.planning.currency)}`
                    : 'Unavailable'}
                </Typography>
              </Box>

              <FormControl required>
                <Typography variant="overline" color="text.secondary">
                  Matching fresh packed rate
                </Typography>
                <RadioGroup
                  value={oneOffGroupPurchaseOfferGlobalId}
                  onChange={(event) => setOneOffGroupPurchaseOfferGlobalId(event.target.value)}
                >
                  <Stack spacing={1}>
                    {oneOffPackedOffers.map((offer) => {
                      const variance = oneOffExecutionState
                        ? offer.amountMinor - oneOffExecutionState.planning.amountMinor
                        : 0
                      return (
                        <Box
                          key={offer.globalId}
                          sx={{
                            p: 1,
                            border: `1px solid ${oneOffGroupPurchaseOfferGlobalId === offer.globalId ? '#A8C7FA' : 'rgba(255,255,255,0.12)'}`,
                            borderRadius: 2,
                          }}
                        >
                          <FormControlLabel
                            value={offer.globalId}
                            control={<Radio />}
                            sx={{ m: 0, width: '100%' }}
                            label={(
                              <Stack direction="row" justifyContent="space-between" gap={1} sx={{ width: '100%' }}>
                                <Box>
                                  <Typography variant="body2" fontWeight={700}>
                                    {offer.providerLabel} · {offer.serviceName}
                                  </Typography>
                                  <Typography variant="caption" color="text.secondary">
                                    Exact planned service · {offer.globalId}
                                  </Typography>
                                </Box>
                                <Box sx={{ textAlign: 'right' }}>
                                  <Typography variant="body2" fontWeight={700}>
                                    {money(String(offer.amountMinor), offer.currency)}
                                  </Typography>
                                  <Typography
                                    variant="caption"
                                    color={variance > 0 ? 'warning.main' : variance < 0 ? 'success.main' : 'text.secondary'}
                                  >
                                    {variance === 0
                                      ? 'No change'
                                      : `${variance > 0 ? '+' : '−'}${money(String(Math.abs(variance)), offer.currency)}`}
                                  </Typography>
                                </Box>
                              </Stack>
                            )}
                          />
                        </Box>
                      )
                    })}
                  </Stack>
                </RadioGroup>
                <FormHelperText>
                  Expires {oneOffExecutionState?.packedRate
                    ? formatUserDateTime(oneOffExecutionState.packedRate.expiresAt, dateTime, {
                      year: 'numeric',
                      month: 'short',
                      day: 'numeric',
                      hour: 'numeric',
                      minute: '2-digit',
                      fallback: 'Unknown',
                    })
                    : 'unavailable'}.
                </FormHelperText>
              </FormControl>

              <TextField
                required
                multiline
                minRows={3}
                label="Whole-shipment purchase reason"
                value={oneOffGroupPurchaseReason}
                onChange={(event) => setOneOffGroupPurchaseReason(event.target.value)}
                inputProps={{ maxLength: 500 }}
                helperText={`${oneOffGroupPurchaseReason.trim().length}/500 · Recorded with the group carrier attempt and audit event`}
              />
              <FormControlLabel
                sx={{ alignItems: 'flex-start' }}
                control={(
                  <Checkbox
                    checked={oneOffGroupPurchaseConfirmed}
                    onChange={(event) => setOneOffGroupPurchaseConfirmed(event.target.checked)}
                  />
                )}
                label={detail?.oneOffShippingMode === 'live'
                  ? `I reviewed the fresh packed rate, variance, and all ${oneOffExecutionState?.packageCount || 0} parcels and authorize this LIVE whole-shipment postage purchase.`
                  : `I reviewed the fresh packed rate, variance, and all ${oneOffExecutionState?.packageCount || 0} parcels and authorize this TEST whole-shipment command.`}
              />
            </Stack>
          </DialogContent>
          <DialogActions>
            <Button onClick={closeOneOffGroupPurchase} disabled={oneOffGroupAction === 'purchase'}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant="contained"
              disabled={
                oneOffGroupAction === 'purchase'
                || !oneOffGroupSelectedOffer
                || oneOffPackedRateExpired
                || oneOffPackedRateConsumed
                || oneOffGroupPurchaseReason.trim().length < 10
                || !oneOffGroupPurchaseConfirmed
                || !oneOffGroupPurchasePermissionsReady()
              }
              startIcon={oneOffGroupAction === 'purchase'
                ? <CircularProgress size={16} />
                : <LocalShippingRounded />}
              data-testid="purchase-one-off-carrier-group"
            >
              {oneOffGroupAction === 'purchase'
                ? 'Purchasing complete shipment'
                : `Purchase ${oneOffExecutionState?.packageCount || 0}-parcel shipment`}
            </Button>
          </DialogActions>
        </Box>
      </Dialog>

      <Dialog open={oneOffGroupVoidOpen} onClose={closeOneOffGroupVoid} fullWidth maxWidth="sm">
        <Box component="form" onSubmit={voidOneOffCarrierGroup}>
          <DialogTitle>
            {oneOffExecutionState?.carrierGroup?.lifecycleMode
              === 'local_sample_close'
              ? 'Close complete UPS TEST sample'
              : 'Void complete shipment group'}
          </DialogTitle>
          <DialogContent dividers>
            <Stack spacing={2}>
              <Alert severity="warning">
                {oneOffExecutionState?.carrierGroup?.lifecycleMode
                  === 'local_sample_close'
                  ? 'UPS CIE returns masked sample identifiers. ClawPilot will retire the complete test group and all package labels locally with zero provider writes.'
                  : `ClawPilot will send one whole-shipment cancellation through the exact carrier account used for purchase. All ${oneOffExecutionState?.carrierGroup?.packageCount || 0} package labels must be retired together.`}
              </Alert>
              {oneOffExecutionError && (
                <Alert severity="error">{oneOffExecutionError}</Alert>
              )}
              <Box>
                <Typography variant="caption" color="text.secondary">Master tracking</Typography>
                <Typography sx={{ overflowWrap: 'anywhere' }}>
                  {oneOffExecutionState?.carrierGroup?.masterTrackingNumber || 'Unavailable'}
                </Typography>
              </Box>
              <TextField
                required
                autoFocus
                multiline
                minRows={3}
                label="Whole-shipment cancellation reason"
                value={oneOffGroupVoidReason}
                onChange={(event) => setOneOffGroupVoidReason(event.target.value)}
                inputProps={{ maxLength: 500 }}
                helperText={`${oneOffGroupVoidReason.trim().length}/500 · Recorded with the group carrier attempt and audit event`}
              />
            </Stack>
          </DialogContent>
          <DialogActions>
            <Button onClick={closeOneOffGroupVoid} disabled={oneOffGroupAction === 'void'}>
              Cancel
            </Button>
            <Button
              type="submit"
              color="error"
              variant="contained"
              disabled={
                oneOffGroupAction === 'void'
                || oneOffGroupVoidReason.trim().length < 10
                || !oneOffGroupVoidPermissionsReady()
              }
              startIcon={oneOffGroupAction === 'void'
                ? <CircularProgress size={16} />
                : <CancelRounded />}
              data-testid="confirm-void-one-off-carrier-group"
            >
              {oneOffGroupAction === 'void'
                ? 'Closing complete group'
                : oneOffExecutionState?.carrierGroup?.lifecycleMode
                  === 'local_sample_close'
                  ? 'Close complete TEST group'
                  : 'Void complete shipment group'}
            </Button>
          </DialogActions>
        </Box>
      </Dialog>

      <Dialog open={createLabelOpen} onClose={closeCreateLabel} fullWidth maxWidth="sm">
        <Box component="form" onSubmit={createSandboxLabel}>
          <DialogTitle>
            {detailCreateLabelPackage
              ? `Create package ${detailCreateLabelPackage.packageNumber} sandbox label`
              : 'Create sandbox carrier label'}
          </DialogTitle>
          <DialogContent dividers>
            <Stack spacing={2}>
              {detailCreateLabelPackage ? (
                <Alert severity="error">
                  Authorized E2E test package only. ClawPilot will create a
                  non-tracking sandbox label for {detailCreateLabelPackage.globalId}
                  using the exact order allocation. Do not void it: after every
                  package is labeled, shipment confirmation will consume the
                  reservation and write all tracking numbers to{' '}
                  {detail?.sourceProvider === 'faire' ? 'Faire' : 'Shopify'}.
                </Alert>
              ) : (
                <Alert severity="warning">
                  Sandbox only. ClawPilot will use John Doe, Test Product, 101 Jegs Place in Delaware,
                  Ohio, and Massachusetts Maritime Academy in Buzzards Bay. Inspect the label and
                  print evidence, then void it immediately.
                </Alert>
              )}
              {detailCreateLabelPackage && (
                <Box>
                  <Typography variant="caption" color="text.secondary">
                    Exact package
                  </Typography>
                  <Typography>
                    Package {detailCreateLabelPackage.packageNumber} of{' '}
                    {detail?.packages.length || 0} · {detailCreateLabelPackage.globalId}
                  </Typography>
                </Box>
              )}
              <Box>
                <Typography variant="caption" color="text.secondary">Selected service</Typography>
                <Typography>
                  {detailSelectedRate
                    ? `${detailSelectedRate.carrier} · ${detailSelectedRate.serviceName}`
                    : 'No carrier service selected'}
                </Typography>
              </Box>
              <TextField
                required
                select
                label="Sandbox carrier account"
                value={carrierAccountGlobalId}
                onChange={(event) => setCarrierAccountGlobalId(event.target.value)}
                helperText="Only active, verified sandbox credentials for the selected carrier are available."
              >
                {eligibleSandboxCarrierAccounts.map((account) => (
                  <MenuItem key={account.globalId} value={account.globalId}>
                    {account.displayName} · •••• {account.accountNumberLastFour}
                  </MenuItem>
                ))}
              </TextField>
              <TextField
                required
                multiline
                minRows={3}
                label="Label creation reason"
                value={createLabelReason}
                onChange={(event) => setCreateLabelReason(event.target.value)}
                inputProps={{ maxLength: 500 }}
                helperText={`${createLabelReason.trim().length}/500 · Recorded with the carrier attempt and audit event`}
              />
            </Stack>
          </DialogContent>
          <DialogActions>
            <Button onClick={closeCreateLabel} disabled={creatingLabel}>Cancel</Button>
            <Button
              type="submit"
              variant="contained"
              disabled={
                creatingLabel
                || !createLabelReason.trim()
                || !carrierAccountGlobalId
                || !detailSelectedRate
                || Boolean(
                  detailCreateLabelPackage
                  && !detail?.sandboxCommerceE2eAuthorization,
                )
              }
              startIcon={creatingLabel ? <CircularProgress size={16} /> : <LocalShippingRounded />}
            >
              {creatingLabel
                ? 'Creating label'
                : 'Create sandbox label'}
            </Button>
          </DialogActions>
        </Box>
      </Dialog>

      <Dialog open={voidLabelOpen} onClose={closeVoidLabel} fullWidth maxWidth="sm">
        <Box component="form" onSubmit={voidSandboxLabel}>
          <DialogTitle>
            Void sandbox carrier label
          </DialogTitle>
          <DialogContent dividers>
            <Stack spacing={2}>
              <Alert severity="warning">
                ClawPilot will void the active label through the exact provider account recorded
                at purchase. This does not accept a replacement account or create another label.
              </Alert>
              <TextField
                required
                autoFocus
                multiline
                minRows={3}
                label="Void reason"
                value={voidLabelReason}
                onChange={(event) => setVoidLabelReason(event.target.value)}
                inputProps={{ maxLength: 500 }}
                helperText={`${voidLabelReason.trim().length}/500 · Recorded with the carrier attempt and audit event`}
              />
            </Stack>
          </DialogContent>
          <DialogActions>
            <Button onClick={closeVoidLabel} disabled={voidingLabel}>Cancel</Button>
            <Button
              type="submit"
              color="error"
              variant="contained"
              disabled={voidingLabel || !voidLabelReason.trim()}
              startIcon={voidingLabel ? <CircularProgress size={16} /> : <CancelRounded />}
            >
              {voidingLabel ? 'Voiding label' : 'Confirm void'}
            </Button>
          </DialogActions>
        </Box>
      </Dialog>

    </Box>
  )
}
