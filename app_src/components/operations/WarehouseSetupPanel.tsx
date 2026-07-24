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
import DeleteOutlineRounded from '@mui/icons-material/DeleteOutlineRounded'
import EditRounded from '@mui/icons-material/EditRounded'
import Inventory2Rounded from '@mui/icons-material/Inventory2Rounded'
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
type ProductRule = Location['productRules'][number]
type MeasurementSystem = 'imperial' | 'metric'

type WarehouseForm = {
  code: string
  name: string
  facilityType: FacilityType
  timezone: string
  cutoffTime: string
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
  }>
}

const facilityTypes: Array<{ value: FacilityType; label: string }> = [
  { value: 'distribution_center', label: 'Distribution center' },
  { value: 'store', label: 'Store' },
  { value: 'dark_store', label: 'Dark store' },
  { value: 'micro_fulfillment', label: 'Micro-fulfillment center' },
  { value: 'cross_dock', label: 'Cross-dock facility' },
  { value: 'supplier', label: 'Supplier facility' },
  { value: 'drop_ship', label: 'Drop-ship node' },
  { value: 'third_party', label: 'Third-party warehouse' },
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

const locationTypes: Array<{ value: LocationType; label: string }> = [
  { value: 'receiving', label: 'Receiving' },
  { value: 'storage', label: 'Storage' },
  { value: 'pick', label: 'Picking' },
  { value: 'pack', label: 'Packing' },
  { value: 'staging', label: 'Staging' },
  { value: 'shipping', label: 'Shipping' },
  { value: 'returns', label: 'Returns' },
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

const defaultZones = ['INBOUND', 'STORAGE', 'FULFILLMENT', 'OUTBOUND', 'RETURNS', 'QUARANTINE']
const CUBIC_FEET_PER_CUBIC_METER = 35.3146667
const POUNDS_PER_KILOGRAM = 2.20462262

const initialWarehouse: WarehouseForm = {
  code: '',
  name: '',
  facilityType: 'distribution_center',
  timezone: 'America/New_York',
  cutoffTime: '16:00',
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

async function command(body: Record<string, unknown>) {
  const response = await fetch('/api/operations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const payload = await response.json().catch(() => ({})) as {
    error?: string
    result?: { outcome?: 'deleted' | 'retired' }
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
  const [deleteTarget, setDeleteTarget] = useState<Location | null>(null)
  const [warehouse, setWarehouse] = useState(initialWarehouse)
  const [location, setLocation] = useState(initialLocation)
  const [ruleProductGlobalId, setRuleProductGlobalId] = useState('')
  const [ruleType, setRuleType] = useState<ProductRule['ruleType']>('allowed')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const canManage = workspace?.capabilities.canManage === true

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

  function openWarehouse(item: Warehouse | 'new') {
    setWarehouseEditor(item)
    setWarehouse(item === 'new' ? initialWarehouse : warehouseForm(item))
    setError('')
  }

  function openLocation(targetWarehouse: Warehouse, item: Location | null = null) {
    setLocationEditor({ warehouse: targetWarehouse, item })
    setLocation(item ? locationForm(item) : initialLocation)
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
        <Button
          variant="contained"
          startIcon={<AddRounded />}
          disabled={!canManage}
          onClick={() => openWarehouse('new')}
          sx={{ alignSelf: { xs: 'stretch', sm: 'center' } }}
        >
          New warehouse
        </Button>
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

      <Stack divider={<Divider flexItem />} sx={{ mt: 2 }}>
        {workspace?.warehouses.map((item) => (
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
                        {!entry.active && <Chip size="small" label="retired" color="warning" />}
                      </Stack>
                      <Typography variant="caption" color="text.secondary">
                        {entry.zone} · sequence {entry.pickSequence} · {entry.globalId}
                        {entry.productRules.filter((rule) => rule.active).length
                          ? ` · ${entry.productRules.filter((rule) => rule.active).length} product rule${entry.productRules.filter((rule) => rule.active).length === 1 ? '' : 's'}`
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
        ))}
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
                <TextField select required label="Facility type" value={warehouse.facilityType} onChange={(e) => setWarehouse({ ...warehouse, facilityType: e.target.value as FacilityType })} fullWidth>
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
                <TextField label="Daily cutoff" type="time" value={warehouse.cutoffTime} onChange={(e) => setWarehouse({ ...warehouse, cutoffTime: e.target.value })} InputLabelProps={{ shrink: true }} fullWidth />
              </Stack>
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
                <TextField select label="Topology level" value={location.topologyLevel} onChange={(e) => setLocation({ ...location, topologyLevel: e.target.value as TopologyLevel })} fullWidth>
                  {topologyLevels.map((level) => <MenuItem key={level.value} value={level.value}>{level.label}</MenuItem>)}
                </TextField>
                <TextField select label="Operational use" value={location.locationType} onChange={(e) => setLocation({ ...location, locationType: e.target.value as LocationType })} fullWidth>
                  {locationTypes.map((type) => <MenuItem key={type.value} value={type.value}>{type.label}</MenuItem>)}
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
                <TextField required type="number" label="Pick sequence" value={location.pickSequence} onChange={(e) => setLocation({ ...location, pickSequence: Number(e.target.value) })} inputProps={{ min: 0, max: 1000000 }} fullWidth />
                <FormControlLabel control={<Switch checked={location.active} onChange={(e) => setLocation({ ...location, active: e.target.checked })} />} label="Active" />
                <FormControlLabel control={<Switch checked={location.allowMixedProducts} onChange={(e) => setLocation({ ...location, allowMixedProducts: e.target.checked })} />} label="Allow mixed products" />
              </Stack>

              <Divider />
              <Stack direction={{ xs: 'column', sm: 'row' }} justifyContent="space-between" alignItems={{ sm: 'center' }} gap={1}>
                <Box>
                  <Typography fontWeight={700}>Capacity limits</Typography>
                  <Typography variant="body2" color="text.secondary">Optional physical limits used for putaway and replenishment eligibility.</Typography>
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
                  Restrict, allow, or prefer specific products at this location. A quantity limit is optional.
                </Typography>
              </Box>
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
                  <Stack key={rule.productGlobalId} direction={{ xs: 'column', sm: 'row' }} gap={1} alignItems={{ sm: 'center' }} sx={{ py: 1 }}>
                    <Typography sx={{ flex: 1 }} fontWeight={600}>{rule.productName}</Typography>
                    <TextField
                      select
                      size="small"
                      label="Rule"
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
                      label="Max quantity"
                      value={rule.maxQuantity}
                      onChange={(e) => {
                        const next = [...location.productRules]
                        next[index] = { ...rule, maxQuantity: e.target.value }
                        setLocation({ ...location, productRules: next })
                      }}
                      inputProps={{ min: 0.000001, step: 'any' }}
                      sx={{ width: { sm: 150 } }}
                    />
                    <Tooltip title="Remove product rule">
                      <IconButton type="button" onClick={() => setLocation({ ...location, productRules: location.productRules.filter((_, ruleIndex) => ruleIndex !== index) })}>
                        <DeleteOutlineRounded />
                      </IconButton>
                    </Tooltip>
                  </Stack>
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
    </Box>
  )
}
