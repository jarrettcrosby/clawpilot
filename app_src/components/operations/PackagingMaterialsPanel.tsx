'use client'

import {
  FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
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
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material'
import AddRounded from '@mui/icons-material/AddRounded'
import AutoAwesomeRounded from '@mui/icons-material/AutoAwesomeRounded'
import DeleteOutlineRounded from '@mui/icons-material/DeleteOutlineRounded'
import EditRounded from '@mui/icons-material/EditRounded'
import FileUploadRounded from '@mui/icons-material/FileUploadRounded'
import Inventory2Rounded from '@mui/icons-material/Inventory2Rounded'
import SearchRounded from '@mui/icons-material/SearchRounded'
import {
  packagingDimensionEvidenceReferenceRequired,
  type PackagingMaterial,
  type PackagingMaterialStock,
  type PackagingMaterialsWorkspace,
  type PackagingDimensionBasis,
  type PackagingDimensionEvidenceType,
  type PackagingMaterialSource,
  type PackagingMaterialType,
} from '@/lib/operations/packagingMaterials'
import { useMeasurementSystem } from '@/components/measurements/MeasurementSystemProvider'
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

type Payload = {
  ok?: boolean
  error?: string
  packagingMaterials?: PackagingMaterialsWorkspace
  result?: {
    globalId?: string
    createdCount?: number
    totalCount?: number
    replayed?: boolean
    outcome?: 'deleted' | 'retired'
    updatedCount?: number
  }
  preview?: {
    fileSha256: string
    totalCount: number
    defaultCount: number
    warnings: string[]
    rows: Array<{
      code: string
      name: string
      shopifyType: string
      ratedOuterLengthMm: number
      ratedOuterWidthMm: number
      ratedOuterHeightMm: number
      tareWeightGrams: number
      isDefault: boolean
    }>
  }
}

type MaterialForm = {
  code: string
  name: string
  materialType: PackagingMaterialType
  innerLengthMm: string
  innerWidthMm: string
  innerHeightMm: string
  ratedOuterLengthMm: string
  ratedOuterWidthMm: string
  ratedOuterHeightMm: string
  ratedOuterDimensionEvidenceType:
    | Exclude<PackagingDimensionEvidenceType, 'unknown'>
    | ''
  ratedOuterDimensionEvidenceReference: string
  dimensionBasis: PackagingDimensionBasis
  dimensionEvidenceType: PackagingDimensionEvidenceType
  dimensionEvidenceReference: string
  tareWeightGrams: string
  maxWeightGrams: string
  unitCost: string
  currency: string
  source: PackagingMaterialSource
}

type MaterialMeasurementForm = {
  innerLength: string
  innerWidth: string
  innerHeight: string
  ratedOuterLength: string
  ratedOuterWidth: string
  ratedOuterHeight: string
  tareWeight: string
  maxWeight: string
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
  ratedOuterLengthMm: '',
  ratedOuterWidthMm: '',
  ratedOuterHeightMm: '',
  ratedOuterDimensionEvidenceType: '',
  ratedOuterDimensionEvidenceReference: '',
  dimensionBasis: 'unspecified',
  dimensionEvidenceType: 'unknown',
  dimensionEvidenceReference: '',
  tareWeightGrams: '',
  maxWeightGrams: '',
  unitCost: '',
  currency: 'USD',
  source: 'manual',
}

const emptyMaterialMeasurements: MaterialMeasurementForm = {
  innerLength: '',
  innerWidth: '',
  innerHeight: '',
  ratedOuterLength: '',
  ratedOuterWidth: '',
  ratedOuterHeight: '',
  tareWeight: '',
  maxWeight: '',
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

const dimensionBasisOptions: Array<{
  value: PackagingDimensionBasis
  label: string
}> = [
  { value: 'unspecified', label: 'Not confirmed' },
  { value: 'inner', label: 'Usable inner dimensions' },
  { value: 'outer', label: 'Outer dimensions' },
]

const evidenceTypeOptions: Array<{
  value: PackagingDimensionEvidenceType
  label: string
}> = [
  { value: 'unknown', label: 'Not yet verified' },
  { value: 'customer_confirmed', label: 'Customer confirmed' },
  { value: 'measured', label: 'Measured' },
  { value: 'provider', label: 'Supplier or provider' },
  { value: 'legacy', label: 'Legacy specification' },
]

const materialSourceOptions: Array<{
  value: PackagingMaterialSource
  label: string
}> = [
  { value: 'manual', label: 'Operator entered' },
  { value: 'customer_supplied', label: 'Customer supplied' },
  { value: 'csv_import', label: 'CSV import' },
  { value: 'shopify_import', label: 'Shopify package import' },
  { value: 'starter_assortment', label: 'Starter assortment' },
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

const readinessGapLabels: Record<
  PackagingMaterial['readiness']['missing'][number],
  string
> = {
  dimensions: 'usable inner dimensions',
  dimension_basis: 'inner-dimension confirmation',
  dimension_evidence: 'dimension evidence',
  tare_weight: 'tare weight',
  max_weight: 'maximum weight',
  unit_cost: 'unit cost',
  warehouse_stock: 'warehouse stock',
  available_stock: 'available stock',
}

function readinessGapSummary(material: PackagingMaterial) {
  return material.readiness.missing
    .map((gap) => readinessGapLabels[gap])
    .join(', ')
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

function materialDimensions(
  material: PackagingMaterial,
  system: MeasurementSystem,
) {
  const dimensions = material.innerDimensionsMm
  if (
    dimensions.length !== null
    && dimensions.width !== null
    && dimensions.height !== null
  ) {
    return formatDimensionsMm({
      lengthMm: dimensions.length,
      widthMm: dimensions.width,
      heightMm: dimensions.height,
    }, system)
  }
  return [dimensions.length, dimensions.width, dimensions.height]
    .map((value) => (
      value === null
        ? 'unknown'
        : `${displayMeasurementValue(
          millimetersToDisplayLength(value, system),
        )} ${measurementUnits(system).length}`
    ))
    .join(' × ')
}

function canonicalDimensions(material: PackagingMaterial) {
  return [
    material.innerDimensionsMm.length,
    material.innerDimensionsMm.width,
    material.innerDimensionsMm.height,
  ].map((value) => value === null ? 'unknown' : String(value)).join(' × ')
}

function ratedOuterDimensions(
  material: PackagingMaterial,
  system: MeasurementSystem,
) {
  const dimensions = material.ratedOuterDimensionsMm
  if (
    dimensions.length === null
    || dimensions.width === null
    || dimensions.height === null
  ) return 'Not recorded'
  return formatDimensionsMm({
    lengthMm: dimensions.length,
    widthMm: dimensions.width,
    heightMm: dimensions.height,
  }, system)
}

function optionalWeight(
  grams: number | null,
  system: MeasurementSystem,
) {
  return grams === null ? 'Not recorded' : formatGrams(grams, system)
}

function displayMeasurementValue(value: number) {
  return String(Number(value.toFixed(3)))
}

function optionalMeasurementValue(
  value: number | null,
  convert: (measurement: number) => number,
) {
  return value === null ? '' : displayMeasurementValue(convert(value))
}

function materialMeasurementForm(
  material: Pick<
    PackagingMaterial,
    | 'innerDimensionsMm'
    | 'ratedOuterDimensionsMm'
    | 'tareWeightGrams'
    | 'maxWeightGrams'
  >,
  system: MeasurementSystem,
): MaterialMeasurementForm {
  return {
    innerLength: optionalMeasurementValue(
      material.innerDimensionsMm.length,
      (value) => millimetersToDisplayLength(value, system),
    ),
    innerWidth: optionalMeasurementValue(
      material.innerDimensionsMm.width,
      (value) => millimetersToDisplayLength(value, system),
    ),
    innerHeight: optionalMeasurementValue(
      material.innerDimensionsMm.height,
      (value) => millimetersToDisplayLength(value, system),
    ),
    ratedOuterLength: optionalMeasurementValue(
      material.ratedOuterDimensionsMm.length,
      (value) => millimetersToDisplayLength(value, system),
    ),
    ratedOuterWidth: optionalMeasurementValue(
      material.ratedOuterDimensionsMm.width,
      (value) => millimetersToDisplayLength(value, system),
    ),
    ratedOuterHeight: optionalMeasurementValue(
      material.ratedOuterDimensionsMm.height,
      (value) => millimetersToDisplayLength(value, system),
    ),
    tareWeight: optionalMeasurementValue(
      material.tareWeightGrams,
      (value) => gramsToDisplayWeight(value, system),
    ),
    maxWeight: optionalMeasurementValue(
      material.maxWeightGrams,
      (value) => gramsToDisplayWeight(value, system),
    ),
  }
}

function measurementFormFromCanonical(
  material: MaterialForm,
  system: MeasurementSystem,
): MaterialMeasurementForm {
  const length = Number(material.innerLengthMm)
  const width = Number(material.innerWidthMm)
  const height = Number(material.innerHeightMm)
  const ratedOuterLength = Number(material.ratedOuterLengthMm)
  const ratedOuterWidth = Number(material.ratedOuterWidthMm)
  const ratedOuterHeight = Number(material.ratedOuterHeightMm)
  const tareWeight = Number(material.tareWeightGrams)
  const maxWeight = Number(material.maxWeightGrams)
  return {
    innerLength: material.innerLengthMm && Number.isFinite(length)
      ? displayMeasurementValue(millimetersToDisplayLength(length, system))
      : '',
    innerWidth: material.innerWidthMm && Number.isFinite(width)
      ? displayMeasurementValue(millimetersToDisplayLength(width, system))
      : '',
    innerHeight: material.innerHeightMm && Number.isFinite(height)
      ? displayMeasurementValue(millimetersToDisplayLength(height, system))
      : '',
    ratedOuterLength: material.ratedOuterLengthMm
      && Number.isFinite(ratedOuterLength)
      ? displayMeasurementValue(
        millimetersToDisplayLength(ratedOuterLength, system),
      )
      : '',
    ratedOuterWidth: material.ratedOuterWidthMm
      && Number.isFinite(ratedOuterWidth)
      ? displayMeasurementValue(
        millimetersToDisplayLength(ratedOuterWidth, system),
      )
      : '',
    ratedOuterHeight: material.ratedOuterHeightMm
      && Number.isFinite(ratedOuterHeight)
      ? displayMeasurementValue(
        millimetersToDisplayLength(ratedOuterHeight, system),
      )
      : '',
    tareWeight: material.tareWeightGrams && Number.isFinite(tareWeight)
      ? displayMeasurementValue(gramsToDisplayWeight(tareWeight, system))
      : '',
    maxWeight: material.maxWeightGrams && Number.isFinite(maxWeight)
      ? displayMeasurementValue(gramsToDisplayWeight(maxWeight, system))
      : '',
  }
}

function materialForm(material: PackagingMaterial): MaterialForm {
  return {
    code: material.code,
    name: material.name,
    materialType: material.materialType,
    innerLengthMm: material.innerDimensionsMm.length === null
      ? ''
      : String(material.innerDimensionsMm.length),
    innerWidthMm: material.innerDimensionsMm.width === null
      ? ''
      : String(material.innerDimensionsMm.width),
    innerHeightMm: material.innerDimensionsMm.height === null
      ? ''
      : String(material.innerDimensionsMm.height),
    ratedOuterLengthMm: material.ratedOuterDimensionsMm.length === null
      ? ''
      : String(material.ratedOuterDimensionsMm.length),
    ratedOuterWidthMm: material.ratedOuterDimensionsMm.width === null
      ? ''
      : String(material.ratedOuterDimensionsMm.width),
    ratedOuterHeightMm: material.ratedOuterDimensionsMm.height === null
      ? ''
      : String(material.ratedOuterDimensionsMm.height),
    ratedOuterDimensionEvidenceType:
      material.ratedOuterDimensionEvidenceType || '',
    ratedOuterDimensionEvidenceReference:
      material.ratedOuterDimensionEvidenceReference || '',
    dimensionBasis: material.dimensionBasis,
    dimensionEvidenceType: material.dimensionEvidenceType,
    dimensionEvidenceReference: material.dimensionEvidenceReference || '',
    tareWeightGrams: material.tareWeightGrams === null
      ? ''
      : String(material.tareWeightGrams),
    maxWeightGrams: material.maxWeightGrams === null
      ? ''
      : String(material.maxWeightGrams),
    unitCost: material.unitCostMinor === null
      ? ''
      : (material.unitCostMinor / 100).toFixed(2),
    currency: material.currency || 'USD',
    source: material.source,
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
  const {
    measurementSystem: preferredMeasurementSystem,
    effectiveSource: measurementPreferenceSource,
    error: measurementPreferenceError,
  } = useMeasurementSystem()
  const [measurementSystem, setMeasurementSystem] = useState<MeasurementSystem>(
    preferredMeasurementSystem,
  )
  const [hasLocalMeasurementOverride, setHasLocalMeasurementOverride] = useState(false)
  const units = measurementUnits(measurementSystem)
  const [workspace, setWorkspace] = useState<PackagingMaterialsWorkspace | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [search, setSearch] = useState('')
  const [materialOpen, setMaterialOpen] = useState(false)
  const [editingMaterial, setEditingMaterial] = useState<PackagingMaterial | null>(null)
  const [materialDraft, setMaterialDraft] = useState<MaterialForm>(emptyMaterial)
  const [materialMeasurementDraft, setMaterialMeasurementDraft] = useState<
    MaterialMeasurementForm
  >(emptyMaterialMeasurements)
  const [materialSubmitted, setMaterialSubmitted] = useState(false)
  const [stockOpen, setStockOpen] = useState(false)
  const [stockMaterial, setStockMaterial] = useState<PackagingMaterial | null>(null)
  const [stockDraft, setStockDraft] = useState<StockForm>(emptyStock)
  const [removeMaterial, setRemoveMaterial] = useState<PackagingMaterial | null>(null)
  const [importOpen, setImportOpen] = useState(false)
  const [importCsv, setImportCsv] = useState('')
  const [importAccountGlobalId, setImportAccountGlobalId] = useState('')
  const [importPreview, setImportPreview] = useState<Payload['preview']>(undefined)
  const starterCommandKey = useRef<string | null>(null)
  const importCommandKey = useRef<string | null>(null)
  const previousMeasurementSystem = useRef(measurementSystem)

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

  useEffect(() => {
    if (hasLocalMeasurementOverride) return
    setMeasurementSystem(preferredMeasurementSystem)
  }, [hasLocalMeasurementOverride, preferredMeasurementSystem])

  useEffect(() => {
    if (previousMeasurementSystem.current === measurementSystem) return
    previousMeasurementSystem.current = measurementSystem
    if (!materialOpen) return
    setMaterialMeasurementDraft(
      measurementFormFromCanonical(materialDraft, measurementSystem),
    )
  }, [materialDraft, materialOpen, measurementSystem])

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
    setMaterialMeasurementDraft(emptyMaterialMeasurements)
    setMaterialSubmitted(false)
    setMaterialOpen(true)
  }

  const openEdit = (material: PackagingMaterial) => {
    setEditingMaterial(material)
    setMaterialDraft(materialForm(material))
    setMaterialMeasurementDraft(
      materialMeasurementForm(material, measurementSystem),
    )
    setMaterialSubmitted(false)
    setMaterialOpen(true)
  }

  const changeLocalMeasurementSystem = (next: MeasurementSystem | null) => {
    if (!next || next === measurementSystem) return
    setHasLocalMeasurementOverride(true)
    setMeasurementSystem(next)
  }

  const updateMaterialMeasurement = (
    field: keyof MaterialMeasurementForm,
    value: string,
  ) => {
    setMaterialMeasurementDraft((current) => ({ ...current, [field]: value }))
    const numeric = Number(value)
    const canonicalField = {
      innerLength: 'innerLengthMm',
      innerWidth: 'innerWidthMm',
      innerHeight: 'innerHeightMm',
      ratedOuterLength: 'ratedOuterLengthMm',
      ratedOuterWidth: 'ratedOuterWidthMm',
      ratedOuterHeight: 'ratedOuterHeightMm',
      tareWeight: 'tareWeightGrams',
      maxWeight: 'maxWeightGrams',
    }[field] as keyof Pick<
      MaterialForm,
      | 'innerLengthMm'
      | 'innerWidthMm'
      | 'innerHeightMm'
      | 'ratedOuterLengthMm'
      | 'ratedOuterWidthMm'
      | 'ratedOuterHeightMm'
      | 'tareWeightGrams'
      | 'maxWeightGrams'
    >
    let canonical = ''
    if (value.trim() && Number.isFinite(numeric) && numeric > 0) {
      canonical = String(
        (
          field === 'innerLength'
          || field === 'innerWidth'
          || field === 'innerHeight'
          || field === 'ratedOuterLength'
          || field === 'ratedOuterWidth'
          || field === 'ratedOuterHeight'
        )
          ? displayLengthToMillimeters(numeric, measurementSystem)
          : displayWeightToGrams(numeric, measurementSystem),
      )
    }
    setMaterialDraft((current) => ({ ...current, [canonicalField]: canonical }))
  }

  const materialMeasurementErrors = useMemo(() => {
    const activationRequired = editingMaterial?.status === 'active'
    const innerMeasurementsRequired = activationRequired
      || materialDraft.dimensionEvidenceType === 'measured'
    const validate = (
      displayValue: string,
      canonicalValue: string,
      label: string,
      required = activationRequired,
    ) => {
      const numeric = Number(displayValue)
      const canonical = Number(canonicalValue)
      if (!displayValue.trim()) {
        return required ? `${label} is required` : ''
      }
      if (!Number.isFinite(numeric) || numeric <= 0) {
        return `${label} must be greater than zero`
      }
      if (!Number.isSafeInteger(canonical) || canonical < 1) {
        return `${label} is below the supported 1 mm or 1 g precision`
      }
      return ''
    }
    const validateOptional = (
      displayValue: string,
      canonicalValue: string,
      label: string,
    ) => {
      if (!displayValue.trim()) return ''
      const numeric = Number(displayValue)
      const canonical = Number(canonicalValue)
      if (!Number.isFinite(numeric) || numeric <= 0) {
        return `${label} must be greater than zero`
      }
      if (!Number.isSafeInteger(canonical) || canonical < 1) {
        return `${label} is below the supported 1 mm precision`
      }
      return ''
    }
    const errors = {
      innerLength: validate(
        materialMeasurementDraft.innerLength,
        materialDraft.innerLengthMm,
        'Inner length',
        innerMeasurementsRequired,
      ),
      innerWidth: validate(
        materialMeasurementDraft.innerWidth,
        materialDraft.innerWidthMm,
        'Inner width',
        innerMeasurementsRequired,
      ),
      innerHeight: validate(
        materialMeasurementDraft.innerHeight,
        materialDraft.innerHeightMm,
        'Inner height',
        innerMeasurementsRequired,
      ),
      ratedOuterLength: validateOptional(
        materialMeasurementDraft.ratedOuterLength,
        materialDraft.ratedOuterLengthMm,
        'Rated outer length',
      ),
      ratedOuterWidth: validateOptional(
        materialMeasurementDraft.ratedOuterWidth,
        materialDraft.ratedOuterWidthMm,
        'Rated outer width',
      ),
      ratedOuterHeight: validateOptional(
        materialMeasurementDraft.ratedOuterHeight,
        materialDraft.ratedOuterHeightMm,
        'Rated outer height',
      ),
      tareWeight: validate(
        materialMeasurementDraft.tareWeight,
        materialDraft.tareWeightGrams,
        'Tare weight',
      ),
      maxWeight: validate(
        materialMeasurementDraft.maxWeight,
        materialDraft.maxWeightGrams,
        'Maximum weight',
      ),
    }
    if (
      !errors.tareWeight
      && !errors.maxWeight
      && materialDraft.tareWeightGrams
      && materialDraft.maxWeightGrams
      && Number(materialDraft.maxWeightGrams) <= Number(materialDraft.tareWeightGrams)
    ) {
      errors.maxWeight = 'Maximum weight must be greater than tare weight'
    }
    if (activationRequired && materialDraft.dimensionBasis !== 'inner') {
      errors.innerLength = 'Confirm usable inner dimensions before activation'
    }
    if (
      activationRequired
      && materialDraft.dimensionEvidenceType === 'unknown'
    ) {
      errors.innerWidth = 'Record the dimension evidence before activation'
    }
    const outerValues = [
      materialDraft.ratedOuterLengthMm,
      materialDraft.ratedOuterWidthMm,
      materialDraft.ratedOuterHeightMm,
    ]
    const hasAnyOuter = outerValues.some(Boolean)
    const hasAllOuter = outerValues.every(Boolean)
    if (hasAnyOuter && !hasAllOuter) {
      if (!materialDraft.ratedOuterLengthMm) {
        errors.ratedOuterLength = 'Complete all three rated outer dimensions'
      }
      if (!materialDraft.ratedOuterWidthMm) {
        errors.ratedOuterWidth = 'Complete all three rated outer dimensions'
      }
      if (!materialDraft.ratedOuterHeightMm) {
        errors.ratedOuterHeight = 'Complete all three rated outer dimensions'
      }
    }
    if (
      hasAllOuter
      && (
        !materialDraft.ratedOuterDimensionEvidenceType
        || (
          packagingDimensionEvidenceReferenceRequired(
            materialDraft.ratedOuterDimensionEvidenceType,
          )
          && !materialDraft.ratedOuterDimensionEvidenceReference.trim()
        )
      )
    ) {
      errors.ratedOuterLength =
        'Select evidence and retain its required reference'
    }
    return errors
  }, [editingMaterial?.status, materialDraft, materialMeasurementDraft])

  const materialMeasurementsValid = Object.values(
    materialMeasurementErrors,
  ).every((message) => !message)

  const saveMaterial = async (event: FormEvent) => {
    event.preventDefault()
    setMaterialSubmitted(true)
    if (!materialMeasurementsValid) return
    if (
      (
        ['customer_confirmed', 'provider'].includes(
          materialDraft.dimensionEvidenceType,
        )
        || (
          editingMaterial?.status === 'active'
          && packagingDimensionEvidenceReferenceRequired(
            materialDraft.dimensionEvidenceType,
          )
        )
      )
      && !materialDraft.dimensionEvidenceReference.trim()
    ) {
      setError('Provide the retained evidence reference for these dimensions')
      return
    }
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
          innerLengthMm: materialDraft.innerLengthMm.trim()
            ? Number(materialDraft.innerLengthMm)
            : null,
          innerWidthMm: materialDraft.innerWidthMm.trim()
            ? Number(materialDraft.innerWidthMm)
            : null,
          innerHeightMm: materialDraft.innerHeightMm.trim()
            ? Number(materialDraft.innerHeightMm)
            : null,
          ratedOuterLengthMm: materialDraft.ratedOuterLengthMm.trim()
            ? Number(materialDraft.ratedOuterLengthMm)
            : null,
          ratedOuterWidthMm: materialDraft.ratedOuterWidthMm.trim()
            ? Number(materialDraft.ratedOuterWidthMm)
            : null,
          ratedOuterHeightMm: materialDraft.ratedOuterHeightMm.trim()
            ? Number(materialDraft.ratedOuterHeightMm)
            : null,
          ratedOuterDimensionEvidenceType:
            materialDraft.ratedOuterDimensionEvidenceType || null,
          ratedOuterDimensionEvidenceReference:
            materialDraft.ratedOuterDimensionEvidenceReference.trim()
              || null,
          dimensionBasis: materialDraft.dimensionBasis,
          dimensionEvidenceType: materialDraft.dimensionEvidenceType,
          dimensionEvidenceReference:
            materialDraft.dimensionEvidenceReference.trim() || null,
          tareWeightGrams: materialDraft.tareWeightGrams.trim()
            ? Number(materialDraft.tareWeightGrams)
            : null,
          maxWeightGrams: materialDraft.maxWeightGrams.trim()
            ? Number(materialDraft.maxWeightGrams)
            : null,
          unitCostMinor: unitCost,
          currency: unitCost === null ? null : materialDraft.currency,
          status: editingMaterial?.status || 'draft',
          source: materialDraft.source,
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

  const openActivationSetup = (material: PackagingMaterial) => {
    const stockOnly = material.readiness.missing.every(
      (gap) => gap === 'warehouse_stock' || gap === 'available_stock',
    )
    if (stockOnly) {
      openStock(material)
      return
    }
    openEdit(material)
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
          ratedOuterLengthMm: material.ratedOuterDimensionsMm.length,
          ratedOuterWidthMm: material.ratedOuterDimensionsMm.width,
          ratedOuterHeightMm: material.ratedOuterDimensionsMm.height,
          ratedOuterDimensionEvidenceType:
            material.ratedOuterDimensionEvidenceType,
          ratedOuterDimensionEvidenceReference:
            material.ratedOuterDimensionEvidenceReference,
          dimensionBasis: material.dimensionBasis,
          dimensionEvidenceType: material.dimensionEvidenceType,
          dimensionEvidenceReference: material.dimensionEvidenceReference,
          tareWeightGrams: material.tareWeightGrams,
          maxWeightGrams: material.maxWeightGrams,
          unitCostMinor: material.unitCostMinor,
          currency: material.currency,
          status,
          source: material.source,
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
    const commandKey = starterCommandKey.current
      ?? `packaging-materials:starter-assortment:${globalThis.crypto.randomUUID()}`
    starterCommandKey.current = commandKey
    let terminalResponse = false
    try {
      const response = await fetch('/api/operations/packaging-materials', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': commandKey,
        },
        body: JSON.stringify({ action: 'create-starter-assortment' }),
      })
      terminalResponse = true
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
      if (terminalResponse) starterCommandKey.current = null
      setBusy(false)
    }
  }

  const previewShopifyPackages = async () => {
    setBusy(true)
    setError('')
    setImportPreview(undefined)
    try {
      const response = await fetch('/api/operations/packaging-materials/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'preview', csv: importCsv, accountGlobalId: '' }),
      })
      const payload = await response.json() as Payload
      if (!response.ok || !payload.preview) {
        throw new Error(payload.error || 'Shopify package CSV could not be previewed')
      }
      importCommandKey.current = null
      setImportPreview(payload.preview)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Shopify package CSV could not be previewed')
    } finally {
      setBusy(false)
    }
  }

  const applyShopifyPackages = async () => {
    if (!importPreview || !importAccountGlobalId) return
    setBusy(true)
    setError('')
    const commandKey = importCommandKey.current
      ?? `shopify-packages:${globalThis.crypto.randomUUID()}`
    importCommandKey.current = commandKey
    let terminalResponse = false
    try {
      const response = await fetch('/api/operations/packaging-materials/import', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': commandKey,
        },
        body: JSON.stringify({
          action: 'apply',
          accountGlobalId: importAccountGlobalId,
          csv: importCsv,
        }),
      })
      terminalResponse = true
      const payload = await response.json() as Payload
      if (!response.ok || payload.result?.totalCount === undefined) {
        throw new Error(payload.error || 'Shopify packages could not be imported')
      }
      setNotice(
        `${payload.result.totalCount} Shopify packages are available as drafts. `
        + `${payload.result.createdCount || 0} were added and ${payload.result.updatedCount || 0} were refreshed.`,
      )
      setImportOpen(false)
      setImportCsv('')
      setImportPreview(undefined)
      await load()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Shopify packages could not be imported')
    } finally {
      if (terminalResponse) importCommandKey.current = null
      setBusy(false)
    }
  }

  const confirmRemoveMaterial = async () => {
    if (!removeMaterial) return
    const removal = removeMaterial
    setBusy(true)
    setError('')
    try {
      const response = await fetch('/api/operations/packaging-materials', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': `remove-packaging:${removal.globalId}:v${removal.rowVersion}`,
        },
        body: JSON.stringify({
          action: 'remove-material',
          materialGlobalId: removal.globalId,
          expectedRowVersion: removal.rowVersion,
        }),
      })
      const payload = await response.json() as Payload
      if (!response.ok || !payload.result?.outcome) {
        throw new Error(payload.error || 'Packaging material could not be removed')
      }
      setNotice(
        payload.result.outcome === 'deleted'
          ? `${removal.name} was deleted.`
          : `${removal.name} was removed from use. Historical references were preserved.`,
      )
      setRemoveMaterial(null)
      await load()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Packaging material could not be removed')
    } finally {
      setBusy(false)
    }
  }

  const canManage = workspace?.capabilities.canManage === true
  const readiness = workspace?.optimizerReadiness

  return (
    <Box sx={{ px: { xs: 2, md: 3 }, py: 2.5, minWidth: 0 }}>
      <Stack spacing={2.5}>
        <Stack
          direction={{ xs: 'column', sm: 'row' }}
          justifyContent="space-between"
          alignItems={{ sm: 'flex-start' }}
          spacing={1.5}
        >
          <Box>
            <Typography variant="h6" fontWeight={750}>Cartons and mailers</Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
              Maintain the real materials available at each warehouse. Drafts are never
              offered to cartonization, and availability alone does not fabricate stock.
            </Typography>
          </Box>
          <Box sx={{ flexShrink: 0 }}>
            <ToggleButtonGroup
              exclusive
              size="small"
              value={measurementSystem}
              onChange={(_event, next: MeasurementSystem | null) => {
                changeLocalMeasurementSystem(next)
              }}
              aria-label="Packaging material measurement system"
            >
              <ToggleButton value="imperial">Imperial</ToggleButton>
              <ToggleButton value="metric">Metric</ToggleButton>
            </ToggleButtonGroup>
            <Typography
              variant="caption"
              color="text.secondary"
              display="block"
              sx={{ mt: 0.5, textAlign: { sm: 'right' } }}
            >
              {hasLocalMeasurementOverride
                ? 'Local display only · personal default unchanged'
                : measurementPreferenceSource === 'user'
                  ? 'Local display · starts from your preference'
                  : measurementPreferenceSource === 'organization'
                    ? 'Local display · starts from organization default'
                    : 'Local display · starts from system default'}
            </Typography>
          </Box>
        </Stack>

        {error && <Alert severity="error" onClose={() => setError('')}>{error}</Alert>}
        {measurementPreferenceError && (
          <Alert severity="warning">{measurementPreferenceError}</Alert>
        )}
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
            startIcon={<FileUploadRounded />}
            disabled={!canManage || busy || !(workspace?.shopifyPackageImport?.accounts.length)}
            onClick={() => {
              const first = workspace?.shopifyPackageImport?.accounts[0]
              setImportAccountGlobalId(first?.globalId || '')
              importCommandKey.current = null
              setImportOpen(true)
            }}
          >
            Import Shopify packages
          </Button>
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
                      {material.ratedOuterDimensionsMm.length !== null
                        && material.ratedOuterDimensionsMm.width !== null
                        && material.ratedOuterDimensionsMm.height !== null
                        && material.ratedOuterDimensionEvidenceType ? (
                        <Chip
                          size="small"
                          label="Checkout-rated dimensions"
                          color="secondary"
                          variant="outlined"
                        />
                      ) : null}
                      {material.shopifyImport?.isDefault ? (
                        <Chip size="small" label="Shopify default" color="primary" variant="outlined" />
                      ) : null}
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
                    <Typography variant="caption" color="text.secondary">
                      {material.dimensionBasis === 'inner'
                        ? 'Usable inner dimensions'
                        : material.dimensionBasis === 'outer'
                          ? 'Outer dimensions'
                          : 'Dimensions — basis unconfirmed'}
                    </Typography>
                    <Typography variant="body2">
                      {materialDimensions(material, measurementSystem)}
                    </Typography>
                    <Typography variant="caption" color="text.disabled" display="block">
                      {canonicalDimensions(material)} mm canonical
                    </Typography>
                    <Typography
                      variant="caption"
                      color="text.secondary"
                      display="block"
                      sx={{ mt: 0.5 }}
                    >
                      Rated outer: {ratedOuterDimensions(
                        material,
                        measurementSystem,
                      )}
                    </Typography>
                  </Box>
                  <Box>
                    <Typography variant="caption" color="text.secondary">Tare</Typography>
                    <Typography variant="body2">
                      {optionalWeight(material.tareWeightGrams, measurementSystem)}
                    </Typography>
                    <Typography variant="caption" color="text.disabled" display="block">
                      {material.tareWeightGrams === null
                        ? 'Required before activation'
                        : `${material.tareWeightGrams} g canonical`}
                    </Typography>
                  </Box>
                  <Box>
                    <Typography variant="caption" color="text.secondary">Maximum</Typography>
                    <Typography variant="body2">
                      {optionalWeight(material.maxWeightGrams, measurementSystem)}
                    </Typography>
                    <Typography variant="caption" color="text.disabled" display="block">
                      {material.maxWeightGrams === null
                        ? 'Required before activation'
                        : `${material.maxWeightGrams} g canonical`}
                    </Typography>
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

                <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ mt: 1.5 }}>
                  {material.status === 'draft' ? (
                    <Button
                      variant={material.readiness.missing.length > 0
                        ? 'outlined'
                        : 'contained'}
                      disabled={!canManage || busy}
                      onClick={() => {
                        if (material.readiness.missing.length > 0) {
                          openActivationSetup(material)
                          return
                        }
                        void changeStatus(material, 'active')
                      }}
                    >
                      {material.readiness.missing.length > 0
                        ? 'Finish setup'
                        : 'Activate material'}
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
                  <Button
                    variant="text"
                    color="error"
                    startIcon={<DeleteOutlineRounded />}
                    disabled={!canManage || busy}
                    onClick={() => setRemoveMaterial(material)}
                  >
                    Remove
                  </Button>
                  <Typography variant="caption" color="text.secondary" sx={{ alignSelf: 'center' }}>
                    {material.status === 'draft' && material.readiness.missing.length > 0
                      ? `Needed before activation: ${readinessGapSummary(material)}.`
                      : material.source === 'starter_assortment'
                        ? 'Starter specification — verify against the selected supplier.'
                        : material.source === 'customer_supplied'
                          ? 'Customer-supplied draft — verify basis, capacity, cost, and stock.'
                          : `${display(material.source)} specification.`}
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
                Record only the measurements the customer or supplier actually supplied.
                Incomplete facts remain a safe draft; ClawPilot will not invent envelope
                depth, tare, capacity, cost, or stock. Activation requires verified usable
                inner dimensions and every operating fact. Shopify checkout rating
                additionally requires evidenced outside dimensions because carriers rate
                the parcel exterior.
              </Alert>
              <Stack
                direction={{ xs: 'column', sm: 'row' }}
                alignItems={{ sm: 'center' }}
                justifyContent="space-between"
                spacing={1}
              >
                <Box>
                  <Typography fontWeight={700}>Physical measurements</Typography>
                  <Typography variant="caption" color="text.secondary">
                    Dimensions in {units.length}; weights in {units.weight}. Stored to
                    the nearest 1 mm and 1 g. This selector changes only this packaging
                    screen; your saved preference is unchanged.
                  </Typography>
                </Box>
                <ToggleButtonGroup
                  exclusive
                  size="small"
                  value={measurementSystem}
                  onChange={(_event, next: MeasurementSystem | null) => {
                    changeLocalMeasurementSystem(next)
                  }}
                  aria-label="Material editor measurement system"
                >
                  <ToggleButton value="imperial">Imperial</ToggleButton>
                  <ToggleButton value="metric">Metric</ToggleButton>
                </ToggleButtonGroup>
              </Stack>
              <Box
                sx={{
                  display: 'grid',
                  gridTemplateColumns: { xs: '1fr', sm: '1fr 2fr 1fr' },
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
                <TextField
                  select
                  label="Source"
                  value={materialDraft.source}
                  onChange={(event) => setMaterialDraft({
                    ...materialDraft,
                    source: event.target.value as PackagingMaterialSource,
                  })}
                  disabled={
                    editingMaterial?.source === 'starter_assortment'
                    || editingMaterial?.source === 'shopify_import'
                  }
                >
                  {materialSourceOptions.map((option) => (
                    <MenuItem key={option.value} value={option.value}>
                      {option.label}
                    </MenuItem>
                  ))}
                </TextField>
              </Box>
              <Box
                sx={{
                  display: 'grid',
                  gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr 2fr' },
                  gap: 1.5,
                }}
              >
                <TextField
                  select
                  label="Dimension basis"
                  value={materialDraft.dimensionBasis}
                  onChange={(event) => setMaterialDraft({
                    ...materialDraft,
                    dimensionBasis: event.target.value as PackagingDimensionBasis,
                  })}
                  helperText="Do not mark inner unless usable inside measurements are confirmed"
                >
                  {dimensionBasisOptions.map((option) => (
                    <MenuItem key={option.value} value={option.value}>
                      {option.label}
                    </MenuItem>
                  ))}
                </TextField>
                <TextField
                  select
                  label="Evidence"
                  value={materialDraft.dimensionEvidenceType}
                  onChange={(event) => setMaterialDraft({
                    ...materialDraft,
                    dimensionEvidenceType:
                      event.target.value as PackagingDimensionEvidenceType,
                  })}
                >
                  {evidenceTypeOptions.map((option) => (
                    <MenuItem key={option.value} value={option.value}>
                      {option.label}
                    </MenuItem>
                  ))}
                </TextField>
                <TextField
                  label="Evidence reference"
                  value={materialDraft.dimensionEvidenceReference}
                  onChange={(event) => setMaterialDraft({
                    ...materialDraft,
                    dimensionEvidenceReference: event.target.value,
                  })}
                  helperText={materialDraft.dimensionEvidenceType === 'measured'
                    ? 'Optional note; exact measurements retain the confirming actor and time automatically'
                    : 'Required for provider and customer-confirmed evidence, and before activation for legacy evidence'}
                  required={[
                    'customer_confirmed',
                    'provider',
                  ].includes(materialDraft.dimensionEvidenceType)
                    || (
                      editingMaterial?.status === 'active'
                      && packagingDimensionEvidenceReferenceRequired(
                        materialDraft.dimensionEvidenceType,
                      )
                    )}
                />
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
                  label={`Length (${units.length})`}
                  value={materialMeasurementDraft.innerLength}
                  onChange={(event) => updateMaterialMeasurement(
                    'innerLength',
                    event.target.value,
                  )}
                  inputProps={{
                    min: measurementSystem === 'imperial' ? 0.001 : 0.1,
                    step: measurementSystem === 'imperial' ? 0.001 : 0.1,
                  }}
                  error={materialSubmitted && Boolean(
                    materialMeasurementErrors.innerLength,
                  )}
                  helperText={materialSubmitted
                    ? materialMeasurementErrors.innerLength
                    : 'Leave blank if not supplied'}
                />
                <TextField
                  type="number"
                  label={`Width (${units.length})`}
                  value={materialMeasurementDraft.innerWidth}
                  onChange={(event) => updateMaterialMeasurement(
                    'innerWidth',
                    event.target.value,
                  )}
                  inputProps={{
                    min: measurementSystem === 'imperial' ? 0.001 : 0.1,
                    step: measurementSystem === 'imperial' ? 0.001 : 0.1,
                  }}
                  error={materialSubmitted && Boolean(
                    materialMeasurementErrors.innerWidth,
                  )}
                  helperText={materialSubmitted
                    ? materialMeasurementErrors.innerWidth
                    : 'Leave blank if not supplied'}
                />
                <TextField
                  type="number"
                  label={`Height / depth (${units.length})`}
                  value={materialMeasurementDraft.innerHeight}
                  onChange={(event) => updateMaterialMeasurement(
                    'innerHeight',
                    event.target.value,
                  )}
                  inputProps={{
                    min: measurementSystem === 'imperial' ? 0.001 : 0.1,
                    step: measurementSystem === 'imperial' ? 0.001 : 0.1,
                  }}
                  error={materialSubmitted && Boolean(
                    materialMeasurementErrors.innerHeight,
                  )}
                  helperText={materialSubmitted
                    ? materialMeasurementErrors.innerHeight
                    : 'Leave blank if not supplied'}
                />
                <TextField
                  type="number"
                  label={`Tare weight (${units.weight})`}
                  value={materialMeasurementDraft.tareWeight}
                  onChange={(event) => updateMaterialMeasurement(
                    'tareWeight',
                    event.target.value,
                  )}
                  inputProps={{ min: 0.001, step: 0.001 }}
                  error={materialSubmitted && Boolean(
                    materialMeasurementErrors.tareWeight,
                  )}
                  helperText={materialSubmitted
                    ? materialMeasurementErrors.tareWeight
                    : 'Leave blank if unknown'}
                />
                <TextField
                  type="number"
                  label={`Maximum weight (${units.weight})`}
                  value={materialMeasurementDraft.maxWeight}
                  onChange={(event) => updateMaterialMeasurement(
                    'maxWeight',
                    event.target.value,
                  )}
                  inputProps={{ min: 0.001, step: 0.001 }}
                  error={materialSubmitted && Boolean(
                    materialMeasurementErrors.maxWeight,
                  )}
                  helperText={materialSubmitted
                    ? materialMeasurementErrors.maxWeight
                    : 'Leave blank if unknown'}
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
              <Divider />
              <Box>
                <Typography fontWeight={700}>
                  Rated outer shipping dimensions
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  Optional for general storage, but required before this
                  material can be used for live checkout rating. Enter the
                  outside parcel dimensions the carrier will rate, not the
                  usable interior.
                </Typography>
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
                  label={`Outer length (${units.length})`}
                  value={materialMeasurementDraft.ratedOuterLength}
                  onChange={(event) => updateMaterialMeasurement(
                    'ratedOuterLength',
                    event.target.value,
                  )}
                  inputProps={{
                    min: measurementSystem === 'imperial' ? 0.001 : 0.1,
                    step: measurementSystem === 'imperial' ? 0.001 : 0.1,
                  }}
                  error={materialSubmitted && Boolean(
                    materialMeasurementErrors.ratedOuterLength,
                  )}
                  helperText={materialSubmitted
                    ? materialMeasurementErrors.ratedOuterLength
                    : 'Leave all three blank if not measured'}
                />
                <TextField
                  type="number"
                  label={`Outer width (${units.length})`}
                  value={materialMeasurementDraft.ratedOuterWidth}
                  onChange={(event) => updateMaterialMeasurement(
                    'ratedOuterWidth',
                    event.target.value,
                  )}
                  inputProps={{
                    min: measurementSystem === 'imperial' ? 0.001 : 0.1,
                    step: measurementSystem === 'imperial' ? 0.001 : 0.1,
                  }}
                  error={materialSubmitted && Boolean(
                    materialMeasurementErrors.ratedOuterWidth,
                  )}
                  helperText={materialSubmitted
                    ? materialMeasurementErrors.ratedOuterWidth
                    : 'Carrier-rated outside measurement'}
                />
                <TextField
                  type="number"
                  label={`Outer height (${units.length})`}
                  value={materialMeasurementDraft.ratedOuterHeight}
                  onChange={(event) => updateMaterialMeasurement(
                    'ratedOuterHeight',
                    event.target.value,
                  )}
                  inputProps={{
                    min: measurementSystem === 'imperial' ? 0.001 : 0.1,
                    step: measurementSystem === 'imperial' ? 0.001 : 0.1,
                  }}
                  error={materialSubmitted && Boolean(
                    materialMeasurementErrors.ratedOuterHeight,
                  )}
                  helperText={materialSubmitted
                    ? materialMeasurementErrors.ratedOuterHeight
                    : 'Carrier-rated outside measurement'}
                />
              </Box>
              <Box
                sx={{
                  display: 'grid',
                  gridTemplateColumns: { xs: '1fr', sm: '1fr 2fr' },
                  gap: 1.5,
                }}
              >
                <TextField
                  select
                  label="Outer-dimension evidence"
                  value={materialDraft.ratedOuterDimensionEvidenceType}
                  onChange={(event) => setMaterialDraft({
                    ...materialDraft,
                    ratedOuterDimensionEvidenceType:
                      event.target.value as MaterialForm[
                        'ratedOuterDimensionEvidenceType'
                      ],
                  })}
                  helperText="Required when rated outer dimensions are present"
                >
                  <MenuItem value="">Not recorded</MenuItem>
                  {evidenceTypeOptions
                    .filter((option) => option.value !== 'unknown')
                    .map((option) => (
                      <MenuItem key={option.value} value={option.value}>
                        {option.label}
                      </MenuItem>
                    ))}
                </TextField>
                <TextField
                  label="Outer-dimension evidence reference"
                  value={
                    materialDraft.ratedOuterDimensionEvidenceReference
                  }
                  onChange={(event) => setMaterialDraft({
                    ...materialDraft,
                    ratedOuterDimensionEvidenceReference:
                      event.target.value,
                  })}
                  helperText={
                    materialDraft.ratedOuterDimensionEvidenceType === 'measured'
                      ? 'Optional note; exact outer measurements retain the confirming actor and time automatically'
                      : 'Required for provider, customer-confirmed, and legacy evidence'
                  }
                  required={Boolean(
                    materialDraft.ratedOuterDimensionEvidenceType
                    && packagingDimensionEvidenceReferenceRequired(
                      materialDraft.ratedOuterDimensionEvidenceType,
                    )
                  )}
                />
              </Box>
              {materialMeasurementsValid && (
                materialDraft.innerLengthMm
                || materialDraft.innerWidthMm
                || materialDraft.innerHeightMm
                || materialDraft.tareWeightGrams
                || materialDraft.maxWeightGrams
              ) ? (
                <Alert severity="success" icon={false}>
                  Recorded canonical draft values:{' '}
                  {materialDraft.innerLengthMm || 'unknown'} ×{' '}
                  {materialDraft.innerWidthMm || 'unknown'} ×{' '}
                  {materialDraft.innerHeightMm || 'unknown'} mm · tare{' '}
                  {materialDraft.tareWeightGrams || 'unknown'} g · maximum{' '}
                  {materialDraft.maxWeightGrams || 'unknown'} g. Draft values do
                  not become optimizer eligible until all activation facts are complete.
                </Alert>
              ) : (
                <Typography variant="caption" color="text.secondary">
                  You may save an incomplete draft. Activation will show the exact
                  missing facts instead of substituting estimates.
                </Typography>
              )}
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
        open={importOpen}
        onClose={() => !busy && setImportOpen(false)}
        fullWidth
        maxWidth="md"
      >
        <DialogTitle>Import Shopify saved packages</DialogTitle>
        <DialogContent dividers>
          <Stack spacing={2}>
            <Alert severity="info">
              Shopify’s public Admin API currently exposes saved-package mutations but no supported package-list query. Export or transcribe the store package list into this template; ClawPilot performs no Shopify write and stages every row as a draft.
            </Alert>
            <TextField
              select
              label="Shopify connection"
              value={importAccountGlobalId}
              onChange={(event) => {
                setImportAccountGlobalId(event.target.value)
                importCommandKey.current = null
              }}
              required
            >
              {(workspace?.shopifyPackageImport?.accounts || []).map((account) => (
                <MenuItem key={account.globalId} value={account.globalId}>
                  {account.displayName} · {account.canonicalDomain}
                </MenuItem>
              ))}
            </TextField>
            <Button
              component="a"
              href="/api/operations/packaging-materials/import"
              variant="outlined"
              sx={{ alignSelf: 'flex-start' }}
            >
              Download CSV template
            </Button>
            <Button component="label" variant="outlined" sx={{ alignSelf: 'flex-start' }}>
              Choose completed CSV
              <input
                hidden
                type="file"
                accept=".csv,text/csv"
                onChange={(event) => {
                  const file = event.target.files?.[0]
                  if (!file) return
                  void file.text().then((csv) => {
                    setImportCsv(csv)
                    setImportPreview(undefined)
                    importCommandKey.current = null
                  })
                }}
              />
            </Button>
            {importCsv ? (
              <Typography variant="caption" color="text.secondary">
                {new Blob([importCsv]).size.toLocaleString()} bytes loaded
              </Typography>
            ) : null}
            {importPreview ? (
              <Stack spacing={1}>
                <Alert severity="warning">
                  {importPreview.totalCount} package{importPreview.totalCount === 1 ? '' : 's'} · {importPreview.defaultCount} default. Outer dimensions and empty weights are evidence only; verify inner capacity, cost, and stock before activation.
                </Alert>
                <Box sx={{ maxHeight: 280, overflow: 'auto' }}>
                  {importPreview.rows.map((row) => (
                    <Typography key={row.code} variant="body2" sx={{ py: 0.5 }}>
                      {row.code} · {row.name} · {row.shopifyType} · {row.ratedOuterLengthMm} × {row.ratedOuterWidthMm} × {row.ratedOuterHeightMm} mm · {row.tareWeightGrams} g{row.isDefault ? ' · default' : ''}
                    </Typography>
                  ))}
                </Box>
              </Stack>
            ) : null}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setImportOpen(false)} disabled={busy}>Cancel</Button>
          <Button
            onClick={() => void previewShopifyPackages()}
            disabled={busy || !importCsv}
          >
            Preview
          </Button>
          <Button
            variant="contained"
            onClick={() => void applyShopifyPackages()}
            disabled={busy || !importPreview || !importAccountGlobalId}
          >
            Import drafts
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog
        open={Boolean(removeMaterial)}
        onClose={() => !busy && setRemoveMaterial(null)}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>Remove packaging material?</DialogTitle>
        <DialogContent dividers>
          <Typography>
            {removeMaterial?.name} will disappear from the packaging catalog. Unused records are deleted; materials referenced by historical rates, recipes, or shipments are retired so audit evidence remains intact.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setRemoveMaterial(null)} disabled={busy}>Cancel</Button>
          <Button
            color="error"
            variant="contained"
            onClick={() => void confirmRemoveMaterial()}
            disabled={busy}
          >
            Remove material
          </Button>
        </DialogActions>
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
