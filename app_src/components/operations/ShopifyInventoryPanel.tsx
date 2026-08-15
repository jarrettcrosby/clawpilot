'use client'

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Card from '@mui/material/Card'
import CardContent from '@mui/material/CardContent'
import Chip from '@mui/material/Chip'
import CircularProgress from '@mui/material/CircularProgress'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import Divider from '@mui/material/Divider'
import FormControl from '@mui/material/FormControl'
import InputLabel from '@mui/material/InputLabel'
import MenuItem from '@mui/material/MenuItem'
import Select from '@mui/material/Select'
import Stack from '@mui/material/Stack'
import Table from '@mui/material/Table'
import TableBody from '@mui/material/TableBody'
import TableCell from '@mui/material/TableCell'
import TableContainer from '@mui/material/TableContainer'
import TableHead from '@mui/material/TableHead'
import TablePagination from '@mui/material/TablePagination'
import TableRow from '@mui/material/TableRow'
import TextField from '@mui/material/TextField'
import ToggleButton from '@mui/material/ToggleButton'
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup'
import Typography from '@mui/material/Typography'
import Inventory2Rounded from '@mui/icons-material/Inventory2Rounded'
import OpenInNewRounded from '@mui/icons-material/OpenInNewRounded'
import RefreshRounded from '@mui/icons-material/RefreshRounded'
import WarehouseRounded from '@mui/icons-material/WarehouseRounded'
import { useMeasurementSystem } from '@/components/measurements/MeasurementSystemProvider'
import ShopifyLocationAdministrationPanel from '@/components/operations/ShopifyLocationAdministrationPanel'
import {
  formatDimensionsMm,
  formatGrams,
  formatMillimeters,
  type MeasurementSystem,
} from '@/lib/measurements'

const SHOPIFY_INVENTORY_STATES = [
  ['available', 'Available'],
  ['incoming', 'Incoming'],
  ['committed', 'Committed'],
  ['damaged', 'Damaged'],
  ['onHand', 'On hand'],
  ['qualityControl', 'Quality control'],
  ['reserved', 'Reserved'],
  ['safetyStock', 'Safety stock'],
] as const

type InventoryLocation = {
  id?: string
  name?: string
  isActive?: boolean
  shipsInventory?: boolean
  fulfillsOnlineOrders?: boolean
  hasActiveInventory?: boolean
  addressVerified?: boolean
  isFulfillmentService?: boolean
  fulfillmentService?: {
    serviceName?: string
    handle?: string
  } | null
  address?: {
    line1?: string
    line2?: string
    city?: string
    region?: string
    regionCode?: string
    postalCode?: string
    country?: string
    countryCode?: string
  }
  ownershipClassification?: 'merchant_managed' | 'fulfillment_service'
  mappingEligible?: boolean
  mappingIneligibleReason?: string | null
  mappingGlobalId?: string | null
}

type InventoryWarehouseLocation = {
  globalId: string
  code: string
  zone: string
  locationType: string
  active: boolean
}

type InventoryWarehouse = {
  globalId: string
  code: string
  name: string
  address?: Record<string, unknown>
  status: string
  locations: InventoryWarehouseLocation[]
}

type DimensionDefinition = {
  ownerType?: string
  identifier?: string
  type?: string
  axis?: string | null
  name?: string
  description?: string
}

type InventoryEnrichment = {
  unitCostAvailable?: boolean
  productDimensionKeys?: Partial<
    Record<'length' | 'width' | 'height', string>
  >
  variantDimensionKeys?: Partial<
    Record<'length' | 'width' | 'height', string>
  >
  ambiguousDimensionDefinitions?: DimensionDefinition[]
}

type InventoryLevel = {
  globalId: string
  sku: string | null
  tracked: boolean
  mappingState: 'mapped' | 'unmapped'
  projectionState:
    | 'projected'
    | 'unmapped'
    | 'untracked'
    | 'inconsistent'
    | 'negative_available'
  productGlobalId: string | null
  productName: string | null
  providerQuantities: {
    available: number
    incoming: number
    committed: number
    damaged: number
    onHand: number
    qualityControl: number
    reserved: number
    safetyStock: number
  }
  providerQuantityEvidence: Partial<Record<
    (typeof SHOPIFY_INVENTORY_STATES)[number][0],
    {
      id?: string
      quantity?: number
      updatedAt?: string | null
    } | null
  >>
  operationalAvailableQuantity: number
  equationMatches: boolean
  providerUpdatedAt: string | null
  providerWeightGrams: number | null
  providerDimensionsMm: {
    length?: number
    width?: number
    height?: number
    source?: string
    sourceKeys?: string[]
  } | null
  product: Record<string, unknown>
  inventoryPositionGlobalId: string | null
}

type InventoryRun = {
  globalId: string
  providerFetchedAt: string | null
  completedAt: string | null
  providerLocationName: string
  warehouseGlobalId: string
  warehouseName: string
  locationGlobalId: string
  locationCode: string
  levelsSeen: number
  levelsMapped: number
  levelsProjected: number
  levelsUnmapped: number
  levelsUntracked: number
  negativeAvailableLevels: number
  equationMismatchLevels: number
  providerAvailableQuantity: number
  providerCommittedQuantity: number
  providerOnHandQuantity: number
  operationalAvailableQuantity: number
  positionsCreated: number
  positionsUpdated: number
  positionsZeroed: number
  providerWrites: number
  orderQuantityAdjustment: number
  snapshotHashPrefix: string
  providerLocation?: InventoryLocation
  enrichment?: InventoryEnrichment
  warnings?: string[]
}

type InventoryLocationMapping = {
  globalId: string
  externalLocationId: string
  externalLocationName: string
  externalLocationAddress?: Record<string, unknown> | null
  ownershipClassification: 'merchant_managed' | 'fulfillment_service'
  inventoryImportEnabled: boolean
  rowVersion: number
  providerObservedAt: string | null
  warehouse: {
    globalId: string
    code: string
    name: string
  }
  location: {
    globalId: string
    code: string
    zone: string
    locationType: string
  }
  latestRun: InventoryRun | null
}

type InventoryState = {
  accountGlobalId: string
  status: 'never_synced' | 'synced'
  latestRun: InventoryRun | null
  levels: InventoryLevel[]
  providerLocation?: InventoryLocation
  providerLocations?: InventoryLocation[]
  warehouses?: InventoryWarehouse[]
  mappings?: InventoryLocationMapping[]
  enrichment?: InventoryEnrichment
  warnings?: string[]
  refreshRecovery?: {
    status:
      | 'idle'
      | 'pending'
      | 'processing'
      | 'failed'
      | 'succeeded'
      | 'cancelled'
      | 'dead'
    automaticSchedulingBlocked: boolean
    managerRecoveryRequired: boolean
    recoveredAfterDead: boolean
    lastErrorCode: string | null
    attemptCount: number
    maxAttempts: number
    availableAt: string | null
    completedAt: string | null
    affectedOrders: Array<{
      globalId: string
      orderNumber: string
    }>
  }
}

type InventoryPayload = {
  ok?: boolean
  error?: string
  code?: string
  replayed?: boolean
  inventory?: InventoryState
  mapping?: InventoryLocationMapping
  providerWrites?: number
}

type LocationRoutingMode = 'existing' | 'create'

type WarehouseImportForm = {
  code: string
  name: string
  facilityType:
    | 'distribution_center'
    | 'store'
    | 'dark_store'
    | 'micro_fulfillment'
    | 'cross_dock'
    | 'supplier'
    | 'drop_ship'
    | 'third_party'
  timezone: string
}

const WAREHOUSE_FACILITY_OPTIONS: Array<{
  value: WarehouseImportForm['facilityType']
  label: string
}> = [
  { value: 'distribution_center', label: 'Distribution center' },
  { value: 'store', label: 'Store' },
  { value: 'dark_store', label: 'Dark store' },
  { value: 'micro_fulfillment', label: 'Micro-fulfillment center' },
  { value: 'cross_dock', label: 'Cross-dock facility' },
  { value: 'supplier', label: 'Supplier facility' },
  { value: 'drop_ship', label: 'Drop-ship node' },
  { value: 'third_party', label: 'Third-party warehouse' },
]

const WAREHOUSE_TIMEZONE_OPTIONS = [
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Phoenix',
  'America/Los_Angeles',
  'America/Anchorage',
  'Pacific/Honolulu',
  'America/Toronto',
  'America/Vancouver',
  'Europe/London',
  'UTC',
]

class InventoryRequestError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'InventoryRequestError'
  }
}

const RETAIN_IDEMPOTENCY_CODES = new Set([
  'SHOPIFY_INVENTORY_SYNC_IN_PROGRESS',
  'SHOPIFY_INVENTORY_READ_LEASE_LOST',
  'SHOPIFY_TIMEOUT',
  'SHOPIFY_UPSTREAM_FAILED',
])

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function text(value: unknown) {
  return typeof value === 'string' ? value : ''
}

function number(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : null
}

function booleanFact(value: unknown, whenTrue: string, whenFalse: string) {
  if (typeof value !== 'boolean') return ''
  return value ? whenTrue : whenFalse
}

function stringList(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
}

function recordList(value: unknown) {
  return Array.isArray(value)
    ? value
      .map((item) => record(item))
      .filter((item) => Object.keys(item).length > 0)
    : []
}

function formatQuantity(value: number) {
  return new Intl.NumberFormat(undefined, {
    maximumFractionDigits: 6,
  }).format(value)
}

function formatDate(value: string | null | undefined) {
  if (!value) return 'Not available'
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime())
    ? 'Not available'
    : parsed.toLocaleString()
}

function levelDetails(
  level: InventoryLevel,
  measurementSystem: MeasurementSystem,
) {
  const variant = record(level.product.variant)
  const product = record(variant.product)
  const inventoryItem = record(level.product.inventoryItem)
  const category = record(product.category)
  const unitCost = record(inventoryItem.unitCost)
  const selectedOptions = recordList(variant.selectedOptions)
    .map((option) => {
      const name = text(option.name)
      const value = text(option.value)
      return name && value ? `${name}: ${value}` : ''
    })
    .filter(Boolean)
  const countryHarmonizedSystemCodes = record(
    inventoryItem.countryHarmonizedSystemCodes,
  )
  const countryHsPageInfo = record(
    countryHarmonizedSystemCodes.pageInfo,
  )
  const countryHsCodes = recordList(
    countryHarmonizedSystemCodes.nodes,
  ).map((entry) => {
    const country = text(entry.countryCode)
    const code = text(entry.harmonizedSystemCode)
    return country && code ? `${country} ${code}` : ''
  }).filter(Boolean)
  const featuredMedia = record(product.featuredMedia)
  const preview = record(featuredMedia.preview)
  const featuredImage = record(preview.image)
  const providerDimensionEvidence = record(
    level.product.providerDimensionEvidence,
  )
  const partialDimensions = (
    [
      ['Variant', record(providerDimensionEvidence.variant)],
      ['Product', record(providerDimensionEvidence.product)],
    ] as const
  ).flatMap(([owner, axes]) => (
    (['length', 'width', 'height'] as const).flatMap((axis) => {
      const evidence = record(axes[axis])
      const millimeters = number(evidence.millimeters)
      return millimeters === null
        ? []
        : [
            `${owner} ${axis}: ${
              formatMillimeters(millimeters, measurementSystem)
            }; exact ${formatQuantity(millimeters)} mm (${text(evidence.key)})`,
          ]
    })
  ))
  return {
    inventoryItemId: text(inventoryItem.id),
    inventoryItemLegacyId: text(inventoryItem.legacyResourceId),
    variantId: text(variant.id),
    variantLegacyId: text(variant.legacyResourceId),
    productId: text(product.id),
    productLegacyId: text(product.legacyResourceId),
    providerProductName:
      text(product.title) || text(variant.displayName),
    variantTitle: text(variant.title),
    description: text(product.description),
    handle: text(product.handle),
    barcode: text(variant.barcode),
    vendor: text(product.vendor),
    productType: text(product.productType),
    productStatus: text(product.status),
    category: text(category.fullName) || text(category.name),
    tags: stringList(product.tags),
    selectedOptions,
    price: text(variant.price),
    compareAtPrice: text(variant.compareAtPrice),
    taxable: booleanFact(variant.taxable, 'Taxable', 'Not taxable'),
    availableForSale: booleanFact(
      variant.availableForSale,
      'Available for sale',
      'Unavailable for sale',
    ),
    inventoryQuantity: number(variant.inventoryQuantity),
    sellableOnlineQuantity: number(variant.sellableOnlineQuantity),
    totalInventory: number(product.totalInventory),
    tracksInventory: booleanFact(
      product.tracksInventory,
      'Product tracks inventory',
      'Product does not track inventory',
    ),
    hasOutOfStockVariants: booleanFact(
      product.hasOutOfStockVariants,
      'Has out-of-stock variants',
      'No out-of-stock variants',
    ),
    inventoryPolicy: text(variant.inventoryPolicy),
    requiresShipping:
      typeof inventoryItem.requiresShipping === 'boolean'
        ? inventoryItem.requiresShipping
        : null,
    unitCostAmount: text(unitCost.amount),
    unitCostCurrency: text(unitCost.currencyCode),
    harmonizedSystemCode: text(inventoryItem.harmonizedSystemCode),
    countryHsCodes,
    countryHsCodesTruncated:
      countryHsPageInfo.hasNextPage === true,
    countryCodeOfOrigin: text(inventoryItem.countryCodeOfOrigin),
    provinceCodeOfOrigin: text(inventoryItem.provinceCodeOfOrigin),
    onlineStoreUrl: text(product.onlineStoreUrl),
    inventoryItemCreatedAt: text(inventoryItem.createdAt),
    inventoryItemUpdatedAt: text(inventoryItem.updatedAt),
    variantCreatedAt: text(variant.createdAt),
    variantUpdatedAt: text(variant.updatedAt),
    productCreatedAt: text(product.createdAt),
    productUpdatedAt: text(product.updatedAt),
    productPublishedAt: text(product.publishedAt),
    duplicateSkuCount: number(inventoryItem.duplicateSkuCount),
    isGiftCard: booleanFact(
      product.isGiftCard,
      'Gift card',
      'Not a gift card',
    ),
    requiresComponents: booleanFact(
      variant.requiresComponents,
      'Requires components',
      'Does not require components',
    ),
    hasVariantsThatRequiresComponents: booleanFact(
      product.hasVariantsThatRequiresComponents,
      'Product has component variants',
      'No component variants',
    ),
    featuredImageUrl: text(featuredImage.url),
    featuredImageAlt:
      text(featuredImage.altText) || text(featuredMedia.alt),
    partialDimensions,
  }
}

function productFacts(
  level: InventoryLevel,
  measurementSystem: MeasurementSystem,
) {
  const details = levelDetails(level, measurementSystem)
  const facts = [
    ['Inventory item ID', details.inventoryItemId],
    ['Inventory item legacy ID', details.inventoryItemLegacyId],
    ['Product ID', details.productId],
    ['Product legacy ID', details.productLegacyId],
    ['Variant ID', details.variantId],
    ['Variant legacy ID', details.variantLegacyId],
    ['Shopify product', details.providerProductName],
    ['Variant', details.variantTitle],
    ['Options', details.selectedOptions.join(', ')],
    ['SKU', level.sku || 'Not assigned'],
    ['Barcode', details.barcode || 'Not assigned'],
    ['Vendor', details.vendor],
    ['Product type', details.productType],
    ['Category', details.category],
    ['Status', details.productStatus],
    ['Price', details.price],
    ['Compare-at price', details.compareAtPrice],
    ['Tax', details.taxable],
    ['Sales availability', details.availableForSale],
    [
      'Variant inventory',
      details.inventoryQuantity === null
        ? ''
        : formatQuantity(details.inventoryQuantity),
    ],
    [
      'Online sellable',
      details.sellableOnlineQuantity === null
        ? ''
        : formatQuantity(details.sellableOnlineQuantity),
    ],
    [
      'Product total inventory',
      details.totalInventory === null
        ? ''
        : formatQuantity(details.totalInventory),
    ],
    ['Tracking', details.tracksInventory],
    ['Out-of-stock variants', details.hasOutOfStockVariants],
    ['Inventory policy', details.inventoryPolicy],
    [
      'Duplicate SKU count',
      details.duplicateSkuCount === null
        ? ''
        : formatQuantity(details.duplicateSkuCount),
    ],
    ['Variant composition', details.requiresComponents],
    [
      'Product component coverage',
      details.hasVariantsThatRequiresComponents,
    ],
    ['Gift card', details.isGiftCard],
    [
      'Shipping',
      details.requiresShipping === null
        ? ''
        : details.requiresShipping
          ? 'Requires shipping'
          : 'No shipping required',
    ],
    [
      'Unit cost',
      details.unitCostAmount
        ? `${details.unitCostAmount} ${details.unitCostCurrency}`.trim()
        : '',
    ],
    ['HS code', details.harmonizedSystemCode],
    ['Country-specific HS', details.countryHsCodes.join(', ')],
    [
      'Country-specific HS coverage',
      details.countryHsCodesTruncated
        ? 'First 10 returned; more codes exist in Shopify'
        : details.countryHsCodes.length
          ? 'Complete bounded connection'
          : '',
    ],
    [
      'Origin',
      [
        details.countryCodeOfOrigin,
        details.provinceCodeOfOrigin,
      ].filter(Boolean).join('-'),
    ],
    ['Tags', details.tags.join(', ')],
    ['Shopify handle', details.handle],
    [
      'Inventory item created',
      details.inventoryItemCreatedAt
        ? formatDate(details.inventoryItemCreatedAt)
        : '',
    ],
    [
      'Inventory item updated',
      details.inventoryItemUpdatedAt
        ? formatDate(details.inventoryItemUpdatedAt)
        : '',
    ],
    [
      'Variant created',
      details.variantCreatedAt ? formatDate(details.variantCreatedAt) : '',
    ],
    [
      'Variant updated',
      details.variantUpdatedAt ? formatDate(details.variantUpdatedAt) : '',
    ],
    [
      'Product created',
      details.productCreatedAt ? formatDate(details.productCreatedAt) : '',
    ],
    [
      'Product updated',
      details.productUpdatedAt ? formatDate(details.productUpdatedAt) : '',
    ],
    [
      'Product published',
      details.productPublishedAt
        ? formatDate(details.productPublishedAt)
        : '',
    ],
  ].filter((fact): fact is string[] => Boolean(fact[1]))
  return { details, facts }
}

function dimensionSource(
  dimensions: InventoryLevel['providerDimensionsMm'],
) {
  if (!dimensions) return ''
  if (dimensions.source === 'variant_metafield') {
    return 'Shopify variant metafields'
  }
  if (dimensions.source === 'product_metafield') {
    return 'Shopify product metafields'
  }
  return dimensions.source || 'Shopify metadata'
}

function locationAddress(location: InventoryLocation | undefined) {
  if (!location?.address) return ''
  return [
    location.address.line1,
    location.address.line2,
    location.address.city,
    location.address.regionCode || location.address.region,
    location.address.postalCode,
    location.address.countryCode || location.address.country,
  ].filter(Boolean).join(', ')
}

function stateLabel(level: InventoryLevel) {
  if (level.projectionState === 'projected') return 'Projected'
  if (level.projectionState === 'unmapped') return 'Needs product mapping'
  if (level.projectionState === 'untracked') return 'Not tracked'
  if (level.projectionState === 'negative_available') {
    return 'Negative available'
  }
  return 'Quantity mismatch'
}

function stateColor(level: InventoryLevel) {
  if (level.projectionState === 'projected') return 'success' as const
  if (level.projectionState === 'untracked') return 'default' as const
  return 'warning' as const
}

function idempotencyKey() {
  const id = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`
  return `shopify-inventory:${id}`
}

function suggestedWarehouseCode(location: InventoryLocation) {
  const stem = String(location.name || 'SHOPIFY')
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toUpperCase()
    .slice(0, 24)
  return `${stem || 'SHOPIFY'}-01`.slice(0, 32)
}

function warehouseImportForm(location: InventoryLocation): WarehouseImportForm {
  return {
    code: suggestedWarehouseCode(location),
    name: String(location.name || 'Shopify warehouse').trim(),
    facilityType: 'distribution_center',
    timezone: '',
  }
}

export default function ShopifyInventoryPanel({
  accountGlobalId,
  displayName,
  onOpenOrder,
}: {
  accountGlobalId: string
  displayName: string
  onOpenOrder: (orderGlobalId: string) => void
}) {
  const {
    measurementSystem,
    effectiveSource: measurementPreferenceSource,
    loading: measurementPreferenceLoading,
    error: measurementPreferenceError,
    preferencesWritable,
    setUserOverride,
  } = useMeasurementSystem()
  const [inventory, setInventory] = useState<InventoryState | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingMappingGlobalId, setLoadingMappingGlobalId] = useState('')
  const [syncingMappingGlobalId, setSyncingMappingGlobalId] = useState('')
  const [selectedMappingGlobalId, setSelectedMappingGlobalId] = useState('')
  const [mappingLocation, setMappingLocation] =
    useState<InventoryLocation | null>(null)
  const [locationRoutingMode, setLocationRoutingMode] =
    useState<LocationRoutingMode>('existing')
  const [warehouseImport, setWarehouseImport] =
    useState<WarehouseImportForm | null>(null)
  const [mappingWarehouseGlobalId, setMappingWarehouseGlobalId] = useState('')
  const [mappingInternalLocationGlobalId, setMappingInternalLocationGlobalId] =
    useState('')
  const [mappingBusy, setMappingBusy] = useState(false)
  const [measurementPreferenceBusy, setMeasurementPreferenceBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(0)
  const syncIdempotencyKeys = useRef(new Map<string, string>())
  const mappingIdempotencyKeys = useRef(new Map<string, string>())
  const rowsPerPage = 10

  const load = useCallback(async (
    signal?: AbortSignal,
    mappingGlobalId?: string,
  ) => {
    const params = new URLSearchParams({ accountGlobalId })
    if (mappingGlobalId) params.set('mappingGlobalId', mappingGlobalId)
    const response = await fetch(
      `/api/integrations/commerce/inventory?${params.toString()}`,
      { cache: 'no-store', signal },
    )
    const payload = await response.json() as InventoryPayload
    if (!response.ok || !payload.inventory) {
      throw new Error(payload.error || 'Shopify inventory is unavailable.')
    }
    setInventory(payload.inventory)
    setSelectedMappingGlobalId((current) => {
      const mappings = payload.inventory?.mappings || []
      if (mappingGlobalId && mappings.some(
        (mapping) => mapping.globalId === mappingGlobalId,
      )) return mappingGlobalId
      if (current && mappings.some(
        (mapping) => mapping.globalId === current,
      )) return current
      const latestRunGlobalId = payload.inventory?.latestRun?.globalId
      return mappings.find(
        (mapping) => mapping.latestRun?.globalId === latestRunGlobalId,
      )?.globalId || mappings[0]?.globalId || ''
    })
    return payload.inventory
  }, [accountGlobalId])

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError('')
    setNotice('')
    setInventory(null)
    setSearch('')
    setPage(0)
    setSelectedMappingGlobalId('')
    setMappingLocation(null)
    setLocationRoutingMode('existing')
    setWarehouseImport(null)
    syncIdempotencyKeys.current.clear()
    mappingIdempotencyKeys.current.clear()
    load(controller.signal)
      .catch((caught) => {
        if (
          caught instanceof DOMException
          && caught.name === 'AbortError'
        ) return
        setError(
          caught instanceof Error
            ? caught.message
            : 'Shopify inventory is unavailable.',
        )
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [load])

  const filteredLevels = useMemo(() => {
    const needle = search.trim().toLowerCase()
    if (!needle) return inventory?.levels || []
    return (inventory?.levels || []).filter((level) => {
      const details = levelDetails(level, measurementSystem)
      return [
        level.productName,
        level.productGlobalId,
        level.sku,
        details.providerProductName,
        details.variantTitle,
        details.barcode,
        details.vendor,
      ].some((value) => String(value || '').toLowerCase().includes(needle))
    })
  }, [inventory?.levels, measurementSystem, search])

  const visibleLevels = filteredLevels.slice(
    page * rowsPerPage,
    page * rowsPerPage + rowsPerPage,
  )

  async function changeMeasurementPreference(next: MeasurementSystem | null) {
    if (
      !preferencesWritable
      || !next
      || next === measurementSystem
      || measurementPreferenceBusy
    ) return
    setMeasurementPreferenceBusy(true)
    setError('')
    try {
      await setUserOverride(next)
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : 'Measurement preference could not be updated.',
      )
    } finally {
      setMeasurementPreferenceBusy(false)
    }
  }

  async function showMappingDetails(mappingGlobalId: string) {
    if (!mappingGlobalId || loadingMappingGlobalId) return
    setLoadingMappingGlobalId(mappingGlobalId)
    setError('')
    setNotice('')
    try {
      await load(undefined, mappingGlobalId)
      setSearch('')
      setPage(0)
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : 'The selected Shopify inventory import is unavailable.',
      )
    } finally {
      setLoadingMappingGlobalId('')
    }
  }

  async function sync(mapping: InventoryLocationMapping) {
    if (syncingMappingGlobalId) return
    const requestIdempotencyKey =
      syncIdempotencyKeys.current.get(mapping.globalId) || idempotencyKey()
    syncIdempotencyKeys.current.set(mapping.globalId, requestIdempotencyKey)
    setSyncingMappingGlobalId(mapping.globalId)
    setError('')
    setNotice('')
    try {
      const response = await fetch('/api/integrations/commerce/inventory', {
        method: 'POST',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'sync',
          accountGlobalId,
          mappingGlobalId: mapping.globalId,
          expectedMappingRowVersion: mapping.rowVersion,
          idempotencyKey: requestIdempotencyKey,
        }),
      })
      const payload = await response.json() as InventoryPayload
      if (!response.ok || !payload.inventory) {
        throw new InventoryRequestError(
          payload.error || 'Shopify inventory could not be synchronized.',
          payload.code || 'SHOPIFY_INVENTORY_SYNC_FAILED',
          response.status,
        )
      }
      setInventory(payload.inventory)
      setSelectedMappingGlobalId(mapping.globalId)
      syncIdempotencyKeys.current.delete(mapping.globalId)
      setSearch('')
      setPage(0)
      setNotice(
        payload.replayed
          ? 'The request was replayed without another Shopify read; the current inventory state is shown.'
          : payload.inventory.latestRun?.levelsProjected
            ? `${mapping.externalLocationName} inventory was read successfully; ${
              payload.inventory.latestRun.levelsProjected
            } item${
              payload.inventory.latestRun.levelsProjected === 1 ? '' : 's'
            } projected into the selected warehouse.`
            : `${mapping.externalLocationName} inventory was read successfully, but no item passed every mapping and quantity check for projection.`,
      )
    } catch (caught) {
      if (
        caught instanceof InventoryRequestError
        && caught.status < 500
        && !RETAIN_IDEMPOTENCY_CODES.has(caught.code)
      ) {
        syncIdempotencyKeys.current.delete(mapping.globalId)
      }
      setError(
        caught instanceof Error
          ? caught.message
          : 'Shopify inventory could not be synchronized.',
      )
    } finally {
      setSyncingMappingGlobalId('')
    }
  }

  const providerLocations = inventory?.providerLocations || []
  const mappings = inventory?.mappings || []
  const warehouses = inventory?.warehouses || []
  const selectedMapping = mappings.find(
    (mapping) => mapping.globalId === selectedMappingGlobalId,
  ) || null
  const selectedMappingWarehouse = warehouses.find(
    (warehouse) => warehouse.globalId === mappingWarehouseGlobalId,
  ) || null
  const selectedWarehouseLocations = (
    selectedMappingWarehouse?.locations || []
  ).filter((location) => location.active)

  function mappingForLocation(location: InventoryLocation) {
    return mappings.find((mapping) => (
      mapping.globalId === location.mappingGlobalId
      || mapping.externalLocationId === location.id
    )) || null
  }

  function openMapping(
    location: InventoryLocation,
    mode: LocationRoutingMode = 'existing',
  ) {
    const current = mappingForLocation(location)
    setMappingLocation(location)
    setLocationRoutingMode(current ? 'existing' : mode)
    setWarehouseImport(current ? null : warehouseImportForm(location))
    setMappingWarehouseGlobalId(current?.warehouse.globalId || '')
    setMappingInternalLocationGlobalId(current?.location.globalId || '')
    setError('')
    setNotice('')
  }

  function closeMapping() {
    if (mappingBusy) return
    setMappingLocation(null)
    setLocationRoutingMode('existing')
    setWarehouseImport(null)
    setMappingWarehouseGlobalId('')
    setMappingInternalLocationGlobalId('')
  }

  function openWarehouseSetup() {
    closeMapping()
    window.location.hash = '#operations/warehouses'
  }

  async function saveMapping() {
    if (
      !mappingLocation?.id
      || mappingLocation.mappingEligible !== true
      || !mappingWarehouseGlobalId
      || !mappingInternalLocationGlobalId
      || mappingBusy
    ) return
    const current = mappingForLocation(mappingLocation)
    const requestIdempotencyKey =
      mappingIdempotencyKeys.current.get(`map:${mappingLocation.id}`)
      || idempotencyKey()
    mappingIdempotencyKeys.current.set(
      `map:${mappingLocation.id}`,
      requestIdempotencyKey,
    )
    setMappingBusy(true)
    setError('')
    setNotice('')
    try {
      const response = await fetch('/api/integrations/commerce/inventory', {
        method: 'POST',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'map-location',
          accountGlobalId,
          externalLocationId: mappingLocation.id,
          warehouseGlobalId: mappingWarehouseGlobalId,
          locationGlobalId: mappingInternalLocationGlobalId,
          mappingGlobalId: current?.globalId || null,
          expectedRowVersion: current?.rowVersion ?? null,
          idempotencyKey: requestIdempotencyKey,
        }),
      })
      const payload = await response.json() as InventoryPayload
      if (!response.ok || !payload.inventory || !payload.mapping) {
        throw new InventoryRequestError(
          payload.error || 'The Shopify location could not be mapped.',
          payload.code || 'SHOPIFY_INVENTORY_LOCATION_MAPPING_FAILED',
          response.status,
        )
      }
      if (payload.providerWrites !== 0) {
        throw new InventoryRequestError(
          'The location mapping response did not preserve the zero-write boundary.',
          'SHOPIFY_INVENTORY_LOCATION_MAPPING_WRITE_BOUNDARY_FAILED',
          502,
        )
      }
      setInventory(payload.inventory)
      setSelectedMappingGlobalId(payload.mapping.globalId)
      mappingIdempotencyKeys.current.delete(`map:${mappingLocation.id}`)
      setMappingLocation(null)
      setMappingWarehouseGlobalId('')
      setMappingInternalLocationGlobalId('')
      setNotice(
        `${payload.mapping.externalLocationName} now imports into ${
          payload.mapping.warehouse.name
        } / ${payload.mapping.location.code}. No Shopify inventory was changed.`,
      )
    } catch (caught) {
      if (
        caught instanceof InventoryRequestError
        && caught.status < 500
        && mappingLocation?.id
      ) {
        mappingIdempotencyKeys.current.delete(`map:${mappingLocation.id}`)
      }
      setError(
        caught instanceof Error
          ? caught.message
          : 'The Shopify location could not be mapped.',
      )
    } finally {
      setMappingBusy(false)
    }
  }

  async function createWarehouseFromShopifyLocation() {
    if (
      !mappingLocation?.id
      || mappingLocation.mappingEligible !== true
      || !warehouseImport?.code.trim()
      || !warehouseImport.name.trim()
      || !warehouseImport.timezone
      || mappingBusy
    ) return
    const key = `create:${mappingLocation.id}`
    const requestIdempotencyKey =
      mappingIdempotencyKeys.current.get(key) || idempotencyKey()
    mappingIdempotencyKeys.current.set(key, requestIdempotencyKey)
    setMappingBusy(true)
    setError('')
    setNotice('')
    try {
      const response = await fetch('/api/integrations/commerce/inventory', {
        method: 'POST',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'create-warehouse-and-map',
          accountGlobalId,
          externalLocationId: mappingLocation.id,
          warehouse: {
            code: warehouseImport.code.trim(),
            name: warehouseImport.name.trim(),
            facilityType: warehouseImport.facilityType,
            timezone: warehouseImport.timezone,
          },
          idempotencyKey: requestIdempotencyKey,
        }),
      })
      const payload = await response.json() as InventoryPayload
      if (!response.ok || !payload.inventory || !payload.mapping) {
        throw new InventoryRequestError(
          payload.error || 'The ClawPilot warehouse could not be created.',
          payload.code || 'SHOPIFY_INVENTORY_WAREHOUSE_CREATE_FAILED',
          response.status,
        )
      }
      if (payload.providerWrites !== 0) {
        throw new InventoryRequestError(
          'The warehouse import response did not preserve the zero-write boundary.',
          'SHOPIFY_INVENTORY_LOCATION_MAPPING_WRITE_BOUNDARY_FAILED',
          502,
        )
      }
      setInventory(payload.inventory)
      setSelectedMappingGlobalId(payload.mapping.globalId)
      mappingIdempotencyKeys.current.delete(key)
      setMappingLocation(null)
      setLocationRoutingMode('existing')
      setWarehouseImport(null)
      setMappingWarehouseGlobalId('')
      setMappingInternalLocationGlobalId('')
      setNotice(
        `${payload.mapping.warehouse.name} was created from ${
          payload.mapping.externalLocationName
        } and routed to ${payload.mapping.location.code}. Shopify was not changed.`,
      )
    } catch (caught) {
      if (
        caught instanceof InventoryRequestError
        && caught.status < 500
      ) {
        mappingIdempotencyKeys.current.delete(key)
      }
      setError(
        caught instanceof Error
          ? caught.message
          : 'The ClawPilot warehouse could not be created.',
      )
    } finally {
      setMappingBusy(false)
    }
  }

  const mappingLocationCurrent = mappingLocation
    ? mappingForLocation(mappingLocation)
    : null
  const run = inventory?.latestRun
  const refreshRecovery = inventory?.refreshRecovery
  const affectedOrders = refreshRecovery?.affectedOrders || []
  const providerCommitmentRecovery = Boolean(
    refreshRecovery?.managerRecoveryRequired
    && refreshRecovery.lastErrorCode
      === 'SHOPIFY_INVENTORY_PROVIDER_COMMITMENT_CONFLICT'
    && affectedOrders.length > 0,
  )
  const automaticRefreshBusy = (
    refreshRecovery?.status === 'pending'
    || refreshRecovery?.status === 'processing'
    || refreshRecovery?.status === 'failed'
  )
  useEffect(() => {
    if (!automaticRefreshBusy) return
    const interval = window.setInterval(() => {
      void load().catch((caught) => {
        setError(
          caught instanceof Error
            ? caught.message
            : 'Shopify inventory status could not be refreshed.',
        )
      })
    }, 5_000)
    return () => window.clearInterval(interval)
  }, [automaticRefreshBusy, load])
  const providerLocation =
    inventory?.providerLocation || run?.providerLocation
  const enrichment = inventory?.enrichment || run?.enrichment
  const returnedWarnings = [
    ...(inventory?.warnings || []),
    ...(run?.warnings || []),
  ]
  const enrichmentWarnings = [
    ...returnedWarnings,
    ...(providerLocation?.addressVerified === false
      ? ['Shopify has not verified the selected location address.']
      : []),
    ...(providerLocation?.shipsInventory === false
      ? ['The selected Shopify location is not configured to ship inventory.']
      : []),
    ...(providerLocation?.fulfillsOnlineOrders === false
      ? ['The selected Shopify location does not fulfill online orders.']
      : []),
    ...(providerLocation?.isFulfillmentService === true
      ? ['The selected location is managed by a fulfillment service.']
      : []),
    ...(enrichment?.unitCostAvailable === false
      ? ['Shopify did not authorize unit-cost enrichment for this sync.']
      : []),
    ...((enrichment?.ambiguousDimensionDefinitions?.length || 0) > 0
      ? [
          `${
            enrichment?.ambiguousDimensionDefinitions?.length
          } Shopify dimension definition${
            enrichment?.ambiguousDimensionDefinitions?.length === 1
              ? ' is'
              : 's are'
          } ambiguous and was not used: ${
            (enrichment?.ambiguousDimensionDefinitions || [])
              .slice(0, 8)
              .map((definition) => definition.identifier || 'unnamed')
              .join(', ')
          }${
            (enrichment?.ambiguousDimensionDefinitions?.length || 0) > 8
              ? ', …'
              : ''
          }.`,
        ]
      : []),
  ].filter((warning, index, warnings) => (
    warning && warnings.indexOf(warning) === index
  ))

  return (
    <Card variant="outlined" id="operations/shopify-inventory">
      <CardContent sx={{ '&:last-child': { pb: 2 } }}>
        <Stack spacing={2}>
          <Stack
            direction={{ xs: 'column', md: 'row' }}
            justifyContent="space-between"
            alignItems={{ md: 'center' }}
            spacing={1.5}
          >
            <Box>
              <Typography variant="overline" color="text.secondary">
                Inventory
              </Typography>
              <Typography variant="h6" fontWeight={700}>
                Shopify inventory
              </Typography>
              <Typography variant="body2" color="text.secondary">
                Route each {displayName} location into the matching ClawPilot
                warehouse and internal stock location.
              </Typography>
            </Box>
            <Box>
              <ToggleButtonGroup
                exclusive
                size="small"
                value={measurementSystem}
                onChange={(_event, next: MeasurementSystem | null) => {
                  void changeMeasurementPreference(next)
                }}
                disabled={
                  !preferencesWritable
                  || measurementPreferenceLoading
                  || measurementPreferenceBusy
                }
                aria-label="Shopify inventory measurement system"
              >
                <ToggleButton value="imperial">Imperial</ToggleButton>
                <ToggleButton value="metric">Metric</ToggleButton>
              </ToggleButtonGroup>
              <Typography
                variant="caption"
                color="text.secondary"
                display="block"
                sx={{ mt: 0.5, textAlign: { md: 'right' } }}
              >
                {measurementPreferenceSource === 'user'
                  ? 'Your display preference'
                  : measurementPreferenceSource === 'organization'
                    ? 'Organization default'
                    : preferencesWritable
                      ? 'System default'
                      : 'System default · no active organization'}
              </Typography>
            </Box>
          </Stack>

          <Stack
            direction={{ xs: 'column', sm: 'row' }}
            justifyContent="space-between"
            alignItems={{ sm: 'center' }}
            spacing={1}
          >
            <Stack direction="row" spacing={0.75} alignItems="center">
              <Inventory2Rounded color="action" fontSize="small" />
              <Typography variant="caption" color="text.secondary">
                Inventory import is Shopify → ClawPilot and makes zero Shopify
                writes. Shopify committed units remain already reserved.
              </Typography>
            </Stack>
            <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap>
              <ShopifyLocationAdministrationPanel
                accountGlobalId={accountGlobalId}
                onProviderLocationsChanged={async () => {
                  await load()
                }}
              />
              <Button
                size="small"
                variant="outlined"
                startIcon={<WarehouseRounded />}
                onClick={openWarehouseSetup}
                sx={{ minHeight: 36, flexShrink: 0 }}
              >
                Manage warehouses
              </Button>
            </Stack>
          </Stack>

          {!loading && providerLocations.length ? (
            <TableContainer sx={{ maxWidth: '100%', overflowX: 'auto' }}>
              <Table size="small" aria-label="Shopify location routing">
                <TableHead>
                  <TableRow>
                    <TableCell>Shopify location</TableCell>
                    <TableCell>Control</TableCell>
                    <TableCell>ClawPilot route</TableCell>
                    <TableCell>Import</TableCell>
                    <TableCell>Latest refresh</TableCell>
                    <TableCell align="right">Actions</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {providerLocations.map((location) => {
                    const mapping = mappingForLocation(location)
                    const fulfillmentService =
                      location.ownershipClassification
                        === 'fulfillment_service'
                      || location.isFulfillmentService === true
                    const mappingEligible =
                      location.mappingEligible === true && !fulfillmentService
                    const syncingThis =
                      syncingMappingGlobalId === mapping?.globalId
                    const loadingThis =
                      loadingMappingGlobalId === mapping?.globalId
                    return (
                      <TableRow
                        key={location.id || location.name}
                        selected={Boolean(
                          mapping
                          && mapping.globalId === selectedMappingGlobalId,
                        )}
                      >
                        <TableCell sx={{ minWidth: 220, verticalAlign: 'top' }}>
                          <Typography variant="body2" fontWeight={700}>
                            {location.name || 'Unnamed Shopify location'}
                          </Typography>
                          {locationAddress(location) ? (
                            <Typography
                              variant="caption"
                              color="text.secondary"
                              display="block"
                            >
                              {locationAddress(location)}
                            </Typography>
                          ) : null}
                        </TableCell>
                        <TableCell sx={{ minWidth: 150, verticalAlign: 'top' }}>
                          <Chip
                            size="small"
                            variant="outlined"
                            color={fulfillmentService ? 'default' : 'success'}
                            label={fulfillmentService
                              ? 'Provider / app managed'
                              : 'Merchant managed'}
                          />
                          {fulfillmentService ? (
                            <Typography
                              variant="caption"
                              color="text.secondary"
                              display="block"
                              sx={{ mt: 0.5 }}
                            >
                              {location.fulfillmentService?.serviceName
                                || 'External fulfillment service'}
                            </Typography>
                          ) : null}
                        </TableCell>
                        <TableCell sx={{ minWidth: 210, verticalAlign: 'top' }}>
                          {mapping ? (
                            <>
                              <Typography variant="body2" fontWeight={700}>
                                {mapping.warehouse.name}
                              </Typography>
                              <Typography
                                variant="caption"
                                color="text.secondary"
                                display="block"
                              >
                                {mapping.location.code}
                                {mapping.location.zone
                                  ? ` · ${mapping.location.zone}`
                                  : ''}
                              </Typography>
                            </>
                          ) : (
                            <Typography variant="body2" color="text.secondary">
                              Not mapped
                            </Typography>
                          )}
                        </TableCell>
                        <TableCell sx={{ minWidth: 125, verticalAlign: 'top' }}>
                          <Chip
                            size="small"
                            variant="outlined"
                            color={mapping?.inventoryImportEnabled
                              ? 'success'
                              : 'default'}
                            label={fulfillmentService
                              ? 'Read only'
                              : mapping?.inventoryImportEnabled
                                ? 'Enabled'
                                : 'Not configured'}
                          />
                          {!mappingEligible && !mapping ? (
                            <Typography
                              variant="caption"
                              color="text.secondary"
                              display="block"
                              sx={{ mt: 0.5, maxWidth: 220 }}
                            >
                              {location.mappingIneligibleReason
                                || 'This location cannot be mapped by default.'}
                            </Typography>
                          ) : null}
                        </TableCell>
                        <TableCell sx={{ minWidth: 170, verticalAlign: 'top' }}>
                          <Typography variant="body2">
                            {mapping?.latestRun
                              ? formatDate(
                                mapping.latestRun.completedAt
                                  || mapping.latestRun.providerFetchedAt,
                              )
                              : 'Never imported'}
                          </Typography>
                          {mapping?.latestRun ? (
                            <Typography
                              variant="caption"
                              color="text.secondary"
                              display="block"
                            >
                              {mapping.latestRun.levelsProjected} projected
                            </Typography>
                          ) : null}
                        </TableCell>
                        <TableCell
                          align="right"
                          sx={{ minWidth: 250, verticalAlign: 'top' }}
                        >
                          <Stack
                            direction="row"
                            spacing={0.75}
                            justifyContent="flex-end"
                            flexWrap="wrap"
                            useFlexGap
                          >
                            {mapping?.latestRun ? (
                              <Button
                                size="small"
                                disabled={Boolean(loadingMappingGlobalId)}
                                startIcon={loadingThis
                                  ? <CircularProgress size={14} />
                                  : <OpenInNewRounded />}
                                onClick={() => {
                                  void showMappingDetails(mapping.globalId)
                                }}
                              >
                                View import
                              </Button>
                            ) : null}
                            {mappingEligible ? (
                              <Button
                                size="small"
                                variant={mapping ? 'text' : 'outlined'}
                                onClick={() => openMapping(location, 'existing')}
                              >
                                {mapping ? 'Change route' : 'Map existing'}
                              </Button>
                            ) : null}
                            {mappingEligible && !mapping ? (
                              <Button
                                size="small"
                                variant="contained"
                                startIcon={<WarehouseRounded />}
                                onClick={() => openMapping(location, 'create')}
                              >
                                Create warehouse
                              </Button>
                            ) : null}
                            {mapping?.inventoryImportEnabled ? (
                              <Button
                                size="small"
                                variant="contained"
                                startIcon={syncingThis
                                  ? (
                                    <CircularProgress
                                      size={14}
                                      color="inherit"
                                    />
                                  )
                                  : <RefreshRounded />}
                                disabled={
                                  Boolean(syncingMappingGlobalId)
                                  || automaticRefreshBusy
                                  || providerCommitmentRecovery
                                }
                                onClick={() => { void sync(mapping) }}
                              >
                                {syncingThis ? 'Refreshing…' : 'Refresh this'}
                              </Button>
                            ) : null}
                          </Stack>
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            </TableContainer>
          ) : null}

          {!loading && !providerLocations.length ? (
            <Typography variant="body2" color="text.secondary">
              No Shopify locations are available for this connection.
            </Typography>
          ) : null}

          {providerCommitmentRecovery ? (
            <Alert severity="error">
              <Stack spacing={1.25} alignItems="flex-start">
                <Typography variant="body2">
                  Shopify’s current inventory no longer covers units reserved
                  for {affectedOrders.length === 1
                    ? 'this Operations order'
                    : 'these Operations orders'}. Open the affected order
                  {affectedOrders.length === 1 ? '' : 's'},
                  reconcile the Shopify fulfillment, then retry inventory sync.
                </Typography>
                {affectedOrders.map((order) => (
                  <Button
                    key={order.globalId}
                    size="small"
                    variant="outlined"
                    startIcon={<OpenInNewRounded />}
                    onClick={() => onOpenOrder(order.globalId)}
                  >
                    Open order {order.orderNumber}
                  </Button>
                ))}
              </Stack>
            </Alert>
          ) : refreshRecovery?.managerRecoveryRequired ? (
            <Alert severity="error">
              Automatic Shopify inventory refresh is paused for this
              connection after {refreshRecovery.attemptCount} of{' '}
              {refreshRecovery.maxAttempts} attempts
              {refreshRecovery.lastErrorCode
                ? ` (${refreshRecovery.lastErrorCode})`
                : ''}. Correct the connection, scope, location, or warehouse
              blocker, then choose <strong>Refresh this</strong> for the mapped
              location.
              The failed job remains preserved as audit evidence.
            </Alert>
          ) : automaticRefreshBusy ? (
            <Alert severity="info">
              Shopify inventory refresh is queued or retrying automatically.
              Wait for that bounded attempt instead of starting another read.
            </Alert>
          ) : refreshRecovery?.recoveredAfterDead ? (
            <Alert severity="success">
              Inventory recovery succeeded. The prior dead job remains audit
              evidence and automatic scheduling is eligible again.
            </Alert>
          ) : null}

          {error ? <Alert severity="error">{error}</Alert> : null}
          {measurementPreferenceError ? (
            <Alert severity="warning">{measurementPreferenceError}</Alert>
          ) : null}
          {notice ? <Alert severity="success">{notice}</Alert> : null}
          {enrichmentWarnings.length ? (
            <Box component="details" sx={{ '& summary': { cursor: 'pointer' } }}>
              <Typography
                component="summary"
                variant="caption"
                color="warning.main"
              >
                {enrichmentWarnings.length} import note{
                  enrichmentWarnings.length === 1 ? '' : 's'
                }
              </Typography>
              <Stack spacing={0.25} sx={{ mt: 0.5, pl: 2 }}>
                {enrichmentWarnings.map((warning) => (
                  <Typography
                    key={warning}
                    component="span"
                    variant="caption"
                    color="text.secondary"
                  >
                    {warning}
                  </Typography>
                ))}
              </Stack>
            </Box>
          ) : null}

          {loading && !inventory ? (
            <Box sx={{ minHeight: 120, display: 'grid', placeItems: 'center' }}>
              <CircularProgress size={28} />
            </Box>
          ) : null}

          {!loading && selectedMapping && !run ? (
            <Typography variant="body2" color="text.secondary">
              {selectedMapping.externalLocationName} is routed but has not been
              imported yet. Choose <strong>Refresh this</strong> in the location
              table when you are ready.
            </Typography>
          ) : null}

          {run ? (
            <>
              <Divider />
              <Box>
                <Typography variant="overline" color="text.secondary">
                  Selected location import
                </Typography>
                <Typography variant="h6" fontWeight={700}>
                  {selectedMapping?.externalLocationName
                    || run.providerLocationName}
                </Typography>
              </Box>
              {providerLocation ? (
                <Card variant="outlined">
                  <CardContent sx={{ '&:last-child': { pb: 1.5 } }}>
                    <Stack spacing={1}>
                      <Box>
                        <Typography variant="caption" color="text.secondary">
                          Shopify source location
                        </Typography>
                        <Typography variant="body2" fontWeight={700}>
                          {providerLocation.name || run.providerLocationName}
                        </Typography>
                        {locationAddress(providerLocation) ? (
                          <Typography
                            variant="caption"
                            color="text.secondary"
                          >
                            {locationAddress(providerLocation)}
                          </Typography>
                        ) : null}
                      </Box>
                      <Stack direction="row" gap={0.75} flexWrap="wrap">
                        {typeof providerLocation.isActive === 'boolean' ? (
                          <Chip
                            size="small"
                            color={providerLocation.isActive
                              ? 'success'
                              : 'warning'}
                            variant="outlined"
                            label={providerLocation.isActive
                              ? 'Active location'
                              : 'Inactive location'}
                          />
                        ) : null}
                        {typeof providerLocation.shipsInventory
                          === 'boolean' ? (
                            <Chip
                              size="small"
                              color={providerLocation.shipsInventory
                                ? 'success'
                                : 'warning'}
                              variant="outlined"
                              label={providerLocation.shipsInventory
                                ? 'Ships inventory'
                                : 'Does not ship inventory'}
                            />
                          ) : null}
                        {typeof providerLocation.fulfillsOnlineOrders
                          === 'boolean' ? (
                            <Chip
                              size="small"
                              color={providerLocation.fulfillsOnlineOrders
                                ? 'success'
                                : 'warning'}
                              variant="outlined"
                              label={providerLocation.fulfillsOnlineOrders
                                ? 'Fulfills online orders'
                                : 'No online fulfillment'}
                            />
                          ) : null}
                        {typeof providerLocation.addressVerified
                          === 'boolean' ? (
                            <Chip
                              size="small"
                              color={providerLocation.addressVerified
                                ? 'success'
                                : 'warning'}
                              variant="outlined"
                              label={providerLocation.addressVerified
                                ? 'Address verified'
                                : 'Address not verified'}
                            />
                          ) : null}
                        {providerLocation.fulfillmentService?.serviceName ? (
                          <Chip
                            size="small"
                            variant="outlined"
                            label={`Fulfillment service: ${
                              providerLocation.fulfillmentService.serviceName
                            }`}
                          />
                        ) : null}
                      </Stack>
                    </Stack>
                  </CardContent>
                </Card>
              ) : null}

              <Box
                sx={{
                  display: 'grid',
                  gridTemplateColumns: {
                    xs: 'repeat(2, minmax(0, 1fr))',
                    md: 'repeat(4, minmax(0, 1fr))',
                  },
                  gap: 1,
                }}
              >
                {[
                  ['Available to sell', run.operationalAvailableQuantity],
                  ['Committed to orders', run.providerCommittedQuantity],
                  ['Shopify physical on hand', run.providerOnHandQuantity],
                  ['Inventory items projected', run.levelsProjected],
                ].map(([label, value]) => (
                  <Card key={String(label)} variant="outlined">
                    <CardContent sx={{ '&:last-child': { pb: 1.5 } }}>
                      <Typography variant="caption" color="text.secondary">
                        {label}
                      </Typography>
                      <Typography variant="h6" fontWeight={700}>
                        {formatQuantity(Number(value))}
                      </Typography>
                    </CardContent>
                  </Card>
                ))}
              </Box>

              <Stack direction="row" gap={0.75} flexWrap="wrap">
                <Chip
                  size="small"
                  color="success"
                  variant="outlined"
                  label={`${run.levelsMapped} mapped`}
                />
                <Chip
                  size="small"
                  color={run.levelsUnmapped ? 'warning' : 'default'}
                  variant="outlined"
                  label={`${run.levelsUnmapped} unmapped`}
                />
                <Chip
                  size="small"
                  color={run.levelsUntracked ? 'warning' : 'default'}
                  variant="outlined"
                  label={`${run.levelsUntracked} untracked`}
                />
                <Chip
                  size="small"
                  color={run.equationMismatchLevels ? 'warning' : 'default'}
                  variant="outlined"
                  label={`${run.equationMismatchLevels} state mismatches`}
                />
                <Chip
                  size="small"
                  color={run.negativeAvailableLevels ? 'warning' : 'default'}
                  variant="outlined"
                  label={`${run.negativeAvailableLevels} negative ATP`}
                />
                <Chip
                  size="small"
                  variant="outlined"
                  label="0 order units reapplied"
                />
                <Chip
                  size="small"
                  variant="outlined"
                  label="0 Shopify writes"
                />
              </Stack>

              <Typography variant="body2" color="text.secondary">
                {run.providerLocationName} → {run.warehouseName} /{' '}
                {run.locationCode} · fetched {formatDate(run.providerFetchedAt)}
                {' '}· evidence {run.globalId} / {run.snapshotHashPrefix}…
              </Typography>

              <Divider />

              <TextField
                size="small"
                label="Search inventory"
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value)
                  setPage(0)
                }}
                inputProps={{
                  'aria-label': 'Search Shopify inventory',
                }}
                sx={{ maxWidth: 460 }}
              />

              <TableContainer sx={{ maxWidth: '100%', overflowX: 'auto' }}>
                <Table size="small" aria-label="Shopify inventory levels">
                  <TableHead>
                    <TableRow>
                      <TableCell>Product</TableCell>
                      <TableCell>Projection</TableCell>
                      <TableCell>All Shopify states</TableCell>
                      <TableCell>Imported physical facts</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {visibleLevels.map((level) => {
                      const { details, facts } = productFacts(
                        level,
                        measurementSystem,
                      )
                      const dimensions = level.providerDimensionsMm
                      const completeDimensions = dimensions
                        && typeof dimensions.length === 'number'
                        && typeof dimensions.width === 'number'
                        && typeof dimensions.height === 'number'
                        ? {
                            lengthMm: dimensions.length,
                            widthMm: dimensions.width,
                            heightMm: dimensions.height,
                          }
                        : null
                      const dimensionKeys =
                        dimensions?.sourceKeys?.filter(Boolean) || []
                      return (
                        <TableRow key={level.globalId} hover>
                          <TableCell sx={{ minWidth: 300, verticalAlign: 'top' }}>
                            <Typography variant="body2" fontWeight={700}>
                              {level.productName
                                || details.providerProductName
                                || 'Unmapped Shopify item'}
                            </Typography>
                            <Typography
                              variant="caption"
                              color="text.secondary"
                              display="block"
                            >
                              {level.sku || 'No SKU'}
                              {level.productGlobalId
                                ? ` · ${level.productGlobalId}`
                                : ''}
                            </Typography>
                            <Box
                              component="details"
                              sx={{ mt: 0.5, '& summary': { cursor: 'pointer' } }}
                            >
                              <Typography
                                component="summary"
                                variant="caption"
                                color="primary"
                              >
                                Product facts
                              </Typography>
                              <Box
                                sx={{
                                  mt: 0.75,
                                  display: 'grid',
                                  gridTemplateColumns:
                                    'minmax(100px, auto) minmax(140px, 1fr)',
                                  columnGap: 1,
                                  rowGap: 0.5,
                                }}
                              >
                                {facts.map(([label, value]) => (
                                  <Box
                                    key={label}
                                    sx={{ display: 'contents' }}
                                  >
                                    <Typography
                                      variant="caption"
                                      color="text.secondary"
                                    >
                                      {label}
                                    </Typography>
                                    <Typography
                                      variant="caption"
                                      sx={{ overflowWrap: 'anywhere' }}
                                    >
                                      {value}
                                    </Typography>
                                  </Box>
                                ))}
                              </Box>
                              {details.description ? (
                                <Typography
                                  variant="caption"
                                  color="text.secondary"
                                  component="p"
                                  sx={{ mt: 0.75, mb: 0 }}
                                >
                                  {details.description}
                                </Typography>
                              ) : null}
                              <Stack
                                direction="row"
                                spacing={1}
                                sx={{ mt: 0.75 }}
                              >
                                {details.onlineStoreUrl ? (
                                  <Typography
                                    component="a"
                                    href={details.onlineStoreUrl}
                                    target="_blank"
                                    rel="noreferrer"
                                    variant="caption"
                                    color="primary"
                                  >
                                    Open product
                                  </Typography>
                                ) : null}
                                {details.featuredImageUrl ? (
                                  <Typography
                                    component="a"
                                    href={details.featuredImageUrl}
                                    target="_blank"
                                    rel="noreferrer"
                                    variant="caption"
                                    color="primary"
                                  >
                                    Open featured image
                                  </Typography>
                                ) : null}
                              </Stack>
                            </Box>
                          </TableCell>
                          <TableCell sx={{ minWidth: 180, verticalAlign: 'top' }}>
                            <Stack spacing={0.75} alignItems="flex-start">
                              <Chip
                                size="small"
                                color={stateColor(level)}
                                variant="outlined"
                                label={stateLabel(level)}
                              />
                              <Typography variant="caption">
                                Operational ATP:{' '}
                                <strong>
                                  {formatQuantity(
                                    level.operationalAvailableQuantity,
                                  )}
                                </strong>
                              </Typography>
                              <Typography
                                variant="caption"
                                color="text.secondary"
                              >
                                Source updated{' '}
                                {formatDate(level.providerUpdatedAt)}
                              </Typography>
                            </Stack>
                          </TableCell>
                          <TableCell sx={{ minWidth: 350, verticalAlign: 'top' }}>
                            <Box
                              sx={{
                                display: 'grid',
                                gridTemplateColumns:
                                  'repeat(2, minmax(140px, 1fr))',
                                gap: 0.5,
                              }}
                            >
                              {SHOPIFY_INVENTORY_STATES.map(([key, label]) => (
                                (() => {
                                  const evidence =
                                    level.providerQuantityEvidence?.[key]
                                  return (
                                <Box
                                  key={key}
                                  title={evidence?.id || undefined}
                                  sx={{
                                    border: 1,
                                    borderColor: 'divider',
                                    borderRadius: 1,
                                    px: 1,
                                    py: 0.5,
                                  }}
                                >
                                  <Stack
                                    direction="row"
                                    justifyContent="space-between"
                                    gap={1}
                                  >
                                    <Typography
                                      variant="caption"
                                      color="text.secondary"
                                    >
                                      {label}
                                    </Typography>
                                    <Typography
                                      variant="caption"
                                      fontWeight={700}
                                    >
                                      {formatQuantity(
                                        level.providerQuantities[key],
                                      )}
                                    </Typography>
                                  </Stack>
                                  {evidence ? (
                                    <Typography
                                      variant="caption"
                                      color="text.disabled"
                                      display="block"
                                      sx={{ fontSize: '0.64rem' }}
                                    >
                                      {formatDate(evidence.updatedAt)}
                                      {evidence.id
                                        ? ` · ${evidence.id.slice(-12)}`
                                        : ''}
                                    </Typography>
                                  ) : null}
                                </Box>
                                  )
                                })()
                              ))}
                            </Box>
                            <Typography
                              variant="caption"
                              color={level.equationMatches
                                ? 'success.main'
                                : 'warning.main'}
                              display="block"
                              sx={{ mt: 0.75 }}
                            >
                              {level.equationMatches
                                ? 'Shopify physical-state equation reconciles'
                                : 'Shopify physical-state equation does not reconcile'}
                            </Typography>
                          </TableCell>
                          <TableCell sx={{ minWidth: 260, verticalAlign: 'top' }}>
                            <Typography variant="body2">
                              {level.providerWeightGrams !== null
                                ? formatGrams(
                                  level.providerWeightGrams,
                                  measurementSystem,
                                )
                                : 'Weight unavailable'}
                            </Typography>
                            {level.providerWeightGrams !== null ? (
                              <Typography
                                variant="caption"
                                color="text.secondary"
                                display="block"
                              >
                                Exact Shopify evidence (canonical):{' '}
                                {formatQuantity(level.providerWeightGrams)} g
                              </Typography>
                            ) : null}
                            <Typography
                              variant="caption"
                              color={dimensions
                                ? 'text.secondary'
                                : 'warning.main'}
                              display="block"
                            >
                              {completeDimensions
                                ? formatDimensionsMm(
                                  completeDimensions,
                                  measurementSystem,
                                )
                                : details.partialDimensions.length
                                  ? 'Complete L × W × H is unavailable'
                                  : 'L × W × H unavailable in Shopify'}
                            </Typography>
                            {completeDimensions ? (
                              <Typography
                                variant="caption"
                                color="text.secondary"
                                display="block"
                              >
                                Exact Shopify evidence (canonical):{' '}
                                {formatQuantity(completeDimensions.lengthMm)} ×{' '}
                                {formatQuantity(completeDimensions.widthMm)} ×{' '}
                                {formatQuantity(completeDimensions.heightMm)} mm
                              </Typography>
                            ) : null}
                            {details.partialDimensions.length ? (
                              <Typography
                                variant="caption"
                                color="text.secondary"
                                display="block"
                              >
                                Axis evidence:{' '}
                                {details.partialDimensions.join(' · ')}
                              </Typography>
                            ) : null}
                            {completeDimensions ? (
                              <>
                                <Typography
                                  variant="caption"
                                  color="text.secondary"
                                  display="block"
                                >
                                  Source: {dimensionSource(dimensions)}
                                </Typography>
                                {dimensionKeys.length ? (
                                  <Typography
                                    variant="caption"
                                    color="text.secondary"
                                    display="block"
                                    sx={{ overflowWrap: 'anywhere' }}
                                  >
                                    Keys: {dimensionKeys.join(', ')}
                                  </Typography>
                                ) : null}
                                <Typography
                                  variant="caption"
                                  color="warning.main"
                                  display="block"
                                  sx={{ mt: 0.5 }}
                                >
                                  Product metadata; verify packaged dimensions
                                  before cartonization.
                                </Typography>
                              </>
                            ) : null}
                          </TableCell>
                        </TableRow>
                      )
                    })}
                    {!visibleLevels.length ? (
                      <TableRow>
                        <TableCell colSpan={4} align="center">
                          No matching inventory levels
                        </TableCell>
                      </TableRow>
                    ) : null}
                  </TableBody>
                </Table>
              </TableContainer>
              <TablePagination
                component="div"
                count={filteredLevels.length}
                page={Math.min(
                  page,
                  Math.max(0, Math.ceil(
                    filteredLevels.length / rowsPerPage,
                  ) - 1),
                )}
                onPageChange={(_event, nextPage) => setPage(nextPage)}
                rowsPerPage={rowsPerPage}
                rowsPerPageOptions={[rowsPerPage]}
              />
            </>
          ) : null}
        </Stack>

        <Dialog
          open={Boolean(mappingLocation)}
          onClose={closeMapping}
          fullWidth
          maxWidth="sm"
        >
          <DialogTitle>
            Route {mappingLocation?.name || 'Shopify location'}
          </DialogTitle>
          <DialogContent>
            <Stack spacing={2} sx={{ pt: 1 }}>
              <Typography variant="body2" color="text.secondary">
                Use this merchant-managed Shopify location as the source for a
                ClawPilot warehouse route. Shopify is reread before the route
                is saved, and this setup never changes Shopify inventory.
              </Typography>
              {mappingLocation ? (
                <Box
                  sx={{
                    border: 1,
                    borderColor: 'divider',
                    borderRadius: 1.5,
                    p: 1.5,
                  }}
                >
                  <Typography variant="body2" fontWeight={700}>
                    {mappingLocation.name}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    {locationAddress(mappingLocation)
                      || 'Shopify did not provide a complete street address.'}
                  </Typography>
                </Box>
              ) : null}
              {!mappingLocationCurrent ? (
                <ToggleButtonGroup
                  exclusive
                  fullWidth
                  size="small"
                  value={locationRoutingMode}
                  onChange={(_event, next: LocationRoutingMode | null) => {
                    if (next) setLocationRoutingMode(next)
                  }}
                  aria-label="Shopify location routing choice"
                >
                  <ToggleButton value="existing">
                    Map existing
                  </ToggleButton>
                  <ToggleButton value="create">
                    Create ClawPilot warehouse
                  </ToggleButton>
                </ToggleButtonGroup>
              ) : null}
              {locationRoutingMode === 'existing' ? (
                <>
                  <FormControl fullWidth>
                    <InputLabel id="shopify-inventory-warehouse-label">
                      ClawPilot warehouse
                    </InputLabel>
                    <Select
                      labelId="shopify-inventory-warehouse-label"
                      label="ClawPilot warehouse"
                      value={mappingWarehouseGlobalId}
                      onChange={(event) => {
                        setMappingWarehouseGlobalId(event.target.value)
                        setMappingInternalLocationGlobalId('')
                      }}
                    >
                      {warehouses.map((warehouse) => (
                        <MenuItem
                          key={warehouse.globalId}
                          value={warehouse.globalId}
                          disabled={warehouse.status !== 'active'}
                        >
                          {warehouse.name} · {warehouse.code}
                          {warehouse.status !== 'active' ? ' · inactive' : ''}
                        </MenuItem>
                      ))}
                    </Select>
                  </FormControl>
                  <FormControl
                    fullWidth
                    disabled={!mappingWarehouseGlobalId}
                  >
                    <InputLabel id="shopify-inventory-location-label">
                      Internal stock location
                    </InputLabel>
                    <Select
                      labelId="shopify-inventory-location-label"
                      label="Internal stock location"
                      value={mappingInternalLocationGlobalId}
                      onChange={(event) => {
                        setMappingInternalLocationGlobalId(event.target.value)
                      }}
                    >
                      {selectedWarehouseLocations.map((location) => (
                        <MenuItem
                          key={location.globalId}
                          value={location.globalId}
                        >
                          {location.code}
                          {location.zone ? ` · ${location.zone}` : ''}
                          {location.locationType
                            ? ` · ${location.locationType}`
                            : ''}
                        </MenuItem>
                      ))}
                    </Select>
                  </FormControl>
                  {!warehouses.some(
                    (warehouse) => warehouse.status === 'active',
                  ) ? (
                    <Typography variant="body2" color="text.secondary">
                      No active warehouse is available. Create one from this
                      Shopify location or open the full warehouse setup.
                    </Typography>
                  ) : mappingWarehouseGlobalId
                      && !selectedWarehouseLocations.length ? (
                      <Typography variant="body2" color="text.secondary">
                        This warehouse has no active internal stock location.
                        Add one in Operations before mapping it.
                      </Typography>
                    ) : null}
                  <Button
                    size="small"
                    startIcon={<WarehouseRounded />}
                    onClick={openWarehouseSetup}
                    sx={{ alignSelf: 'flex-start' }}
                  >
                    Open full warehouse setup
                  </Button>
                </>
              ) : warehouseImport ? (
                <>
                  <Typography variant="body2" color="text.secondary">
                    ClawPilot will create the standard receiving, storage,
                    picking, packing, and shipping topology and route this
                    Shopify location to its RESERVE-01 stock location.
                  </Typography>
                  <TextField
                    fullWidth
                    label="Warehouse code"
                    value={warehouseImport.code}
                    inputProps={{ maxLength: 32 }}
                    onChange={(event) => setWarehouseImport({
                      ...warehouseImport,
                      code: event.target.value.toUpperCase(),
                    })}
                  />
                  <TextField
                    fullWidth
                    label="Warehouse name"
                    value={warehouseImport.name}
                    inputProps={{ maxLength: 160 }}
                    onChange={(event) => setWarehouseImport({
                      ...warehouseImport,
                      name: event.target.value,
                    })}
                  />
                  <FormControl fullWidth>
                    <InputLabel id="shopify-inventory-facility-type-label">
                      Facility type
                    </InputLabel>
                    <Select
                      labelId="shopify-inventory-facility-type-label"
                      label="Facility type"
                      value={warehouseImport.facilityType}
                      onChange={(event) => setWarehouseImport({
                        ...warehouseImport,
                        facilityType: event.target.value as WarehouseImportForm[
                          'facilityType'
                        ],
                      })}
                    >
                      {WAREHOUSE_FACILITY_OPTIONS.map((option) => (
                        <MenuItem key={option.value} value={option.value}>
                          {option.label}
                        </MenuItem>
                      ))}
                    </Select>
                  </FormControl>
                  <FormControl fullWidth>
                    <InputLabel id="shopify-inventory-timezone-label">
                      Warehouse timezone
                    </InputLabel>
                    <Select
                      labelId="shopify-inventory-timezone-label"
                      label="Warehouse timezone"
                      value={warehouseImport.timezone}
                      onChange={(event) => setWarehouseImport({
                        ...warehouseImport,
                        timezone: event.target.value,
                      })}
                    >
                      {WAREHOUSE_TIMEZONE_OPTIONS.map((timezone) => (
                        <MenuItem key={timezone} value={timezone}>
                          {timezone}
                        </MenuItem>
                      ))}
                    </Select>
                  </FormControl>
                  <Typography variant="caption" color="text.secondary">
                    Shopify does not provide a warehouse timezone, so choose
                    the location’s actual timezone before creating it.
                  </Typography>
                </>
              ) : null}
              <Typography variant="caption" color="text.secondary">
                Provider / app-managed fulfillment-service locations remain
                visible in the routing table but cannot be mapped here.
              </Typography>
            </Stack>
          </DialogContent>
          <DialogActions sx={{ flexWrap: 'wrap', gap: 0.75 }}>
            <Button onClick={closeMapping} disabled={mappingBusy}>
              Cancel
            </Button>
            <Button
              variant="contained"
              disabled={
                mappingBusy
                || (locationRoutingMode === 'existing'
                  ? !mappingWarehouseGlobalId
                    || !mappingInternalLocationGlobalId
                  : !warehouseImport?.code.trim()
                    || !warehouseImport?.name.trim()
                    || !warehouseImport?.timezone)
              }
              startIcon={mappingBusy
                ? <CircularProgress size={16} color="inherit" />
                : undefined}
              onClick={() => {
                if (locationRoutingMode === 'create') {
                  void createWarehouseFromShopifyLocation()
                } else {
                  void saveMapping()
                }
              }}
            >
              {mappingBusy
                ? locationRoutingMode === 'create'
                  ? 'Creating warehouse…'
                  : 'Saving route…'
                : locationRoutingMode === 'create'
                  ? 'Create warehouse and route'
                  : 'Save route'}
            </Button>
          </DialogActions>
        </Dialog>
      </CardContent>
    </Card>
  )
}
