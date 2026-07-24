'use client'

import { FormEvent, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  MenuItem,
  Stack,
  Switch,
  TextField,
  Typography,
} from '@mui/material'
import AddRounded from '@mui/icons-material/AddRounded'
import Inventory2Rounded from '@mui/icons-material/Inventory2Rounded'
import WarehouseRounded from '@mui/icons-material/WarehouseRounded'
import type { OperationsWorkspace } from '@/lib/operations/types'

type Props = {
  workspace: OperationsWorkspace | null
  onRefresh: () => Promise<void>
  onNavigate: (view: 'gl-coding' | 'printing') => void
}

type WarehouseForm = {
  code: string
  name: string
  timezone: string
  cutoffTime: string
  line1: string
  line2: string
  city: string
  region: string
  postalCode: string
  country: string
  createStarterLocations: boolean
}

const initialWarehouse: WarehouseForm = {
  code: '',
  name: '',
  timezone: 'America/New_York',
  cutoffTime: '16:00',
  line1: '',
  line2: '',
  city: '',
  region: '',
  postalCode: '',
  country: 'US',
  createStarterLocations: true,
}

const locationTypes = [
  'receiving', 'storage', 'pick', 'pack', 'staging', 'shipping', 'returns',
] as const

async function command(body: Record<string, unknown>) {
  const response = await fetch('/api/operations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const payload = await response.json().catch(() => ({})) as { error?: string }
  if (!response.ok) throw new Error(payload.error || 'Warehouse setup could not be saved')
}

export default function WarehouseSetupPanel({ workspace, onRefresh, onNavigate }: Props) {
  const [warehouseOpen, setWarehouseOpen] = useState(false)
  const [locationWarehouse, setLocationWarehouse] = useState<OperationsWorkspace['warehouses'][number] | null>(null)
  const [warehouse, setWarehouse] = useState(initialWarehouse)
  const [location, setLocation] = useState({ code: '', zone: 'STORAGE', locationType: 'storage', pickSequence: 100 })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const canManage = workspace?.capabilities.canManage === true

  async function submitWarehouse(event: FormEvent) {
    event.preventDefault()
    setSaving(true)
    setError('')
    try {
      await command({
        action: 'create-warehouse',
        code: warehouse.code,
        name: warehouse.name,
        timezone: warehouse.timezone,
        cutoffTime: warehouse.cutoffTime || null,
        createStarterLocations: warehouse.createStarterLocations,
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
      setWarehouseOpen(false)
      setWarehouse(initialWarehouse)
      setNotice('Warehouse created and activated.')
      await onRefresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Warehouse could not be created')
    } finally {
      setSaving(false)
    }
  }

  async function submitLocation(event: FormEvent) {
    event.preventDefault()
    if (!locationWarehouse) return
    setSaving(true)
    setError('')
    try {
      await command({
        action: 'create-location',
        warehouseGlobalId: locationWarehouse.globalId,
        ...location,
      })
      setLocationWarehouse(null)
      setLocation({ code: '', zone: 'STORAGE', locationType: 'storage', pickSequence: 100 })
      setNotice('Warehouse location created.')
      await onRefresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Location could not be created')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Box sx={{ px: { xs: 2, md: 3 }, py: 2.5, maxWidth: 1180, mx: 'auto' }}>
      <Stack direction={{ xs: 'column', sm: 'row' }} justifyContent="space-between" gap={1.5}>
        <Box>
          <Typography variant="h5" fontWeight={700}>Warehouse setup</Typography>
          <Typography color="text.secondary">Facilities, receiving points, storage bins, and outbound work areas.</Typography>
        </Box>
        <Button
          variant="contained"
          startIcon={<AddRounded />}
          disabled={!canManage}
          onClick={() => setWarehouseOpen(true)}
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
                  <Typography fontWeight={700}>{item.name}</Typography>
                  <Typography variant="body2" color="text.secondary">
                    {item.code} · {item.globalId} · {item.timezone}
                    {item.cutoffTime ? ` · cutoff ${item.cutoffTime.slice(0, 5)}` : ''}
                  </Typography>
                </Box>
                <Chip size="small" label={item.status} color={item.status === 'active' ? 'success' : 'default'} variant="outlined" />
              </Stack>
              <Button
                size="small"
                startIcon={<AddRounded />}
                disabled={!canManage}
                onClick={() => setLocationWarehouse(item)}
              >
                Add location
              </Button>
            </Stack>
            <Stack direction="row" gap={0.75} flexWrap="wrap" useFlexGap sx={{ mt: 1.5 }}>
              {item.locations.length ? item.locations.map((entry) => (
                <Chip
                  key={entry.globalId}
                  icon={<Inventory2Rounded />}
                  label={`${entry.code} · ${entry.locationType}`}
                  title={`${entry.zone} · Pick sequence ${entry.pickSequence} · ${entry.globalId}`}
                  variant="outlined"
                  color={entry.active ? 'default' : 'warning'}
                />
              )) : <Typography variant="body2" color="text.secondary">No locations configured.</Typography>}
            </Stack>
          </Box>
        ))}
      </Stack>

      {!workspace?.warehouses.length && (
        <Box sx={{ py: 8, textAlign: 'center' }}>
          <WarehouseRounded sx={{ fontSize: 42, color: 'text.disabled' }} />
          <Typography fontWeight={700} sx={{ mt: 1 }}>No warehouse configured</Typography>
          <Typography color="text.secondary">The quick-start topology creates receiving, storage, pick, pack, staging, shipping, and returns locations.</Typography>
        </Box>
      )}

      <Dialog open={warehouseOpen} onClose={() => !saving && setWarehouseOpen(false)} fullWidth maxWidth="sm">
        <Box component="form" onSubmit={submitWarehouse}>
          <DialogTitle>Create warehouse</DialogTitle>
          <DialogContent>
            <Stack gap={1.5} sx={{ pt: 1 }}>
              <Stack direction={{ xs: 'column', sm: 'row' }} gap={1.5}>
                <TextField required label="Warehouse code" value={warehouse.code} onChange={(e) => setWarehouse({ ...warehouse, code: e.target.value })} helperText="Example: DEL-OH-01" fullWidth />
                <TextField required label="Warehouse name" value={warehouse.name} onChange={(e) => setWarehouse({ ...warehouse, name: e.target.value })} fullWidth />
              </Stack>
              <TextField required label="Address" value={warehouse.line1} onChange={(e) => setWarehouse({ ...warehouse, line1: e.target.value })} />
              <TextField label="Address line 2" value={warehouse.line2} onChange={(e) => setWarehouse({ ...warehouse, line2: e.target.value })} />
              <Stack direction={{ xs: 'column', sm: 'row' }} gap={1.5}>
                <TextField required label="City" value={warehouse.city} onChange={(e) => setWarehouse({ ...warehouse, city: e.target.value })} fullWidth />
                <TextField required label="State / region" value={warehouse.region} onChange={(e) => setWarehouse({ ...warehouse, region: e.target.value })} fullWidth />
                <TextField required label="Postal code" value={warehouse.postalCode} onChange={(e) => setWarehouse({ ...warehouse, postalCode: e.target.value })} fullWidth />
              </Stack>
              <Stack direction={{ xs: 'column', sm: 'row' }} gap={1.5}>
                <TextField required label="Country" value={warehouse.country} onChange={(e) => setWarehouse({ ...warehouse, country: e.target.value.toUpperCase() })} inputProps={{ maxLength: 2 }} fullWidth />
                <TextField required label="Timezone" value={warehouse.timezone} onChange={(e) => setWarehouse({ ...warehouse, timezone: e.target.value })} fullWidth />
                <TextField label="Daily cutoff" type="time" value={warehouse.cutoffTime} onChange={(e) => setWarehouse({ ...warehouse, cutoffTime: e.target.value })} InputLabelProps={{ shrink: true }} fullWidth />
              </Stack>
              <Stack direction="row" justifyContent="space-between" alignItems="center">
                <Box>
                  <Typography fontWeight={600}>Create starter locations</Typography>
                  <Typography variant="body2" color="text.secondary">Adds the minimum inbound, storage, fulfillment, and returns topology.</Typography>
                </Box>
                <Switch checked={warehouse.createStarterLocations} onChange={(e) => setWarehouse({ ...warehouse, createStarterLocations: e.target.checked })} />
              </Stack>
            </Stack>
          </DialogContent>
          <DialogActions>
            <Button onClick={() => setWarehouseOpen(false)} disabled={saving}>Cancel</Button>
            <Button type="submit" variant="contained" disabled={saving}>Create warehouse</Button>
          </DialogActions>
        </Box>
      </Dialog>

      <Dialog open={Boolean(locationWarehouse)} onClose={() => !saving && setLocationWarehouse(null)} fullWidth maxWidth="xs">
        <Box component="form" onSubmit={submitLocation}>
          <DialogTitle>Add location to {locationWarehouse?.name}</DialogTitle>
          <DialogContent>
            <Stack gap={1.5} sx={{ pt: 1 }}>
              <TextField required label="Location / bin code" value={location.code} onChange={(e) => setLocation({ ...location, code: e.target.value })} helperText="Example: A01-B02-L03" />
              <TextField required label="Zone" value={location.zone} onChange={(e) => setLocation({ ...location, zone: e.target.value })} />
              <TextField select label="Location type" value={location.locationType} onChange={(e) => setLocation({ ...location, locationType: e.target.value })}>
                {locationTypes.map((type) => <MenuItem key={type} value={type}>{type}</MenuItem>)}
              </TextField>
              <TextField required type="number" label="Pick sequence" value={location.pickSequence} onChange={(e) => setLocation({ ...location, pickSequence: Number(e.target.value) })} inputProps={{ min: 0, max: 1000000 }} />
            </Stack>
          </DialogContent>
          <DialogActions>
            <Button onClick={() => setLocationWarehouse(null)} disabled={saving}>Cancel</Button>
            <Button type="submit" variant="contained" disabled={saving}>Add location</Button>
          </DialogActions>
        </Box>
      </Dialog>
    </Box>
  )
}
