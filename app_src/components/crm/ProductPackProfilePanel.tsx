'use client'

import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Divider,
  FormControlLabel,
  MenuItem,
  Stack,
  Switch,
  TextField,
  Typography,
} from '@mui/material'
import {
  AutorenewRounded,
  Inventory2Rounded,
  LinkRounded,
  ScaleRounded,
} from '@mui/icons-material'
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react'

type Dimensions = {
  length: number
  width: number
  height: number
}

type PackVersion = {
  globalId: string
  versionNumber: number
  lifecycleState: string
  baseEachQuantity: number
  unitOfMeasure: string
  dimensionsMm: Dimensions | null
  grossWeightGrams: number | null
  evidenceReference: string | null
  isCurrent: boolean
  rowVersion: number
}

type PackProfile = {
  globalId: string
  profileKey: string
  profileName: string
  packageLevel: string
  isDefault: boolean
  status: string
  rowVersion: number
  versions: PackVersion[]
}

type ChannelState = {
  globalId: string
  accountGlobalId: string
  provider: 'shopify' | 'faire'
  environment: string
  accountStatus: string
  credentialVerificationStatus: string | null
  externalProductId: string
  externalVariantId: string
  normalizedStatus: string
  sourceRevision: string
  sourceHash: string
  requiresShipping: boolean | null
  weightGrams: number | null
  rowVersion: number
}

type PackMapping = {
  globalId: string
  provider: 'shopify' | 'faire'
  channelStateGlobalId: string
  profileVersionGlobalId: string
  purpose: 'catalog' | 'shopify_checkout'
  projectionState: string
  isCurrent: boolean
  rowVersion: number
}

type PackagingMaterial = {
  globalId: string
  name: string
  status: 'draft' | 'active'
  innerDimensionsMm: Dimensions | null
  ratedOuterDimensionsMm: Dimensions | null
  rowVersion: number
}

type PackRecipe = {
  globalId: string
  recipeKey: string
  recipeName: string
  inputProfileVersionGlobalId: string
  outputProfileVersionGlobalId: string
  packagingMaterialGlobalId: string
  inputQuantity: number
  recipeType: 'exact_case' | 'max_capacity' | 'ship_ready_unit'
  minimumInputQuantity: number | null
  lifecycleState: string
  isCurrent: boolean
  rowVersion: number
}

type ProductPackState = {
  product: {
    globalId: string
    name: string
  }
  profiles: PackProfile[]
  channelStates: ChannelState[]
  mappings: PackMapping[]
  packagingMaterials: PackagingMaterial[]
  recipes: PackRecipe[]
}

type ProductPackPayload = {
  ok?: boolean
  error?: string
  code?: string
  capabilities?: {
    canManage?: boolean
  }
  productPack?: ProductPackState
}

type ProfileForm = {
  kind: 'each' | 'case'
  lifecycleState: 'draft' | 'active'
  weightBasis: 'measured' | 'provider' | 'customer_stated'
  profileKey: string
  profileName: string
  baseEachQuantity: string
  length: string
  width: string
  height: string
  grossWeight: string
  evidenceReference: string
}

const API_PATH = '/api/operations/product-pack-profiles'

function commandKey(prefix: string) {
  const entropy = globalThis.crypto?.randomUUID?.()
    || `${Date.now()}-${Math.random().toString(16).slice(2)}`
  return `${prefix}:${entropy}`
}

function positiveNumber(value: string, label: string) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${label} must be greater than zero`)
  }
  return parsed
}

function rounded(value: number, places = 3) {
  const scale = 10 ** places
  return String(Math.round(value * scale) / scale)
}

function dimensionsLabel(dimensions: Dimensions | null) {
  if (!dimensions) return 'Dimensions incomplete'
  return `${rounded(dimensions.length / 25.4, 2)} × ${
    rounded(dimensions.width / 25.4, 2)
  } × ${rounded(dimensions.height / 25.4, 2)} in`
}

function currentVersion(profile: PackProfile) {
  return profile.versions.find((version) => version.isCurrent) || null
}

function profileVersionLabel(
  profile: PackProfile,
  version: PackVersion,
) {
  return `${profile.profileName} · v${version.versionNumber} · ${
    version.baseEachQuantity
  } each · ${dimensionsLabel(version.dimensionsMm)}`
}

function profileDefaults(productName: string): ProfileForm {
  return {
    kind: 'each',
    lifecycleState: 'draft',
    weightBasis: 'measured',
    profileKey: 'each',
    profileName: `${productName} each`,
    baseEachQuantity: '1',
    length: '',
    width: '',
    height: '',
    grossWeight: '',
    evidenceReference: '',
  }
}

export default function ProductPackProfilePanel({
  productGlobalId,
}: {
  productGlobalId: string
}) {
  const [state, setState] = useState<ProductPackState | null>(null)
  const [canManage, setCanManage] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [metric, setMetric] = useState(false)
  const [form, setForm] = useState<ProfileForm>(
    profileDefaults('Product'),
  )
  const [channelStateGlobalId, setChannelStateGlobalId] = useState('')
  const [
    providerWeightChannelStateGlobalId,
    setProviderWeightChannelStateGlobalId,
  ] = useState('')
  const [mappingProfileVersionGlobalId, setMappingProfileVersionGlobalId] =
    useState('')
  const [mappingPurpose, setMappingPurpose] =
    useState<'catalog' | 'shopify_checkout'>('catalog')
  const [recipeInputVersionGlobalId, setRecipeInputVersionGlobalId] =
    useState('')
  const [recipeOutputVersionGlobalId, setRecipeOutputVersionGlobalId] =
    useState('')
  const [recipeMaterialGlobalId, setRecipeMaterialGlobalId] = useState('')
  const [recipeQuantity, setRecipeQuantity] = useState('12')
  const [recipeEvidence, setRecipeEvidence] = useState('')
  const [looseEachMaximum, setLooseEachMaximum] = useState('12')
  const [looseEachEvidence, setLooseEachEvidence] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const response = await fetch(
        `${API_PATH}?productGlobalId=${encodeURIComponent(productGlobalId)}`,
        {
          cache: 'no-store',
          credentials: 'same-origin',
          headers: { Accept: 'application/json' },
        },
      )
      const payload = await response.json() as ProductPackPayload
      if (!response.ok || payload.ok !== true || !payload.productPack) {
        throw new Error(payload.error || 'Product pack profiles did not load')
      }
      setState(payload.productPack)
      setCanManage(payload.capabilities?.canManage === true)
      setForm((current) => (
        current.profileName === 'Product each'
          ? profileDefaults(payload.productPack?.product.name || 'Product')
          : current
      ))
      const firstChannel = payload.productPack.channelStates[0]
      const activeVersions = payload.productPack.profiles
        .flatMap((profile) => profile.versions.map((version) => ({
          profile,
          version,
        })))
        .filter(({ version }) => (
          version.isCurrent && version.lifecycleState === 'active'
        ))
      const each = activeVersions.find(({ profile }) => (
        profile.packageLevel === 'each'
      ))
      const casePack = activeVersions.find(({ profile }) => (
        profile.packageLevel === 'case'
      ))
      const firstMaterial = payload.productPack.packagingMaterials.find(
        (material) => material.status === 'active',
      )
      if (firstChannel) {
        setChannelStateGlobalId((value) => value || firstChannel.globalId)
        setProviderWeightChannelStateGlobalId(
          (value) => value || firstChannel.globalId,
        )
      }
      if (each) {
        setMappingProfileVersionGlobalId((value) => (
          value || each.version.globalId
        ))
        setRecipeInputVersionGlobalId((value) => (
          value || each.version.globalId
        ))
      }
      if (casePack) {
        setRecipeOutputVersionGlobalId((value) => (
          value || casePack.version.globalId
        ))
      }
      if (firstMaterial) {
        setRecipeMaterialGlobalId((value) => (
          value || firstMaterial.globalId
        ))
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Product pack profiles did not load')
    } finally {
      setLoading(false)
    }
  }, [productGlobalId])

  useEffect(() => {
    void load()
  }, [load])

  const activeVersions = useMemo(() => (
    (state?.profiles || [])
      .flatMap((profile) => profile.versions.map((version) => ({
        profile,
        version,
      })))
      .filter(({ version }) => (
        version.isCurrent && version.lifecycleState === 'active'
      ))
  ), [state])

  async function post(body: Record<string, unknown>, prefix: string) {
    const response = await fetch(API_PATH, {
      method: 'POST',
      cache: 'no-store',
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'Idempotency-Key': commandKey(prefix),
      },
      body: JSON.stringify(body),
    })
    const payload = await response.json() as ProductPackPayload
    if (!response.ok || payload.ok !== true) {
      throw new Error(payload.error || 'Product pack command failed')
    }
  }

  async function saveProfile() {
    if (!state) return
    setSaving(true)
    setError('')
    setNotice('')
    try {
      const length = positiveNumber(form.length, 'Length')
      const width = positiveNumber(form.width, 'Width')
      const height = positiveNumber(form.height, 'Height')
      const providerWeightState = state.channelStates.find(
        (channel) => (
          channel.globalId === providerWeightChannelStateGlobalId
        ),
      )
      const providerWeight = form.weightBasis === 'provider'
        ? providerWeightState?.weightGrams ?? null
        : null
      const manualGrossWeight = form.grossWeight.trim()
        ? positiveNumber(form.grossWeight, 'Gross weight')
        : null
      if (
        form.weightBasis === 'provider'
        && (
          !providerWeightState
          || !Number.isSafeInteger(providerWeight)
          || Number(providerWeight) < 1
        )
      ) {
        throw new Error(
          'Choose a sales-channel variant with a positive retained shipping weight',
        )
      }
      if (
        form.lifecycleState === 'active'
        && form.weightBasis !== 'provider'
        && manualGrossWeight === null
      ) {
        throw new Error(
          'Active profiles require a measured or customer-confirmed gross shipping weight',
        )
      }
      const baseEachQuantity = Number(form.baseEachQuantity)
      if (!Number.isSafeInteger(baseEachQuantity) || baseEachQuantity < 1) {
        throw new Error('Base-each quantity must be a positive whole number')
      }
      if (
        form.lifecycleState === 'active'
        && !form.evidenceReference.trim()
      ) {
        throw new Error(
          'Active profiles require dimension and gross-weight evidence',
        )
      }
      const existing = state.profiles.find(
        (profile) => profile.profileKey === form.profileKey.trim(),
      )
      const existingVersion = existing
        ? currentVersion(existing)
        : null
      await post({
        action: 'save-profile-version',
        productGlobalId,
        profileGlobalId: existing?.globalId || null,
        expectedProfileRowVersion: existing?.rowVersion ?? null,
        expectedCurrentVersionGlobalId: existingVersion?.globalId || null,
        expectedCurrentVersionRowVersion:
          existingVersion?.rowVersion ?? null,
        profileKey: form.profileKey.trim(),
        profileName: form.profileName.trim(),
        packageLevel: form.kind,
        isDefault: form.kind === 'each',
        profileStatus: form.lifecycleState,
        lifecycleState: form.lifecycleState,
        baseEachQuantity,
        unitOfMeasure: form.kind,
        dimensionsMm: {
          length: Math.round(metric ? length * 10 : length * 25.4),
          width: Math.round(metric ? width * 10 : width * 25.4),
          height: Math.round(metric ? height * 10 : height * 25.4),
        },
        dimensionBasis: 'outer',
        grossWeightGrams: providerWeight ?? (
          manualGrossWeight === null
            ? null
            : Math.round(
                metric
                  ? manualGrossWeight
                  : manualGrossWeight * 28.349523125,
              )
        ),
        weightBasis: providerWeight !== null
          ? 'provider'
          : manualGrossWeight === null
            ? 'unspecified'
            : form.weightBasis,
        fitModel: 'rigid_3d',
        shipsAsOwnPackage: form.kind === 'case',
        assemblyPolicy: form.kind === 'case'
          ? 'allow_from_child'
          : 'never',
        evidenceType: providerWeight !== null
          ? 'provider'
          : form.evidenceReference.trim()
            ? form.weightBasis === 'measured'
              ? 'measured'
              : 'customer_confirmed'
            : 'unknown',
        evidenceReference: form.evidenceReference.trim() || null,
        source: providerWeight !== null
          ? 'provider_sync'
          : 'customer_supplied',
        providerWeightEvidence: providerWeightState && providerWeight !== null
          ? {
              channelStateGlobalId: providerWeightState.globalId,
              expectedChannelStateRowVersion: providerWeightState.rowVersion,
            }
          : null,
      }, 'product-pack-profile')
      setNotice(
        `${form.profileName.trim()} saved as a versioned ${
          form.lifecycleState
        } profile.`,
      )
      await load()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Profile save failed')
    } finally {
      setSaving(false)
    }
  }

  async function saveMapping() {
    if (!state) return
    const channel = state.channelStates.find(
      (candidate) => candidate.globalId === channelStateGlobalId,
    )
    const selected = activeVersions.find(
      ({ version }) => (
        version.globalId === mappingProfileVersionGlobalId
      ),
    )
    if (!channel || !selected) {
      setError('Choose an exact channel variant and active pack profile')
      return
    }
    const existing = state.mappings.find((mapping) => (
      mapping.isCurrent
      && mapping.channelStateGlobalId === channel.globalId
      && mapping.purpose === mappingPurpose
    ))
    setSaving(true)
    setError('')
    setNotice('')
    try {
      await post({
        action: 'save-variant-mapping',
        productGlobalId,
        channelStateGlobalId: channel.globalId,
        expectedChannelStateRowVersion: channel.rowVersion,
        profileVersionGlobalId: selected.version.globalId,
        expectedProfileVersionRowVersion: selected.version.rowVersion,
        expectedCurrentMappingGlobalId: existing?.globalId || null,
        expectedCurrentMappingRowVersion: existing?.rowVersion ?? null,
        purpose: mappingPurpose,
      }, 'product-pack-mapping')
      setNotice('The exact sales-channel variant is now mapped to this pack profile.')
      await load()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Mapping save failed')
    } finally {
      setSaving(false)
    }
  }

  async function saveExactCaseRecipe() {
    if (!state) return
    const input = activeVersions.find(
      ({ version }) => version.globalId === recipeInputVersionGlobalId,
    )
    const output = activeVersions.find(
      ({ version }) => version.globalId === recipeOutputVersionGlobalId,
    )
    const material = state.packagingMaterials.find(
      (candidate) => candidate.globalId === recipeMaterialGlobalId,
    )
    const quantity = Number(recipeQuantity)
    if (
      !input
      || !output
      || !material
      || !Number.isSafeInteger(quantity)
      || quantity < 2
    ) {
      setError('Choose each/case profiles, a package, and a valid case quantity')
      return
    }
    if (!recipeEvidence.trim()) {
      setError('Enter the customer-confirmed case-fit evidence')
      return
    }
    const recipeKey = `case-${quantity}`
    const existing = state.recipes.find((recipe) => (
      recipe.isCurrent && recipe.recipeKey === recipeKey
    ))
    setSaving(true)
    setError('')
    setNotice('')
    try {
      await post({
        action: 'save-approved-recipe',
        productGlobalId,
        recipeGlobalId: existing?.globalId || null,
        expectedRecipeRowVersion: existing?.rowVersion ?? null,
        recipeKey,
        recipeName: `Case of ${quantity}`,
        inputProfileVersionGlobalId: input.version.globalId,
        expectedInputProfileVersionRowVersion: input.version.rowVersion,
        outputProfileVersionGlobalId: output.version.globalId,
        expectedOutputProfileVersionRowVersion: output.version.rowVersion,
        packagingMaterialGlobalId: material.globalId,
        expectedPackagingMaterialRowVersion: material.rowVersion,
        inputQuantity: quantity,
        outputQuantity: 1,
        packagingMaterialQuantity: 1,
        recipeType: 'exact_case',
        minimumInputQuantity: null,
        contentCompatibilityKey: null,
        allowsMixedProducts: false,
        fulfillmentPolicy: 'prefer_full_case',
        remainderPolicy: 'case_plus_each',
        inventoryEvidenceRequirement: 'either',
        assemblyPolicy: 'allowed',
        exclusiveContents: true,
        lifecycleState: 'active',
        fitEvidenceType: 'customer_confirmed',
        fitEvidenceReference: recipeEvidence.trim(),
        source: 'customer_supplied',
      }, 'product-pack-recipe')
      setNotice('The exact case conversion and package fit are now versioned and active.')
      await load()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Recipe save failed')
    } finally {
      setSaving(false)
    }
  }

  async function saveLooseEachRecipe() {
    if (!state) return
    const input = activeVersions.find(
      ({ version }) => version.globalId === recipeInputVersionGlobalId,
    )
    const output = activeVersions.find(
      ({ version }) => version.globalId === recipeOutputVersionGlobalId,
    )
    const material = state.packagingMaterials.find(
      (candidate) => candidate.globalId === recipeMaterialGlobalId,
    )
    const maximum = Number(looseEachMaximum)
    if (
      !input
      || !output
      || !material
      || !Number.isSafeInteger(maximum)
      || maximum < 1
    ) {
      setError(
        'Choose each/case profiles, a package, and a positive loose-each maximum',
      )
      return
    }
    if (!looseEachEvidence.trim()) {
      setError(
        `Enter evidence confirming that 1 through ${maximum} eaches fit safely`,
      )
      return
    }
    const recipeKey = 'loose-each-carton'
    const existing = state.recipes.find((recipe) => (
      recipe.isCurrent && recipe.recipeKey === recipeKey
    ))
    setSaving(true)
    setError('')
    setNotice('')
    try {
      await post({
        action: 'save-approved-recipe',
        productGlobalId,
        recipeGlobalId: existing?.globalId || null,
        expectedRecipeRowVersion: existing?.rowVersion ?? null,
        recipeKey,
        recipeName: `Loose each carton (1 through ${maximum})`,
        inputProfileVersionGlobalId: input.version.globalId,
        expectedInputProfileVersionRowVersion: input.version.rowVersion,
        outputProfileVersionGlobalId: output.version.globalId,
        expectedOutputProfileVersionRowVersion: output.version.rowVersion,
        packagingMaterialGlobalId: material.globalId,
        expectedPackagingMaterialRowVersion: material.rowVersion,
        inputQuantity: maximum,
        outputQuantity: 1,
        packagingMaterialQuantity: 1,
        recipeType: 'max_capacity',
        minimumInputQuantity: 1,
        contentCompatibilityKey: null,
        allowsMixedProducts: false,
        fulfillmentPolicy: 'each_pick_only',
        remainderPolicy: 'all_each',
        inventoryEvidenceRequirement: 'each_assembly_allowed',
        assemblyPolicy: 'required',
        exclusiveContents: true,
        lifecycleState: 'active',
        fitEvidenceType: 'customer_confirmed',
        fitEvidenceReference: looseEachEvidence.trim(),
        source: 'customer_supplied',
      }, 'product-pack-loose-each-recipe')
      setNotice(
        `The evidenced 1-through-${maximum} loose-each carton rule is active.`,
      )
      await load()
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : 'Loose-each rule save failed',
      )
    } finally {
      setSaving(false)
    }
  }

  function applySixOunceEach() {
    const name = state?.product.name || 'Product'
    setMetric(false)
    setForm({
      kind: 'each',
      lifecycleState: 'draft',
      weightBasis: 'measured',
      profileKey: 'each',
      profileName: `${name} each`,
      baseEachQuantity: '1',
      length: '8',
      width: '6',
      height: '2',
      grossWeight: '',
      evidenceReference:
        'Customer specification: 6 oz net-content bag, 8 × 6 × 2 in. Gross shipping weight is not yet supplied.',
    })
  }

  function applyCaseOfTwelve() {
    const name = state?.product.name || 'Product'
    setMetric(false)
    setForm({
      kind: 'case',
      lifecycleState: 'draft',
      weightBasis: 'measured',
      profileKey: 'case-12',
      profileName: `${name} case of 12`,
      baseEachQuantity: '12',
      length: '11',
      width: '9',
      height: '7',
      grossWeight: '',
      evidenceReference:
        'Customer specification: 12 × 6 oz net-content bags in AG12V2, 11 × 9 × 7 in. Gross shipping weight is not yet supplied.',
    })
    setRecipeQuantity('12')
    setLooseEachMaximum('12')
    setLooseEachEvidence('')
    setRecipeEvidence(
      'Customer confirmed that one AG12V2 contains exactly 12 of the 6 oz bags.',
    )
  }

  function toggleMetric(nextMetric: boolean) {
    if (nextMetric === metric) return
    const convert = (value: string, multiplier: number) => {
      const parsed = Number(value)
      return Number.isFinite(parsed) && parsed > 0
        ? rounded(parsed * multiplier)
        : value
    }
    setForm((current) => ({
      ...current,
      length: convert(current.length, nextMetric ? 2.54 : 1 / 2.54),
      width: convert(current.width, nextMetric ? 2.54 : 1 / 2.54),
      height: convert(current.height, nextMetric ? 2.54 : 1 / 2.54),
      grossWeight: convert(
        current.grossWeight,
        nextMetric ? 28.349523125 : 1 / 28.349523125,
      ),
    }))
    setMetric(nextMetric)
  }

  if (loading) {
    return (
      <Stack direction="row" gap={1} alignItems="center">
        <CircularProgress size={18} />
        <Typography variant="body2">
          Loading pack profiles…
        </Typography>
      </Stack>
    )
  }

  if (!state) {
    return (
      <Alert
        severity="warning"
        action={(
          <Button color="inherit" size="small" onClick={() => void load()}>
            Retry
          </Button>
        )}
      >
        {error || 'Product pack profiles are unavailable.'}
      </Alert>
    )
  }

  return (
    <Stack spacing={2}>
      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        justifyContent="space-between"
        alignItems={{ sm: 'center' }}
        gap={1}
      >
        <Box>
          <Stack direction="row" gap={1} alignItems="center">
            <Inventory2Rounded color="primary" />
            <Typography variant="subtitle2" fontWeight={700}>
              Packaging and sales-channel pack rules
            </Typography>
          </Stack>
          <Typography variant="caption" color="text.secondary">
            Version the sellable each and case, then map the exact provider
            variant and approve its case conversion.
          </Typography>
        </Box>
        <Stack direction="row" gap={0.75} flexWrap="wrap">
          <Chip size="small" label={`${state.profiles.length} profiles`} />
          <Chip size="small" label={`${state.mappings.filter((mapping) => mapping.isCurrent).length} mappings`} />
          <Chip size="small" label={`${state.recipes.filter((recipe) => recipe.isCurrent).length} recipes`} />
        </Stack>
      </Stack>

      {error ? <Alert severity="error">{error}</Alert> : null}
      {notice ? <Alert severity="success">{notice}</Alert> : null}
      {!canManage ? (
        <Alert severity="info">
          You can review these records, but Operations manager permission is
          required to change them.
        </Alert>
      ) : null}

      {state.profiles.length ? (
        <Stack spacing={0.75}>
          {state.profiles.map((profile) => {
            const version = currentVersion(profile)
            return (
              <Box
                key={profile.globalId}
                sx={{
                  border: '1px solid',
                  borderColor: 'divider',
                  borderRadius: 1,
                  p: 1.25,
                }}
              >
                <Stack
                  direction="row"
                  gap={0.75}
                  alignItems="center"
                  flexWrap="wrap"
                >
                  <Typography variant="body2" fontWeight={700}>
                    {profile.profileName}
                  </Typography>
                  <Chip size="small" label={profile.packageLevel} />
                  <Chip
                    size="small"
                    color={profile.status === 'active' ? 'success' : 'default'}
                    label={profile.status}
                  />
                </Stack>
                <Typography variant="caption" color="text.secondary">
                  {version
                    ? `v${version.versionNumber} · ${version.baseEachQuantity} base each · ${dimensionsLabel(version.dimensionsMm)} · ${
                      version.grossWeightGrams === null
                        ? 'weight incomplete'
                        : `${version.grossWeightGrams} g gross`
                    }`
                    : 'No current version'}
                </Typography>
              </Box>
            )
          })}
        </Stack>
      ) : (
        <Alert severity="warning">
          No product pack profile exists. Cartonization and checkout rating
          must remain blocked until an evidenced active profile is saved.
        </Alert>
      )}

      <Divider />
      <Box>
        <Typography variant="overline" color="text.secondary">
          Step 1 · Define the sellable pack
        </Typography>
        <Stack
          direction={{ xs: 'column', sm: 'row' }}
          gap={1}
          sx={{ mt: 0.5 }}
        >
          <Button
            variant="outlined"
            size="small"
            onClick={applySixOunceEach}
            disabled={!canManage || saving}
          >
            Use 6 oz bag template
          </Button>
          <Button
            variant="outlined"
            size="small"
            onClick={applyCaseOfTwelve}
            disabled={!canManage || saving}
          >
            Use case-of-12 template
          </Button>
          <FormControlLabel
            control={(
              <Switch
                checked={metric}
                onChange={(event) => toggleMetric(event.target.checked)}
              />
            )}
            label={metric ? 'Metric · cm / g' : 'Imperial · in / oz'}
          />
        </Stack>
      </Box>
      <Stack direction={{ xs: 'column', sm: 'row' }} gap={1.5}>
        <TextField
          select
          fullWidth
          label="Pack level"
          value={form.kind}
          disabled={!canManage || saving}
          onChange={(event) => setForm((current) => ({
            ...current,
            kind: event.target.value as 'each' | 'case',
          }))}
        >
          <MenuItem value="each">Each / unit</MenuItem>
          <MenuItem value="case">Case pack</MenuItem>
        </TextField>
        <TextField
          select
          fullWidth
          label="Profile state"
          value={form.lifecycleState}
          disabled={!canManage || saving}
          onChange={(event) => setForm((current) => ({
            ...current,
            lifecycleState: event.target.value as 'draft' | 'active',
          }))}
          helperText="Draft facts cannot drive cartonization or checkout."
        >
          <MenuItem value="draft">Draft / incomplete</MenuItem>
          <MenuItem value="active">Active / evidenced</MenuItem>
        </TextField>
        <TextField
          fullWidth
          label="Stable profile key"
          value={form.profileKey}
          disabled={!canManage || saving}
          onChange={(event) => setForm((current) => ({
            ...current,
            profileKey: event.target.value,
          }))}
        />
        <TextField
          fullWidth
          label="Base each quantity"
          type="number"
          value={form.baseEachQuantity}
          disabled={!canManage || saving}
          onChange={(event) => setForm((current) => ({
            ...current,
            baseEachQuantity: event.target.value,
          }))}
        />
      </Stack>
      <TextField
        fullWidth
        label="Profile name"
        value={form.profileName}
        disabled={!canManage || saving}
        onChange={(event) => setForm((current) => ({
          ...current,
          profileName: event.target.value,
        }))}
      />
      <Stack direction={{ xs: 'column', sm: 'row' }} gap={1.5}>
        <TextField
          select
          fullWidth
          label="Gross-weight evidence"
          value={form.weightBasis}
          disabled={!canManage || saving}
          onChange={(event) => setForm((current) => ({
            ...current,
            weightBasis: event.target.value as ProfileForm['weightBasis'],
          }))}
        >
          <MenuItem value="measured">Measured on a scale</MenuItem>
          <MenuItem value="customer_stated">Customer-confirmed gross</MenuItem>
          <MenuItem value="provider">Sales-channel shipping weight</MenuItem>
        </TextField>
        {form.weightBasis === 'provider' ? (
          <TextField
            select
            fullWidth
            label="Provider weight revision"
            value={providerWeightChannelStateGlobalId}
            disabled={!canManage || saving}
            onChange={(event) => {
              setProviderWeightChannelStateGlobalId(event.target.value)
            }}
            helperText="The exact retained variant revision and weight are locked as evidence."
          >
            {state.channelStates.map((channel) => (
              <MenuItem
                key={channel.globalId}
                value={channel.globalId}
                disabled={
                  channel.weightGrams === null
                  || channel.weightGrams < 1
                }
              >
                {channel.provider.toUpperCase()} · {channel.externalVariantId}
                {' · '}
                {channel.weightGrams === null
                  ? 'weight unavailable'
                  : `${channel.weightGrams} g`}
              </MenuItem>
            ))}
          </TextField>
        ) : null}
      </Stack>
      <Stack direction={{ xs: 'column', sm: 'row' }} gap={1.5}>
        {(['length', 'width', 'height'] as const).map((field) => (
          <TextField
            key={field}
            fullWidth
            label={`${field[0].toUpperCase()}${field.slice(1)} (${metric ? 'cm' : 'in'})`}
            type="number"
            value={form[field]}
            disabled={!canManage || saving}
            onChange={(event) => setForm((current) => ({
              ...current,
              [field]: event.target.value,
            }))}
          />
        ))}
        <TextField
          fullWidth
          label={`Gross weight (${metric ? 'g' : 'oz'})`}
          type="number"
          value={
            form.weightBasis === 'provider'
              ? (() => {
                  const grams = state.channelStates.find(
                    (channel) => (
                      channel.globalId
                      === providerWeightChannelStateGlobalId
                    ),
                  )?.weightGrams
                  if (grams === null || grams === undefined) return ''
                  return metric
                    ? String(grams)
                    : rounded(grams / 28.349523125)
                })()
              : form.grossWeight
          }
          disabled={!canManage || saving || form.weightBasis === 'provider'}
          onChange={(event) => setForm((current) => ({
            ...current,
            grossWeight: event.target.value,
          }))}
          helperText={
            form.weightBasis === 'provider'
              ? 'Read from the retained sales-channel revision.'
              : 'Use packaged gross shipping weight, not net contents.'
          }
        />
      </Stack>
      <TextField
        fullWidth
        multiline
        minRows={2}
        label="Dimension and gross-weight evidence"
        value={form.evidenceReference}
        disabled={!canManage || saving}
        onChange={(event) => setForm((current) => ({
          ...current,
          evidenceReference: event.target.value,
        }))}
        helperText={
          form.lifecycleState === 'active'
            ? 'Active profiles require exact source evidence; nominal net contents are not gross shipping weight.'
            : 'Draft preserves incomplete dimensions without making them eligible for rating.'
        }
      />
      <Button
        variant="contained"
        startIcon={saving ? <CircularProgress size={16} /> : <ScaleRounded />}
        disabled={!canManage || saving}
        onClick={() => void saveProfile()}
        sx={{ alignSelf: 'flex-start' }}
      >
        Save versioned pack profile
      </Button>

      <Divider />
      <Box>
        <Typography variant="overline" color="text.secondary">
          Step 2 · Map the exact sales-channel variant
        </Typography>
        <Typography variant="body2">
          Mapping is variant-specific. It does not duplicate the ClawPilot
          product and it is invalidated if provider or pack evidence changes.
        </Typography>
      </Box>
      {state.channelStates.length ? (
        <>
          <TextField
            select
            fullWidth
            label="Sales-channel variant"
            value={channelStateGlobalId}
            disabled={!canManage || saving}
            onChange={(event) => setChannelStateGlobalId(event.target.value)}
          >
            {state.channelStates.map((channel) => (
              <MenuItem key={channel.globalId} value={channel.globalId}>
                {channel.provider.toUpperCase()} · {channel.environment} · {channel.externalVariantId} · {channel.normalizedStatus}
              </MenuItem>
            ))}
          </TextField>
          <Stack direction={{ xs: 'column', sm: 'row' }} gap={1.5}>
            <TextField
              select
              fullWidth
              label="Active pack profile"
              value={mappingProfileVersionGlobalId}
              disabled={!canManage || saving}
              onChange={(event) => setMappingProfileVersionGlobalId(event.target.value)}
            >
              {activeVersions.map(({ profile, version }) => (
                <MenuItem key={version.globalId} value={version.globalId}>
                  {profileVersionLabel(profile, version)}
                </MenuItem>
              ))}
            </TextField>
            <TextField
              select
              fullWidth
              label="Mapping purpose"
              value={mappingPurpose}
              disabled={!canManage || saving}
              onChange={(event) => setMappingPurpose(
                event.target.value as 'catalog' | 'shopify_checkout',
              )}
            >
              <MenuItem value="catalog">Catalog and order intake</MenuItem>
              <MenuItem value="shopify_checkout">
                Shopify checkout rating
              </MenuItem>
            </TextField>
          </Stack>
          <Button
            variant="contained"
            startIcon={<LinkRounded />}
            disabled={!canManage || saving || !activeVersions.length}
            onClick={() => void saveMapping()}
            sx={{ alignSelf: 'flex-start' }}
          >
            Save exact variant mapping
          </Button>
        </>
      ) : (
        <Alert severity="info">
          Import and resolve the product from Shopify or Faire before mapping
          its provider variant.
        </Alert>
      )}

      <Divider />
      <Box>
        <Typography variant="overline" color="text.secondary">
          Step 3 · Approve exact-case and loose-each rules
        </Typography>
        <Typography variant="body2">
          These are separate evidence paths. The exact-case rule preserves a
          complete case. The loose-each rule confirms the full quantity range
          that can be picked as eaches into the selected shipping material.
        </Typography>
      </Box>
      <Stack direction={{ xs: 'column', sm: 'row' }} gap={1.5}>
        <TextField
          select
          fullWidth
          label="Input each profile"
          value={recipeInputVersionGlobalId}
          disabled={!canManage || saving}
          onChange={(event) => setRecipeInputVersionGlobalId(event.target.value)}
        >
          {activeVersions
            .filter(({ profile }) => profile.packageLevel === 'each')
            .map(({ profile, version }) => (
              <MenuItem key={version.globalId} value={version.globalId}>
                {profileVersionLabel(profile, version)}
              </MenuItem>
            ))}
        </TextField>
        <TextField
          select
          fullWidth
          label="Output case profile"
          value={recipeOutputVersionGlobalId}
          disabled={!canManage || saving}
          onChange={(event) => setRecipeOutputVersionGlobalId(event.target.value)}
        >
          {activeVersions
            .filter(({ profile }) => profile.packageLevel === 'case')
            .map(({ profile, version }) => (
              <MenuItem key={version.globalId} value={version.globalId}>
                {profileVersionLabel(profile, version)}
              </MenuItem>
            ))}
        </TextField>
      </Stack>
      <Stack direction={{ xs: 'column', sm: 'row' }} gap={1.5}>
        <TextField
          select
          fullWidth
          label="Approved shipping material"
          value={recipeMaterialGlobalId}
          disabled={!canManage || saving}
          onChange={(event) => setRecipeMaterialGlobalId(event.target.value)}
        >
          {state.packagingMaterials.map((material) => (
            <MenuItem
              key={material.globalId}
              value={material.globalId}
              disabled={material.status !== 'active'}
            >
              {material.name} · {material.status} · {dimensionsLabel(
                material.ratedOuterDimensionsMm
                || material.innerDimensionsMm,
              )}
            </MenuItem>
          ))}
        </TextField>
        <TextField
          fullWidth
          label="Eaches per case"
          type="number"
          value={recipeQuantity}
          disabled={!canManage || saving}
          onChange={(event) => setRecipeQuantity(event.target.value)}
        />
      </Stack>
      <TextField
        fullWidth
        multiline
        minRows={2}
        label="Customer-confirmed case fit"
        value={recipeEvidence}
        disabled={!canManage || saving}
        onChange={(event) => setRecipeEvidence(event.target.value)}
      />
      <Button
        variant="contained"
        startIcon={saving ? <CircularProgress size={16} /> : <AutorenewRounded />}
        disabled={!canManage || saving}
        onClick={() => void saveExactCaseRecipe()}
        sx={{ alignSelf: 'flex-start' }}
      >
        Save active exact-case rule
      </Button>
      <Alert severity="info">
        The exact-case rule applies only to a complete case quantity. It does
        not authorize an underfilled carton. Add the separately evidenced
        loose-each rule below when quantities such as 1 or 13 must proceed
        without geometric fallback.
      </Alert>
      <TextField
        fullWidth
        label="Maximum eaches per loose-pick carton"
        type="number"
        value={looseEachMaximum}
        disabled={!canManage || saving}
        onChange={(event) => setLooseEachMaximum(event.target.value)}
        helperText="The active range starts at 1. The exact-case rule wins when the quantity equals one complete case."
      />
      <TextField
        fullWidth
        multiline
        minRows={2}
        label="Customer-confirmed loose-each fit"
        value={looseEachEvidence}
        disabled={!canManage || saving}
        onChange={(event) => setLooseEachEvidence(event.target.value)}
        helperText={
          `Cite evidence that every quantity from 1 through ${
            looseEachMaximum || 'the maximum'
          } fits safely in the selected material. Case-only evidence is not enough.`
        }
      />
      <Button
        variant="contained"
        startIcon={saving ? <CircularProgress size={16} /> : <Inventory2Rounded />}
        disabled={!canManage || saving}
        onClick={() => void saveLooseEachRecipe()}
        sx={{ alignSelf: 'flex-start' }}
      >
        Save active loose-each rule
      </Button>
      {state.recipes.some((recipe) => recipe.isCurrent) ? (
        <Stack direction="row" gap={0.75} flexWrap="wrap">
          {state.recipes
            .filter((recipe) => recipe.isCurrent)
            .map((recipe) => (
              <Chip
                key={recipe.globalId}
                size="small"
                color={recipe.lifecycleState === 'active' ? 'success' : 'default'}
                label={
                  recipe.recipeType === 'max_capacity'
                    ? `${recipe.recipeName} · ${
                      recipe.minimumInputQuantity ?? '?'
                    }–${recipe.inputQuantity}`
                    : `${recipe.recipeName} · exact ${recipe.inputQuantity}`
                }
              />
            ))}
        </Stack>
      ) : null}
    </Stack>
  )
}
