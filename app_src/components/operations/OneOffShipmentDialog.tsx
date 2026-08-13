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
  ListSubheader,
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
import {
  PACKAGE_CATALOG_CONTRACT_VERSION,
  packageCatalogEntriesCompatibleWithProviders,
  packageCatalogEntry,
  packageKindForMaterialType,
  packageProviderCode,
  packagingMaterialUnitCounts,
  type CanonicalPackageKind,
  type PackageCatalogEntryId,
} from '@/lib/operations/packageCatalog'
import type { PackagingMaterial } from '@/lib/operations/packagingMaterials'

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
  catalogEntryId: PackageCatalogEntryId | null
  packageKind: CanonicalPackageKind
  packagingMaterialGlobalId: string | null
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

type PackagingMaterialsPayload = {
  ok?: boolean
  error?: string
  packagingMaterials?: {
    materials: PackagingMaterial[]
  }
}

type ParcelPackageOption = {
  group:
    | 'UPS'
    | 'FedEx'
    | 'Worldwide Express'
    | 'Common packaging'
    | 'Saved packaging'
    | 'Custom packaging'
  value: string
  label: string
  description: string
  catalogEntryId: PackageCatalogEntryId
  packageKind: CanonicalPackageKind
  packagingMaterialGlobalId: string | null
  defaultDimensionsMm: {
    length: number | null
    width: number | null
    height: number | null
  }
  disabled: boolean
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
const iconActionSx = { minWidth: 44, minHeight: 44 }
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
    catalogEntryId: 'box',
    packageKind: 'box',
    packagingMaterialGlobalId: null,
    description: 'Carton / box',
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

function carrierSelectionRef(
  carrier: OneOffShipmentWorkspace['carriers'][number],
) {
  return `${carrier.provider}:${carrier.integrationAccountGlobalId}:${carrier.carrierAccountGlobalId}`
}

function carrierProviderLabel(
  provider: OneOffShipmentQuote['requiredCarrierProviders'][number],
) {
  if (provider === 'ups_rest') return 'UPS'
  if (provider === 'fedex_rest') return 'FedEx'
  return 'Worldwide Express'
}

export type OneOffShipmentDevelopmentFixture = Readonly<{
  workspace: OneOffShipmentWorkspace
  packagingMaterials: PackagingMaterial[]
  initialStep?: 0 | 1
}>

export default function OneOffShipmentDialog({
  open,
  onClose,
  onCreated,
  canActivate,
  developmentFixture,
}: {
  open: boolean
  onClose: () => void
  onCreated: (result: OneOffShipmentCreateResult) => void | Promise<void>
  canActivate: boolean
  developmentFixture?: OneOffShipmentDevelopmentFixture
}) {
  const fixture = process.env.NEXT_PUBLIC_LOCAL_UI_FIXTURES === '1'
    ? developmentFixture
    : undefined
  const theme = useTheme()
  const mobile = useMediaQuery(theme.breakpoints.down('sm'))
  const [workspace, setWorkspace] = useState<OneOffShipmentWorkspace | null>(
    fixture?.workspace || null,
  )
  const [packagingMaterials, setPackagingMaterials] = useState<PackagingMaterial[]>(
    fixture?.packagingMaterials || [],
  )
  const [packagingMaterialsWarning, setPackagingMaterialsWarning] = useState('')
  const [selectedCarrierRefs, setSelectedCarrierRefs] = useState<string[]>([])
  const [carrierSelectionTouched, setCarrierSelectionTouched] = useState(false)
  const [carrierSelectionWarning, setCarrierSelectionWarning] = useState('')
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState<'quote' | 'create' | ''>('')
  const [error, setError] = useState('')
  const [step, setStep] = useState(fixture?.initialStep || 0)
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

  const sortedQuoteOffers = useMemo(() => (
    [...(quote?.offers || [])].sort((left, right) => (
      left.amountMinor - right.amountMinor
    ))
  ), [quote])

  const lowestPurchasableOfferGlobalId = useMemo(() => (
    sortedQuoteOffers.find((offer) => (
      offer.executionCapability === 'direct_purchase_later'
    ))?.globalId || ''
  ), [sortedQuoteOffers])

  const selectedRateOffer = useMemo(() => (
    quote?.offers.find((offer) => offer.globalId === selectedOfferGlobalId) || null
  ), [quote, selectedOfferGlobalId])

  const selectedWarehouse = useMemo(() => (
    workspace?.warehouses.find((warehouse) => warehouse.globalId === warehouseGlobalId)
    || null
  ), [warehouseGlobalId, workspace])

  const materialPackageOptions = useMemo<ParcelPackageOption[]>(() => {
    const materialOptions = packagingMaterials
      .filter((material) => material.status === 'active')
      .map((material): ParcelPackageOption => {
        const stock = material.stock.find((entry) => (
          entry.warehouseGlobalId === warehouseGlobalId
        ))
        const available = Boolean(
          stock?.warehouseStatus === 'active'
          && stock.isAvailable
          && Number(stock.onHandQuantity || 0) > 0,
        )
        const outer = material.ratedOuterDimensionsMm
        const hasRatedOuterDimensions = (
          Number(outer.length) > 0
          && Number(outer.width) > 0
          && Number(outer.height) > 0
        )
        const packageKind = packageKindForMaterialType(material.materialType)
        return {
          group: 'Saved packaging',
          value: `material:${material.globalId}`,
          label: material.name,
          description: available
            ? `${stock?.onHandQuantity} available at this warehouse${hasRatedOuterDimensions ? ' · rated exterior dimensions loaded' : ' · enter measured exterior dimensions'}`
            : 'Not available at this warehouse',
          catalogEntryId: packageKind,
          packageKind,
          packagingMaterialGlobalId: material.globalId,
          defaultDimensionsMm: hasRatedOuterDimensions
            ? {
                length: Number(outer.length),
                width: Number(outer.width),
                height: Number(outer.height),
              }
            : { length: null, width: null, height: null },
          disabled: !available,
        }
      })
      .sort((left, right) => left.label.localeCompare(right.label))
    return materialOptions
  }, [packagingMaterials, warehouseGlobalId])

  const enabledCarriers = useMemo(() => (
    workspace?.carriers.filter((carrier) => (
      carrier.environment === (executionMode === 'live' ? 'production' : 'sandbox')
      && (
      !carrier.senderOriginWarehouseGlobalId
      || carrier.senderOriginWarehouseGlobalId === warehouseGlobalId
      )
    )) || []
  ), [executionMode, warehouseGlobalId, workspace])

  const selectedCarrierAccounts = useMemo(() => {
    const selected = new Set(selectedCarrierRefs)
    return enabledCarriers.filter((carrier) => selected.has(carrierSelectionRef(carrier)))
  }, [enabledCarriers, selectedCarrierRefs])

  const parcelPackageOptions = useMemo<ParcelPackageOption[]>(() => {
    const providers = selectedCarrierAccounts.map((carrier) => carrier.provider)
    const singleCarrier = providers.length === 1
    const carrierPackagingGroup = singleCarrier
      ? carrierProviderLabel(providers[0])
      : 'Common packaging'
    const catalogOptions = packageCatalogEntriesCompatibleWithProviders({
      providers,
      usage: 'small_parcel_package',
    })
      .filter((entry) => !(
        singleCarrier
        && entry.providerScope !== 'canonical'
        && entry.kind === 'custom'
      ))
      .map((entry): ParcelPackageOption => ({
        group: entry.id === 'custom'
          ? 'Custom packaging'
          : singleCarrier && entry.providerScope !== 'canonical'
            ? carrierPackagingGroup
            : singleCarrier
              ? 'Custom packaging'
              : 'Common packaging',
        value: entry.id,
        label: entry.label,
        description: '',
        catalogEntryId: entry.id,
        packageKind: entry.kind,
        packagingMaterialGlobalId: null,
        defaultDimensionsMm: entry.defaultDimensionsMm,
        disabled: false,
      }))
    const compatibleMaterials = materialPackageOptions.filter((option) => {
      const entry = packageCatalogEntry(option.catalogEntryId)
      return Boolean(entry) && providers.every((provider) => (
        Boolean(entry?.providerMappings[provider].smallParcelPackageCode)
      ))
    })
    const groupOrder: ParcelPackageOption['group'][] = singleCarrier
      ? [carrierPackagingGroup, 'Saved packaging', 'Custom packaging']
      : ['Common packaging', 'Saved packaging', 'Custom packaging']
    return [...compatibleMaterials, ...catalogOptions].sort((left, right) => (
      groupOrder.indexOf(left.group) - groupOrder.indexOf(right.group)
      || left.label.localeCompare(right.label)
    ))
  }, [materialPackageOptions, selectedCarrierAccounts])

  const packageProfilesSupportSelectedCarriers = useMemo(() => packages.every((parcel) => {
    const entry = packageCatalogEntry(parcel.catalogEntryId || '')
    if (!entry) return false
    return selectedCarrierAccounts.every((carrier) => (
      Boolean(entry.providerMappings[carrier.provider].smallParcelPackageCode)
    ))
  }), [selectedCarrierAccounts, packages])

  const resetQuote = () => {
    setQuote(null)
    setSelectedOfferGlobalId('')
    setQuoteIdempotencyKey(nextQuoteIdempotencyKey())
    setFreshRateRetryAvailable(false)
    setCreateIdempotencyKey('')
  }

  const updateCarrierSelection = (nextRefs: string[]) => {
    const ordered = enabledCarriers
      .map(carrierSelectionRef)
      .filter((ref) => nextRefs.includes(ref))
    setCarrierSelectionTouched(true)
    setSelectedCarrierRefs(ordered)
    setCarrierSelectionWarning('')
    resetQuote()
  }

  useEffect(() => {
    const validRefs = enabledCarriers.map(carrierSelectionRef)
    const valid = new Set(validRefs)
    const next = carrierSelectionTouched
      ? selectedCarrierRefs.filter((ref) => valid.has(ref))
      : validRefs
    const removed = selectedCarrierRefs.filter((ref) => !valid.has(ref))
    setCarrierSelectionWarning(removed.length
      ? 'A previously selected account is no longer available. Review carriers and request new rates.'
      : '')
    if (
      next.length !== selectedCarrierRefs.length
      || next.some((ref, index) => ref !== selectedCarrierRefs[index])
    ) {
      setSelectedCarrierRefs(next)
    }
  }, [carrierSelectionTouched, enabledCarriers, selectedCarrierRefs])

  useEffect(() => {
    if (!selectedCarrierAccounts.length) return
    const providers = selectedCarrierAccounts.map((carrier) => carrier.provider)
    let changed = false
    const next = packages.map((shipmentPackage) => {
        if (shipmentPackage.catalogEntryId === null) return shipmentPackage
        const entry = packageCatalogEntry(shipmentPackage.catalogEntryId || '')
        const supported = Boolean(entry) && providers.every((provider) => (
          Boolean(entry?.providerMappings[provider].smallParcelPackageCode)
        ))
        if (supported) return shipmentPackage
        changed = true
        return {
          ...shipmentPackage,
          catalogEntryId: null,
          packagingMaterialGlobalId: null,
          description: '',
        }
      })
    if (changed) {
      setPackages(next)
      setCarrierSelectionWarning(
        'Choose a package supported by every selected carrier, then request new rates.',
      )
    }
  }, [packages, selectedCarrierAccounts])

  useEffect(() => {
    if (!open) return
    setError('')
    setPackagingMaterialsWarning('')
    setCarrierSelectionTouched(false)
    setCarrierSelectionWarning('')
    if (fixture) {
      const nextWorkspace = fixture.workspace
      setLoading(false)
      setWorkspace(nextWorkspace)
      setPackagingMaterials(fixture.packagingMaterials)
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
      setStep(fixture.initialStep || 0)
      return
    }
    const controller = new AbortController()
    setLoading(true)
    void (async () => {
      try {
        const [response, materialsResponse] = await Promise.all([
          fetch('/api/operations/one-off-shipments', {
            cache: 'no-store',
            signal: controller.signal,
          }),
          fetch('/api/operations/packaging-materials', {
            cache: 'no-store',
            signal: controller.signal,
          }).catch(() => null),
        ])
        const payload = await response.json().catch(() => ({})) as WorkspacePayload
        if (!response.ok || !payload.ok || !payload.workspace) {
          throw new Error(payload.error || 'One-off shipment setup is unavailable')
        }
        const nextWorkspace = payload.workspace
        setWorkspace(nextWorkspace)
        const materialsPayload = materialsResponse
          ? await materialsResponse.json().catch(() => ({})) as PackagingMaterialsPayload
          : {}
        if (
          materialsResponse?.ok
          && materialsPayload.ok
          && materialsPayload.packagingMaterials
        ) {
          setPackagingMaterials(materialsPayload.packagingMaterials.materials)
        } else {
          setPackagingMaterials([])
          setPackagingMaterialsWarning(
            materialsPayload.error
            || 'Organization packaging materials are unavailable; common package types remain available.',
          )
        }
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
  }, [fixture, open])

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

  const selectPackageOption = (packageKey: string, value: string) => {
    const option = parcelPackageOptions.find((entry) => entry.value === value)
    if (!option || option.disabled) return
    updatePackage(packageKey, {
      catalogEntryId: option.catalogEntryId,
      packageKind: option.packageKind,
      packagingMaterialGlobalId: option.packagingMaterialGlobalId,
      description: option.label,
      lengthMm: option.defaultDimensionsMm.length === null
        ? ''
        : String(option.defaultDimensionsMm.length),
      widthMm: option.defaultDimensionsMm.width === null
        ? ''
        : String(option.defaultDimensionsMm.width),
      heightMm: option.defaultDimensionsMm.height === null
        ? ''
        : String(option.defaultDimensionsMm.height),
    })
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
    if (!selectedCarrierAccounts.length) return 'Select at least one carrier account.'
    if (!packages.length || packages.length > ONE_OFF_MAX_SYNCHRONOUS_PACKAGES) {
      return `Add between 1 and ${ONE_OFF_MAX_SYNCHRONOUS_PACKAGES} parcels.`
    }
    if (selectedCarrierAccounts.some((carrier) => carrier.provider === 'fedex_rest')) {
      try {
        const fedExPackageCodes = packages.map((parcel) => packageProviderCode({
          catalogEntryId: parcel.catalogEntryId as PackageCatalogEntryId,
          provider: 'fedex_rest',
          usage: 'small_parcel_package',
        }))
        if (new Set(fedExPackageCodes).size > 1) {
          return 'FedEx requires one package type across every parcel in this shipment.'
        }
      } catch {
        return 'Every parcel package must be supported by the selected FedEx account.'
      }
    }
    const materialUseCounts = packagingMaterialUnitCounts(packages)
    for (const [index, parcel] of packages.entries()) {
      const catalogEntry = packageCatalogEntry(parcel.catalogEntryId || '')
      if (
        !catalogEntry
        || !catalogEntry.usages.includes('small_parcel_package')
        || catalogEntry.kind !== parcel.packageKind
      ) {
        return `Parcel ${index + 1} uses an unsupported package and carrier combination.`
      }
      try {
        for (const carrier of selectedCarrierAccounts) {
          packageProviderCode({
            catalogEntryId: catalogEntry.id,
            provider: carrier.provider,
            usage: 'small_parcel_package',
          })
        }
      } catch {
        return `Parcel ${index + 1} package is not supported by every selected carrier.`
      }
      const material = parcel.packagingMaterialGlobalId
        ? packagingMaterials.find((entry) => (
            entry.globalId === parcel.packagingMaterialGlobalId
          ))
        : null
      if (parcel.packagingMaterialGlobalId) {
        const materialStock = material?.stock.find((entry) => (
          entry.warehouseGlobalId === warehouseGlobalId
        ))
        const selectedMaterialUnits = materialUseCounts.get(
          parcel.packagingMaterialGlobalId,
        ) || 0
        if (
          !material
          || material.status !== 'active'
          || packageKindForMaterialType(material.materialType) !== parcel.packageKind
          || !materialStock?.isAvailable
          || Number(materialStock.onHandQuantity || 0) < selectedMaterialUnits
        ) {
          return `The selected packaging material is not active or does not have enough stock for all ${selectedMaterialUnits} assigned parcels at this warehouse.`
        }
      }
      if (!parcel.description.trim()) return `Parcel ${index + 1} needs a description.`
      if (!positiveInteger(parcel.lengthMm)
        || !positiveInteger(parcel.widthMm)
        || !positiveInteger(parcel.heightMm)
        || !positiveInteger(parcel.grossWeightGrams)) {
        return `Parcel ${index + 1} needs factual dimensions and gross weight.`
      }
      const grossWeightGrams = positiveInteger(parcel.grossWeightGrams) || 0
      if (material?.tareWeightGrams && grossWeightGrams < material.tareWeightGrams) {
        return `Parcel ${index + 1} gross weight cannot be below the selected material tare weight.`
      }
      if (material?.maxWeightGrams && grossWeightGrams > material.maxWeightGrams) {
        return `Parcel ${index + 1} exceeds the selected material maximum weight.`
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
    selectedCarriers: selectedCarrierAccounts.map((carrier) => ({
      provider: carrier.provider,
      integrationAccountGlobalId: carrier.integrationAccountGlobalId,
      carrierAccountGlobalId: carrier.carrierAccountGlobalId,
    })),
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
      packageProfile: {
        contractVersion: PACKAGE_CATALOG_CONTRACT_VERSION,
        catalogEntryId: parcel.catalogEntryId as PackageCatalogEntryId,
        packageKind: parcel.packageKind,
        packagingMaterialGlobalId: parcel.packagingMaterialGlobalId,
      },
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
    if (!selectedCarrierAccounts.length) {
      setError('No enabled carrier account can rate from the selected warehouse.')
      return
    }
    if (!packageProfilesSupportSelectedCarriers) {
      setError(
        'Choose a package supported by every selected carrier.',
      )
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
      const lowest = [...nextQuote.offers]
        .filter((offer) => offer.executionCapability === 'direct_purchase_later')
        .sort((left, right) => left.amountMinor - right.amountMinor)[0]
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
    const selectedOffer = quote.offers.find((offer) => (
      offer.globalId === selectedOfferGlobalId
    ))
    if (selectedOffer?.executionCapability !== 'direct_purchase_later') {
      setError('Choose a carrier rate that can create a shipment plan.')
      return
    }
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
            <Typography component="span" variant="h6" fontWeight={700}>Create parcel shipment</Typography>
          </Box>
          <IconButton sx={iconActionSx} aria-label="Close one-off shipment" onClick={close} disabled={Boolean(busy)}>
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
                  No parcel rate account is ready. Configure and verify one before requesting rates.
                </Alert>
              )}

              {step === 0 && workspace && (
                <>
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
                          {!ready && (
                            <Typography variant="caption" color="text.secondary">
                              {blocker || 'Carrier execution is not ready.'}
                            </Typography>
                          )}
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
                      ?.blockers.join(' · ') || undefined}
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
                          <span><IconButton sx={iconActionSx} size="small" aria-label={`Remove line ${index + 1}`} disabled={lines.length === 1} onClick={() => removeLine(line.lineKey)}><DeleteOutlineRounded /></IconButton></span>
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
                  {packagingMaterialsWarning && (
                    <Alert severity="warning">{packagingMaterialsWarning}</Alert>
                  )}
                  {carrierSelectionWarning && (
                    <Alert severity="warning">{carrierSelectionWarning}</Alert>
                  )}
                  <Box
                    data-testid="one-off-carrier-selection"
                    sx={{
                      p: 2,
                      border: '1px solid rgba(255,255,255,0.12)',
                      borderRadius: 2,
                    }}
                  >
                    <Stack
                      direction={{ xs: 'column', sm: 'row' }}
                      justifyContent="space-between"
                      alignItems={{ xs: 'stretch', sm: 'center' }}
                      gap={1}
                    >
                      <Box>
                        <Typography fontWeight={700}>Carriers</Typography>
                        <Typography variant="body2" color="text.secondary">
                          {selectedCarrierAccounts.length} selected
                        </Typography>
                      </Box>
                      <FormControlLabel
                        sx={{ m: 0, minHeight: 44 }}
                        control={(
                          <Checkbox
                            sx={iconActionSx}
                            checked={Boolean(enabledCarriers.length)
                              && selectedCarrierAccounts.length === enabledCarriers.length}
                            indeterminate={selectedCarrierAccounts.length > 0
                              && selectedCarrierAccounts.length < enabledCarriers.length}
                            onChange={(event) => updateCarrierSelection(
                              event.target.checked
                                ? enabledCarriers.map(carrierSelectionRef)
                                : [],
                            )}
                          />
                        )}
                        label="All enabled"
                      />
                    </Stack>
                    <Stack spacing={0.25} sx={{ mt: 1 }}>
                      {enabledCarriers.map((carrier) => {
                        const ref = carrierSelectionRef(carrier)
                        const checked = selectedCarrierRefs.includes(ref)
                        return (
                          <FormControlLabel
                            key={ref}
                            sx={{ m: 0, minHeight: 44 }}
                            control={(
                              <Checkbox
                                sx={iconActionSx}
                                checked={checked}
                                onChange={(event) => updateCarrierSelection(
                                  event.target.checked
                                    ? [...selectedCarrierRefs, ref]
                                    : selectedCarrierRefs.filter((value) => value !== ref),
                                )}
                              />
                            )}
                            label={`${carrier.providerLabel} · ${carrier.displayName}`}
                          />
                        )
                      })}
                      {!enabledCarriers.length && (
                        <Typography variant="body2" color="text.secondary">
                          No eligible accounts for this warehouse.
                        </Typography>
                      )}
                    </Stack>
                  </Box>
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
                          <span><IconButton sx={iconActionSx} size="small" aria-label={`Remove parcel ${packageIndex + 1}`} disabled={packages.length === 1} onClick={() => removePackage(parcel.packageKey)}><DeleteOutlineRounded /></IconButton></span>
                        </Tooltip>
                      </Stack>
                      <Stack spacing={2}>
                        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: 'minmax(260px, 0.9fr) minmax(0, 1.1fr)' }, gap: 2 }}>
                          <TextField
                            data-testid={`parcel-package-profile-${packageIndex + 1}`}
                            select
                            required
                            fullWidth
                            label="Package type / material"
                            value={parcel.packagingMaterialGlobalId
                              ? `material:${parcel.packagingMaterialGlobalId}`
                              : parcel.catalogEntryId || ''}
                            onChange={(event) => selectPackageOption(
                              parcel.packageKey,
                              event.target.value,
                            )}
                          >
                            <MenuItem value="" disabled>Choose package</MenuItem>
                            {[...new Set(parcelPackageOptions.map((option) => option.group))]
                              .flatMap((group) => [
                                <ListSubheader key={`group:${group}`} disableSticky>
                                  {group}
                                </ListSubheader>,
                                ...parcelPackageOptions
                                  .filter((option) => option.group === group)
                                  .map((option) => (
                                    <MenuItem
                                      key={option.value}
                                      value={option.value}
                                      disabled={option.disabled}
                                      sx={{ pl: 4 }}
                                    >
                                      {option.label}
                                    </MenuItem>
                                  )),
                              ])}
                          </TextField>
                          <TextField
                            fullWidth
                            required
                            label="Parcel description"
                            value={parcel.description}
                            onChange={(event) => updatePackage(
                              parcel.packageKey,
                              { description: event.target.value },
                            )}
                          />
                        </Box>
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
                </>
              )}

              {step === 2 && quote && (
                <>
                  <Alert severity={quote.status === 'succeeded' ? 'success' : 'warning'}>
                    {quote.offers.length} {quote.offers.length === 1 ? 'rate' : 'rates'} ready. Expires {new Date(quote.expiresAt).toLocaleString()}.
                  </Alert>
                  <Stack direction="row" gap={1} flexWrap="wrap" useFlexGap>
                    {quote.requiredCarrierSelections.map((selection) => {
                      const result = quote.carrierSelectionResults[selection.selectionKey]
                      const account = workspace?.carriers.find((carrier) => (
                        carrier.provider === selection.provider
                        && carrier.integrationAccountGlobalId === selection.integrationAccountGlobalId
                        && carrier.carrierAccountGlobalId === selection.carrierAccountGlobalId
                      ))
                      const label = account
                        ? `${account.providerLabel} · ${account.displayName}`
                        : carrierProviderLabel(selection.provider)
                      const succeeded = result?.status === 'succeeded'
                      return (
                        <Chip
                          key={selection.selectionKey}
                          color={succeeded ? 'success' : 'warning'}
                          variant="outlined"
                          label={succeeded
                            ? `${label}: ${result.eligibleOfferCount} ${result.eligibleOfferCount === 1 ? 'rate' : 'rates'}`
                            : `${label}: unavailable`}
                        />
                      )
                    })}
                  </Stack>
                  <Typography variant="overline" color="text.secondary">Choose a carrier service</Typography>
                  <RadioGroup
                    value={selectedOfferGlobalId}
                    onChange={(event) => {
                      const offer = quote.offers.find((entry) => (
                        entry.globalId === event.target.value
                      ))
                      if (offer?.executionCapability === 'direct_purchase_later') {
                        setSelectedOfferGlobalId(offer.globalId)
                      }
                    }}
                  >
                    <Stack spacing={1.25}>
                      {sortedQuoteOffers.map((offer) => {
                        const rateOnly = offer.executionCapability === 'rate_only'
                        return (
                        <Box key={offer.globalId} sx={{ border: `1px solid ${selectedOfferGlobalId === offer.globalId ? '#A8C7FA' : 'rgba(255,255,255,0.12)'}`, borderRadius: 2, p: 1.25, backgroundColor: selectedOfferGlobalId === offer.globalId ? 'rgba(168,199,250,0.08)' : 'transparent' }}>
                          <FormControlLabel
                            value={offer.globalId}
                            disabled={rateOnly}
                            control={<Radio disabled={rateOnly} sx={iconActionSx} />}
                            sx={{ m: 0, minHeight: 44, width: '100%', alignItems: 'flex-start' }}
                            label={(
                              <Stack direction={{ xs: 'column', sm: 'row' }} justifyContent="space-between" gap={{ xs: 0.5, sm: 2 }} sx={{ width: '100%', pt: 0.5 }}>
                                <Box>
                                  <Stack direction="row" gap={1} alignItems="center" flexWrap="wrap" useFlexGap>
                                    <Typography fontWeight={700}>{offer.providerLabel} · {offer.serviceName}</Typography>
                                    {offer.globalId === lowestPurchasableOfferGlobalId && <Chip size="small" label="Lowest cost" color="info" variant="outlined" />}
                                    {rateOnly && <Chip size="small" label="Rate only" variant="outlined" />}
                                    <Chip size="small" label={offer.environment} variant="outlined" />
                                  </Stack>
                                  <Typography variant="body2" color="text.secondary">{formatDelivery(offer.estimatedDeliveryAt, offer.transitDays)}</Typography>
                                </Box>
                                <Typography variant="h6" fontWeight={700}>{formatMoney(offer.amountMinor, offer.currency)}</Typography>
                              </Stack>
                            )}
                          />
                        </Box>
                        )
                      })}
                    </Stack>
                  </RadioGroup>
                  {lowestPurchasableOfferGlobalId ? (
                    <>
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
                        Creates the plan and reserves inventory. No postage is purchased now. After packing, ClawPilot rerates the same carrier selection and requires explicit purchase confirmation.
                      </Alert>
                    </>
                  ) : (
                    <Alert severity="warning">
                      No selected carrier returned a rate that can create a shipment plan.
                    </Alert>
                  )}
                </>
              )}
            </Stack>
          )}
        </DialogContent>
        <DialogActions
          disableSpacing
          data-testid="one-off-shipment-actions"
          sx={{
            px: { xs: 2, sm: 3 },
            py: 2,
            gap: 1,
            flexDirection: { xs: 'column-reverse', sm: 'row' },
            alignItems: 'stretch',
            '& .MuiButton-root': {
              minHeight: 44,
              whiteSpace: { xs: 'normal', sm: 'nowrap' },
            },
          }}
        >
          <Button onClick={close} disabled={Boolean(busy)}>Cancel</Button>
          <Box sx={{ flex: { xs: 0, sm: 1 } }} />
          <Stack
            direction={{ xs: 'column-reverse', sm: 'row' }}
            spacing={1}
            sx={{ width: { xs: '100%', sm: 'auto' } }}
          >
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
                {busy === 'quote' ? 'Reading carrier rates' : 'Compare selected carrier rates'}
              </Button>
            ) : (
              <Button type="submit" variant="contained" disabled={busy === 'create' || selectedRateOffer?.executionCapability !== 'direct_purchase_later' || reason.trim().length < 10} startIcon={busy === 'create' ? <CircularProgress size={16} /> : <Inventory2Rounded />}>
                {busy === 'create' ? 'Creating planned order' : 'Create and plan shipment'}
              </Button>
            )}
          </Stack>
        </DialogActions>
      </Box>
    </Dialog>
  )
}
