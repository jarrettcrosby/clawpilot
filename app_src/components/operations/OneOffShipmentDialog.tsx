'use client'

import {
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from 'react'
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
  FormControl,
  FormControlLabel,
  FormHelperText,
  IconButton,
  InputLabel,
  MenuItem,
  Radio,
  RadioGroup,
  Select,
  Stack,
  Step,
  StepLabel,
  Stepper,
  TextField,
  Tooltip,
  Typography,
  useMediaQuery,
  useTheme,
} from '@mui/material'
import AddRounded from '@mui/icons-material/AddRounded'
import CloseRounded from '@mui/icons-material/CloseRounded'
import DeleteOutlineRounded from '@mui/icons-material/DeleteOutlineRounded'
import Inventory2Rounded from '@mui/icons-material/Inventory2Rounded'
import LocalShippingRounded from '@mui/icons-material/LocalShippingRounded'
import ScienceRounded from '@mui/icons-material/ScienceRounded'
import {
  type OneOffShipmentCreateResult,
  type OneOffShipmentQuote,
  type OneOffShipmentQuoteInput,
  type OneOffShipmentWorkspace,
} from '@/lib/operations/oneOffShipments'
import { ONE_OFF_MAX_SYNCHRONOUS_PACKAGES } from '@/lib/operations/oneOffShipmentConstants'

type DraftLine = {
  lineKey: string
  kind: 'existing' | 'new'
  productGlobalId: string
  name: string
  sku: string
  quantity: string
  unitPriceMinor: string
  unitWeightGrams: string
  lengthMm: string
  widthMm: string
  heightMm: string
  physicalUnitsOnHandConfirmed: boolean
}

type DraftPackage = {
  packageKey: string
  description: string
  lengthMm: string
  widthMm: string
  heightMm: string
  grossWeightGrams: string
  allocations: Record<string, string>
}

type WorkspacePayload = {
  ok?: boolean
  error?: string
  workspace?: OneOffShipmentWorkspace
}

type QuotePayload = {
  ok?: boolean
  error?: string
  code?: string
  quote?: OneOffShipmentQuote
}

type CreatePayload = {
  ok?: boolean
  error?: string
  code?: string
  result?: OneOffShipmentCreateResult
}

const STEPS = ['Shipment and units', 'Parcels', 'Review rates']
const MAX_LINES = 25

function nextKey(prefix: 'line' | 'parcel') {
  return `${prefix}-${crypto.randomUUID()}`
}

function nextQuoteIdempotencyKey() {
  return `operations-one-off-quote:${crypto.randomUUID()}`
}

function initialLine(): DraftLine {
  return {
    lineKey: nextKey('line'),
    kind: 'existing',
    productGlobalId: '',
    name: '',
    sku: '',
    quantity: '1',
    unitPriceMinor: '0',
    unitWeightGrams: '',
    lengthMm: '',
    widthMm: '',
    heightMm: '',
    physicalUnitsOnHandConfirmed: false,
  }
}

function initialPackage(lines: DraftLine[]): DraftPackage {
  return {
    packageKey: nextKey('parcel'),
    description: 'One-off shipment parcel',
    lengthMm: '',
    widthMm: '',
    heightMm: '',
    grossWeightGrams: '',
    allocations: Object.fromEntries(lines.map((line) => [line.lineKey, line.quantity])),
  }
}

function positiveInteger(value: string) {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}

function nonNegativeInteger(value: string) {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null
}

function formatMoney(minor: number, currency: string) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
  }).format(minor / 100)
}

function formatDelivery(value: string | null, transitDays: number | null) {
  if (value) {
    const date = new Date(value)
    if (!Number.isNaN(date.valueOf())) {
      return date.toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      })
    }
  }
  return transitDays === null
    ? 'Delivery estimate unavailable'
    : `${transitDays} business ${transitDays === 1 ? 'day' : 'days'}`
}

export default function OneOffShipmentDialog({
  open,
  onClose,
  onCreated,
  canActivate,
}: {
  open: boolean
  onClose: () => void
  onCreated: (result: OneOffShipmentCreateResult) => void | Promise<void>
  canActivate: boolean
}) {
  const theme = useTheme()
  const mobile = useMediaQuery(theme.breakpoints.down('sm'))
  const [workspace, setWorkspace] = useState<OneOffShipmentWorkspace | null>(null)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState<'quote' | 'create' | ''>('')
  const [error, setError] = useState('')
  const [step, setStep] = useState(0)
  const [customerGlobalId, setCustomerGlobalId] = useState('')
  const [warehouseGlobalId, setWarehouseGlobalId] = useState('')
  const [inventoryPoolGlobalId, setInventoryPoolGlobalId] = useState('')
  const [receivingLocationGlobalId, setReceivingLocationGlobalId] = useState('')
  const [referenceNumber, setReferenceNumber] = useState('')
  const [requestedDeliveryAt, setRequestedDeliveryAt] = useState('')
  const [executionMode, setExecutionMode] = useState<'test' | 'live'>('test')
  const [shipFromPhone, setShipFromPhone] = useState('')
  const [shipToPhone, setShipToPhone] = useState('')
  const [shipToResidential, setShipToResidential] = useState<boolean | null>(null)
  const [recipientName, setRecipientName] = useState('')
  const [line1, setLine1] = useState('')
  const [line2, setLine2] = useState('')
  const [city, setCity] = useState('')
  const [region, setRegion] = useState('')
  const [postalCode, setPostalCode] = useState('')
  const [lines, setLines] = useState<DraftLine[]>(() => [initialLine()])
  const [packages, setPackages] = useState<DraftPackage[]>([])
  const [quote, setQuote] = useState<OneOffShipmentQuote | null>(null)
  const [selectedOfferGlobalId, setSelectedOfferGlobalId] = useState('')
  const [quoteIdempotencyKey, setQuoteIdempotencyKey] = useState(
    nextQuoteIdempotencyKey,
  )
  const [freshRateRetryAvailable, setFreshRateRetryAvailable] = useState(false)
  const [reason, setReason] = useState(
    'Create and plan this reviewed one-off shipment from the selected physical inventory',
  )
  const [createIdempotencyKey, setCreateIdempotencyKey] = useState('')

  const selectedWarehouse = useMemo(() => (
    workspace?.warehouses.find((warehouse) => warehouse.globalId === warehouseGlobalId)
    || null
  ), [warehouseGlobalId, workspace])

  const enabledCarriers = useMemo(() => (
    workspace?.carriers.filter((carrier) => (
      carrier.environment === (executionMode === 'live' ? 'production' : 'sandbox')
      && (
      !carrier.senderOriginWarehouseGlobalId
      || carrier.senderOriginWarehouseGlobalId === warehouseGlobalId
      )
    )) || []
  ), [executionMode, warehouseGlobalId, workspace])

  const resetQuote = () => {
    setQuote(null)
    setSelectedOfferGlobalId('')
    setQuoteIdempotencyKey(nextQuoteIdempotencyKey())
    setFreshRateRetryAvailable(false)
    setCreateIdempotencyKey('')
  }

  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    setLoading(true)
    setError('')
    void (async () => {
      try {
        const response = await fetch('/api/operations/one-off-shipments', {
          cache: 'no-store',
          signal: controller.signal,
        })
        const payload = await response.json().catch(() => ({})) as WorkspacePayload
        if (!response.ok || !payload.ok || !payload.workspace) {
          throw new Error(payload.error || 'One-off shipment setup is unavailable')
        }
        const nextWorkspace = payload.workspace
        setWorkspace(nextWorkspace)
        setCustomerGlobalId((current) => (
          nextWorkspace.customers.some((customer) => customer.globalId === current)
            ? current
            : nextWorkspace.customers[0]?.globalId || ''
        ))
        setWarehouseGlobalId((current) => (
          nextWorkspace.warehouses.some((warehouse) => warehouse.globalId === current)
            ? current
            : nextWorkspace.warehouses[0]?.globalId || ''
        ))
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === 'AbortError') return
        setError(caught instanceof Error
          ? caught.message
          : 'One-off shipment setup is unavailable')
      } finally {
        if (!controller.signal.aborted) setLoading(false)
      }
    })()
    return () => controller.abort()
  }, [open])

  useEffect(() => {
    if (!selectedWarehouse) {
      setInventoryPoolGlobalId('')
      setReceivingLocationGlobalId('')
      return
    }
    setInventoryPoolGlobalId((current) => (
      selectedWarehouse.inventoryPools.some((pool) => pool.globalId === current)
        ? current
        : selectedWarehouse.inventoryPools[0]?.globalId || ''
    ))
    setReceivingLocationGlobalId((current) => (
      selectedWarehouse.receivingLocations.some((location) => location.globalId === current)
        ? current
        : selectedWarehouse.receivingLocations[0]?.globalId || ''
    ))
  }, [selectedWarehouse])

  useEffect(() => {
    if (packages.length) return
    setPackages([initialPackage(lines)])
  }, [lines, packages.length])

  const selectedPoolAvailability = (productGlobalId: string) => {
    const product = workspace?.products.find((entry) => entry.globalId === productGlobalId)
    return product?.availability.find((availability) => (
      availability.warehouseGlobalId === warehouseGlobalId
      && availability.inventoryPoolGlobalId === inventoryPoolGlobalId
    ))?.availableQuantity ?? 0
  }

  const updateLine = (lineKey: string, patch: Partial<DraftLine>) => {
    setLines((current) => current.map((line) => (
      line.lineKey === lineKey ? { ...line, ...patch } : line
    )))
    if (patch.quantity !== undefined && packages.length === 1) {
      setPackages((current) => current.map((parcel) => ({
        ...parcel,
        allocations: {
          ...parcel.allocations,
          [lineKey]: patch.quantity || '0',
        },
      })))
    }
    resetQuote()
  }

  const addLine = () => {
    if (lines.length >= MAX_LINES) return
    const line = initialLine()
    setLines((current) => [...current, line])
    setPackages((current) => current.map((parcel, index) => ({
      ...parcel,
      allocations: {
        ...parcel.allocations,
        [line.lineKey]: index === 0 ? line.quantity : '0',
      },
    })))
    resetQuote()
  }

  const removeLine = (lineKey: string) => {
    if (lines.length === 1) return
    setLines((current) => current.filter((line) => line.lineKey !== lineKey))
    setPackages((current) => current.map((parcel) => {
      const allocations = { ...parcel.allocations }
      delete allocations[lineKey]
      return { ...parcel, allocations }
    }))
    resetQuote()
  }

  const updatePackage = (packageKey: string, patch: Partial<DraftPackage>) => {
    setPackages((current) => current.map((parcel) => (
      parcel.packageKey === packageKey ? { ...parcel, ...patch } : parcel
    )))
    resetQuote()
  }

  const addPackage = () => {
    if (packages.length >= ONE_OFF_MAX_SYNCHRONOUS_PACKAGES) return
    const parcel = initialPackage([])
    parcel.description = `One-off shipment parcel ${packages.length + 1}`
    parcel.allocations = Object.fromEntries(lines.map((line) => [line.lineKey, '0']))
    setPackages((current) => [...current, parcel])
    resetQuote()
  }

  const removePackage = (packageKey: string) => {
    if (packages.length === 1) return
    setPackages((current) => current.filter((parcel) => parcel.packageKey !== packageKey))
    resetQuote()
  }

  const shipmentError = () => {
    const mode = workspace?.executionModes.find((entry) => entry.mode === executionMode)
    if (!mode?.enabled) return mode?.blockers[0] || 'The selected shipping mode is unavailable.'
    if (executionMode === 'live' && !canActivate) {
      return 'LIVE shipment planning requires Operations activation permission.'
    }
    if (!customerGlobalId) return 'Choose a customer.'
    if (!referenceNumber.trim()) return 'Enter an order or shipment reference.'
    if (!recipientName.trim() || !line1.trim() || !city.trim()) {
      return 'Complete the recipient name, street, and city.'
    }
    if (!/^[A-Za-z]{2}$/.test(region.trim())) return 'Enter a two-letter US state code.'
    if (!/^\d{5}(?:-\d{4})?$/.test(postalCode.trim())) return 'Enter a valid US ZIP code.'
    if (shipFromPhone.replace(/\D/g, '').length < 7) return 'Enter a sender phone number.'
    if (shipToPhone.replace(/\D/g, '').length < 7) return 'Enter a recipient phone number.'
    if (shipToResidential === null) return 'Choose whether the recipient address is residential or commercial.'
    if (!warehouseGlobalId || !inventoryPoolGlobalId || !receivingLocationGlobalId) {
      return 'Choose a warehouse, inventory pool, and physical location.'
    }
    if (!lines.length || lines.length > MAX_LINES) return `Add between 1 and ${MAX_LINES} lines.`
    const usedExisting = new Set<string>()
    const usedSkus = new Set<string>()
    for (const [index, line] of lines.entries()) {
      const quantity = positiveInteger(line.quantity)
      if (!quantity) return `Line ${index + 1} needs a whole-unit quantity.`
      if (line.kind === 'existing') {
        if (!line.productGlobalId) return `Choose an existing product for line ${index + 1}.`
        if (usedExisting.has(line.productGlobalId)) {
          return 'Use one line per existing product; increase its quantity instead of duplicating it.'
        }
        usedExisting.add(line.productGlobalId)
        if (selectedPoolAvailability(line.productGlobalId) < quantity) {
          return `Line ${index + 1} exceeds the available quantity in the selected pool.`
        }
      } else {
        if (!line.name.trim() || !line.sku.trim()) return `Name and SKU are required for new product line ${index + 1}.`
        const normalizedSku = line.sku.trim().toLowerCase()
        if (usedSkus.has(normalizedSku)) return 'Each new product SKU must be unique in this shipment.'
        usedSkus.add(normalizedSku)
        if (nonNegativeInteger(line.unitPriceMinor) === null) return `Line ${index + 1} needs a valid unit value.`
        if (!positiveInteger(line.unitWeightGrams)
          || !positiveInteger(line.lengthMm)
          || !positiveInteger(line.widthMm)
          || !positiveInteger(line.heightMm)) {
          return `New product line ${index + 1} needs factual unit weight and dimensions.`
        }
        if (!line.physicalUnitsOnHandConfirmed) {
          return `Confirm that physical units exist for new product line ${index + 1}.`
        }
      }
    }
    return ''
  }

  const packageError = () => {
    if (!packages.length || packages.length > ONE_OFF_MAX_SYNCHRONOUS_PACKAGES) {
      return `Add between 1 and ${ONE_OFF_MAX_SYNCHRONOUS_PACKAGES} parcels.`
    }
    for (const [index, parcel] of packages.entries()) {
      if (!parcel.description.trim()) return `Parcel ${index + 1} needs a description.`
      if (!positiveInteger(parcel.lengthMm)
        || !positiveInteger(parcel.widthMm)
        || !positiveInteger(parcel.heightMm)
        || !positiveInteger(parcel.grossWeightGrams)) {
        return `Parcel ${index + 1} needs factual dimensions and gross weight.`
      }
      const allocated = lines.reduce((sum, line) => (
        sum + (nonNegativeInteger(parcel.allocations[line.lineKey] || '0') ?? -1000000)
      ), 0)
      if (allocated <= 0) return `Parcel ${index + 1} must contain at least one unit.`
    }
    for (const [index, line] of lines.entries()) {
      const allocated = packages.reduce((sum, parcel) => (
        sum + (nonNegativeInteger(parcel.allocations[line.lineKey] || '0') ?? -1000000)
      ), 0)
      if (allocated !== positiveInteger(line.quantity)) {
        return `Line ${index + 1} allocations must total exactly ${line.quantity}.`
      }
    }
    return ''
  }

  const buildQuoteInput = (): OneOffShipmentQuoteInput => ({
    executionMode,
    customerGlobalId,
    warehouseGlobalId,
    inventoryPoolGlobalId,
    receivingLocationGlobalId,
    referenceNumber: referenceNumber.trim(),
    currency: 'USD',
    requestedDeliveryAt: requestedDeliveryAt
      ? new Date(requestedDeliveryAt).toISOString()
      : null,
    shipFromPhone,
    shipToPhone,
    shipToResidential: shipToResidential === true,
    shipTo: {
      name: recipientName.trim(),
      line1: line1.trim(),
      line2: line2.trim() || null,
      city: city.trim(),
      region: region.trim().toUpperCase(),
      postalCode: postalCode.trim(),
      country: 'US',
    },
    lines: lines.map((line) => line.kind === 'existing' ? ({
      kind: 'existing' as const,
      lineKey: line.lineKey,
      productGlobalId: line.productGlobalId,
      quantity: positiveInteger(line.quantity) || 0,
    }) : ({
      kind: 'new' as const,
      lineKey: line.lineKey,
      name: line.name.trim(),
      sku: line.sku.trim(),
      quantity: positiveInteger(line.quantity) || 0,
      unitPriceMinor: nonNegativeInteger(line.unitPriceMinor) || 0,
      unitWeightGrams: positiveInteger(line.unitWeightGrams) || 0,
      unitDimensionsMm: {
        length: positiveInteger(line.lengthMm) || 0,
        width: positiveInteger(line.widthMm) || 0,
        height: positiveInteger(line.heightMm) || 0,
      },
      physicalUnitsOnHandConfirmed: true as const,
    })),
    packages: packages.map((parcel) => ({
      packageKey: parcel.packageKey,
      description: parcel.description.trim(),
      dimensionsMm: {
        length: positiveInteger(parcel.lengthMm) || 0,
        width: positiveInteger(parcel.widthMm) || 0,
        height: positiveInteger(parcel.heightMm) || 0,
      },
      grossWeightGrams: positiveInteger(parcel.grossWeightGrams) || 0,
      allocations: lines.flatMap((line) => {
        const quantity = nonNegativeInteger(parcel.allocations[line.lineKey] || '0') || 0
        return quantity > 0 ? [{ lineKey: line.lineKey, quantity }] : []
      }),
    })),
  })

  const continueToParcels = () => {
    const message = shipmentError()
    if (message) {
      setError(message)
      return
    }
    setError('')
    setStep(1)
  }

  const requestQuote = async (idempotencyOverride?: string) => {
    const message = packageError()
    if (message) {
      setError(message)
      return
    }
    if (!enabledCarriers.length) {
      setError('No enabled carrier account can rate from the selected warehouse.')
      return
    }
    setBusy('quote')
    setError('')
    setFreshRateRetryAvailable(false)
    try {
      const response = await fetch('/api/operations/one-off-shipments', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyOverride || quoteIdempotencyKey,
        },
        body: JSON.stringify({ action: 'quote', quote: buildQuoteInput() }),
      })
      const payload = await response.json().catch(() => ({})) as QuotePayload
      if (!response.ok || !payload.ok || !payload.quote) {
        if (payload.code === 'OPERATIONS_COMMAND_EXPIRED') {
          setFreshRateRetryAvailable(true)
        }
        throw new Error(`${payload.error || 'Carrier rates could not be returned'}${payload.code ? ` [${payload.code}]` : ''}`)
      }
      const nextQuote = payload.quote
      if (!nextQuote.offers.length) {
        setFreshRateRetryAvailable(true)
        throw new Error('No enabled carrier returned an eligible rate.')
      }
      const lowest = [...nextQuote.offers].sort((left, right) => left.amountMinor - right.amountMinor)[0]
      setQuote(nextQuote)
      setSelectedOfferGlobalId(lowest?.globalId || '')
      setQuoteIdempotencyKey(nextQuoteIdempotencyKey())
      setFreshRateRetryAvailable(false)
      setCreateIdempotencyKey(`operations-one-off-create:${nextQuote.globalId}:${crypto.randomUUID()}`)
      setStep(2)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Carrier rates could not be returned')
    } finally {
      setBusy('')
    }
  }

  const retryCurrentRates = () => {
    const nextKey = nextQuoteIdempotencyKey()
    setQuoteIdempotencyKey(nextKey)
    void requestQuote(nextKey)
  }

  const createAndPlan = async (event: FormEvent) => {
    event.preventDefault()
    if (!quote || !selectedOfferGlobalId || reason.trim().length < 10 || !createIdempotencyKey) return
    setBusy('create')
    setError('')
    try {
      const response = await fetch('/api/operations/one-off-shipments', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': createIdempotencyKey,
        },
        body: JSON.stringify({
          action: 'create-and-plan',
          quoteGlobalId: quote.globalId,
          selectedOfferGlobalId,
          reason: reason.trim(),
        }),
      })
      const payload = await response.json().catch(() => ({})) as CreatePayload
      if (!response.ok || !payload.ok || !payload.result) {
        throw new Error(`${payload.error || 'The one-off shipment could not be planned'}${payload.code ? ` [${payload.code}]` : ''}`)
      }
      const result = payload.result
      const firstLine = initialLine()
      setStep(0)
      setReferenceNumber('')
      setRequestedDeliveryAt('')
      setRecipientName('')
      setLine1('')
      setLine2('')
      setCity('')
      setRegion('')
      setPostalCode('')
      setLines([firstLine])
      setPackages([initialPackage([firstLine])])
      setQuote(null)
      setSelectedOfferGlobalId('')
      setCreateIdempotencyKey('')
      await onCreated(result)
      onClose()
    } catch (caught) {
      setError(caught instanceof Error
        ? caught.message
        : 'The one-off shipment could not be planned')
    } finally {
      setBusy('')
    }
  }

  const close = () => {
    if (busy) return
    onClose()
  }

  const lineLabel = (line: DraftLine, index: number) => {
    if (line.kind === 'new') return line.name.trim() || `New product ${index + 1}`
    return workspace?.products.find((product) => product.globalId === line.productGlobalId)?.name
      || `Existing product ${index + 1}`
  }

  return (
    <Dialog
      open={open}
      onClose={close}
      fullWidth
      maxWidth="lg"
      fullScreen={mobile}
      PaperProps={{ sx: { minHeight: mobile ? '100%' : 'min(86vh, 860px)' } }}
    >
      <Box component="form" onSubmit={createAndPlan} sx={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 }}>
        <DialogTitle sx={{ display: 'flex', alignItems: 'flex-start', gap: 1 }}>
          <Box sx={{ flex: 1 }}>
            <Typography component="span" variant="h6" fontWeight={700}>Create one-off shipment</Typography>
            <Typography display="block" variant="body2" color="text.secondary">
              Build a planned warehouse order and compare rates from enabled carriers.
            </Typography>
          </Box>
          <IconButton aria-label="Close one-off shipment" onClick={close} disabled={Boolean(busy)}>
            <CloseRounded />
          </IconButton>
        </DialogTitle>
        <Box sx={{ px: { xs: 2, sm: 3 }, pb: 2 }}>
          <Stepper activeStep={step} alternativeLabel={!mobile} orientation={mobile ? 'vertical' : 'horizontal'}>
            {STEPS.map((label) => <Step key={label}><StepLabel>{label}</StepLabel></Step>)}
          </Stepper>
        </Box>
        <DialogContent dividers sx={{ flex: 1 }}>
          {loading ? (
            <Stack direction="row" spacing={1.5} alignItems="center" justifyContent="center" sx={{ minHeight: 280 }}>
              <CircularProgress size={24} />
              <Typography>Loading customers, inventory, warehouses, and carriers…</Typography>
            </Stack>
          ) : (
            <Stack spacing={2.5}>
              {error && (
                <Alert
                  severity="error"
                  onClose={() => setError('')}
                  action={step === 1 && freshRateRetryAvailable ? (
                    <Button
                      color="inherit"
                      size="small"
                      onClick={retryCurrentRates}
                      disabled={Boolean(busy)}
                    >
                      Retry current rates
                    </Button>
                  ) : undefined}
                >
                  {error}
                </Alert>
              )}
              {workspace && !workspace.carriers.length && (
                <Alert severity="warning">
                  No enabled UPS or FedEx integration is ready. Configure and verify at least one carrier before requesting rates.
                </Alert>
              )}

              {step === 0 && workspace && (
                <>
                  <Alert severity="info">
                    Existing products reserve physical inventory from the selected pool. A manually entered unit becomes a catalog product only when you create the planned order.
                  </Alert>
                  <Alert severity={executionMode === 'live' ? 'warning' : 'info'}>
                    {executionMode === 'live'
                      ? 'LIVE uses production carrier rates. Planning does not buy postage. After every parcel is packed, ClawPilot rerates the complete group and requires one explicit whole-shipment purchase confirmation.'
                      : 'TEST uses carrier sandbox rates and labels. It never buys production postage or mutates a production carrier shipment. The complete packed group is still purchased and closed as one audited command.'}
                  </Alert>
                  <Box
                    data-testid="one-off-mode-readiness"
                    sx={{
                      display: 'grid',
                      gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' },
                      gap: 1,
                    }}
                  >
                    {workspace.executionModes.map((mode) => {
                      const permissionBlocked = mode.mode === 'live' && !canActivate
                      const ready = mode.enabled && !permissionBlocked
                      const blocker = permissionBlocked
                        ? 'Your role does not have Operations activation permission.'
                        : mode.blockers.join(' · ')
                      return (
                        <Box
                          key={mode.mode}
                          sx={{
                            p: 1.5,
                            border: '1px solid rgba(255,255,255,0.12)',
                            borderRadius: 2,
                          }}
                        >
                          <Stack direction="row" justifyContent="space-between" gap={1}>
                            <Typography fontWeight={700}>
                              {mode.mode === 'live' ? 'LIVE production' : 'TEST sandbox'}
                            </Typography>
                            <Chip
                              size="small"
                              color={ready ? 'success' : 'warning'}
                              label={ready ? 'Ready' : 'Blocked'}
                            />
                          </Stack>
                          <Typography variant="caption" color="text.secondary">
                            {ready
                              ? mode.mode === 'live'
                                ? 'Rates and whole-shipment purchase use the authorized production account.'
                                : 'Rates and whole-shipment purchase use a verified carrier sandbox.'
                              : blocker || 'Carrier execution is not ready.'}
                          </Typography>
                        </Box>
                      )
                    })}
                  </Box>
                  <TextField
                    select
                    required
                    label="Shipping mode"
                    value={executionMode}
                    onChange={(event) => {
                      setExecutionMode(event.target.value as 'test' | 'live')
                      resetQuote()
                    }}
                    helperText={workspace.executionModes
                      .find((entry) => entry.mode === executionMode)
                      ?.blockers.join(' · ') || 'Choose the carrier environment explicitly.'}
                  >
                    {workspace.executionModes.map((mode) => (
                      <MenuItem
                        key={mode.mode}
                        value={mode.mode}
                        disabled={!mode.enabled || (mode.mode === 'live' && !canActivate)}
                      >
                        {mode.mode === 'live'
                          ? 'LIVE · production carrier integration'
                          : 'TEST · sandbox carrier integration'}
                      </MenuItem>
                    ))}
                  </TextField>
                  <Typography variant="overline" color="text.secondary">Order information</Typography>
                  <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' }, gap: 2 }}>
                    <TextField
                      select
                      required
                      label="Customer"
                      value={customerGlobalId}
                      onChange={(event) => { setCustomerGlobalId(event.target.value); resetQuote() }}
                    >
                      {workspace.customers.map((customer) => (
                        <MenuItem key={customer.globalId} value={customer.globalId}>{customer.name}</MenuItem>
                      ))}
                    </TextField>
                    <TextField
                      required
                      label="Order / shipment reference"
                      value={referenceNumber}
                      onChange={(event) => { setReferenceNumber(event.target.value); resetQuote() }}
                      inputProps={{ maxLength: 120 }}
                    />
                    <TextField
                      label="Requested delivery"
                      type="datetime-local"
                      value={requestedDeliveryAt}
                      onChange={(event) => { setRequestedDeliveryAt(event.target.value); resetQuote() }}
                      InputLabelProps={{ shrink: true }}
                    />
                    <TextField label="Currency" value="USD" disabled />
                  </Box>

                  <Typography variant="overline" color="text.secondary">US recipient</Typography>
                  <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: 'repeat(2, 1fr)' }, gap: 2 }}>
                    <TextField required label="Recipient name" value={recipientName} onChange={(event) => { setRecipientName(event.target.value); resetQuote() }} />
                    <TextField required label="Recipient phone" value={shipToPhone} onChange={(event) => { setShipToPhone(event.target.value); resetQuote() }} inputProps={{ inputMode: 'tel' }} />
                    <TextField required label="Street address" value={line1} onChange={(event) => { setLine1(event.target.value); resetQuote() }} />
                    <TextField label="Apartment, suite, etc." value={line2} onChange={(event) => { setLine2(event.target.value); resetQuote() }} />
                    <TextField required label="City" value={city} onChange={(event) => { setCity(event.target.value); resetQuote() }} />
                    <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1.4fr', gap: 2 }}>
                      <TextField required label="State" value={region} onChange={(event) => { setRegion(event.target.value.toUpperCase().slice(0, 2)); resetQuote() }} />
                      <TextField required label="ZIP code" value={postalCode} onChange={(event) => { setPostalCode(event.target.value); resetQuote() }} />
                    </Box>
                    <TextField label="Country" value="United States" disabled />
                    <TextField required label="Warehouse sender phone" value={shipFromPhone} onChange={(event) => { setShipFromPhone(event.target.value); resetQuote() }} inputProps={{ inputMode: 'tel' }} />
                    <TextField
                      select
                      required
                      label="Recipient address type"
                      value={shipToResidential === null ? '' : shipToResidential ? 'residential' : 'commercial'}
                      onChange={(event) => {
                        setShipToResidential(event.target.value === 'residential')
                        resetQuote()
                      }}
                      helperText="UPS and FedEx can return different rates for homes and businesses."
                    >
                      <MenuItem value="residential">Residential</MenuItem>
                      <MenuItem value="commercial">Commercial</MenuItem>
                    </TextField>
                  </Box>

                  <Typography variant="overline" color="text.secondary">Inventory source</Typography>
                  <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: 'repeat(3, 1fr)' }, gap: 2 }}>
                    <TextField
                      select
                      required
                      label="Warehouse"
                      value={warehouseGlobalId}
                      onChange={(event) => { setWarehouseGlobalId(event.target.value); resetQuote() }}
                    >
                      {workspace.warehouses.map((warehouse) => (
                        <MenuItem key={warehouse.globalId} value={warehouse.globalId}>{warehouse.name}</MenuItem>
                      ))}
                    </TextField>
                    <TextField
                      select
                      required
                      label="Inventory pool"
                      value={inventoryPoolGlobalId}
                      onChange={(event) => { setInventoryPoolGlobalId(event.target.value); resetQuote() }}
                    >
                      {selectedWarehouse?.inventoryPools.map((pool) => (
                        <MenuItem key={pool.globalId} value={pool.globalId}>{pool.name}</MenuItem>
                      ))}
                    </TextField>
                    <TextField
                      select
                      required
                      label="Physical location"
                      value={receivingLocationGlobalId}
                      onChange={(event) => { setReceivingLocationGlobalId(event.target.value); resetQuote() }}
                      helperText="Used to establish factual stock for manually added units."
                    >
                      {selectedWarehouse?.receivingLocations.map((location) => (
                        <MenuItem key={location.globalId} value={location.globalId}>{location.code}</MenuItem>
                      ))}
                    </TextField>
                  </Box>

                  <Stack direction="row" alignItems="center" justifyContent="space-between" gap={2}>
                    <Box>
                      <Typography variant="overline" color="text.secondary">Units</Typography>
                      <Typography variant="body2" color="text.secondary">{lines.length} of {MAX_LINES} lines</Typography>
                    </Box>
                    <Button startIcon={<AddRounded />} onClick={addLine} disabled={lines.length >= MAX_LINES}>Add unit line</Button>
                  </Stack>

                  {lines.map((line, index) => (
                    <Box key={line.lineKey} sx={{ p: { xs: 1.5, sm: 2 }, border: '1px solid rgba(255,255,255,0.12)', borderRadius: 2 }}>
                      <Stack direction="row" justifyContent="space-between" alignItems="center" gap={1} sx={{ mb: 2 }}>
                        <Typography fontWeight={700}>Line {index + 1}</Typography>
                        <Tooltip title={lines.length === 1 ? 'A shipment needs at least one line' : 'Remove line'}>
                          <span><IconButton size="small" aria-label={`Remove line ${index + 1}`} disabled={lines.length === 1} onClick={() => removeLine(line.lineKey)}><DeleteOutlineRounded /></IconButton></span>
                        </Tooltip>
                      </Stack>
                      <TextField
                        select
                        fullWidth
                        label="Unit source"
                        value={line.kind}
                        onChange={(event) => updateLine(line.lineKey, {
                          kind: event.target.value as DraftLine['kind'],
                          productGlobalId: '',
                          physicalUnitsOnHandConfirmed: false,
                        })}
                        sx={{ mb: 2 }}
                      >
                        <MenuItem value="existing">Existing product and inventory</MenuItem>
                        <MenuItem value="new">Create a new product from physical units</MenuItem>
                      </TextField>
                      {line.kind === 'existing' ? (
                        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: 'minmax(0, 1fr) 150px' }, gap: 2 }}>
                          <FormControl fullWidth required>
                            <InputLabel id={`product-${line.lineKey}`}>Product</InputLabel>
                            <Select
                              labelId={`product-${line.lineKey}`}
                              label="Product"
                              value={line.productGlobalId}
                              onChange={(event) => updateLine(line.lineKey, { productGlobalId: event.target.value })}
                            >
                              {workspace.products.map((product) => {
                                const available = selectedPoolAvailability(product.globalId)
                                return (
                                  <MenuItem key={product.globalId} value={product.globalId} disabled={available < 1}>
                                    {product.name}{product.sku ? ` · ${product.sku}` : ''} · {available} available
                                  </MenuItem>
                                )
                              })}
                            </Select>
                            <FormHelperText>Availability is for the selected warehouse and pool.</FormHelperText>
                          </FormControl>
                          <TextField required label="Quantity" type="number" value={line.quantity} onChange={(event) => updateLine(line.lineKey, { quantity: event.target.value })} inputProps={{ min: 1, step: 1 }} />
                        </Box>
                      ) : (
                        <Stack spacing={2}>
                          <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: 'minmax(0, 1fr) 180px 130px' }, gap: 2 }}>
                            <TextField required label="Product name" value={line.name} onChange={(event) => updateLine(line.lineKey, { name: event.target.value })} />
                            <TextField required label="SKU" value={line.sku} onChange={(event) => updateLine(line.lineKey, { sku: event.target.value })} inputProps={{ maxLength: 25 }} />
                            <TextField required label="Quantity" type="number" value={line.quantity} onChange={(event) => updateLine(line.lineKey, { quantity: event.target.value })} inputProps={{ min: 1, step: 1 }} />
                          </Box>
                          <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr 1fr', md: 'repeat(5, 1fr)' }, gap: 2 }}>
                            <TextField required label="Unit value (cents)" type="number" value={line.unitPriceMinor} onChange={(event) => updateLine(line.lineKey, { unitPriceMinor: event.target.value })} inputProps={{ min: 0, step: 1 }} />
                            <TextField required label="Unit weight (g)" type="number" value={line.unitWeightGrams} onChange={(event) => updateLine(line.lineKey, { unitWeightGrams: event.target.value })} inputProps={{ min: 1, step: 1 }} />
                            <TextField required label="Length (mm)" type="number" value={line.lengthMm} onChange={(event) => updateLine(line.lineKey, { lengthMm: event.target.value })} inputProps={{ min: 1, step: 1 }} />
                            <TextField required label="Width (mm)" type="number" value={line.widthMm} onChange={(event) => updateLine(line.lineKey, { widthMm: event.target.value })} inputProps={{ min: 1, step: 1 }} />
                            <TextField required label="Height (mm)" type="number" value={line.heightMm} onChange={(event) => updateLine(line.lineKey, { heightMm: event.target.value })} inputProps={{ min: 1, step: 1 }} />
                          </Box>
                          <FormControlLabel
                            sx={{ alignItems: 'flex-start' }}
                            control={<Checkbox checked={line.physicalUnitsOnHandConfirmed} onChange={(event) => updateLine(line.lineKey, { physicalUnitsOnHandConfirmed: event.target.checked })} />}
                            label="I confirm these are real physical units at the selected warehouse and location. Create this SKU in Products and establish only the stated quantity as inventory when I finalize the shipment."
                          />
                        </Stack>
                      )}
                    </Box>
                  ))}
                </>
              )}

              {step === 1 && workspace && (
                <>
                  <Alert severity="info">
                    Enter the exterior parcel dimensions and actual gross scale weight. Allocate every ordered unit exactly once across the parcels.
                  </Alert>
                  <Stack direction={{ xs: 'column', sm: 'row' }} justifyContent="space-between" alignItems={{ xs: 'stretch', sm: 'center' }} gap={1}>
                    <Box>
                      <Typography variant="overline" color="text.secondary">Physical parcels</Typography>
                      <Typography variant="body2" color="text.secondary">{packages.length} of {ONE_OFF_MAX_SYNCHRONOUS_PACKAGES} parcels</Typography>
                    </Box>
                    <Button startIcon={<AddRounded />} onClick={addPackage} disabled={packages.length >= ONE_OFF_MAX_SYNCHRONOUS_PACKAGES}>Add parcel</Button>
                  </Stack>
                  {packages.map((parcel, packageIndex) => (
                    <Box key={parcel.packageKey} sx={{ p: { xs: 1.5, sm: 2 }, border: '1px solid rgba(255,255,255,0.12)', borderRadius: 2 }}>
                      <Stack direction="row" justifyContent="space-between" alignItems="center" gap={1} sx={{ mb: 2 }}>
                        <Typography fontWeight={700}>Parcel {packageIndex + 1}</Typography>
                        <Tooltip title={packages.length === 1 ? 'A shipment needs at least one parcel' : 'Remove parcel'}>
                          <span><IconButton size="small" aria-label={`Remove parcel ${packageIndex + 1}`} disabled={packages.length === 1} onClick={() => removePackage(parcel.packageKey)}><DeleteOutlineRounded /></IconButton></span>
                        </Tooltip>
                      </Stack>
                      <Stack spacing={2}>
                        <TextField fullWidth required label="Description" value={parcel.description} onChange={(event) => updatePackage(parcel.packageKey, { description: event.target.value })} />
                        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr 1fr', md: 'repeat(4, 1fr)' }, gap: 2 }}>
                          <TextField required label="Length (mm)" type="number" value={parcel.lengthMm} onChange={(event) => updatePackage(parcel.packageKey, { lengthMm: event.target.value })} inputProps={{ min: 1, step: 1 }} />
                          <TextField required label="Width (mm)" type="number" value={parcel.widthMm} onChange={(event) => updatePackage(parcel.packageKey, { widthMm: event.target.value })} inputProps={{ min: 1, step: 1 }} />
                          <TextField required label="Height (mm)" type="number" value={parcel.heightMm} onChange={(event) => updatePackage(parcel.packageKey, { heightMm: event.target.value })} inputProps={{ min: 1, step: 1 }} />
                          <TextField required label="Gross weight (g)" type="number" value={parcel.grossWeightGrams} onChange={(event) => updatePackage(parcel.packageKey, { grossWeightGrams: event.target.value })} inputProps={{ min: 1, step: 1 }} />
                        </Box>
                        <Divider />
                        <Typography variant="subtitle2">Unit allocations</Typography>
                        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' }, gap: 2 }}>
                          {lines.map((line, lineIndex) => (
                            <TextField
                              key={line.lineKey}
                              label={`${lineLabel(line, lineIndex)} (ordered ${line.quantity})`}
                              type="number"
                              value={parcel.allocations[line.lineKey] || '0'}
                              onChange={(event) => updatePackage(parcel.packageKey, {
                                allocations: { ...parcel.allocations, [line.lineKey]: event.target.value },
                              })}
                              inputProps={{ min: 0, max: positiveInteger(line.quantity) || undefined, step: 1 }}
                            />
                          ))}
                        </Box>
                      </Stack>
                    </Box>
                  ))}
                  <Box sx={{ p: 2, borderRadius: 2, backgroundColor: 'rgba(168,199,250,0.07)' }}>
                    <Typography variant="subtitle2">Enabled rate sources</Typography>
                    <Stack direction="row" gap={1} flexWrap="wrap" useFlexGap sx={{ mt: 1 }}>
                      {enabledCarriers.map((carrier) => (
                        <Chip key={`${carrier.provider}:${carrier.carrierAccountGlobalId}`} label={`${carrier.providerLabel} · ${carrier.displayName} · ${carrier.environment}`} variant="outlined" />
                      ))}
                      {!enabledCarriers.length && <Typography variant="body2" color="text.secondary">None for this warehouse</Typography>}
                    </Stack>
                  </Box>
                </>
              )}

              {step === 2 && quote && (
                <>
                  <Alert severity={quote.status === 'succeeded' ? 'success' : 'warning'}>
                    {quote.offers.length} read-only {quote.offers.length === 1 ? 'rate was' : 'rates were'} returned from {quote.requiredCarrierProviders.map((provider) => provider === 'ups_rest' ? 'UPS' : 'FedEx').join(' and ')}. This quote expires {new Date(quote.expiresAt).toLocaleString()}.
                  </Alert>
                  <Typography variant="overline" color="text.secondary">Choose a carrier service</Typography>
                  <RadioGroup value={selectedOfferGlobalId} onChange={(event) => setSelectedOfferGlobalId(event.target.value)}>
                    <Stack spacing={1.25}>
                      {[...quote.offers].sort((left, right) => left.amountMinor - right.amountMinor).map((offer, index) => (
                        <Box key={offer.globalId} sx={{ border: `1px solid ${selectedOfferGlobalId === offer.globalId ? '#A8C7FA' : 'rgba(255,255,255,0.12)'}`, borderRadius: 2, p: 1.25, backgroundColor: selectedOfferGlobalId === offer.globalId ? 'rgba(168,199,250,0.08)' : 'transparent' }}>
                          <FormControlLabel
                            value={offer.globalId}
                            control={<Radio />}
                            sx={{ m: 0, width: '100%', alignItems: 'flex-start' }}
                            label={(
                              <Stack direction={{ xs: 'column', sm: 'row' }} justifyContent="space-between" gap={{ xs: 0.5, sm: 2 }} sx={{ width: '100%', pt: 0.5 }}>
                                <Box>
                                  <Stack direction="row" gap={1} alignItems="center" flexWrap="wrap" useFlexGap>
                                    <Typography fontWeight={700}>{offer.providerLabel} · {offer.serviceName}</Typography>
                                    {index === 0 && <Chip size="small" label="Lowest cost" color="info" variant="outlined" />}
                                    <Chip size="small" label={offer.environment} variant="outlined" />
                                  </Stack>
                                  <Typography variant="body2" color="text.secondary">{offer.serviceCode} · {formatDelivery(offer.estimatedDeliveryAt, offer.transitDays)}</Typography>
                                </Box>
                                <Typography variant="h6" fontWeight={700}>{formatMoney(offer.amountMinor, offer.currency)}</Typography>
                              </Stack>
                            )}
                          />
                        </Box>
                      ))}
                    </Stack>
                  </RadioGroup>
                  <Typography variant="overline" color="text.secondary">Final confirmation</Typography>
                  <TextField
                    required
                    multiline
                    minRows={3}
                    label="Planning reason"
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                    inputProps={{ maxLength: 500 }}
                    helperText={`${reason.trim().length}/500 · Recorded in the immutable audit history`}
                  />
                  <Alert severity="warning" icon={<Inventory2Rounded />}>
                    Confirming creates a planned Operations order, reserves the selected inventory, records the parcels and selected rate, and creates any reviewed new products. It does <strong>not</strong> buy postage during planning.
                    {' '}Release and assign the plan, complete every pick, and verify every package. ClawPilot then rerates the exact packed group and, after your explicit confirmation, submits one {packages.length}-parcel {executionMode === 'live' ? 'LIVE production' : 'TEST sandbox'} shipment command. Every returned package label is retained and the whole group is voided or closed together.
                  </Alert>
                </>
              )}
            </Stack>
          )}
        </DialogContent>
        <DialogActions sx={{ px: { xs: 2, sm: 3 }, py: 2 }}>
          <Button onClick={close} disabled={Boolean(busy)}>Cancel</Button>
          <Box sx={{ flex: 1 }} />
          {step > 0 && (
            <Button
              onClick={() => {
                setError('')
                if (step === 2) resetQuote()
                setStep((current) => current - 1)
              }}
              disabled={Boolean(busy)}
            >
              Back
            </Button>
          )}
          {step === 0 ? (
            <Button variant="contained" onClick={continueToParcels} disabled={loading || !workspace} endIcon={<LocalShippingRounded />}>Continue to parcels</Button>
          ) : step === 1 ? (
            <Button variant="contained" onClick={() => void requestQuote()} disabled={Boolean(busy) || !workspace} startIcon={busy === 'quote' ? <CircularProgress size={16} /> : <ScienceRounded />}>
              {busy === 'quote' ? 'Reading carrier rates' : 'Compare enabled carrier rates'}
            </Button>
          ) : (
            <Button type="submit" variant="contained" disabled={busy === 'create' || !selectedOfferGlobalId || reason.trim().length < 10} startIcon={busy === 'create' ? <CircularProgress size={16} /> : <Inventory2Rounded />}>
              {busy === 'create' ? 'Creating planned order' : 'Create and plan shipment'}
            </Button>
          )}
        </DialogActions>
      </Box>
    </Dialog>
  )
}
