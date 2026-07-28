'use client'

import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  FormControlLabel,
  InputAdornment,
  MenuItem,
  Stack,
  Switch,
  TextField,
  Typography,
} from '@mui/material'
import AddRounded from '@mui/icons-material/AddRounded'
import AutoAwesomeRounded from '@mui/icons-material/AutoAwesomeRounded'
import EditRounded from '@mui/icons-material/EditRounded'
import Inventory2Rounded from '@mui/icons-material/Inventory2Rounded'
import SearchRounded from '@mui/icons-material/SearchRounded'
import type {
  PackagingMaterial,
  PackagingMaterialStock,
  PackagingMaterialsWorkspace,
  PackagingMaterialType,
} from '@/lib/operations/packagingMaterials'

type Payload = {
  ok?: boolean
  error?: string
  packagingMaterials?: PackagingMaterialsWorkspace
  result?: {
    globalId?: string
    createdCount?: number
    totalCount?: number
    replayed?: boolean
  }
}

type MaterialForm = {
  code: string
  name: string
  materialType: PackagingMaterialType
  innerLengthMm: string
  innerWidthMm: string
  innerHeightMm: string
  tareWeightGrams: string
  maxWeightGrams: string
  unitCost: string
  currency: string
}

type StockForm = {
  warehouseId: string
  isAvailable: boolean
  onHandQuantity: string
  reorderPointQuantity: string
  reorderToQuantity: string
}

const emptyMaterial: MaterialForm = {
  code: '',
  name: '',
  materialType: 'carton',
  innerLengthMm: '',
  innerWidthMm: '',
  innerHeightMm: '',
  tareWeightGrams: '',
  maxWeightGrams: '',
  unitCost: '',
  currency: 'USD',
}

const emptyStock: StockForm = {
  warehouseId: '',
  isAvailable: false,
  onHandQuantity: '',
  reorderPointQuantity: '',
  reorderToQuantity: '',
}

const materialTypeOptions: Array<{
  value: PackagingMaterialType
  label: string
}> = [
  { value: 'carton', label: 'Carton' },
  { value: 'poly_mailer', label: 'Poly mailer' },
  { value: 'padded_mailer', label: 'Padded mailer' },
]

const controlSx = {
  minWidth: 0,
  '& .MuiInputBase-root': {
    minHeight: 40,
    borderRadius: '8px',
    backgroundColor: '#15151D',
  },
}

function display(value: string) {
  return value.replace(/[_.-]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase())
}

function money(minor: number | null, currency = 'USD') {
  if (minor === null) return 'Cost required'
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(minor / 100)
}

function materialForm(material: PackagingMaterial): MaterialForm {
  return {
    code: material.code,
    name: material.name,
    materialType: material.materialType,
    innerLengthMm: String(material.innerDimensionsMm.length),
    innerWidthMm: String(material.innerDimensionsMm.width),
    innerHeightMm: String(material.innerDimensionsMm.height),
    tareWeightGrams: String(material.tareWeightGrams),
    maxWeightGrams: String(material.maxWeightGrams),
    unitCost: material.unitCostMinor === null
      ? ''
      : (material.unitCostMinor / 100).toFixed(2),
    currency: material.currency || 'USD',
  }
}

function stockForm(
  warehouseId: string,
  stock: PackagingMaterialStock | undefined,
): StockForm {
  return {
    warehouseId,
    isAvailable: stock?.isAvailable || false,
    onHandQuantity: stock?.onHandQuantity === null || stock?.onHandQuantity === undefined
      ? ''
      : String(stock.onHandQuantity),
    reorderPointQuantity: stock?.reorderPointQuantity === null
      || stock?.reorderPointQuantity === undefined
      ? ''
      : String(stock.reorderPointQuantity),
    reorderToQuantity: stock?.reorderToQuantity === null
      || stock?.reorderToQuantity === undefined
      ? ''
      : String(stock.reorderToQuantity),
  }
}

function ReadinessMetric({
  label,
  value,
  warning,
}: {
  label: string
  value: number
  warning?: boolean
}) {
  return (
    <Box
      sx={{
        flex: '1 1 150px',
        minWidth: 0,
        p: 1.5,
        border: '1px solid rgba(255,255,255,0.1)',
        borderRadius: '8px',
        backgroundColor: '#13131A',
      }}
    >
      <Typography variant="caption" color="text.secondary">{label}</Typography>
      <Typography
        fontSize="1.35rem"
        fontWeight={750}
        color={warning && value ? 'warning.light' : 'text.primary'}
      >
        {value}
      </Typography>
    </Box>
  )
}

export default function PackagingMaterialsPanel() {
  const [workspace, setWorkspace] = useState<PackagingMaterialsWorkspace | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [search, setSearch] = useState('')
  const [materialOpen, setMaterialOpen] = useState(false)
  const [editingMaterial, setEditingMaterial] = useState<PackagingMaterial | null>(null)
  const [materialDraft, setMaterialDraft] = useState<MaterialForm>(emptyMaterial)
  const [stockOpen, setStockOpen] = useState(false)
  const [stockMaterial, setStockMaterial] = useState<PackagingMaterial | null>(null)
  const [stockDraft, setStockDraft] = useState<StockForm>(emptyStock)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const response = await fetch('/api/operations/packaging-materials', {
        cache: 'no-store',
      })
      const payload = await response.json() as Payload
      if (!response.ok || !payload.packagingMaterials) {
        throw new Error(payload.error || 'Packaging materials are unavailable')
      }
      setWorkspace(payload.packagingMaterials)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Packaging materials are unavailable')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const materials = useMemo(() => {
    const needle = search.trim().toLowerCase()
    if (!needle) return workspace?.materials || []
    return (workspace?.materials || []).filter((material) => (
      material.code.toLowerCase().includes(needle)
      || material.name.toLowerCase().includes(needle)
      || material.materialType.toLowerCase().includes(needle)
      || material.globalId.toLowerCase().includes(needle)
    ))
  }, [search, workspace])

  const openCreate = () => {
    setEditingMaterial(null)
    setMaterialDraft(emptyMaterial)
    setMaterialOpen(true)
  }

  const openEdit = (material: PackagingMaterial) => {
    setEditingMaterial(material)
    setMaterialDraft(materialForm(material))
    setMaterialOpen(true)
  }

  const saveMaterial = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const unitCost = materialDraft.unitCost.trim()
        ? Math.round(Number(materialDraft.unitCost) * 100)
        : null
      const response = await fetch('/api/operations/packaging-materials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'save-material',
          ...(editingMaterial ? {
            globalId: editingMaterial.globalId,
            expectedRowVersion: editingMaterial.rowVersion,
          } : {}),
          code: materialDraft.code,
          name: materialDraft.name,
          materialType: materialDraft.materialType,
          innerLengthMm: Number(materialDraft.innerLengthMm),
          innerWidthMm: Number(materialDraft.innerWidthMm),
          innerHeightMm: Number(materialDraft.innerHeightMm),
          tareWeightGrams: Number(materialDraft.tareWeightGrams),
          maxWeightGrams: Number(materialDraft.maxWeightGrams),
          unitCostMinor: unitCost,
          currency: unitCost === null ? null : materialDraft.currency,
          status: editingMaterial?.status || 'draft',
        }),
      })
      const payload = await response.json() as Payload
      if (!response.ok || !payload.result?.globalId) {
        throw new Error(payload.error || 'Packaging material could not be saved')
      }
      setMaterialOpen(false)
      setNotice(
        editingMaterial
          ? `${materialDraft.name} was updated.`
          : `${materialDraft.name} was created as a draft.`,
      )
      await load()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Packaging material could not be saved')
    } finally {
      setBusy(false)
    }
  }

  const openStock = (material: PackagingMaterial, preferredWarehouseId?: string) => {
    const warehouseId = preferredWarehouseId || workspace?.warehouses.find(
      (warehouse) => warehouse.status === 'active',
    )?.id || workspace?.warehouses[0]?.id || ''
    setStockMaterial(material)
    setStockDraft(stockForm(
      warehouseId,
      material.stock.find((stock) => stock.warehouseId === warehouseId),
    ))
    setStockOpen(true)
  }

  const changeStockWarehouse = (warehouseId: string) => {
    setStockDraft(stockForm(
      warehouseId,
      stockMaterial?.stock.find((stock) => stock.warehouseId === warehouseId),
    ))
  }

  const saveStock = async (event: FormEvent) => {
    event.preventDefault()
    if (!stockMaterial) return
    const existing = stockMaterial.stock.find(
      (stock) => stock.warehouseId === stockDraft.warehouseId,
    )
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const response = await fetch('/api/operations/packaging-materials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'save-stock',
          materialGlobalId: stockMaterial.globalId,
          warehouseId: stockDraft.warehouseId,
          ...(existing ? { expectedRowVersion: existing.rowVersion } : {}),
          isAvailable: stockDraft.isAvailable,
          onHandQuantity: stockDraft.onHandQuantity.trim()
            ? Number(stockDraft.onHandQuantity)
            : null,
          reorderPointQuantity: stockDraft.reorderPointQuantity.trim()
            ? Number(stockDraft.reorderPointQuantity)
            : null,
          reorderToQuantity: stockDraft.reorderToQuantity.trim()
            ? Number(stockDraft.reorderToQuantity)
            : null,
        }),
      })
      const payload = await response.json() as Payload
      if (!response.ok || !payload.result?.globalId) {
        throw new Error(payload.error || 'Warehouse stock could not be saved')
      }
      setStockOpen(false)
      setNotice(`Warehouse stock for ${stockMaterial.name} was updated.`)
      await load()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Warehouse stock could not be saved')
    } finally {
      setBusy(false)
    }
  }

  const changeStatus = async (
    material: PackagingMaterial,
    status: 'draft' | 'active',
  ) => {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const response = await fetch('/api/operations/packaging-materials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'save-material',
          globalId: material.globalId,
          expectedRowVersion: material.rowVersion,
          code: material.code,
          name: material.name,
          materialType: material.materialType,
          innerLengthMm: material.innerDimensionsMm.length,
          innerWidthMm: material.innerDimensionsMm.width,
          innerHeightMm: material.innerDimensionsMm.height,
          tareWeightGrams: material.tareWeightGrams,
          maxWeightGrams: material.maxWeightGrams,
          unitCostMinor: material.unitCostMinor,
          currency: material.currency,
          status,
        }),
      })
      const payload = await response.json() as Payload
      if (!response.ok || !payload.result?.globalId) {
        throw new Error(payload.error || 'Packaging material status could not be changed')
      }
      setNotice(
        status === 'active'
          ? `${material.name} is active. Cartonization may use it only while eligible stock is available.`
          : `${material.name} was returned to draft and is excluded from cartonization.`,
      )
      await load()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Packaging material status could not be changed')
    } finally {
      setBusy(false)
    }
  }

  const createStarterAssortment = async () => {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const response = await fetch('/api/operations/packaging-materials', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'packaging-materials:starter-assortment:v1',
        },
        body: JSON.stringify({ action: 'create-starter-assortment' }),
      })
      const payload = await response.json() as Payload
      if (!response.ok || payload.result?.totalCount === undefined) {
        throw new Error(payload.error || 'Starter assortment could not be created')
      }
      setNotice(
        `${payload.result.totalCount} starter materials are available as drafts. `
        + `${payload.result.createdCount || 0} were added; verify the supplier specifications, enter actual cost, and record warehouse stock before activation.`,
      )
      await load()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Starter assortment could not be created')
    } finally {
      setBusy(false)
    }
  }

  const canManage = workspace?.capabilities.canManage === true
  const readiness = workspace?.optimizerReadiness

  return (
    <Box sx={{ px: { xs: 2, md: 3 }, py: 2.5, minWidth: 0 }}>
      <Stack spacing={2.5}>
        <Box>
          <Typography variant="h6" fontWeight={750}>Cartons and mailers</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
            Maintain the real materials available at each warehouse. Drafts are never
            offered to cartonization, and availability alone does not fabricate stock.
          </Typography>
        </Box>

        {error && <Alert severity="error" onClose={() => setError('')}>{error}</Alert>}
        {notice && <Alert severity="success" onClose={() => setNotice('')}>{notice}</Alert>}
        {!loading && workspace && workspace.warehouses.length === 0 && (
          <Alert severity="warning">
            Create the real warehouse first. Packaging Materials never creates or guesses
            a warehouse.
          </Alert>
        )}

        {readiness && (
          <Box
            component="section"
            aria-label="Cartonization readiness"
            sx={{
              p: { xs: 1.5, sm: 2 },
              border: '1px solid rgba(255,255,255,0.12)',
              borderRadius: '10px',
              backgroundColor: '#101017',
            }}
          >
            <Typography fontWeight={700}>Optimizer readiness</Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
              Evidence for a future solver recommendation over the last{' '}
              {readiness.historyWindowDays} days. This is readiness, not a claim that
              the assortment or carrier cost is optimized.
            </Typography>
            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
              <ReadinessMetric
                label="Eligible shipped orders"
                value={readiness.eligibleShippedDemandSampleCount}
              />
              <ReadinessMetric
                label="Shipped orders sampled"
                value={readiness.shippedDemandSampleCount}
              />
              <ReadinessMetric
                label="Products missing dimensions"
                value={readiness.missingProductDimensionCount}
                warning
              />
              <ReadinessMetric
                label="Materials missing cost"
                value={readiness.missingMaterialCostCount}
                warning
              />
              <ReadinessMetric
                label="Warehouse stock gaps"
                value={readiness.missingWarehouseStockCount}
                warning
              />
              <ReadinessMetric
                label="Eligible materials"
                value={readiness.eligibleMaterialCount}
              />
              <ReadinessMetric
                label="Reorders due"
                value={readiness.reorderDueCount}
                warning
              />
            </Box>
          </Box>
        )}

        <Stack
          direction={{ xs: 'column', sm: 'row' }}
          spacing={1}
          alignItems={{ xs: 'stretch', sm: 'center' }}
        >
          <TextField
            size="small"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search material, code, or Global ID"
            inputProps={{ 'aria-label': 'Search packaging materials' }}
            InputProps={{
              startAdornment: (
                <InputAdornment position="start"><SearchRounded fontSize="small" /></InputAdornment>
              ),
            }}
            sx={{ ...controlSx, flex: '1 1 280px' }}
          />
          <Button
            variant="outlined"
            startIcon={busy ? <CircularProgress size={16} /> : <AutoAwesomeRounded />}
            disabled={!canManage || busy}
            onClick={() => void createStarterAssortment()}
          >
            Create starter assortment
          </Button>
          <Button
            variant="contained"
            startIcon={<AddRounded />}
            disabled={!canManage || busy}
            onClick={openCreate}
          >
            Add material
          </Button>
        </Stack>

        {loading ? (
          <Box sx={{ py: 6, display: 'grid', placeItems: 'center' }}>
            <CircularProgress aria-label="Loading packaging materials" />
          </Box>
        ) : materials.length === 0 ? (
          <Box
            sx={{
              py: 6,
              px: 2,
              textAlign: 'center',
              border: '1px dashed rgba(255,255,255,0.16)',
              borderRadius: '10px',
            }}
          >
            <Inventory2Rounded color="disabled" sx={{ fontSize: 38 }} />
            <Typography fontWeight={700} sx={{ mt: 1 }}>
              {search ? 'No matching materials' : 'No packaging materials'}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {search
                ? 'Try a different search.'
                : 'Add your supplier materials or create the editable starter assortment.'}
            </Typography>
          </Box>
        ) : (
          <Box
            sx={{
              display: 'grid',
              gridTemplateColumns: {
                xs: 'minmax(0, 1fr)',
                lg: 'repeat(2, minmax(0, 1fr))',
              },
              gap: 1.5,
            }}
          >
            {materials.map((material) => (
              <Box
                key={material.globalId}
                component="article"
                sx={{
                  minWidth: 0,
                  p: { xs: 1.5, sm: 2 },
                  border: '1px solid rgba(255,255,255,0.12)',
                  borderRadius: '10px',
                  backgroundColor: '#111118',
                }}
              >
                <Stack
                  direction="row"
                  justifyContent="space-between"
                  alignItems="flex-start"
                  spacing={1.5}
                >
                  <Box sx={{ minWidth: 0 }}>
                    <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
                      <Typography fontWeight={750}>{material.name}</Typography>
                      <Chip
                        size="small"
                        label={display(material.status)}
                        color={material.status === 'active' ? 'success' : 'default'}
                        variant={material.status === 'active' ? 'filled' : 'outlined'}
                      />
                      {material.readiness.eligibleForCartonization && (
                        <Chip size="small" label="Optimizer eligible" color="info" variant="outlined" />
                      )}
                    </Stack>
                    <Typography variant="caption" color="text.secondary">
                      {material.code} · {material.globalId} · {display(material.materialType)}
                    </Typography>
                  </Box>
                  <Button
                    size="small"
                    startIcon={<EditRounded />}
                    disabled={!canManage || busy}
                    onClick={() => openEdit(material)}
                  >
                    Edit
                  </Button>
                </Stack>

                <Box
                  sx={{
                    display: 'grid',
                    gridTemplateColumns: { xs: '1fr 1fr', sm: 'repeat(4, 1fr)' },
                    gap: 1.25,
                    mt: 2,
                  }}
                >
                  <Box>
                    <Typography variant="caption" color="text.secondary">Inner dimensions</Typography>
                    <Typography variant="body2">
                      {material.innerDimensionsMm.length} × {material.innerDimensionsMm.width} ×{' '}
                      {material.innerDimensionsMm.height} mm
                    </Typography>
                  </Box>
                  <Box>
                    <Typography variant="caption" color="text.secondary">Tare</Typography>
                    <Typography variant="body2">{material.tareWeightGrams} g</Typography>
                  </Box>
                  <Box>
                    <Typography variant="caption" color="text.secondary">Maximum</Typography>
                    <Typography variant="body2">{material.maxWeightGrams} g</Typography>
                  </Box>
                  <Box>
                    <Typography variant="caption" color="text.secondary">Unit cost</Typography>
                    <Typography variant="body2">
                      {money(material.unitCostMinor, material.currency || 'USD')}
                    </Typography>
                  </Box>
                </Box>

                <Divider sx={{ my: 1.5 }} />

                {workspace?.warehouses.map((warehouse) => {
                  const stock = material.stock.find(
                    (candidate) => candidate.warehouseId === warehouse.id,
                  )
                  return (
                    <Box
                      key={warehouse.id}
                      sx={{
                        display: 'grid',
                        gridTemplateColumns: { xs: 'minmax(0, 1fr)', sm: 'minmax(0, 1fr) auto' },
                        alignItems: 'center',
                        gap: 1,
                        py: 0.5,
                      }}
                    >
                      <Box sx={{ minWidth: 0 }}>
                        <Typography variant="body2" fontWeight={650}>
                          {warehouse.name}
                        </Typography>
                        <Typography variant="caption" color="text.secondary">
                          {stock?.onHandQuantity === null || stock?.onHandQuantity === undefined
                            ? 'On-hand not recorded'
                            : `${stock.onHandQuantity} on hand`}
                          {' · '}
                          {stock?.isAvailable ? 'Available' : 'Unavailable'}
                          {stock?.reorderRecommendedQuantity
                            ? ` · Reorder ${stock.reorderRecommendedQuantity}`
                            : ''}
                        </Typography>
                      </Box>
                      <Button
                        size="small"
                        variant="outlined"
                        disabled={!canManage || busy}
                        onClick={() => openStock(material, warehouse.id)}
                      >
                        Edit stock
                      </Button>
                    </Box>
                  )
                })}

                {material.readiness.missing.length > 0 && (
                  <Alert severity="warning" sx={{ mt: 1.5 }}>
                    Fix before use:{' '}
                    {material.readiness.missing.map((gap) => display(gap)).join(', ')}.
                  </Alert>
                )}

                <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ mt: 1.5 }}>
                  {material.status === 'draft' ? (
                    <Button
                      variant="contained"
                      disabled={!canManage || busy}
                      onClick={() => void changeStatus(material, 'active')}
                    >
                      Activate material
                    </Button>
                  ) : (
                    <Button
                      variant="outlined"
                      color="inherit"
                      disabled={!canManage || busy}
                      onClick={() => void changeStatus(material, 'draft')}
                    >
                      Return to draft
                    </Button>
                  )}
                  <Typography variant="caption" color="text.secondary" sx={{ alignSelf: 'center' }}>
                    {material.source === 'starter_assortment'
                      ? 'Starter specification — verify against the selected supplier.'
                      : 'Manual supplier specification.'}
                  </Typography>
                </Stack>
              </Box>
            ))}
          </Box>
        )}
      </Stack>

      <Dialog
        open={materialOpen}
        onClose={() => !busy && setMaterialOpen(false)}
        fullWidth
        maxWidth="md"
      >
        <Box component="form" onSubmit={saveMaterial}>
          <DialogTitle>
            {editingMaterial ? 'Edit packaging material' : 'Add packaging material'}
          </DialogTitle>
          <DialogContent dividers>
            <Stack spacing={2}>
              <Alert severity="info">
                Dimensions are canonical inner millimeters. Enter the supplier&apos;s
                actual tare, maximum weight, and unit material cost. New records remain
                drafts until warehouse stock is configured and you activate them.
              </Alert>
              <Box
                sx={{
                  display: 'grid',
                  gridTemplateColumns: { xs: '1fr', sm: '1fr 2fr' },
                  gap: 1.5,
                }}
              >
                <TextField
                  label="Code"
                  value={materialDraft.code}
                  onChange={(event) => setMaterialDraft({
                    ...materialDraft,
                    code: event.target.value.toUpperCase(),
                  })}
                  required
                />
                <TextField
                  label="Name"
                  value={materialDraft.name}
                  onChange={(event) => setMaterialDraft({
                    ...materialDraft,
                    name: event.target.value,
                  })}
                  required
                />
                <TextField
                  select
                  label="Material type"
                  value={materialDraft.materialType}
                  onChange={(event) => setMaterialDraft({
                    ...materialDraft,
                    materialType: event.target.value as PackagingMaterialType,
                  })}
                >
                  {materialTypeOptions.map((option) => (
                    <MenuItem key={option.value} value={option.value}>{option.label}</MenuItem>
                  ))}
                </TextField>
              </Box>
              <Box
                sx={{
                  display: 'grid',
                  gridTemplateColumns: { xs: '1fr', sm: 'repeat(3, 1fr)' },
                  gap: 1.5,
                }}
              >
                <TextField
                  type="number"
                  label="Inner length (mm)"
                  value={materialDraft.innerLengthMm}
                  onChange={(event) => setMaterialDraft({
                    ...materialDraft,
                    innerLengthMm: event.target.value,
                  })}
                  inputProps={{ min: 1, step: 1 }}
                  required
                />
                <TextField
                  type="number"
                  label="Inner width (mm)"
                  value={materialDraft.innerWidthMm}
                  onChange={(event) => setMaterialDraft({
                    ...materialDraft,
                    innerWidthMm: event.target.value,
                  })}
                  inputProps={{ min: 1, step: 1 }}
                  required
                />
                <TextField
                  type="number"
                  label="Inner height (mm)"
                  value={materialDraft.innerHeightMm}
                  onChange={(event) => setMaterialDraft({
                    ...materialDraft,
                    innerHeightMm: event.target.value,
                  })}
                  inputProps={{ min: 1, step: 1 }}
                  required
                />
                <TextField
                  type="number"
                  label="Tare weight (g)"
                  value={materialDraft.tareWeightGrams}
                  onChange={(event) => setMaterialDraft({
                    ...materialDraft,
                    tareWeightGrams: event.target.value,
                  })}
                  inputProps={{ min: 1, step: 1 }}
                  required
                />
                <TextField
                  type="number"
                  label="Maximum weight (g)"
                  value={materialDraft.maxWeightGrams}
                  onChange={(event) => setMaterialDraft({
                    ...materialDraft,
                    maxWeightGrams: event.target.value,
                  })}
                  inputProps={{ min: 2, step: 1 }}
                  required
                />
                <TextField
                  type="number"
                  label="Unit cost"
                  value={materialDraft.unitCost}
                  onChange={(event) => setMaterialDraft({
                    ...materialDraft,
                    unitCost: event.target.value,
                  })}
                  inputProps={{ min: 0.01, step: 0.01 }}
                  InputProps={{
                    endAdornment: (
                      <InputAdornment position="end">
                        {materialDraft.currency || 'USD'}
                      </InputAdornment>
                    ),
                  }}
                  helperText="Leave blank while supplier cost is unknown"
                />
                <TextField
                  label="Currency"
                  value={materialDraft.currency}
                  onChange={(event) => setMaterialDraft({
                    ...materialDraft,
                    currency: event.target.value.toUpperCase(),
                  })}
                  inputProps={{ maxLength: 3 }}
                  disabled={!materialDraft.unitCost.trim()}
                  required={Boolean(materialDraft.unitCost.trim())}
                />
              </Box>
            </Stack>
          </DialogContent>
          <DialogActions>
            <Button onClick={() => setMaterialOpen(false)} disabled={busy}>Cancel</Button>
            <Button type="submit" variant="contained" disabled={busy}>
              {busy ? 'Saving' : editingMaterial ? 'Save changes' : 'Create draft'}
            </Button>
          </DialogActions>
        </Box>
      </Dialog>

      <Dialog
        open={stockOpen}
        onClose={() => !busy && setStockOpen(false)}
        fullWidth
        maxWidth="sm"
      >
        <Box component="form" onSubmit={saveStock}>
          <DialogTitle>Warehouse packaging stock</DialogTitle>
          <DialogContent dividers>
            <Stack spacing={2}>
              <Typography color="text.secondary">
                {stockMaterial?.name}. Record physical on-hand units; no warehouse or
                inventory is inferred.
              </Typography>
              <TextField
                select
                label="Warehouse"
                value={stockDraft.warehouseId}
                onChange={(event) => changeStockWarehouse(event.target.value)}
                required
              >
                {(workspace?.warehouses || []).map((warehouse) => (
                  <MenuItem key={warehouse.id} value={warehouse.id}>
                    {warehouse.name}{warehouse.status === 'inactive' ? ' (inactive)' : ''}
                  </MenuItem>
                ))}
              </TextField>
              <FormControlLabel
                control={(
                  <Switch
                    checked={stockDraft.isAvailable}
                    onChange={(event) => setStockDraft({
                      ...stockDraft,
                      isAvailable: event.target.checked,
                    })}
                  />
                )}
                label="Available for cartonization at this warehouse"
              />
              <Box
                sx={{
                  display: 'grid',
                  gridTemplateColumns: { xs: '1fr', sm: 'repeat(3, 1fr)' },
                  gap: 1.5,
                }}
              >
                <TextField
                  type="number"
                  label="On hand"
                  value={stockDraft.onHandQuantity}
                  onChange={(event) => setStockDraft({
                    ...stockDraft,
                    onHandQuantity: event.target.value,
                  })}
                  inputProps={{ min: 0, step: 1 }}
                  required={stockDraft.isAvailable}
                />
                <TextField
                  type="number"
                  label="Reorder point"
                  value={stockDraft.reorderPointQuantity}
                  onChange={(event) => setStockDraft({
                    ...stockDraft,
                    reorderPointQuantity: event.target.value,
                  })}
                  inputProps={{ min: 0, step: 1 }}
                  helperText="Optional; set both reorder values"
                />
                <TextField
                  type="number"
                  label="Reorder to"
                  value={stockDraft.reorderToQuantity}
                  onChange={(event) => setStockDraft({
                    ...stockDraft,
                    reorderToQuantity: event.target.value,
                  })}
                  inputProps={{ min: 1, step: 1 }}
                />
              </Box>
            </Stack>
          </DialogContent>
          <DialogActions>
            <Button onClick={() => setStockOpen(false)} disabled={busy}>Cancel</Button>
            <Button
              type="submit"
              variant="contained"
              disabled={busy || !stockDraft.warehouseId}
            >
              {busy ? 'Saving' : 'Save warehouse stock'}
            </Button>
          </DialogActions>
        </Box>
      </Dialog>
    </Box>
  )
}
