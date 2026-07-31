'use client'

import { FormEvent, forwardRef, type MouseEvent as ReactMouseEvent, useCallback, useEffect, useState } from 'react'
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
  FormControlLabel,
  IconButton,
  InputAdornment,
  MenuItem,
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
import CheckCircleRounded from '@mui/icons-material/CheckCircleRounded'
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
  OperationsExceptionListItem,
  OperationsExceptionStatus,
  OperationsExceptionUpdateResult,
  OperationsOrderCommandResult,
  OperationsOrderDetail,
  OperationsOrderListItem,
  OperationsOrderStatus,
  OperationsPackingSlipCommandResult,
  OperationsSandboxLabelCommandResult,
  OperationsShadowFulfillmentExecutionResult,
  OperationsShadowFulfillmentPreparation,
  OperationsShadowFulfillmentPreparationStage,
  OperationsShipmentCommandResult,
  OperationsWorkspace,
} from '@/lib/operations/types'
import GlCodingPanel from '@/components/operations/GlCodingPanel'
import CommerceImportsPanel from '@/components/operations/CommerceImportsPanel'
import PackagingMaterialsPanel from '@/components/operations/PackagingMaterialsPanel'
import PrinterConfigurationPanel from '@/components/operations/PrinterConfigurationPanel'
import PackRateReplayPanel from '@/components/operations/PackRateReplayPanel'
import ReceivingPanel from '@/components/operations/ReceivingPanel'
import WarehouseSetupPanel from '@/components/operations/WarehouseSetupPanel'
import { useMeasurementSystem } from '@/components/measurements/MeasurementSystemProvider'
import { useUserDateTime } from '@/components/timezone/UserDateTimeProvider'
import { formatDimensionsMm, formatGrams } from '@/lib/measurements'
import { formatUserDateTime } from '@/lib/userDateTime'

type OperationsPayload = {
  ok?: boolean
  error?: string
  code?: string
  operations?: OperationsWorkspace
  result?:
    | OperationsExceptionUpdateResult
    | OperationsActivationUpdateResult
    | OperationsCommerceActivePreparationResult
    | OperationsCommerceActiveTransitionResult
    | OperationsOrderCommandResult
    | OperationsPackingSlipCommandResult
    | OperationsSandboxLabelCommandResult
    | OperationsShadowFulfillmentExecutionResult
    | OperationsShipmentCommandResult
}

export type OperationsView =
  | 'orders'
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

const ACTIVATION_OPTIONS: Array<{ value: OperationsActivationState; label: string }> = [
  { value: 'disabled', label: 'Disabled' },
  { value: 'shadow', label: 'Shadow' },
  { value: 'read_only', label: 'Read only' },
  { value: 'active', label: 'Active' },
  { value: 'frozen', label: 'Frozen' },
]

const CARTONIZATION_EVIDENCE_GLOBAL_ID = /^gcte\d{7}$/

type CommerceActiveAccountOption = {
  accountGlobalId: string
  displayName: string
  provider: 'shopify' | 'faire'
  environment: 'sandbox' | 'production'
  capabilities: Array<{
    capability: CommerceActiveWriteCapability
    selectable: boolean
    unavailableReason: 'not_implemented' | 'missing_scope' | null
  }>
}

type CommerceActiveCatalogPayload = {
  ok?: boolean
  error?: string
  integrations?: {
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
      return {
        capability,
        selectable: implemented && scopeEligible,
        unavailableReason: !implemented
          ? 'not_implemented' as const
          : !scopeEligible
            ? 'missing_scope' as const
            : null,
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
              key={attempt.provider}
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
  activationState,
  canExecute,
  open,
  busy,
  onClose,
  onPlan,
  onRelease,
  onConfirmPicks,
  onVerifyPack,
  onPrepareFulfillment,
  onGeneratePackingSlip,
  onPrintPackingSlip,
  onConfirmShipment,
  onCreateSandboxLabel,
  onVoidSandboxLabel,
  generatingPackingSlipPackageId,
  printingPackingSlipArtifactId,
}: {
  order: OperationsOrderDetail | null
  sandboxCarrierAccounts: OperationsWorkspace['shipping']['sandboxCarrierAccounts']
  activationState: OperationsActivationState
  canExecute: boolean
  open: boolean
  busy: boolean
  onClose: () => void
  onPlan: () => void
  onRelease: () => void
  onConfirmPicks: () => void
  onVerifyPack: () => void
  onPrepareFulfillment: () => void
  onGeneratePackingSlip: (packageGlobalId: string) => void
  onPrintPackingSlip: (artifactGlobalId: string) => void
  onConfirmShipment: () => void
  onCreateSandboxLabel: () => void
  onVoidSandboxLabel: () => void
  generatingPackingSlipPackageId: string | null
  printingPackingSlipArtifactId: string | null
}) {
  const theme = useTheme()
  const mobile = useMediaQuery(theme.breakpoints.down('md'))
  const dateTime = useUserDateTime()
  const { measurementSystem } = useMeasurementSystem()
  const releaseAction = order?.availableActions?.find((item) => item.action === 'release_to_warehouse')
  const confirmPicksAction = order?.availableActions?.find((item) => item.action === 'confirm_picks')
  const verifyPackAction = order?.availableActions?.find((item) => item.action === 'verify_pack')
  const prepareFulfillmentAction = order?.availableActions?.find((item) => item.action === 'prepare_fulfillment')
  const confirmShipmentAction = order?.availableActions?.find((item) => item.action === 'confirm_shipment')
  const canPlanImportedOrder = Boolean(
    order?.status === 'imported'
    && order.sourceProvider
    && order.sourceProvider !== 'mock-commerce',
  )
  const primaryAction = canPlanImportedOrder
    ? undefined
    : order?.status === 'released'
      ? confirmPicksAction
      : order?.status === 'picking'
        ? verifyPackAction
        : order?.status === 'packed'
          ? activationState === 'shadow'
            ? prepareFulfillmentAction
            : confirmShipmentAction
          : order && !['shipped', 'cancelled'].includes(order.status)
            ? releaseAction
            : undefined
  const confirmingPicks = primaryAction?.action === 'confirm_picks'
  const verifyingPack = primaryAction?.action === 'verify_pack'
  const preparingFulfillment = primaryAction?.action === 'prepare_fulfillment'
  const confirmingShipment = primaryAction?.action === 'confirm_shipment'
  const shipments = order?.shipments || []
  const trackingObservations = order?.trackingObservations || []
  const printArtifacts = order?.printArtifacts || []
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
  const activeExecutionRequiredReason = activationState !== 'active'
    ? 'Carrier label create and void actions require Operations Active mode.'
    : null
  const createBlockedReason = activeExecutionRequiredReason
    || (!canExecute
      ? 'You do not have permission to purchase carrier labels.'
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
                  : null)
  const voidBlockedReason = activeExecutionRequiredReason
    || (!canExecute
      ? 'You do not have permission to void carrier labels.'
      : unresolvedAttempt
        ? `Attempt ${unresolvedAttempt.globalId} requires reconciliation before a carrier command.`
        : null)

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
            <DetailSection title="Overview">
              <Box sx={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 1.5 }}>
                <Box><Typography variant="caption" color="text.secondary">Customer</Typography><Typography>{order.customerName}</Typography><Typography variant="caption" color="#A8C7FA">{order.customerGlobalId}</Typography></Box>
                <Box><Typography variant="caption" color="text.secondary">Warehouse</Typography><Typography>{order.warehouseName || 'Unassigned'}</Typography></Box>
                <Box><Typography variant="caption" color="text.secondary">Promise</Typography><Typography>{formatUserDateTime(order.promisedDeliveryAt, dateTime, { year: 'numeric', month: 'short', day: 'numeric', fallback: 'Not promised' })}</Typography></Box>
                <Box><Typography variant="caption" color="text.secondary">Tracking</Typography><Typography sx={{ overflowWrap: 'anywhere' }}>{order.trackingNumber || 'Not shipped'}</Typography></Box>
              </Box>
              <Typography variant="body2" color="text.secondary" sx={{ mt: 1.5 }}>
                {order.shipTo.name} · {order.shipTo.line1}{order.shipTo.line2 ? `, ${order.shipTo.line2}` : ''}, {order.shipTo.city}, {order.shipTo.region} {order.shipTo.postalCode}
              </Typography>
            </DetailSection>

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
                        onClick={onPlan}
                      >
                        {busy ? 'Planning' : 'Plan order'}
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
                <Tooltip title={primaryAction.blockedReason || (confirmingPicks
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
                      onClick={confirmingPicks
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
                        ? confirmingPicks
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
                      && item.contents.length > 0
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
                          {item.contents.length > 0 ? (
                            <Stack divider={<Divider flexItem />}>
                              {item.contents.map((content) => (
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

            <DetailSection title="Shipping execution">
              <Stack spacing={1.5}>
                {activeExecutionRequiredReason && (
                  <Alert
                    severity="info"
                    data-testid="carrier-label-active-mode-required"
                  >
                    {activeExecutionRequiredReason}
                  </Alert>
                )}
                {unresolvedAttempt && (
                  <Alert severity="error">
                    Carrier attempt {unresolvedAttempt.globalId} is {unresolvedAttempt.state}. Do not retry this
                    purchase or void. Reconcile the carrier result first so ClawPilot cannot create a duplicate label.
                  </Alert>
                )}
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
                ) : !activeExecutionRequiredReason ? (
                  <Alert severity={createBlockedReason ? 'info' : 'warning'}>
                    {createBlockedReason
                      || 'Sandbox execution uses the fixed John Doe test shipment. Create the label, inspect the print evidence, then void it immediately.'}
                  </Alert>
                ) : null}
                {!activeLabel && (
                  <Tooltip title={createBlockedReason || 'Purchase a sandbox label and route its print job'}>
                    <span>
                      <Button
                        fullWidth
                        variant="contained"
                        startIcon={<LocalShippingRounded />}
                        disabled={busy || Boolean(createBlockedReason)}
                        onClick={onCreateSandboxLabel}
                      >
                        Create sandbox label
                      </Button>
                    </span>
                  </Tooltip>
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
              </Stack>
            </DetailSection>

            <DetailSection title="Shipment evidence">
              {shipments.length === 0
                && trackingObservations.length === 0
                && printArtifacts.length === 0
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
                          {commerceExports.map((fulfillmentExport) => (
                            <Box
                              key={fulfillmentExport.globalId}
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
                                {(fulfillmentExport.errorCode || fulfillmentExport.errorMessage) && (
                                  <Typography variant="caption" color="error.main" display="block">
                                    {[fulfillmentExport.errorCode, fulfillmentExport.errorMessage]
                                      .filter(Boolean)
                                      .join(' · ')}
                                  </Typography>
                                )}
                              </Box>
                              <Chip
                                size="small"
                                label={displayStatus(fulfillmentExport.state)}
                                color={fulfillmentExport.state === 'succeeded'
                                  ? 'success'
                                  : fulfillmentExport.state === 'failed'
                                    ? 'error'
                                    : fulfillmentExport.state === 'unsupported'
                                      ? 'default'
                                      : 'warning'}
                              />
                            </Box>
                          ))}
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
  busy,
  onClose,
  onTransition,
  onOpenOrder,
}: {
  exception: OperationsExceptionListItem | null
  open: boolean
  canManage: boolean
  busy: boolean
  onClose: () => void
  onTransition: (status: OperationsExceptionStatus) => void
  onOpenOrder: (orderGlobalId: string) => void
}) {
  const theme = useTheme()
  const mobile = useMediaQuery(theme.breakpoints.down('md'))
  const dateTime = useUserDateTime()
  const recommendedAction = typeof exception?.details.recommendedAction === 'string'
    ? exception.details.recommendedAction
    : ''
  const evidence = exception?.details.evidence ?? exception?.details
  const evidenceText = evidence && typeof evidence === 'object' && Object.keys(evidence).length > 0
    ? JSON.stringify(evidence, null, 2)
    : ''
  const transitions: Array<{ status: OperationsExceptionStatus; label: string }> = exception?.status === 'open'
    ? [{ status: 'acknowledged', label: 'Acknowledge' }, { status: 'resolved', label: 'Resolve' }, { status: 'dismissed', label: 'Dismiss' }]
    : exception?.status === 'acknowledged'
      ? [{ status: 'resolved', label: 'Resolve' }, { status: 'open', label: 'Reopen' }, { status: 'dismissed', label: 'Dismiss' }]
      : [{ status: 'open', label: 'Reopen' }]

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
                <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
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
              </DetailSection>
            )}
          </Stack>
        </Box>
      )}
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
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [view, setView] = useState<OperationsView>(initialView)
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState<'' | OperationsOrderStatus>('')
  const [exceptionStatus, setExceptionStatus] = useState<'' | OperationsExceptionStatus>('')
  const [selectedGlobalId, setSelectedGlobalId] = useState<string | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [selectedExceptionGlobalId, setSelectedExceptionGlobalId] = useState<string | null>(null)
  const [exceptionDrawerOpen, setExceptionDrawerOpen] = useState(false)
  const [updatingException, setUpdatingException] = useState(false)
  const [guideOpen, setGuideOpen] = useState(false)
  const [updatingActivation, setUpdatingActivation] = useState(false)
  const [commerceActiveOpen, setCommerceActiveOpen] = useState(false)
  const [commerceActivePending, setCommerceActivePending] = useState<
    '' | 'loading' | 'preparing' | 'activating'
  >('')
  const [commerceActiveError, setCommerceActiveError] = useState('')
  const [commerceActiveAccounts, setCommerceActiveAccounts] = useState<
    CommerceActiveAccountOption[]
  >([])
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
  const [confirmPicksOpen, setConfirmPicksOpen] = useState(false)
  const [confirmPicksReason, setConfirmPicksReason] = useState('Confirm all ready pick tasks for the released wave')
  const [confirmPicksIdempotencyKey, setConfirmPicksIdempotencyKey] = useState('')
  const [confirmingPicks, setConfirmingPicks] = useState(false)
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
  const [createLabelOpen, setCreateLabelOpen] = useState(false)
  const [createLabelReason, setCreateLabelReason] = useState('Purchase a sandbox label for pack-to-ship validation')
  const [createLabelIdempotencyKey, setCreateLabelIdempotencyKey] = useState('')
  const [carrierAccountGlobalId, setCarrierAccountGlobalId] = useState('')
  const [creatingLabel, setCreatingLabel] = useState(false)
  const [voidLabelOpen, setVoidLabelOpen] = useState(false)
  const [voidLabelReason, setVoidLabelReason] = useState('Void the sandbox label after validation')
  const [voidLabelIdempotencyKey, setVoidLabelIdempotencyKey] = useState('')
  const [voidingLabel, setVoidingLabel] = useState(false)
  const [
    generatingPackingSlipPackageId,
    setGeneratingPackingSlipPackageId,
  ] = useState<string | null>(null)
  const [
    printingPackingSlipArtifactId,
    setPrintingPackingSlipArtifactId,
  ] = useState<string | null>(null)

  useEffect(() => {
    setView(initialView)
    setSearch('')
    setSelectedGlobalId(null)
    setDrawerOpen(false)
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
      const payload = await response.json() as OperationsPayload
      if (!response.ok || !payload.operations) throw new Error(payload.error || 'Operations data is unavailable')
      setWorkspace(payload.operations)
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === 'AbortError') return
      setError(caught instanceof Error ? caught.message : 'Operations data is unavailable')
    } finally {
      if (!signal?.aborted) setLoading(false)
    }
  }, [exceptionStatus, search, status, view])

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

  const chooseOrder = (order: OperationsOrderListItem) => {
    setSelectedGlobalId(order.globalId)
    setDrawerOpen(true)
  }

  const closeDrawer = () => {
    setDrawerOpen(false)
    setSelectedGlobalId(null)
  }

  const chooseException = (exception: OperationsExceptionListItem) => {
    setSelectedExceptionGlobalId(exception.globalId)
    setExceptionDrawerOpen(true)
  }

  const closeExceptionDrawer = () => {
    setExceptionDrawerOpen(false)
    setSelectedExceptionGlobalId(null)
  }

  const openExceptionOrder = (orderGlobalId: string) => {
    closeExceptionDrawer()
    setView('orders')
    setSelectedGlobalId(orderGlobalId)
    setDrawerOpen(true)
  }

  const openPlan = () => {
    setPlanCartonizationEvidenceGlobalId('')
    setPlanReason(
      'Accept the reviewed cartonization evidence as the canonical warehouse plan',
    )
    setPlanIdempotencyKey(
      `operations-plan:${detail?.globalId || 'order'}:${crypto.randomUUID()}`,
    )
    setPlanError('')
    setPlanOpen(true)
  }

  const closePlan = () => {
    if (planningOrder) return
    setPlanOpen(false)
    setPlanIdempotencyKey('')
    setPlanError('')
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

  const openConfirmShipment = () => {
    setConfirmShipmentReason('Confirm the packed order and create shipment evidence')
    setConfirmShipmentIdempotencyKey(
      `operations-shipment:${detail?.globalId || 'order'}:${crypto.randomUUID()}`,
    )
    setConfirmShipmentOpen(true)
  }

  const closeConfirmShipment = () => {
    if (confirmingShipment) return
    setConfirmShipmentOpen(false)
    setConfirmShipmentIdempotencyKey('')
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
          : `Commerce fulfillment export ${result.commerceExportGlobalId} failed and requires review.`
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

  const openCreateLabel = () => {
    const selectedRate = detail?.rates.find((rate) => rate.selected)
    const provider = selectedRate ? providerForCarrier(selectedRate.carrier) : null
    const account = workspace?.shipping?.sandboxCarrierAccounts.find(
      (item) => item.provider === provider,
    )
    setCarrierAccountGlobalId(account?.globalId || '')
    setCreateLabelReason('Purchase a sandbox label for pack-to-ship validation')
    setCreateLabelIdempotencyKey(`operations-label-create:${detail?.globalId || 'order'}:${crypto.randomUUID()}`)
    setCreateLabelOpen(true)
  }

  const closeCreateLabel = () => {
    if (creatingLabel) return
    setCreateLabelOpen(false)
    setCreateLabelIdempotencyKey('')
    setCarrierAccountGlobalId('')
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
      setNotice(
        result.printWarning
          ? `Sandbox label ${result.labelGlobalId} was created with tracking ${result.trackingNumber}. ${result.printWarning}`
          : `Sandbox label ${result.labelGlobalId} was created with tracking ${result.trackingNumber} and print job ${result.printJobGlobalId}.`,
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
      setCommerceActiveSelections(Object.fromEntries(
        accounts.map((account) => [
          account.accountGlobalId,
          account.capabilities
            .filter((option) => option.selectable)
            .map((option) => option.capability),
        ]),
      ))
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

  const commerceActiveSelectedAccountCount = Object.values(
    commerceActiveSelections,
  ).filter((entries) => entries.length > 0).length
  const commerceActiveSelectedCapabilityCount = Object.values(
    commerceActiveSelections,
  ).reduce((total, entries) => total + entries.length, 0)
  const capabilities = workspace?.capabilities
  const detail = workspace?.selectedOrder?.globalId === selectedGlobalId ? workspace.selectedOrder : null
  const planEvidenceValid = CARTONIZATION_EVIDENCE_GLOBAL_ID.test(
    planCartonizationEvidenceGlobalId.trim().toLowerCase(),
  )
  const detailSelectedRate = detail?.rates.find((rate) => rate.selected) || null
  const detailSelectedProvider = detailSelectedRate
    ? providerForCarrier(detailSelectedRate.carrier)
    : null
  const eligibleSandboxCarrierAccounts = detailSelectedProvider
    ? workspace?.shipping?.sandboxCarrierAccounts.filter(
        (account) => account.provider === detailSelectedProvider,
      ) || []
    : []
  const selectedException = workspace?.exceptions.find((item) => item.globalId === selectedExceptionGlobalId) || null
  const summary = workspace?.summary
  const empty = !loading && (
    view === 'orders'
      ? workspace?.orders.length === 0
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
      : `Distributed fulfillment${workspace ? ` · CRM: ${workspace.dataPipeline.name}` : ''}`

  return (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column', minWidth: 0, overflow: 'hidden' }}>
      <Box sx={{ px: { xs: 2, md: 3 }, pt: { xs: 2, md: 2.5 }, pb: 1.5, borderBottom: '1px solid rgba(255,255,255,0.07)', flexShrink: 0 }}>
        <Stack direction={{ xs: 'column', sm: 'row' }} justifyContent="space-between" alignItems={{ xs: 'stretch', sm: 'center' }} gap={1.5}>
          <Box>
            <Stack direction="row" spacing={1} alignItems="center">
              <Typography variant="h5" fontWeight={700}>{heading}</Typography>
              {mainWorkspaceView && workspace && (
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
            {workspace?.capabilities.canActivate && (
              <Tooltip title="Controls whether Operations is disabled, validating mock flows, read only, live, or frozen">
                <TextField
                  select
                  size="small"
                  value={workspace.activation.state}
                  onChange={(event) => requestActivationChange(
                    event.target.value as OperationsActivationState,
                  )}
                  disabled={updatingActivation}
                  inputProps={{ 'aria-label': 'Operations activation mode' }}
                  sx={{ ...controlSx, minWidth: 118 }}
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
                    >
                      {option.label}
                    </MenuItem>
                  ))}
                </TextField>
              </Tooltip>
            )}
            <Tooltip title="Operations guide"><IconButton aria-label="Open operations guide" onClick={() => setGuideOpen(true)}><HelpOutlineRounded /></IconButton></Tooltip>
            {mainWorkspaceView && (
              <Tooltip title="Refresh orders"><span><IconButton aria-label="Refresh operations" disabled={loading} onClick={() => void loadWorkspace(selectedGlobalId)}><RefreshRounded /></IconButton></span></Tooltip>
            )}
          </Stack>
        </Stack>

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
            <Tab value="orders" label={`Orders${workspace ? ` (${workspace.orders.length})` : ''}`} />
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

      <Box sx={{ flex: 1, minHeight: 0, overflow: 'auto', WebkitOverflowScrolling: 'touch' }}>
        {view === 'imports' ? (
          <CommerceImportsPanel />
        ) : view === 'receiving' ? (
          <ReceivingPanel workspace={workspace} onRefresh={() => loadWorkspace()} />
        ) : view === 'warehouses' ? (
          <WarehouseSetupPanel
            workspace={workspace}
            onRefresh={() => loadWorkspace()}
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

      <OrderDetailDrawer
        order={detail}
        sandboxCarrierAccounts={workspace?.shipping?.sandboxCarrierAccounts || []}
        activationState={workspace?.activation.state || 'disabled'}
        canExecute={Boolean(capabilities?.canManage && capabilities.canExecute)}
        open={drawerOpen}
        busy={
          planningOrder
          || releasingOrder
          || confirmingPicks
          || verifyingPack
          || preparingFulfillment
          || confirmingShipment
          || creatingLabel
          || voidingLabel
          || Boolean(generatingPackingSlipPackageId)
          || Boolean(printingPackingSlipArtifactId)
        }
        onClose={closeDrawer}
        onPlan={openPlan}
        onRelease={openRelease}
        onConfirmPicks={openConfirmPicks}
        onVerifyPack={openVerifyPack}
        onPrepareFulfillment={openPrepareFulfillment}
        onGeneratePackingSlip={(packageGlobalId) => {
          void generatePackingSlip(packageGlobalId)
        }}
        onPrintPackingSlip={(artifactGlobalId) => {
          void printPackingSlip(artifactGlobalId)
        }}
        onConfirmShipment={openConfirmShipment}
        onCreateSandboxLabel={openCreateLabel}
        onVoidSandboxLabel={openVoidLabel}
        generatingPackingSlipPackageId={generatingPackingSlipPackageId}
        printingPackingSlipArtifactId={printingPackingSlipArtifactId}
      />
      <ExceptionDetailDrawer
        exception={selectedException}
        open={exceptionDrawerOpen}
        canManage={Boolean(capabilities?.canManage)}
        busy={updatingException}
        onClose={closeExceptionDrawer}
        onTransition={(nextStatus) => void transitionException(nextStatus)}
        onOpenOrder={openExceptionOrder}
      />
      <OperationsGuide open={guideOpen} onClose={() => setGuideOpen(false)} />

      <Dialog
        open={commerceActiveOpen}
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
                    effect and the verified account retains every required provider scope. Clear
                    every capability for an account to exclude it.
                  </Typography>
                </Box>
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
                                <Chip
                                  size="small"
                                  variant="outlined"
                                  label={
                                    option.unavailableReason === 'not_implemented'
                                      ? 'Not implemented'
                                      : 'Missing scope'
                                  }
                                />
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

      <Dialog open={planOpen} onClose={closePlan} fullWidth maxWidth="sm">
        <Box component="form" onSubmit={planOrder}>
          <DialogTitle>Plan imported order</DialogTitle>
          <DialogContent dividers>
            <Stack spacing={2}>
              <Alert severity="info">
                Accept reviewed immutable cartonization evidence for{' '}
                {detail?.orderNumber || 'this imported order'} into its canonical
                warehouse plan. This command does not purchase postage, create a
                label, print a packing slip, or confirm a shipment.
              </Alert>
              {planError && (
                <Alert severity="error" onClose={() => setPlanError('')}>
                  {planError}
                </Alert>
              )}
              <TextField
                required
                autoFocus
                label="Cartonization evidence Global ID"
                value={planCartonizationEvidenceGlobalId}
                onChange={(event) => {
                  setPlanCartonizationEvidenceGlobalId(
                    event.target.value.toLowerCase(),
                  )
                  setPlanError('')
                }}
                error={Boolean(
                  planCartonizationEvidenceGlobalId.trim()
                  && !planEvidenceValid
                )}
                inputProps={{
                  maxLength: 11,
                  pattern: 'gcte[0-9]{7}',
                  autoCapitalize: 'none',
                  autoCorrect: 'off',
                  spellCheck: false,
                }}
                helperText={planEvidenceValid
                  ? 'Valid immutable cartonization evidence reference'
                  : 'Enter a Global ID in the form gcte0000001'}
              />
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
            <Button onClick={closePlan} disabled={planningOrder}>Cancel</Button>
            <Button
              type="submit"
              variant="contained"
              disabled={
                planningOrder
                || !planEvidenceValid
                || !planReason.trim()
              }
              startIcon={planningOrder
                ? <CircularProgress size={16} />
                : <Inventory2Rounded />}
            >
              {planningOrder ? 'Planning order' : 'Confirm plan'}
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
                configured UPS and FedEx sandbox accounts. It stores immutable
                checkout, pre-label fulfillment, variance, and carrier-attempt
                evidence only.
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
                readiness checks are repeated when you confirm.
              </Alert>
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
              disabled={confirmingShipment || !confirmShipmentReason.trim()}
              startIcon={confirmingShipment ? <CircularProgress size={16} /> : <LocalShippingRounded />}
            >
              {confirmingShipment ? 'Confirming shipment' : 'Confirm shipment'}
            </Button>
          </DialogActions>
        </Box>
      </Dialog>

      <Dialog open={createLabelOpen} onClose={closeCreateLabel} fullWidth maxWidth="sm">
        <Box component="form" onSubmit={createSandboxLabel}>
          <DialogTitle>Create sandbox carrier label</DialogTitle>
          <DialogContent dividers>
            <Stack spacing={2}>
              <Alert severity="warning">
                Sandbox only. ClawPilot will use John Doe, Test Product, 101 Jegs Place in Delaware,
                Ohio, and Massachusetts Maritime Academy in Buzzards Bay. Inspect the label and
                print evidence, then void it immediately.
              </Alert>
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
              }
              startIcon={creatingLabel ? <CircularProgress size={16} /> : <LocalShippingRounded />}
            >
              {creatingLabel ? 'Creating label' : 'Create sandbox label'}
            </Button>
          </DialogActions>
        </Box>
      </Dialog>

      <Dialog open={voidLabelOpen} onClose={closeVoidLabel} fullWidth maxWidth="sm">
        <Box component="form" onSubmit={voidSandboxLabel}>
          <DialogTitle>Void sandbox carrier label</DialogTitle>
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
