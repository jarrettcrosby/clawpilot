'use client'

import { FormEvent, useMemo, useState } from 'react'
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  FormControlLabel,
  IconButton,
  LinearProgress,
  MenuItem,
  Stack,
  Switch,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from '@mui/material'
import AddRounded from '@mui/icons-material/AddRounded'
import CheckCircleOutlineRounded from '@mui/icons-material/CheckCircleOutlineRounded'
import DeleteOutlineRounded from '@mui/icons-material/DeleteOutlineRounded'
import EditRounded from '@mui/icons-material/EditRounded'
import HelpOutlineRounded from '@mui/icons-material/HelpOutlineRounded'
import Inventory2Rounded from '@mui/icons-material/Inventory2Rounded'
import MoveDownRounded from '@mui/icons-material/MoveDownRounded'
import WarehouseRounded from '@mui/icons-material/WarehouseRounded'
import type { OperationsWorkspace } from '@/lib/operations/types'

type Props = {
  workspace: OperationsWorkspace | null
  onRefresh: () => Promise<void>
  onNavigate: (view: 'gl-coding' | 'printing') => void
}

type Warehouse = OperationsWorkspace['warehouses'][number]
type Location = Warehouse['locations'][number]
type FacilityType = Warehouse['facilityType']
type LocationType = Location['locationType']
type TopologyLevel = Location['topologyLevel']
type StorageFunction = Location['storageFunction']
type ProductRule = Location['productRules'][number]
type ReplenishmentMode = ProductRule['replenishmentMode']
type ReplenishmentRecommendation = OperationsWorkspace['replenishmentRecommendations'][number]
type MeasurementSystem = 'imperial' | 'metric'

type WarehouseForm = {
  code: string
  name: string
  facilityType: FacilityType
  timezone: string
  cutoffTime: string
  operatingDays: number[]
  opensAt: string
  closesAt: string
  standardProcessingMinutes: number
  dailyOrderCapacity: string
  upsCutoff: string
  fedexCutoff: string
  line1: string
  line2: string
  city: string
  region: string
  postalCode: string
  country: string
  status: 'active' | 'inactive'
  createStarterLocations: boolean
}

type LocationForm = {
  code: string
  zone: string
  locationType: LocationType
  topologyLevel: TopologyLevel
  storageFunction: StorageFunction
  parentLocationGlobalId: string
  pickSequence: number
  active: boolean
  measurementSystem: MeasurementSystem
  maxVolume: string
  maxWeight: string
  allowMixedProducts: boolean
  notes: string
  productRules: Array<{
    productGlobalId: string
    productName: string
    ruleType: ProductRule['ruleType']
    maxQuantity: string
    replenishmentMode: ReplenishmentMode
    replenishmentSourceLocationGlobalId: string
    minQuantity: string
    targetQuantity: string
  }>
}

const facilityTypes: Array<{ value: FacilityType; label: string; description: string }> = [
  { value: 'distribution_center', label: 'Distribution center', description: 'Full receiving, storage, picking, packing, and shipping operation.' },
  { value: 'store', label: 'Store', description: 'Retail inventory that may also fulfill or receive customer orders.' },
  { value: 'dark_store', label: 'Dark store', description: 'Customer-free store configured specifically for fulfillment.' },
  { value: 'micro_fulfillment', label: 'Micro-fulfillment center', description: 'Compact, high-throughput fulfillment facility near demand.' },
  { value: 'cross_dock', label: 'Cross-dock facility', description: 'Inbound product moves directly to outbound staging with minimal storage.' },
  { value: 'supplier', label: 'Supplier facility', description: 'Supplier-controlled node used for inventory visibility or fulfillment.' },
  { value: 'drop_ship', label: 'Drop-ship node', description: 'External node that ships orders without operator-owned inventory.' },
  { value: 'third_party', label: 'Third-party warehouse', description: 'Partner or 3PL facility managed through delegated operations.' },
]

const countries = [
  { value: 'US', label: 'United States' },
  { value: 'CA', label: 'Canada' },
  { value: 'MX', label: 'Mexico' },
  { value: 'GB', label: 'United Kingdom' },
]

const usRegions = [
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA', 'HI', 'ID',
  'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS',
  'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK',
  'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV',
  'WI', 'WY', 'DC',
]

const timezones = [
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

const operatingDayOptions = [
  { value: 0, short: 'Sun', label: 'Sunday' },
  { value: 1, short: 'Mon', label: 'Monday' },
  { value: 2, short: 'Tue', label: 'Tuesday' },
  { value: 3, short: 'Wed', label: 'Wednesday' },
  { value: 4, short: 'Thu', label: 'Thursday' },
  { value: 5, short: 'Fri', label: 'Friday' },
  { value: 6, short: 'Sat', label: 'Saturday' },
]

const locationTypes: Array<{ value: LocationType; label: string; description: string }> = [
  { value: 'receiving', label: 'Receiving', description: 'Unload, count, and inspect inbound product.' },
  { value: 'storage', label: 'Storage', description: 'Hold available, reserved, quarantine, or damaged inventory.' },
  { value: 'pick', label: 'Picking', description: 'Source inventory for released wave pick tasks.' },
  { value: 'pack', label: 'Packing', description: 'Verify picked product and prepare packages for shipment.' },
  { value: 'staging', label: 'Staging', description: 'Temporarily hold inbound, outbound, or transfer work.' },
  { value: 'shipping', label: 'Shipping', description: 'Manifest, load, and tender completed packages.' },
  { value: 'returns', label: 'Returns', description: 'Receive and inspect returned product before disposition.' },
]

const topologyLevels: Array<{ value: TopologyLevel; label: string }> = [
  { value: 'building', label: 'Building' },
  { value: 'zone', label: 'Zone' },
  { value: 'aisle', label: 'Aisle' },
  { value: 'row', label: 'Row' },
  { value: 'bay', label: 'Bay' },
  { value: 'level', label: 'Level' },
  { value: 'shelf', label: 'Shelf' },
  { value: 'bin', label: 'Bin' },
  { value: 'staging', label: 'Staging area' },
  { value: 'dock', label: 'Dock' },
  { value: 'station', label: 'Work station' },
]

const storageFunctions: Array<{ value: StorageFunction; label: string; description: string }> = [
  { value: 'work_area', label: 'Work area', description: 'Non-storage work point such as receiving, packing, or shipping.' },
  { value: 'reserve', label: 'Reserve storage', description: 'Case, pallet, or overflow inventory that supplies forward pick locations.' },
  { value: 'bulk', label: 'Bulk storage', description: 'High-volume reserve inventory held outside active pick faces.' },
  { value: 'forward_pick', label: 'Forward pick face', description: 'Primary each- or case-pick location replenished from reserve.' },
  { value: 'mezzanine_pick', label: 'Mezzanine pick face', description: 'Forward pick location on a mezzanine or elevated pick module.' },
  { value: 'flow_rack', label: 'Flow rack', description: 'High-velocity forward pick location designed for frequent replenishment.' },
  { value: 'staging', label: 'Staging', description: 'Temporary inbound, outbound, transfer, or exception holding area.' },
]

const replenishmentModes: Array<{ value: ReplenishmentMode; label: string; description: string }> = [
  { value: 'disabled', label: 'No replenishment', description: 'Do not produce replenishment recommendations for this product and location.' },
  { value: 'min_max', label: 'Min / target', description: 'Recommend stock when the pick face falls below minimum, up to the target.' },
  { value: 'order_demand', label: 'Released order demand', description: 'Recommend stock when released demand exceeds available pick-face inventory.' },
]

const defaultZones = ['INBOUND', 'STORAGE', 'FULFILLMENT', 'OUTBOUND', 'RETURNS', 'QUARANTINE']
const CUBIC_FEET_PER_CUBIC_METER = 35.3146667
const POUNDS_PER_KILOGRAM = 2.20462262

const initialWarehouse: WarehouseForm = {
  code: '',
  name: '',
  facilityType: 'distribution_center',
  timezone: 'America/New_York',
  cutoffTime: '16:00',
  operatingDays: [1, 2, 3, 4, 5],
  opensAt: '08:00',
  closesAt: '17:00',
  standardProcessingMinutes: 120,
  dailyOrderCapacity: '',
  upsCutoff: '21:00',
  fedexCutoff: '21:00',
  line1: '',
  line2: '',
  city: '',
  region: '',
  postalCode: '',
  country: 'US',
  status: 'active',
  createStarterLocations: true,
}

const initialLocation: LocationForm = {
  code: '',
  zone: 'STORAGE',
  locationType: 'storage',
  topologyLevel: 'bin',
  storageFunction: 'reserve',
  parentLocationGlobalId: '',
  pickSequence: 100,
  active: true,
  measurementSystem: 'imperial',
  maxVolume: '',
  maxWeight: '',
  allowMixedProducts: true,
  notes: '',
  productRules: [],
}

function warehouseForm(item: Warehouse): WarehouseForm {
  return {
    code: item.code,
    name: item.name,
    facilityType: item.facilityType,
    timezone: item.timezone,
    cutoffTime: item.cutoffTime?.slice(0, 5) || '',
    operatingDays: item.operatingDays,
    opensAt: item.opensAt.slice(0, 5),
    closesAt: item.closesAt.slice(0, 5),
    standardProcessingMinutes: item.standardProcessingMinutes,
    dailyOrderCapacity: item.dailyOrderCapacity === null ? '' : String(item.dailyOrderCapacity),
    upsCutoff: item.carrierCutoffs.UPS || '',
    fedexCutoff: item.carrierCutoffs.FEDEX || '',
    line1: item.address.line1,
    line2: item.address.line2 || '',
    city: item.address.city,
    region: item.address.region,
    postalCode: item.address.postalCode,
    country: item.address.country,
    status: item.status,
    createStarterLocations: false,
  }
}

function locationForm(item: Location): LocationForm {
  return {
    code: item.code,
    zone: item.zone,
    locationType: item.locationType,
    topologyLevel: item.topologyLevel,
    storageFunction: item.storageFunction,
    parentLocationGlobalId: item.parentLocationGlobalId || '',
    pickSequence: item.pickSequence,
    active: item.active,
    measurementSystem: 'imperial',
    maxVolume: item.maxVolumeCubicMeters === null
      ? ''
      : (item.maxVolumeCubicMeters * CUBIC_FEET_PER_CUBIC_METER).toFixed(2),
    maxWeight: item.maxWeightKg === null
      ? ''
      : (item.maxWeightKg * POUNDS_PER_KILOGRAM).toFixed(2),
    allowMixedProducts: item.allowMixedProducts,
    notes: item.notes || '',
    productRules: item.productRules
      .filter((rule) => rule.active)
      .map((rule) => ({
        productGlobalId: rule.productGlobalId,
        productName: rule.productName,
        ruleType: rule.ruleType,
        maxQuantity: rule.maxQuantity === null ? '' : String(rule.maxQuantity),
        replenishmentMode: rule.replenishmentMode,
        replenishmentSourceLocationGlobalId: rule.replenishmentSourceLocationGlobalId || '',
        minQuantity: rule.minQuantity === null ? '' : String(rule.minQuantity),
        targetQuantity: rule.targetQuantity === null ? '' : String(rule.targetQuantity),
      })),
  }
}

function capacityPercent(used: number, maximum: number | null) {
  if (!maximum) return 0
  return Math.min(100, Math.max(0, used / maximum * 100))
}

function displayCapacity(value: number, system: MeasurementSystem, kind: 'volume' | 'weight') {
  if (kind === 'volume') {
    return system === 'imperial'
      ? `${(value * CUBIC_FEET_PER_CUBIC_METER).toLocaleString(undefined, { maximumFractionDigits: 1 })} ft³`
      : `${value.toLocaleString(undefined, { maximumFractionDigits: 2 })} m³`
  }
  return system === 'imperial'
    ? `${(value * POUNDS_PER_KILOGRAM).toLocaleString(undefined, { maximumFractionDigits: 1 })} lb`
    : `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })} kg`
}

function nextPickRouteOrder(item: Warehouse) {
  const highest = item.locations.reduce((value, location) => Math.max(value, location.pickSequence), 0)
  return Math.max(100, Math.ceil((highest + 1) / 100) * 100)
}

function operatingDaysLabel(days: number[]) {
  const sorted = [...days].sort((a, b) => a - b)
  const weekdays = [1, 2, 3, 4, 5]
  if (sorted.length === 7) return 'Daily'
  if (sorted.length === weekdays.length && sorted.every((day, index) => day === weekdays[index])) {
    return 'Mon-Fri'
  }
  return sorted
    .map((day) => operatingDayOptions.find((option) => option.value === day)?.short)
    .filter(Boolean)
    .join(', ')
}

function warehouseReadiness(item: Warehouse) {
  const activeLocations = item.locations.filter((location) => location.active)
  const checks = [
    { label: 'Active facility', ready: item.status === 'active' },
    {
      label: 'Operating profile',
      ready: item.operatingDays.length > 0
        && Boolean(item.opensAt)
        && Boolean(item.closesAt)
        && item.standardProcessingMinutes >= 0,
    },
    { label: 'Receiving', ready: activeLocations.some((location) => location.locationType === 'receiving') },
    { label: 'Reserve or bulk storage', ready: activeLocations.some((location) => ['reserve', 'bulk'].includes(location.storageFunction)) },
    { label: 'Forward picking', ready: activeLocations.some((location) => ['forward_pick', 'mezzanine_pick', 'flow_rack'].includes(location.storageFunction)) },
    { label: 'Packing', ready: activeLocations.some((location) => location.locationType === 'pack') },
    { label: 'Outbound staging or shipping', ready: activeLocations.some((location) => ['staging', 'shipping'].includes(location.locationType)) },
  ]
  const completed = checks.filter((check) => check.ready).length
  return {
    checks,
    completed,
    percent: completed / checks.length * 100,
  }
}

async function command(body: Record<string, unknown>) {
  const response = await fetch('/api/operations', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': `operations-warehouse:${String(body.action || 'command')}:${crypto.randomUUID()}`,
    },
    body: JSON.stringify(body),
  })
  const payload = await response.json().catch(() => ({})) as {
    error?: string
    result?: {
      outcome?: 'deleted' | 'retired'
      replenishmentTaskGlobalId?: string
    }
  }
  if (!response.ok) throw new Error(payload.error || 'Warehouse setup could not be saved')
  return payload
}

function LocationCapacity({ item }: { item: Location }) {
  const volumePercent = capacityPercent(item.usedVolumeCubicMeters, item.maxVolumeCubicMeters)
  const weightPercent = capacityPercent(item.usedWeightKg, item.maxWeightKg)
  if (!item.maxVolumeCubicMeters && !item.maxWeightKg) {
    return <Typography variant="caption" color="text.secondary">Capacity not limited</Typography>
  }
  return (
    <Stack gap={0.5} sx={{ minWidth: { sm: 210 } }}>
      {item.maxVolumeCubicMeters && (
        <Box>
          <Stack direction="row" justifyContent="space-between">
            <Typography variant="caption">Cubic storage</Typography>
            <Typography variant="caption" color="text.secondary">
              {displayCapacity(item.usedVolumeCubicMeters, 'imperial', 'volume')} / {displayCapacity(item.maxVolumeCubicMeters, 'imperial', 'volume')}
            </Typography>
          </Stack>
          <LinearProgress variant="determinate" value={volumePercent} color={volumePercent >= 90 ? 'warning' : 'primary'} />
        </Box>
      )}
      {item.maxWeightKg && (
        <Box>
          <Stack direction="row" justifyContent="space-between">
            <Typography variant="caption">Weight</Typography>
            <Typography variant="caption" color="text.secondary">
              {displayCapacity(item.usedWeightKg, 'imperial', 'weight')} / {displayCapacity(item.maxWeightKg, 'imperial', 'weight')}
            </Typography>
          </Stack>
          <LinearProgress variant="determinate" value={weightPercent} color={weightPercent >= 90 ? 'warning' : 'secondary'} />
        </Box>
      )}
    </Stack>
  )
}

export default function WarehouseSetupPanel({ workspace, onRefresh, onNavigate }: Props) {
  const [warehouseEditor, setWarehouseEditor] = useState<Warehouse | 'new' | null>(null)
  const [locationEditor, setLocationEditor] = useState<{ warehouse: Warehouse; item: Location | null } | null>(null)
  const [setupGuideOpen, setSetupGuideOpen] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<Location | null>(null)
  const [replenishmentTarget, setReplenishmentTarget] = useState<ReplenishmentRecommendation | null>(null)
  const [warehouse, setWarehouse] = useState(initialWarehouse)
  const [location, setLocation] = useState(initialLocation)
  const [ruleProductGlobalId, setRuleProductGlobalId] = useState('')
  const [ruleType, setRuleType] = useState<ProductRule['ruleType']>('allowed')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const canManage = workspace?.capabilities.canManage === true
  const canExecuteReplenishment = canManage && workspace?.capabilities.canExecute === true

  const locationWarehouse = locationEditor?.warehouse || null
  const editingLocation = locationEditor?.item || null
  const editingWarehouse = warehouseEditor && warehouseEditor !== 'new' ? warehouseEditor : null

  const zoneOptions = useMemo(
    () => Array.from(new Set([
      ...defaultZones,
      ...(locationWarehouse?.locations.map((item) => item.zone) || []),
    ])).sort(),
    [locationWarehouse],
  )
  const replenishmentSourceOptions = useMemo(
    () => (locationWarehouse?.locations || []).filter((item) => (
      item.active
      && item.globalId !== editingLocation?.globalId
      && ['reserve', 'bulk'].includes(item.storageFunction)
    )),
    [editingLocation?.globalId, locationWarehouse],
  )

  function openWarehouse(item: Warehouse | 'new') {
    setWarehouseEditor(item)
    setWarehouse(item === 'new' ? initialWarehouse : warehouseForm(item))
    setError('')
  }

  function openLocation(targetWarehouse: Warehouse, item: Location | null = null) {
    setLocationEditor({ warehouse: targetWarehouse, item })
    setLocation(item ? locationForm(item) : {
      ...initialLocation,
      pickSequence: nextPickRouteOrder(targetWarehouse),
    })
    setRuleProductGlobalId('')
    setRuleType('allowed')
    setError('')
  }

  async function submitWarehouse(event: FormEvent) {
    event.preventDefault()
    setSaving(true)
    setError('')
    try {
      await command({
        action: editingWarehouse ? 'update-warehouse' : 'create-warehouse',
        ...(editingWarehouse ? {
          warehouseGlobalId: editingWarehouse.globalId,
          expectedRowVersion: editingWarehouse.rowVersion,
          status: warehouse.status,
        } : {
          code: warehouse.code,
          createStarterLocations: warehouse.createStarterLocations,
        }),
        name: warehouse.name,
        facilityType: warehouse.facilityType,
        timezone: warehouse.timezone,
        cutoffTime: warehouse.cutoffTime || null,
        operatingDays: warehouse.operatingDays,
        opensAt: warehouse.opensAt,
        closesAt: warehouse.closesAt,
        standardProcessingMinutes: warehouse.standardProcessingMinutes,
        dailyOrderCapacity: warehouse.dailyOrderCapacity ? Number(warehouse.dailyOrderCapacity) : null,
        carrierCutoffs: {
          ...(warehouse.upsCutoff ? { UPS: warehouse.upsCutoff } : {}),
          ...(warehouse.fedexCutoff ? { FEDEX: warehouse.fedexCutoff } : {}),
        },
        address: {
          name: warehouse.name,
          line1: warehouse.line1,
          line2: warehouse.line2 || undefined,
          city: warehouse.city,
          region: warehouse.region,
          postalCode: warehouse.postalCode,
          country: warehouse.country,
        },
      })
      setWarehouseEditor(null)
      setWarehouse(initialWarehouse)
      setNotice(editingWarehouse ? 'Warehouse updated.' : 'Warehouse created with an editable starter topology.')
      await onRefresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Warehouse could not be saved')
    } finally {
      setSaving(false)
    }
  }

  async function submitLocation(event: FormEvent) {
    event.preventDefault()
    if (!locationWarehouse) return
    setSaving(true)
    setError('')
    const maxVolume = location.maxVolume ? Number(location.maxVolume) : null
    const maxWeight = location.maxWeight ? Number(location.maxWeight) : null
    try {
      await command({
        action: editingLocation ? 'update-location' : 'create-location',
        warehouseGlobalId: locationWarehouse.globalId,
        ...(editingLocation ? {
          locationGlobalId: editingLocation.globalId,
          expectedRowVersion: editingLocation.rowVersion,
        } : {}),
        code: location.code,
        zone: location.zone,
        locationType: location.locationType,
        topologyLevel: location.topologyLevel,
        storageFunction: location.storageFunction,
        parentLocationGlobalId: location.parentLocationGlobalId || null,
        pickSequence: location.pickSequence,
        active: location.active,
        maxVolumeCubicMeters: maxVolume === null
          ? null
          : location.measurementSystem === 'imperial' ? maxVolume / CUBIC_FEET_PER_CUBIC_METER : maxVolume,
        maxWeightKg: maxWeight === null
          ? null
          : location.measurementSystem === 'imperial' ? maxWeight / POUNDS_PER_KILOGRAM : maxWeight,
        allowMixedProducts: location.allowMixedProducts,
        notes: location.notes || null,
        productRules: location.productRules.map((rule) => ({
          productGlobalId: rule.productGlobalId,
          ruleType: rule.ruleType,
          maxQuantity: rule.maxQuantity ? Number(rule.maxQuantity) : null,
          replenishmentMode: rule.replenishmentMode,
          replenishmentSourceLocationGlobalId: rule.replenishmentMode === 'disabled'
            ? null
            : rule.replenishmentSourceLocationGlobalId || null,
          minQuantity: rule.replenishmentMode === 'disabled' || !rule.minQuantity
            ? null
            : Number(rule.minQuantity),
          targetQuantity: rule.replenishmentMode === 'disabled' || !rule.targetQuantity
            ? null
            : Number(rule.targetQuantity),
        })),
      })
      setLocationEditor(null)
      setLocation(initialLocation)
      setNotice(editingLocation ? 'Location and product rules updated.' : 'Location added to the facility topology.')
      await onRefresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Location could not be saved')
    } finally {
      setSaving(false)
    }
  }

  async function removeLocation() {
    if (!deleteTarget) return
    setSaving(true)
    setError('')
    try {
      const payload = await command({
        action: 'delete-location',
        locationGlobalId: deleteTarget.globalId,
        expectedRowVersion: deleteTarget.rowVersion,
      })
      setNotice(payload.result?.outcome === 'retired'
        ? 'Location was retired because historical operations reference it.'
        : 'Unused location deleted.')
      setDeleteTarget(null)
      await onRefresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Location could not be removed')
    } finally {
      setSaving(false)
    }
  }

  async function executeReplenishment() {
    if (!replenishmentTarget || !canExecuteReplenishment) return
    setSaving(true)
    setError('')
    try {
      const payload = await command({
        action: 'execute-replenishment',
        sourceLocationGlobalId: replenishmentTarget.sourceLocationGlobalId,
        destinationLocationGlobalId: replenishmentTarget.destinationLocationGlobalId,
        inventoryPoolGlobalId: replenishmentTarget.inventoryPoolGlobalId,
        productGlobalId: replenishmentTarget.productGlobalId,
        quantity: replenishmentTarget.recommendedQuantity,
      })
      const taskGlobalId = payload.result?.replenishmentTaskGlobalId
      setReplenishmentTarget(null)
      setNotice(taskGlobalId
        ? `Replenishment completed. Task ${taskGlobalId}.`
        : 'Replenishment completed.')
      await onRefresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Replenishment could not be completed')
    } finally {
      setSaving(false)
    }
  }

  function addProductRule() {
    const product = workspace?.catalog.products.find((item) => item.globalId === ruleProductGlobalId)
    if (!product || location.productRules.some((item) => item.productGlobalId === product.globalId)) return
    setLocation({
      ...location,
      productRules: [...location.productRules, {
        productGlobalId: product.globalId,
        productName: product.name,
        ruleType,
        maxQuantity: '',
        replenishmentMode: 'disabled',
        replenishmentSourceLocationGlobalId: '',
        minQuantity: '',
        targetQuantity: '',
      }],
    })
    setRuleProductGlobalId('')
  }

  function locationRows(item: Warehouse) {
    const byParent = new Map<string | null, Location[]>()
    item.locations.forEach((entry) => {
      const parent = entry.parentLocationGlobalId
      byParent.set(parent, [...(byParent.get(parent) || []), entry])
    })
    byParent.forEach((entries) => entries.sort((a, b) => a.pickSequence - b.pickSequence || a.code.localeCompare(b.code)))
    const result: Array<{ entry: Location; depth: number }> = []
    const visited = new Set<string>()
    const visit = (parent: string | null, depth: number) => {
      ;(byParent.get(parent) || []).forEach((entry) => {
        if (visited.has(entry.globalId)) return
        visited.add(entry.globalId)
        result.push({ entry, depth })
        visit(entry.globalId, depth + 1)
      })
    }
    visit(null, 0)
    item.locations.forEach((entry) => {
      if (!visited.has(entry.globalId)) result.push({ entry, depth: 0 })
    })
    return result
  }

  return (
    <Box sx={{ px: { xs: 2, md: 3 }, py: 2.5, maxWidth: 1240, mx: 'auto' }}>
      <Stack direction={{ xs: 'column', sm: 'row' }} justifyContent="space-between" gap={1.5}>
        <Box>
          <Typography variant="h5" fontWeight={700}>Warehouse network</Typography>
          <Typography color="text.secondary">Facilities, topology, capacity, product placement, and work areas.</Typography>
        </Box>
        <Stack direction={{ xs: 'column', sm: 'row' }} gap={1} sx={{ alignSelf: { xs: 'stretch', sm: 'center' } }}>
          <Button
            variant="outlined"
            startIcon={<HelpOutlineRounded />}
            onClick={() => setSetupGuideOpen(true)}
          >
            Setup guide
          </Button>
          <Button
            variant="contained"
            startIcon={<AddRounded />}
            disabled={!canManage}
            onClick={() => openWarehouse('new')}
          >
            New warehouse
          </Button>
        </Stack>
      </Stack>

      {error && <Alert severity="error" onClose={() => setError('')} sx={{ mt: 2 }}>{error}</Alert>}
      {notice && <Alert severity="success" onClose={() => setNotice('')} sx={{ mt: 2 }}>{notice}</Alert>}

      <Stack direction={{ xs: 'column', md: 'row' }} gap={1} sx={{ mt: 2 }}>
        <Alert severity={workspace?.warehouses.some((item) => item.status === 'active') ? 'success' : 'warning'} sx={{ flex: 1 }}>
          {workspace?.warehouses.some((item) => item.status === 'active')
            ? 'An active warehouse is available for order allocation.'
            : 'Create an active warehouse before importing or allocating orders.'}
        </Alert>
        <Button variant="outlined" onClick={() => onNavigate('printing')}>Configure printers</Button>
        <Button variant="outlined" onClick={() => onNavigate('gl-coding')}>Import carrier billing</Button>
      </Stack>

      {Boolean(workspace?.replenishmentRecommendations.length) && (
        <Box sx={{ mt: 2, borderTop: 1, borderBottom: 1, borderColor: 'divider', py: 1.5 }}>
          <Stack direction={{ xs: 'column', sm: 'row' }} justifyContent="space-between" gap={0.75}>
            <Box>
              <Typography fontWeight={700}>Replenishment recommendations</Typography>
              <Typography variant="body2" color="text.secondary">
                Forward-pick shortages calculated within the same inventory owner and pool. Recommendations do not move stock until an operator creates and confirms replenishment work.
              </Typography>
            </Box>
            <Chip
              label={`${workspace?.replenishmentRecommendations.length || 0} ready`}
              color="warning"
              variant="outlined"
              sx={{ alignSelf: { xs: 'flex-start', sm: 'center' } }}
            />
          </Stack>
          <Stack divider={<Divider flexItem />} sx={{ mt: 1 }}>
            {workspace?.replenishmentRecommendations.map((recommendation) => (
              <Stack
                key={`${recommendation.inventoryPoolGlobalId}:${recommendation.productGlobalId}:${recommendation.destinationLocationGlobalId}`}
                direction={{ xs: 'column', sm: 'row' }}
                justifyContent="space-between"
                gap={0.75}
                sx={{ py: 1 }}
              >
                <Box>
                  <Typography fontWeight={650}>{recommendation.productName}</Typography>
                  <Typography variant="caption" color="text.secondary">
                    {recommendation.warehouseName} · {recommendation.sourceLocationCode} → {recommendation.destinationLocationCode} · {recommendation.inventoryPoolName}
                  </Typography>
                </Box>
                <Stack direction="row" gap={0.75} alignItems="center" flexWrap="wrap">
                  <Chip size="small" label={replenishmentModes.find((mode) => mode.value === recommendation.replenishmentMode)?.label || recommendation.replenishmentMode} />
                  {recommendation.replenishmentMode === 'order_demand' && (
                    <Chip size="small" variant="outlined" label={`${recommendation.releasedDemand.toLocaleString()} units demand`} />
                  )}
                  <Chip size="small" color="warning" variant="outlined" label={`Move ${recommendation.recommendedQuantity.toLocaleString()}`} />
                  <Tooltip title={canExecuteReplenishment ? 'Review and confirm this inventory move' : 'Warehouse execution permission is required'}>
                    <span>
                      <Button
                        size="small"
                        variant="outlined"
                        startIcon={<MoveDownRounded />}
                        disabled={!canExecuteReplenishment || saving}
                        onClick={() => {
                          setReplenishmentTarget(recommendation)
                          setError('')
                        }}
                      >
                        Move
                      </Button>
                    </span>
                  </Tooltip>
                </Stack>
              </Stack>
            ))}
          </Stack>
        </Box>
      )}

      <Stack divider={<Divider flexItem />} sx={{ mt: 2 }}>
        {workspace?.warehouses.map((item) => {
          const readiness = warehouseReadiness(item)
          return (
          <Box key={item.globalId} sx={{ py: 2 }}>
            <Stack direction={{ xs: 'column', sm: 'row' }} justifyContent="space-between" gap={1}>
              <Stack direction="row" gap={1.25} alignItems="center">
                <WarehouseRounded color={item.status === 'active' ? 'primary' : 'disabled'} />
                <Box>
                  <Stack direction="row" gap={0.75} alignItems="center" flexWrap="wrap">
                    <Typography fontWeight={700}>{item.name}</Typography>
                    <Chip size="small" label={facilityTypes.find((type) => type.value === item.facilityType)?.label || item.facilityType} variant="outlined" />
                    <Chip size="small" label={item.status} color={item.status === 'active' ? 'success' : 'default'} variant="outlined" />
                  </Stack>
                  <Typography variant="body2" color="text.secondary">
                    {item.code} · {item.globalId} · {item.timezone}
                    {item.cutoffTime ? ` · cutoff ${item.cutoffTime.slice(0, 5)}` : ''}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    {operatingDaysLabel(item.operatingDays)}
                    {' · '}{item.opensAt.slice(0, 5)}-{item.closesAt.slice(0, 5)}
                    {' · '}{item.standardProcessingMinutes} min standard processing
                    {item.dailyOrderCapacity ? ` · ${item.dailyOrderCapacity.toLocaleString()} orders/day planning capacity` : ''}
                  </Typography>
                  {Object.keys(item.carrierCutoffs).length > 0 && (
                    <Typography variant="caption" color="text.secondary" display="block">
                      Carrier cutoffs: {Object.entries(item.carrierCutoffs)
                        .map(([provider, cutoff]) => `${provider} ${cutoff}`)
                        .join(' · ')}
                    </Typography>
                  )}
                </Box>
              </Stack>
              <Stack direction="row" gap={0.5}>
                <Tooltip title="Edit warehouse">
                  <span>
                    <IconButton size="small" disabled={!canManage} onClick={() => openWarehouse(item)} aria-label={`Edit ${item.name}`}>
                      <EditRounded fontSize="small" />
                    </IconButton>
                  </span>
                </Tooltip>
                <Button size="small" startIcon={<AddRounded />} disabled={!canManage} onClick={() => openLocation(item)}>
                  Add location
                </Button>
              </Stack>
            </Stack>

            <Box sx={{ mt: 1.5, py: 1.25, borderTop: 1, borderColor: 'divider' }}>
              <Stack direction={{ xs: 'column', sm: 'row' }} justifyContent="space-between" gap={0.75}>
                <Stack direction="row" gap={0.75} alignItems="center">
                  <CheckCircleOutlineRounded
                    fontSize="small"
                    color={readiness.completed === readiness.checks.length ? 'success' : 'disabled'}
                  />
                  <Typography variant="body2" fontWeight={650}>Operational readiness</Typography>
                </Stack>
                <Typography variant="body2" color="text.secondary">
                  {readiness.completed} of {readiness.checks.length} core controls configured
                </Typography>
              </Stack>
              <LinearProgress
                variant="determinate"
                value={readiness.percent}
                color={readiness.percent === 100 ? 'success' : 'primary'}
                sx={{ mt: 0.75, height: 5, borderRadius: 1 }}
              />
              <Stack direction="row" gap={0.75} flexWrap="wrap" sx={{ mt: 1 }}>
                {readiness.checks.map((check) => (
                  <Chip
                    key={check.label}
                    size="small"
                    label={check.label}
                    color={check.ready ? 'success' : 'default'}
                    variant="outlined"
                  />
                ))}
              </Stack>
            </Box>

            <Stack divider={<Divider flexItem />} sx={{ mt: 1.5, borderTop: 1, borderColor: 'divider' }}>
              {item.locations.length ? locationRows(item).map(({ entry, depth }) => (
                <Stack
                  key={entry.globalId}
                  direction={{ xs: 'column', sm: 'row' }}
                  gap={1}
                  alignItems={{ xs: 'stretch', sm: 'center' }}
                  sx={{ py: 1.1, pl: { xs: Math.min(depth, 3) * 1.5, sm: Math.min(depth, 6) * 2 } }}
                >
                  <Stack direction="row" gap={1} alignItems="center" sx={{ flex: 1, minWidth: 0 }}>
                    <Inventory2Rounded color={entry.active ? 'primary' : 'disabled'} fontSize="small" />
                    <Box sx={{ minWidth: 0 }}>
                      <Stack direction="row" gap={0.6} alignItems="center" flexWrap="wrap">
                        <Typography fontWeight={650}>{entry.code}</Typography>
                        <Chip size="small" label={entry.topologyLevel} variant="outlined" />
                        <Chip size="small" label={entry.locationType} />
                        <Chip
                          size="small"
                          label={storageFunctions.find((item) => item.value === entry.storageFunction)?.label || entry.storageFunction}
                          color={['forward_pick', 'mezzanine_pick', 'flow_rack'].includes(entry.storageFunction) ? 'primary' : 'default'}
                          variant="outlined"
                        />
                        {!entry.active && <Chip size="small" label="retired" color="warning" />}
                      </Stack>
                      <Typography variant="caption" color="text.secondary">
                        {entry.zone} · pick route {entry.pickSequence} · {entry.globalId}
                        {entry.productRules.filter((rule) => rule.active).length
                          ? ` · ${entry.productRules.filter((rule) => rule.active).length} product rule${entry.productRules.filter((rule) => rule.active).length === 1 ? '' : 's'}`
                          : ''}
                        {entry.productRules.filter((rule) => rule.active && rule.replenishmentMode !== 'disabled').length
                          ? ` · ${entry.productRules.filter((rule) => rule.active && rule.replenishmentMode !== 'disabled').length} replenished`
                          : ''}
                        {!entry.allowMixedProducts ? ' · single product only' : ''}
                      </Typography>
                    </Box>
                  </Stack>
                  <LocationCapacity item={entry} />
                  <Stack direction="row" justifyContent="flex-end">
                    <Tooltip title="Edit topology, capacity, and product rules">
                      <span>
                        <IconButton size="small" disabled={!canManage} onClick={() => openLocation(item, entry)} aria-label={`Edit ${entry.code}`}>
                          <EditRounded fontSize="small" />
                        </IconButton>
                      </span>
                    </Tooltip>
                    <Tooltip title="Delete if unused; otherwise retire">
                      <span>
                        <IconButton size="small" disabled={!canManage} onClick={() => setDeleteTarget(entry)} aria-label={`Remove ${entry.code}`}>
                          <DeleteOutlineRounded fontSize="small" />
                        </IconButton>
                      </span>
                    </Tooltip>
                  </Stack>
                </Stack>
              )) : (
                <Typography variant="body2" color="text.secondary" sx={{ py: 1.5 }}>No locations configured.</Typography>
              )}
            </Stack>
          </Box>
          )
        })}
      </Stack>

      {!workspace?.warehouses.length && (
        <Box sx={{ py: 8, textAlign: 'center' }}>
          <WarehouseRounded sx={{ fontSize: 42, color: 'text.disabled' }} />
          <Typography fontWeight={700} sx={{ mt: 1 }}>No warehouse configured</Typography>
          <Typography color="text.secondary">The starter topology creates editable zones, docks, bins, staging areas, and work stations.</Typography>
        </Box>
      )}

      <Dialog open={Boolean(warehouseEditor)} onClose={() => !saving && setWarehouseEditor(null)} fullWidth maxWidth="md">
        <Box component="form" onSubmit={submitWarehouse}>
          <DialogTitle>{editingWarehouse ? `Edit ${editingWarehouse.name}` : 'Create warehouse'}</DialogTitle>
          <DialogContent>
            <Stack gap={1.5} sx={{ pt: 1 }}>
              <Stack direction={{ xs: 'column', sm: 'row' }} gap={1.5}>
                <TextField
                  required
                  label="Warehouse code"
                  value={warehouse.code}
                  disabled={Boolean(editingWarehouse)}
                  onChange={(e) => setWarehouse({ ...warehouse, code: e.target.value })}
                  helperText={editingWarehouse ? 'Warehouse codes are immutable.' : 'Example: DEL-OH-01'}
                  fullWidth
                />
                <TextField required label="Warehouse name" value={warehouse.name} onChange={(e) => setWarehouse({ ...warehouse, name: e.target.value })} fullWidth />
              </Stack>
              <Stack direction={{ xs: 'column', sm: 'row' }} gap={1.5}>
                <TextField
                  select
                  required
                  label="Facility type"
                  value={warehouse.facilityType}
                  onChange={(e) => setWarehouse({ ...warehouse, facilityType: e.target.value as FacilityType })}
                  helperText={facilityTypes.find((type) => type.value === warehouse.facilityType)?.description}
                  fullWidth
                >
                  {facilityTypes.map((type) => <MenuItem key={type.value} value={type.value}>{type.label}</MenuItem>)}
                </TextField>
                {editingWarehouse && (
                  <TextField select required label="Status" value={warehouse.status} onChange={(e) => setWarehouse({ ...warehouse, status: e.target.value as 'active' | 'inactive' })} fullWidth>
                    <MenuItem value="active">Active</MenuItem>
                    <MenuItem value="inactive">Inactive</MenuItem>
                  </TextField>
                )}
              </Stack>
              <TextField required label="Address" value={warehouse.line1} onChange={(e) => setWarehouse({ ...warehouse, line1: e.target.value })} />
              <TextField label="Address line 2" value={warehouse.line2} onChange={(e) => setWarehouse({ ...warehouse, line2: e.target.value })} />
              <Stack direction={{ xs: 'column', sm: 'row' }} gap={1.5}>
                <TextField required label="City" value={warehouse.city} onChange={(e) => setWarehouse({ ...warehouse, city: e.target.value })} fullWidth />
                {warehouse.country === 'US' ? (
                  <TextField select required label="State" value={warehouse.region} onChange={(e) => setWarehouse({ ...warehouse, region: e.target.value })} fullWidth>
                    {usRegions.map((region) => <MenuItem key={region} value={region}>{region}</MenuItem>)}
                  </TextField>
                ) : (
                  <TextField required label="State / region" value={warehouse.region} onChange={(e) => setWarehouse({ ...warehouse, region: e.target.value })} fullWidth />
                )}
                <TextField required label="Postal code" value={warehouse.postalCode} onChange={(e) => setWarehouse({ ...warehouse, postalCode: e.target.value })} fullWidth />
              </Stack>
              <Stack direction={{ xs: 'column', sm: 'row' }} gap={1.5}>
                <TextField select required label="Country" value={warehouse.country} onChange={(e) => setWarehouse({ ...warehouse, country: e.target.value, region: '' })} fullWidth>
                  {countries.map((country) => <MenuItem key={country.value} value={country.value}>{country.label}</MenuItem>)}
                </TextField>
                <TextField select required label="Timezone" value={warehouse.timezone} onChange={(e) => setWarehouse({ ...warehouse, timezone: e.target.value })} fullWidth>
                  {timezones.map((timezone) => <MenuItem key={timezone} value={timezone}>{timezone}</MenuItem>)}
                </TextField>
                <TextField
                  label="Carrier tender cutoff"
                  type="time"
                  value={warehouse.cutoffTime}
                  onChange={(e) => setWarehouse({ ...warehouse, cutoffTime: e.target.value })}
                  helperText="Latest normal local-time tender for same-day planning."
                  InputLabelProps={{ shrink: true }}
                  fullWidth
                />
              </Stack>
              <Stack direction={{ xs: 'column', sm: 'row' }} gap={1.5}>
                <TextField
                  label="UPS trailer cutoff"
                  type="time"
                  value={warehouse.upsCutoff}
                  onChange={(e) => setWarehouse({ ...warehouse, upsCutoff: e.target.value })}
                  helperText="Local dock cutoff used for UPS planning."
                  InputLabelProps={{ shrink: true }}
                  fullWidth
                />
                <TextField
                  label="FedEx trailer cutoff"
                  type="time"
                  value={warehouse.fedexCutoff}
                  onChange={(e) => setWarehouse({ ...warehouse, fedexCutoff: e.target.value })}
                  helperText="Local dock cutoff used for FedEx planning."
                  InputLabelProps={{ shrink: true }}
                  fullWidth
                />
              </Stack>
              <Divider />
              <Box>
                <Typography fontWeight={700}>Operating profile</Typography>
                <Typography variant="body2" color="text.secondary">
                  Record the facility-local schedule, normal release-to-carrier processing time, and optional throughput target.
                </Typography>
              </Box>
              <Box>
                <Typography variant="body2" fontWeight={600} sx={{ mb: 0.75 }}>Operating days</Typography>
                <ToggleButtonGroup
                  size="small"
                  value={warehouse.operatingDays}
                  onChange={(_, days: number[]) => {
                    if (days.length) setWarehouse({ ...warehouse, operatingDays: [...days].sort((a, b) => a - b) })
                  }}
                  aria-label="Warehouse operating days"
                  sx={{ display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))' }}
                >
                  {operatingDayOptions.map((day) => (
                    <ToggleButton key={day.value} value={day.value} aria-label={day.label}>
                      {day.short}
                    </ToggleButton>
                  ))}
                </ToggleButtonGroup>
              </Box>
              <Stack direction={{ xs: 'column', sm: 'row' }} gap={1.5}>
                <TextField
                  required
                  label="Local opening time"
                  type="time"
                  value={warehouse.opensAt}
                  onChange={(e) => setWarehouse({ ...warehouse, opensAt: e.target.value })}
                  InputLabelProps={{ shrink: true }}
                  fullWidth
                />
                <TextField
                  required
                  label="Local closing time"
                  type="time"
                  value={warehouse.closesAt}
                  onChange={(e) => setWarehouse({ ...warehouse, closesAt: e.target.value })}
                  InputLabelProps={{ shrink: true }}
                  fullWidth
                />
              </Stack>
              <Stack direction={{ xs: 'column', sm: 'row' }} gap={1.5}>
                <TextField
                  required
                  type="number"
                  label="Standard processing time (minutes)"
                  value={warehouse.standardProcessingMinutes}
                  onChange={(e) => setWarehouse({
                    ...warehouse,
                    standardProcessingMinutes: Math.max(0, Number(e.target.value)),
                  })}
                  inputProps={{ min: 0, max: 10080, step: 1 }}
                  helperText="Typical time from released order to carrier-ready package."
                  fullWidth
                />
                <TextField
                  type="number"
                  label="Daily order capacity"
                  value={warehouse.dailyOrderCapacity}
                  onChange={(e) => setWarehouse({ ...warehouse, dailyOrderCapacity: e.target.value })}
                  inputProps={{ min: 1, max: 1000000000, step: 1 }}
                  helperText="Optional planning threshold; it does not schedule labor or reserve inventory."
                  fullWidth
                />
              </Stack>
              <Alert severity="info">
                Facility and carrier cutoffs are stored in local warehouse time for promise and wave planning. Pick route order controls released task traversal; throughput scheduling remains a later optimization step.
              </Alert>
              {!editingWarehouse && (
                <Stack direction="row" justifyContent="space-between" alignItems="center">
                  <Box>
                    <Typography fontWeight={600}>Create starter topology</Typography>
                    <Typography variant="body2" color="text.secondary">Adds hierarchical inbound, storage, fulfillment, outbound, and returns areas.</Typography>
                  </Box>
                  <Switch checked={warehouse.createStarterLocations} onChange={(e) => setWarehouse({ ...warehouse, createStarterLocations: e.target.checked })} />
                </Stack>
              )}
            </Stack>
          </DialogContent>
          <DialogActions>
            <Button onClick={() => setWarehouseEditor(null)} disabled={saving}>Cancel</Button>
            <Button type="submit" variant="contained" disabled={saving}>{editingWarehouse ? 'Save changes' : 'Create warehouse'}</Button>
          </DialogActions>
        </Box>
      </Dialog>

      <Dialog open={Boolean(locationEditor)} onClose={() => !saving && setLocationEditor(null)} fullWidth maxWidth="md">
        <Box component="form" onSubmit={submitLocation}>
          <DialogTitle>{editingLocation ? `Edit ${editingLocation.code}` : `Add location to ${locationWarehouse?.name || 'warehouse'}`}</DialogTitle>
          <DialogContent>
            <Stack gap={2} sx={{ pt: 1 }}>
              <Stack direction={{ xs: 'column', sm: 'row' }} gap={1.5}>
                <TextField required label="Location / bin code" value={location.code} onChange={(e) => setLocation({ ...location, code: e.target.value })} helperText="Example: A01-B02-L03" fullWidth />
                <TextField select required label="Zone" value={location.zone} onChange={(e) => setLocation({ ...location, zone: e.target.value })} fullWidth>
                  {zoneOptions.map((zone) => <MenuItem key={zone} value={zone}>{zone}</MenuItem>)}
                </TextField>
              </Stack>
              <Stack direction={{ xs: 'column', sm: 'row' }} gap={1.5}>
                <TextField
                  select
                  label="Physical level"
                  value={location.topologyLevel}
                  onChange={(e) => setLocation({ ...location, topologyLevel: e.target.value as TopologyLevel })}
                  helperText="Where this node sits in the physical warehouse hierarchy."
                  fullWidth
                >
                  {topologyLevels.map((level) => <MenuItem key={level.value} value={level.value}>{level.label}</MenuItem>)}
                </TextField>
                <TextField
                  select
                  label="Operational use"
                  value={location.locationType}
                  onChange={(e) => setLocation({ ...location, locationType: e.target.value as LocationType })}
                  helperText={locationTypes.find((type) => type.value === location.locationType)?.description}
                  fullWidth
                >
                  {locationTypes.map((type) => <MenuItem key={type.value} value={type.value}>{type.label}</MenuItem>)}
                </TextField>
              </Stack>
              <Stack direction={{ xs: 'column', sm: 'row' }} gap={1.5}>
                <TextField
                  select
                  label="Storage function"
                  value={location.storageFunction}
                  onChange={(e) => setLocation({ ...location, storageFunction: e.target.value as StorageFunction })}
                  helperText={storageFunctions.find((item) => item.value === location.storageFunction)?.description}
                  fullWidth
                >
                  {storageFunctions.map((item) => <MenuItem key={item.value} value={item.value}>{item.label}</MenuItem>)}
                </TextField>
                <TextField
                  select
                  label="Parent location"
                  value={location.parentLocationGlobalId}
                  onChange={(e) => setLocation({ ...location, parentLocationGlobalId: e.target.value })}
                  helperText="Build the facility from zones down to bins."
                  fullWidth
                >
                  <MenuItem value="">No parent</MenuItem>
                  {locationWarehouse?.locations
                    .filter((item) => item.active && item.globalId !== editingLocation?.globalId)
                    .map((item) => <MenuItem key={item.globalId} value={item.globalId}>{item.code} · {item.topologyLevel}</MenuItem>)}
                </TextField>
              </Stack>
              <Stack direction={{ xs: 'column', sm: 'row' }} gap={1.5} alignItems={{ sm: 'center' }}>
                <TextField
                  required
                  type="number"
                  label="Pick route order"
                  value={location.pickSequence}
                  onChange={(e) => setLocation({ ...location, pickSequence: Number(e.target.value) })}
                  inputProps={{ min: 0, max: 1000000 }}
                  helperText="Lower numbers are picked first when a wave creates tasks. Leave gaps such as 100, 200, and 300. This does not change customer or order priority."
                  fullWidth
                />
                <FormControlLabel control={<Switch checked={location.active} onChange={(e) => setLocation({ ...location, active: e.target.checked })} />} label="Active" />
                <FormControlLabel control={<Switch checked={location.allowMixedProducts} onChange={(e) => setLocation({ ...location, allowMixedProducts: e.target.checked })} />} label="Allow mixed products" />
              </Stack>

              <Divider />
              <Stack direction={{ xs: 'column', sm: 'row' }} justifyContent="space-between" alignItems={{ sm: 'center' }} gap={1}>
                <Box>
                  <Typography fontWeight={700}>Capacity limits</Typography>
                  <Typography variant="body2" color="text.secondary">
                    Optional physical limits identify full or over-capacity locations from recorded inventory and package measurements.
                  </Typography>
                </Box>
                <ToggleButtonGroup
                  exclusive
                  size="small"
                  value={location.measurementSystem}
                  onChange={(_, value: MeasurementSystem | null) => {
                    if (!value || value === location.measurementSystem) return
                    const volume = Number(location.maxVolume)
                    const weight = Number(location.maxWeight)
                    setLocation({
                      ...location,
                      measurementSystem: value,
                      maxVolume: location.maxVolume
                        ? (value === 'imperial' ? volume * CUBIC_FEET_PER_CUBIC_METER : volume / CUBIC_FEET_PER_CUBIC_METER).toFixed(2)
                        : '',
                      maxWeight: location.maxWeight
                        ? (value === 'imperial' ? weight * POUNDS_PER_KILOGRAM : weight / POUNDS_PER_KILOGRAM).toFixed(2)
                        : '',
                    })
                  }}
                >
                  <ToggleButton value="imperial">Imperial</ToggleButton>
                  <ToggleButton value="metric">Metric</ToggleButton>
                </ToggleButtonGroup>
              </Stack>
              <Stack direction={{ xs: 'column', sm: 'row' }} gap={1.5}>
                <TextField
                  type="number"
                  label={`Maximum cubic storage (${location.measurementSystem === 'imperial' ? 'ft³' : 'm³'})`}
                  value={location.maxVolume}
                  onChange={(e) => setLocation({ ...location, maxVolume: e.target.value })}
                  inputProps={{ min: 0, step: 'any' }}
                  fullWidth
                />
                <TextField
                  type="number"
                  label={`Maximum weight (${location.measurementSystem === 'imperial' ? 'lb' : 'kg'})`}
                  value={location.maxWeight}
                  onChange={(e) => setLocation({ ...location, maxWeight: e.target.value })}
                  inputProps={{ min: 0, step: 'any' }}
                  fullWidth
                />
              </Stack>

              <Divider />
              <Box>
                <Typography fontWeight={700}>Product placement</Typography>
                <Typography variant="body2" color="text.secondary">
                  Record allowed, preferred, or restricted products for directed placement. A quantity limit is optional.
                </Typography>
              </Box>
              <Alert severity="info">
                Placement rules and capacity influence directed putaway. Replenishment is recommendation-only in this slice: operators review the proposed source, destination, pool, and quantity before stock is moved.
              </Alert>
              <Stack direction={{ xs: 'column', sm: 'row' }} gap={1}>
                <Autocomplete
                  options={(workspace?.catalog.products || []).filter((product) => !location.productRules.some((rule) => rule.productGlobalId === product.globalId))}
                  getOptionLabel={(option) => `${option.name}${option.sku ? ` · ${option.sku}` : ''}`}
                  value={workspace?.catalog.products.find((product) => product.globalId === ruleProductGlobalId) || null}
                  onChange={(_, value) => setRuleProductGlobalId(value?.globalId || '')}
                  renderInput={(params) => <TextField {...params} label="Product" />}
                  sx={{ flex: 1 }}
                />
                <TextField select label="Rule" value={ruleType} onChange={(e) => setRuleType(e.target.value as ProductRule['ruleType'])} sx={{ minWidth: 150 }}>
                  <MenuItem value="allowed">Allowed</MenuItem>
                  <MenuItem value="preferred">Preferred</MenuItem>
                  <MenuItem value="restricted">Restricted</MenuItem>
                </TextField>
                <Button type="button" variant="outlined" startIcon={<AddRounded />} disabled={!ruleProductGlobalId} onClick={addProductRule}>Add rule</Button>
              </Stack>
              <Stack divider={<Divider flexItem />}>
                {location.productRules.map((rule, index) => (
                  <Box key={rule.productGlobalId} sx={{ py: 1.25 }}>
                    <Stack direction={{ xs: 'column', sm: 'row' }} gap={1} alignItems={{ sm: 'center' }}>
                      <Typography sx={{ flex: 1 }} fontWeight={600}>{rule.productName}</Typography>
                      <TextField
                        select
                        size="small"
                        label="Placement"
                        value={rule.ruleType}
                        onChange={(e) => {
                          const next = [...location.productRules]
                          next[index] = { ...rule, ruleType: e.target.value as ProductRule['ruleType'] }
                          setLocation({ ...location, productRules: next })
                        }}
                        sx={{ minWidth: 145 }}
                      >
                        <MenuItem value="allowed">Allowed</MenuItem>
                        <MenuItem value="preferred">Preferred</MenuItem>
                        <MenuItem value="restricted">Restricted</MenuItem>
                      </TextField>
                      <TextField
                        size="small"
                        type="number"
                        label="Maximum"
                        value={rule.maxQuantity}
                        onChange={(e) => {
                          const next = [...location.productRules]
                          next[index] = { ...rule, maxQuantity: e.target.value }
                          setLocation({ ...location, productRules: next })
                        }}
                        inputProps={{ min: 0.000001, step: 'any' }}
                        sx={{ width: { sm: 140 } }}
                      />
                      <Tooltip title="Remove product rule">
                        <IconButton type="button" onClick={() => setLocation({ ...location, productRules: location.productRules.filter((_, ruleIndex) => ruleIndex !== index) })}>
                          <DeleteOutlineRounded />
                        </IconButton>
                      </Tooltip>
                    </Stack>
                    <Stack direction={{ xs: 'column', sm: 'row' }} gap={1} sx={{ mt: 1 }}>
                      <TextField
                        select
                        size="small"
                        label="Replenishment"
                        value={rule.replenishmentMode}
                        onChange={(e) => {
                          const mode = e.target.value as ReplenishmentMode
                          const next = [...location.productRules]
                          next[index] = {
                            ...rule,
                            replenishmentMode: mode,
                            replenishmentSourceLocationGlobalId: mode === 'disabled' ? '' : rule.replenishmentSourceLocationGlobalId,
                            minQuantity: mode === 'disabled' ? '' : rule.minQuantity,
                            targetQuantity: mode === 'disabled' ? '' : rule.targetQuantity,
                          }
                          setLocation({ ...location, productRules: next })
                        }}
                        helperText={replenishmentModes.find((mode) => mode.value === rule.replenishmentMode)?.description}
                        sx={{ minWidth: { sm: 190 }, flex: 1 }}
                      >
                        {replenishmentModes.map((mode) => <MenuItem key={mode.value} value={mode.value}>{mode.label}</MenuItem>)}
                      </TextField>
                      {rule.replenishmentMode !== 'disabled' && (
                        <>
                          <TextField
                            select
                            required
                            size="small"
                            label="Reserve source"
                            value={rule.replenishmentSourceLocationGlobalId}
                            onChange={(e) => {
                              const next = [...location.productRules]
                              next[index] = { ...rule, replenishmentSourceLocationGlobalId: e.target.value }
                              setLocation({ ...location, productRules: next })
                            }}
                            helperText={replenishmentSourceOptions.length
                              ? 'Active reserve or bulk location in this warehouse.'
                              : 'Create an active reserve or bulk location first.'}
                            sx={{ minWidth: { sm: 190 }, flex: 1 }}
                          >
                            {replenishmentSourceOptions.map((source) => (
                              <MenuItem key={source.globalId} value={source.globalId}>
                                {source.code} · {storageFunctions.find((item) => item.value === source.storageFunction)?.label}
                              </MenuItem>
                            ))}
                          </TextField>
                          {rule.replenishmentMode === 'min_max' && (
                            <TextField
                              required
                              size="small"
                              type="number"
                              label="Minimum"
                              value={rule.minQuantity}
                              onChange={(e) => {
                                const next = [...location.productRules]
                                next[index] = { ...rule, minQuantity: e.target.value }
                                setLocation({ ...location, productRules: next })
                              }}
                              inputProps={{ min: 0, step: 'any' }}
                              sx={{ width: { sm: 125 } }}
                            />
                          )}
                          <TextField
                            required
                            size="small"
                            type="number"
                            label="Target"
                            value={rule.targetQuantity}
                            onChange={(e) => {
                              const next = [...location.productRules]
                              next[index] = { ...rule, targetQuantity: e.target.value }
                              setLocation({ ...location, productRules: next })
                            }}
                            inputProps={{ min: 0.000001, step: 'any' }}
                            sx={{ width: { sm: 125 } }}
                          />
                        </>
                      )}
                    </Stack>
                  </Box>
                ))}
                {!location.productRules.length && <Typography variant="body2" color="text.secondary">No product-specific placement rules.</Typography>}
              </Stack>
              <TextField multiline minRows={3} label="Location notes" value={location.notes} onChange={(e) => setLocation({ ...location, notes: e.target.value })} />
            </Stack>
          </DialogContent>
          <DialogActions>
            <Button onClick={() => setLocationEditor(null)} disabled={saving}>Cancel</Button>
            <Button type="submit" variant="contained" disabled={saving}>{editingLocation ? 'Save location' : 'Add location'}</Button>
          </DialogActions>
        </Box>
      </Dialog>

      <Dialog open={Boolean(deleteTarget)} onClose={() => !saving && setDeleteTarget(null)} maxWidth="xs" fullWidth>
        <DialogTitle>Remove {deleteTarget?.code}?</DialogTitle>
        <DialogContent>
          <Typography>
            Unused locations are deleted. Locations referenced by inventory or warehouse history are safely retired instead.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteTarget(null)} disabled={saving}>Cancel</Button>
          <Button color="error" variant="contained" onClick={removeLocation} disabled={saving}>Remove location</Button>
        </DialogActions>
      </Dialog>

      <Dialog
        open={Boolean(replenishmentTarget)}
        onClose={() => !saving && setReplenishmentTarget(null)}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>Confirm replenishment move</DialogTitle>
        <DialogContent>
          {replenishmentTarget && (
            <Stack gap={1.5} sx={{ pt: 0.5 }}>
              <Alert severity="warning">
                Confirming creates and completes replenishment work, moves inventory atomically, and records the warehouse audit evidence.
              </Alert>
              <Box>
                <Typography fontWeight={700}>{replenishmentTarget.productName}</Typography>
                <Typography variant="body2" color="text.secondary">
                  {replenishmentTarget.warehouseName} · {replenishmentTarget.inventoryPoolName}
                </Typography>
              </Box>
              <Stack direction={{ xs: 'column', sm: 'row' }} gap={1}>
                <Box sx={{ flex: 1 }}>
                  <Typography variant="caption" color="text.secondary">From</Typography>
                  <Typography>{replenishmentTarget.sourceLocationCode}</Typography>
                </Box>
                <Box sx={{ flex: 1 }}>
                  <Typography variant="caption" color="text.secondary">To</Typography>
                  <Typography>{replenishmentTarget.destinationLocationCode}</Typography>
                </Box>
                <Box sx={{ flex: 1 }}>
                  <Typography variant="caption" color="text.secondary">Quantity</Typography>
                  <Typography>{replenishmentTarget.recommendedQuantity.toLocaleString()} units</Typography>
                </Box>
              </Stack>
              <Typography variant="body2" color="text.secondary">
                {replenishmentTarget.explanation}
              </Typography>
            </Stack>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setReplenishmentTarget(null)} disabled={saving}>Cancel</Button>
          <Button
            variant="contained"
            startIcon={<MoveDownRounded />}
            onClick={executeReplenishment}
            disabled={saving || !canExecuteReplenishment}
          >
            Confirm move
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={setupGuideOpen} onClose={() => setSetupGuideOpen(false)} fullWidth maxWidth="sm">
        <DialogTitle>Warehouse setup guide</DialogTitle>
        <DialogContent>
          <Stack divider={<Divider flexItem />} sx={{ pt: 0.5 }}>
            {[
              {
                title: '1. Define the facility',
                body: 'Choose the facility type, physical origin address, IANA timezone, facility tender cutoff, and carrier-specific trailer cutoffs. Cutoffs are local warehouse times used by promise and wave planning.',
              },
              {
                title: '2. Set the operating profile',
                body: 'Record operating days, local opening and closing times, typical processing minutes, and optional daily order capacity. These versioned inputs support readiness now and the upcoming promise and capacity execution slice.',
              },
              {
                title: '3. Build the physical hierarchy',
                body: 'Use physical levels to model buildings, zones, aisles, bays, shelves, bins, docks, staging areas, and stations. Parent locations describe containment; operational use describes the work; storage function identifies reserve, bulk, forward pick, mezzanine, flow rack, staging, or non-storage work areas.',
              },
              {
                title: '4. Order the pick route',
                body: 'Pick route order controls task traversal inside released waves. Lower values are picked first. Use gaps such as 100, 200, and 300. It is not customer, order, allocation, or replenishment priority.',
              },
              {
                title: '5. Record capacity and placement',
                body: 'Set cubic and weight limits in imperial or metric units. Product policies drive directed putaway and keep restricted products out of a location. Maximum quantity caps the product within the location.',
              },
              {
                title: '6. Configure pick-face replenishment',
                body: 'For a product in a forward, mezzanine, or flow-rack pick face, choose a reserve or bulk source. Min / target recommends movement when pick-face stock drops below minimum. Released order demand recommends movement when demand exceeds pick-face availability. Recommendations stay within the same inventory owner and pool.',
              },
              {
                title: '7. Complete the operating path',
                body: 'A fulfillment warehouse should have active receiving, reserve or bulk storage, forward picking, packing, and outbound staging or shipping locations. The readiness indicator identifies missing core controls.',
              },
              {
                title: '8. Connect facility services',
                body: 'Configure printers for labels and packing documents. Bind approved carrier accounts and import carrier billing through the related Operations controls.',
              },
            ].map((step) => (
              <Box key={step.title} sx={{ py: 1.5 }}>
                <Typography fontWeight={700}>{step.title}</Typography>
                <Typography variant="body2" color="text.secondary" sx={{ mt: 0.4 }}>{step.body}</Typography>
              </Box>
            ))}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setSetupGuideOpen(false)}>Done</Button>
        </DialogActions>
      </Dialog>
    </Box>
  )
}
