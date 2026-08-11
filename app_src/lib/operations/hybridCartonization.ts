export type HybridCartonizationFitModel =
  | 'rigid_3d'
  | 'compressible'
  | 'approved_recipe_only'

export type HybridCartonizationEvidenceType =
  | 'unknown'
  | 'customer_confirmed'
  | 'measured'
  | 'provider'
  | 'derived'
  | 'legacy'

export type HybridCartonizationLine = {
  lineGlobalId: string
  productGlobalId: string
  title: string
  quantity: number
  unitWeightGrams: number
  profile: {
    versionGlobalId: string
    capturedRowVersion: number
    currentRowVersion: number
    isCurrent: boolean
    lifecycleState:
      | 'draft'
      | 'customer_confirmed'
      | 'active'
      | 'superseded'
      | 'retired'
    fitModel: HybridCartonizationFitModel
    evidenceType: HybridCartonizationEvidenceType
    evidenceReference: string | null
    confirmedAt: string | null
    packageLevel?: 'each' | 'inner_pack' | 'case' | 'pallet'
    baseEachQuantity?: number
    shipsAsOwnPackage?: boolean
    outerDimensionsMm?: {
      length: number
      width: number
      height: number
    } | null
    grossWeightGrams?: number | null
  }
}

export type HybridCartonizationRecipe = {
  recipeGlobalId: string
  productGlobalId: string
  inputPackProfileVersionGlobalId: string
  outputPackProfileVersionGlobalId: string
  packagingMaterialGlobalId: string
  recipeType: 'exact_case' | 'max_capacity' | 'ship_ready_unit'
  maximumInputQuantity: number
  minimumInputQuantity: number | null
  contentCompatibilityKey: string | null
  allowsMixedProducts: boolean
  exclusiveContents: boolean
  capturedRowVersion: number
  currentRowVersion: number
  isCurrent: boolean
  lifecycleState: 'draft' | 'customer_confirmed' | 'active' | 'retired'
  fitEvidenceType: HybridCartonizationEvidenceType
  fitEvidenceReference: string | null
  confirmedAt: string | null
}

export type HybridCartonizationMinimumOverride = {
  recipeGlobalId?: string
  contentCompatibilityKey?: string
  packagingMaterialGlobalId: string
  minimumInputQuantity: number
  reason: string
  evidenceReference: string
}

export type HybridCartonizationMaterial = {
  materialGlobalId: string
  materialType?: 'carton' | 'poly_mailer' | 'padded_mailer'
  capturedRowVersion: number
  currentRowVersion: number
  isCurrent: boolean
  status: 'draft' | 'active'
  innerDimensionsMm: {
    length: number
    width: number
    height: number
  }
  dimensionBasis: 'inner' | 'outer' | 'unconfirmed'
  dimensionEvidenceType:
    | 'unknown'
    | 'customer_confirmed'
    | 'measured'
    | 'provider'
    | 'legacy'
  dimensionEvidenceReference: string | null
  dimensionConfirmedAt: string | null
  tareWeightGrams: number | null
  unitCostMinor?: number | null
  currency?: string | null
  stockRowVersion?: number | null
  stockOnHandQuantity?: number | null
  activeClaimedQuantity?: number
  /**
   * Optional planning fences supplied by the caller. When present, carton
   * construction must honor them; they are not post-plan advisory checks.
   */
  maximumGrossWeightGrams?: number | null
  availableQuantity?: number | null
  ratedOuterDimensionsMm: {
    length: number
    width: number
    height: number
  } | null
}

export type HybridCartonizationInput = {
  mode: 'production' | 'sandbox_demo'
  lines: HybridCartonizationLine[]
  recipes: HybridCartonizationRecipe[]
  materials: HybridCartonizationMaterial[]
  minimumInputOverrides?: HybridCartonizationMinimumOverride[]
}

export type HybridCartonizationBlockerCode =
  | 'PROFILE_EVIDENCE_MISSING'
  | 'PROFILE_EVIDENCE_STALE'
  | 'RECIPE_EVIDENCE_MISSING'
  | 'RECIPE_EVIDENCE_STALE'
  | 'RECIPE_REQUIRED'
  | 'RECIPE_COMPATIBILITY_AMBIGUOUS'
  | 'RECIPE_OPTION_NOT_SHARED'
  | 'RECIPE_CAPACITY_MINIMUM_NOT_MET'
  | 'MATERIAL_EVIDENCE_MISSING'
  | 'MATERIAL_EVIDENCE_STALE'
  | 'MATERIAL_CAPACITY_UNAVAILABLE'

export type HybridCartonizationBlocker = {
  code: HybridCartonizationBlockerCode
  detail: string
  action: string
  lineGlobalIds: string[]
  recipeGlobalIds: string[]
}

export type HybridRecipePackage = {
  packageKey: string
  sequence: number
  planningMethod: 'approved_recipe'
  packagingMaterialGlobalId: string
  packagingMaterialRowVersion: number
  materialEvidence: {
    innerDimensionsMm: {
      length: number
      width: number
      height: number
    }
    dimensionBasis: 'inner' | 'outer' | 'unconfirmed'
    dimensionEvidenceType:
      | 'unknown'
      | 'customer_confirmed'
      | 'measured'
      | 'provider'
      | 'legacy'
    dimensionEvidenceReference: string
    dimensionConfirmedAt: string
  }
  contentCompatibilityKey: string | null
  mixedProducts: boolean
  maximumInputQuantity: number
  minimumInputQuantity: number
  minimumBasis: 'approved_recipe' | 'sandbox_assumption'
  lineAllocations: Array<{
    lineGlobalId: string
    productGlobalId: string
    title: string
    quantity: number
    profileVersionGlobalId: string
    profileVersionRowVersion: number
    recipeGlobalId: string
    recipeRowVersion: number
    unitWeightGrams: number
    contentWeightGrams: number
  }>
  totalInputQuantity: number
  contentWeightGrams: number
  rateReadiness: {
    status: 'ready' | 'blocked'
    ratedOuterDimensionsMm: {
      length: number
      width: number
      height: number
    } | null
    tareWeightGrams: number | null
    ratedWeightGrams: number | null
    blockers: Array<
      'RATING_OUTER_DIMENSIONS_MISSING'
      | 'RATING_TARE_WEIGHT_MISSING'
    >
  }
  recipeEvidence: Array<{
    recipeGlobalId: string
    recipeRowVersion: number
    productGlobalId: string
    minimumInputQuantity: number | null
    appliedMinimumInputQuantity: number
    maximumInputQuantity: number
  }>
}

export type HybridSelfPackage = {
  packageKey: string
  sequence: number
  planningMethod: 'self_package'
  packProfileVersionGlobalId: string
  packProfileVersionRowVersion: number
  packageLevel: 'case'
  baseEachQuantity: number
  lineAllocations: Array<{
    lineGlobalId: string
    productGlobalId: string
    title: string
    quantity: 1
    profileVersionGlobalId: string
    profileVersionRowVersion: number
    unitWeightGrams: number
    contentWeightGrams: number
  }>
  totalInputQuantity: 1
  contentWeightGrams: number
  rateReadiness: {
    status: 'ready'
    ratedOuterDimensionsMm: {
      length: number
      width: number
      height: number
    }
    tareWeightGrams: 0
    ratedWeightGrams: number
    blockers: []
  }
}

export type HybridCartonizationResult = {
  status: 'ready' | 'blocked'
  policyVersion: typeof HYBRID_CARTONIZATION_POLICY_VERSION
  algorithmVersion: typeof HYBRID_CARTONIZATION_ALGORITHM_VERSION
  inputHash: string
  resultHash: string
  selfPackages: HybridSelfPackage[]
  recipePackages: HybridRecipePackage[]
  geometryFallbackLines: Array<{
    lineGlobalId: string
    productGlobalId: string
    quantity: number
    fitModel: Exclude<
      HybridCartonizationFitModel,
      'approved_recipe_only'
    >
  }>
  assumptions: Array<{
    packagingMaterialGlobalId: string
    contentCompatibilityKey: string | null
    recipeGlobalIds: string[]
    approvedMinimumInputQuantity: number | null
    assumedMinimumInputQuantity: number
    reason: string
    evidenceReference: string
  }>
  blockers: HybridCartonizationBlocker[]
}

export type HybridCartonizationCandidate = {
  candidateKey: string
  preferenceMaterialGlobalId: string | null
  preferenceMaterialGlobalIdsByPool: Record<string, string>
  plan: HybridCartonizationResult
}

type ValidRecipeOption = {
  recipe: HybridCartonizationRecipe
  material: HybridCartonizationMaterial
  appliedMinimumInputQuantity: number
  minimumBasis: 'approved_recipe' | 'sandbox_assumption'
  override: HybridCartonizationMinimumOverride | null
}

type PlannedLine = {
  line: HybridCartonizationLine
  remainingQuantity: number
  options: ValidRecipeOption[]
}

type SharedOption = {
  signature: string
  packagingMaterialGlobalId: string
  contentCompatibilityKey: string | null
  recipeType: HybridCartonizationRecipe['recipeType']
  maximumInputQuantity: number
  minimumInputQuantity: number
  minimumBasis: 'approved_recipe' | 'sandbox_assumption'
  material: HybridCartonizationMaterial
  recipesByProduct: Map<string, ValidRecipeOption>
}

const COMPATIBILITY_KEY = /^[a-z0-9][a-z0-9._-]*$/

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalValue)
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalValue(entry)]),
    )
  }
  return value
}

function canonicalHash(value: unknown) {
  return createHash('sha256')
    .update(JSON.stringify(canonicalValue(value)))
    .digest('hex')
}

function canonicalInputSnapshot(input: HybridCartonizationInput) {
  return {
    policyVersion: HYBRID_CARTONIZATION_POLICY_VERSION,
    algorithmVersion: HYBRID_CARTONIZATION_ALGORITHM_VERSION,
    mode: input.mode,
    lines: [...input.lines].sort((left, right) => (
      left.lineGlobalId.localeCompare(right.lineGlobalId)
    )),
    recipes: [...input.recipes].sort((left, right) => (
      left.recipeGlobalId.localeCompare(right.recipeGlobalId)
    )),
    materials: [...input.materials].sort((left, right) => (
      left.materialGlobalId.localeCompare(right.materialGlobalId)
    )),
    minimumInputOverrides: [...(input.minimumInputOverrides ?? [])]
      .sort((left, right) => (
        (left.recipeGlobalId ?? left.contentCompatibilityKey ?? '')
          .localeCompare(
            right.recipeGlobalId
            ?? right.contentCompatibilityKey
            ?? '',
          )
        || left.packagingMaterialGlobalId.localeCompare(
          right.packagingMaterialGlobalId,
        )
      )),
  }
}

function positiveInteger(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive safe integer`)
  }
}

function nonNegativeInteger(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`)
  }
}

function present(value: string | null | undefined) {
  return typeof value === 'string' && value.trim().length > 0
}

function validTimestamp(value: string | null) {
  return value !== null && Number.isFinite(Date.parse(value))
}

function profileEvidenceProblem(
  input: HybridCartonizationInput,
  line: HybridCartonizationLine,
): HybridCartonizationBlocker | null {
  const { profile } = line
  const eligibleLifecycle = profile.lifecycleState === 'active'
    || (
      input.mode === 'sandbox_demo'
      && profile.lifecycleState === 'customer_confirmed'
    )
  if (
    !profile.isCurrent
    || profile.capturedRowVersion !== profile.currentRowVersion
    || !eligibleLifecycle
  ) {
    return {
      code: 'PROFILE_EVIDENCE_STALE',
      detail:
        `Line ${line.lineGlobalId} does not reference the exact current `
        + 'active pack-profile row version.',
      action:
        'Reload current product-pack evidence before cartonization.',
      lineGlobalIds: [line.lineGlobalId],
      recipeGlobalIds: [],
    }
  }
  if (
    profile.evidenceType === 'unknown'
    || !present(profile.evidenceReference)
    || !validTimestamp(profile.confirmedAt)
  ) {
    return {
      code: 'PROFILE_EVIDENCE_MISSING',
      detail:
        `Line ${line.lineGlobalId} lacks confirmed pack-profile evidence.`,
      action:
        'Confirm the current product pack profile and retain its evidence '
        + 'reference before cartonization.',
      lineGlobalIds: [line.lineGlobalId],
      recipeGlobalIds: [],
    }
  }
  return null
}

function materialEvidenceProblem(
  input: HybridCartonizationInput,
  material: HybridCartonizationMaterial | undefined,
): 'missing' | 'stale' | null {
  if (!material) return 'missing'
  const eligibleLifecycle = material.status === 'active'
    || (
      input.mode === 'sandbox_demo'
      && material.status === 'draft'
    )
  if (
    !material.isCurrent
    || !eligibleLifecycle
    || material.capturedRowVersion !== material.currentRowVersion
  ) {
    return 'stale'
  }
  const dimensions = material.innerDimensionsMm
  const ratedOuterDimensions = material.ratedOuterDimensionsMm
  const sandboxUnconfirmedBasisWithRatedExterior = (
    input.mode === 'sandbox_demo'
    && material.dimensionBasis === 'unconfirmed'
    && ratedOuterDimensions !== null
    && Number.isSafeInteger(ratedOuterDimensions.length)
    && ratedOuterDimensions.length > 0
    && Number.isSafeInteger(ratedOuterDimensions.width)
    && ratedOuterDimensions.width > 0
    && Number.isSafeInteger(ratedOuterDimensions.height)
    && ratedOuterDimensions.height > 0
  )
  if (
    (
      material.dimensionBasis !== 'inner'
      && !(
        input.mode === 'sandbox_demo'
        && material.dimensionBasis === 'outer'
      )
      && !sandboxUnconfirmedBasisWithRatedExterior
    )
    || material.dimensionEvidenceType === 'unknown'
    || !present(material.dimensionEvidenceReference)
    || !validTimestamp(material.dimensionConfirmedAt)
    || !Number.isSafeInteger(dimensions.length)
    || dimensions.length <= 0
    || !Number.isSafeInteger(dimensions.width)
    || dimensions.width <= 0
    || !Number.isSafeInteger(dimensions.height)
    || dimensions.height <= 0
    || (
      material.maximumGrossWeightGrams !== undefined
      && material.maximumGrossWeightGrams !== null
      && (
        !Number.isSafeInteger(material.maximumGrossWeightGrams)
        || material.maximumGrossWeightGrams <= 0
      )
    )
    || (
      material.availableQuantity !== undefined
      && material.availableQuantity !== null
      && (
        !Number.isSafeInteger(material.availableQuantity)
        || material.availableQuantity < 0
      )
    )
  ) {
    return 'missing'
  }
  return null
}

function matchingOverride(
  input: HybridCartonizationInput,
  recipe: HybridCartonizationRecipe,
) {
  const matches = (input.minimumInputOverrides ?? []).filter((override) => {
    if (
      override.packagingMaterialGlobalId
      !== recipe.packagingMaterialGlobalId
    ) {
      return false
    }
    if (override.recipeGlobalId) {
      return override.recipeGlobalId === recipe.recipeGlobalId
    }
    return (
      override.contentCompatibilityKey !== undefined
      && override.contentCompatibilityKey
        === recipe.contentCompatibilityKey
    )
  })
  if (matches.length > 1) {
    throw new Error(
      `More than one minimum-input override matches ${recipe.recipeGlobalId}`,
    )
  }
  return matches[0] ?? null
}

function validateOverrides(input: HybridCartonizationInput) {
  const overrides = input.minimumInputOverrides ?? []
  if (overrides.length > 0 && input.mode !== 'sandbox_demo') {
    throw new Error(
      'Minimum-input assumptions are permitted only in sandbox_demo mode',
    )
  }
  for (const override of overrides) {
    positiveInteger(
      override.minimumInputQuantity,
      'Minimum-input override quantity',
    )
    if (
      Boolean(override.recipeGlobalId)
      === Boolean(override.contentCompatibilityKey)
    ) {
      throw new Error(
        'A minimum-input override must select exactly one recipe or '
        + 'compatibility key',
      )
    }
    if (
      override.contentCompatibilityKey
      && !COMPATIBILITY_KEY.test(override.contentCompatibilityKey)
    ) {
      throw new Error('Minimum-input override compatibility key is invalid')
    }
    if (!present(override.reason) || !present(override.evidenceReference)) {
      throw new Error(
        'Minimum-input overrides require a reason and evidence reference',
      )
    }
  }
}

function assertUniqueIds(values: string[], label: string) {
  const seen = new Set<string>()
  for (const value of values) {
    if (!present(value)) throw new Error(`${label} is required`)
    if (seen.has(value)) throw new Error(`${label} ${value} is duplicated`)
    seen.add(value)
  }
}

function recipeEvidenceProblem(
  input: HybridCartonizationInput,
  line: HybridCartonizationLine,
  recipe: HybridCartonizationRecipe,
): 'missing' | 'stale' | null {
  const eligibleLifecycle = recipe.lifecycleState === 'active'
    || (
      input.mode === 'sandbox_demo'
      && recipe.lifecycleState === 'customer_confirmed'
    )
  if (
    !recipe.isCurrent
    || recipe.capturedRowVersion !== recipe.currentRowVersion
    || !eligibleLifecycle
  ) {
    return 'stale'
  }
  if (
    recipe.productGlobalId !== line.productGlobalId
    || recipe.inputPackProfileVersionGlobalId
      !== line.profile.versionGlobalId
  ) {
    return 'stale'
  }
  if (
    recipe.fitEvidenceType === 'unknown'
    || !present(recipe.fitEvidenceReference)
    || !validTimestamp(recipe.confirmedAt)
  ) {
    return 'missing'
  }
  if (
    (
      recipe.contentCompatibilityKey !== null
      && !COMPATIBILITY_KEY.test(recipe.contentCompatibilityKey)
    )
    ||
    recipe.allowsMixedProducts
    && (
      recipe.recipeType !== 'max_capacity'
      || recipe.exclusiveContents
      || !['customer_confirmed', 'measured'].includes(
        recipe.fitEvidenceType,
      )
      || !recipe.contentCompatibilityKey
      || !COMPATIBILITY_KEY.test(recipe.contentCompatibilityKey)
    )
  ) {
    return 'missing'
  }
  return null
}

function validRecipeOption(
  input: HybridCartonizationInput,
  line: HybridCartonizationLine,
  recipe: HybridCartonizationRecipe,
): ValidRecipeOption | null {
  positiveInteger(recipe.maximumInputQuantity, 'Recipe maximum input quantity')
  nonNegativeInteger(recipe.capturedRowVersion, 'Captured recipe row version')
  nonNegativeInteger(recipe.currentRowVersion, 'Current recipe row version')

  if (recipeEvidenceProblem(input, line, recipe)) return null
  const material = input.materials.find(({ materialGlobalId }) => (
    materialGlobalId === recipe.packagingMaterialGlobalId
  ))
  if (!material || materialEvidenceProblem(input, material)) return null

  const approvedMinimum = recipe.recipeType === 'max_capacity'
    ? recipe.minimumInputQuantity
    : recipe.maximumInputQuantity
  if (approvedMinimum !== null) {
    positiveInteger(approvedMinimum, 'Recipe minimum input quantity')
    if (approvedMinimum > recipe.maximumInputQuantity) {
      throw new RangeError(
        'Recipe minimum input quantity cannot exceed its maximum',
      )
    }
  }

  const override = matchingOverride(input, recipe)
  if (
    override
    && override.minimumInputQuantity > recipe.maximumInputQuantity
  ) {
    throw new RangeError(
      'Minimum-input override cannot exceed the recipe maximum',
    )
  }
  if (approvedMinimum === null && !override) return null

  return {
    recipe,
    material,
    appliedMinimumInputQuantity:
      override?.minimumInputQuantity ?? approvedMinimum ?? 0,
    minimumBasis: override ? 'sandbox_assumption' : 'approved_recipe',
    override,
  }
}

function poolIdentity(option: ValidRecipeOption) {
  const { recipe } = option
  return recipe.allowsMixedProducts
    ? `mixed:${recipe.contentCompatibilityKey}`
    : `exclusive:${recipe.productGlobalId}`
}

function optionSignature(option: ValidRecipeOption) {
  const { recipe } = option
  return [
    recipe.packagingMaterialGlobalId,
    option.material.currentRowVersion,
    recipe.contentCompatibilityKey ?? '',
    recipe.recipeType,
    recipe.maximumInputQuantity,
    option.appliedMinimumInputQuantity,
    option.minimumBasis,
  ].join('|')
}

function buildSharedOptions(
  lines: PlannedLine[],
  preferenceMaterialGlobalId: string | null,
): SharedOption[] {
  const productIds = new Set(
    lines.map(({ line }) => line.productGlobalId),
  )
  const options = new Map<string, SharedOption>()

  for (const plannedLine of lines) {
    for (const option of plannedLine.options) {
      const signature = optionSignature(option)
      const current = options.get(signature) ?? {
        signature,
        packagingMaterialGlobalId:
          option.recipe.packagingMaterialGlobalId,
        contentCompatibilityKey:
          option.recipe.contentCompatibilityKey,
        recipeType: option.recipe.recipeType,
        maximumInputQuantity: option.recipe.maximumInputQuantity,
        minimumInputQuantity: option.appliedMinimumInputQuantity,
        minimumBasis: option.minimumBasis,
        material: option.material,
        recipesByProduct: new Map<string, ValidRecipeOption>(),
      }
      const existing = current.recipesByProduct.get(
        plannedLine.line.productGlobalId,
      )
      if (
        existing
        && existing.recipe.recipeGlobalId !== option.recipe.recipeGlobalId
      ) {
        throw new Error(
          'Multiple current recipes describe the same product and carton '
          + `option: ${signature}`,
        )
      }
      current.recipesByProduct.set(
        plannedLine.line.productGlobalId,
        option,
      )
      options.set(signature, current)
    }
  }

  return [...options.values()]
    .filter((option) => (
      [...productIds].every((productId) => (
        option.recipesByProduct.has(productId)
      ))
    ))
    .sort((left, right) => (
      (
        preferenceMaterialGlobalId === null
          ? 0
          : Number(
            right.packagingMaterialGlobalId
              === preferenceMaterialGlobalId,
          )
            - Number(
              left.packagingMaterialGlobalId
                === preferenceMaterialGlobalId,
            )
      )
      || left.maximumInputQuantity - right.maximumInputQuantity
      || recipeTypePriority(left.recipeType)
        - recipeTypePriority(right.recipeType)
      || left.packagingMaterialGlobalId.localeCompare(
        right.packagingMaterialGlobalId,
      )
    ))
}

function recipeTypePriority(
  recipeType: HybridCartonizationRecipe['recipeType'],
) {
  if (recipeType === 'exact_case') return 0
  if (recipeType === 'max_capacity') return 1
  return 2
}

function remainingMaterialQuantity(
  material: HybridCartonizationMaterial,
  materialUsage: Map<string, number>,
) {
  if (
    material.availableQuantity === undefined
    || material.availableQuantity === null
  ) {
    return Number.POSITIVE_INFINITY
  }
  return Math.max(
    0,
    material.availableQuantity
      - (materialUsage.get(material.materialGlobalId) || 0),
  )
}

/**
 * Computes the largest deterministic allocation that respects both the
 * recipe quantity and the material's gross-weight fence. Allocation order is
 * the same stable line order used by allocatePackage, so feasibility cannot
 * drift between planning and package construction.
 */
function maximumAllocatableQuantity(
  lines: PlannedLine[],
  option: SharedOption,
  requestedMaximum: number,
) {
  let quantityRemaining = requestedMaximum
  let contentWeightGrams = 0
  let quantity = 0
  const tareWeightGrams = option.material.tareWeightGrams ?? 0
  const maximumContentWeightGrams = (
    option.material.maximumGrossWeightGrams === undefined
    || option.material.maximumGrossWeightGrams === null
  )
    ? Number.POSITIVE_INFINITY
    : option.material.maximumGrossWeightGrams - tareWeightGrams
  if (maximumContentWeightGrams <= 0) return 0

  for (const plannedLine of lines) {
    if (quantityRemaining === 0 || plannedLine.remainingQuantity === 0) {
      continue
    }
    const availableByQuantity = Math.min(
      plannedLine.remainingQuantity,
      quantityRemaining,
    )
    const availableByWeight = Number.isFinite(maximumContentWeightGrams)
      ? Math.floor(
          (maximumContentWeightGrams - contentWeightGrams)
            / plannedLine.line.unitWeightGrams,
        )
      : availableByQuantity
    const allocated = Math.max(
      0,
      Math.min(availableByQuantity, availableByWeight),
    )
    quantity += allocated
    quantityRemaining -= allocated
    contentWeightGrams += allocated * plannedLine.line.unitWeightGrams
  }
  return quantity
}

function allocatePackage(
  lines: PlannedLine[],
  option: SharedOption,
  targetQuantity: number,
  sequence: number,
): HybridRecipePackage {
  let quantityToAllocate = targetQuantity
  const lineAllocations: HybridRecipePackage['lineAllocations'] = []
  for (const plannedLine of lines) {
    if (quantityToAllocate === 0 || plannedLine.remainingQuantity === 0) {
      continue
    }
    const quantity = Math.min(
      plannedLine.remainingQuantity,
      quantityToAllocate,
    )
    const recipe = option.recipesByProduct.get(
      plannedLine.line.productGlobalId,
    )
    if (!recipe) {
      throw new Error('Shared recipe option lost a participating product')
    }
    lineAllocations.push({
      lineGlobalId: plannedLine.line.lineGlobalId,
      productGlobalId: plannedLine.line.productGlobalId,
      title: plannedLine.line.title,
      quantity,
      profileVersionGlobalId:
        plannedLine.line.profile.versionGlobalId,
      profileVersionRowVersion:
        plannedLine.line.profile.currentRowVersion,
      recipeGlobalId: recipe.recipe.recipeGlobalId,
      recipeRowVersion: recipe.recipe.currentRowVersion,
      unitWeightGrams: plannedLine.line.unitWeightGrams,
      contentWeightGrams: quantity * plannedLine.line.unitWeightGrams,
    })
    plannedLine.remainingQuantity -= quantity
    quantityToAllocate -= quantity
  }
  if (quantityToAllocate !== 0) {
    throw new Error('Recipe package allocation did not satisfy its target')
  }
  const contentWeightGrams = lineAllocations.reduce(
    (total, allocation) => total + allocation.contentWeightGrams,
    0,
  )
  const ratedWeightGrams = option.material.tareWeightGrams === null
    ? null
    : contentWeightGrams + option.material.tareWeightGrams
  if (
    ratedWeightGrams !== null
    && option.material.maximumGrossWeightGrams !== undefined
    && option.material.maximumGrossWeightGrams !== null
    && ratedWeightGrams > option.material.maximumGrossWeightGrams
  ) {
    throw new Error('Recipe package exceeds the material gross-weight fence')
  }
  const rateBlockers: HybridRecipePackage['rateReadiness']['blockers'] = []
  if (!option.material.ratedOuterDimensionsMm) {
    rateBlockers.push('RATING_OUTER_DIMENSIONS_MISSING')
  }
  if (option.material.tareWeightGrams === null) {
    rateBlockers.push('RATING_TARE_WEIGHT_MISSING')
  }
  const recipeEvidence = [...option.recipesByProduct.values()]
    .filter(({ recipe }) => (
      lineAllocations.some(({ recipeGlobalId }) => (
        recipeGlobalId === recipe.recipeGlobalId
      ))
    ))
    .map(({ recipe, appliedMinimumInputQuantity }) => ({
      recipeGlobalId: recipe.recipeGlobalId,
      recipeRowVersion: recipe.currentRowVersion,
      productGlobalId: recipe.productGlobalId,
      minimumInputQuantity: recipe.minimumInputQuantity,
      appliedMinimumInputQuantity,
      maximumInputQuantity: recipe.maximumInputQuantity,
    }))
    .sort((left, right) => (
      left.recipeGlobalId.localeCompare(right.recipeGlobalId)
    ))
  const packageEvidence = {
    sequence,
    planningMethod: 'approved_recipe' as const,
    packagingMaterialGlobalId: option.packagingMaterialGlobalId,
    packagingMaterialRowVersion: option.material.currentRowVersion,
    contentCompatibilityKey: option.contentCompatibilityKey,
    lineAllocations,
    recipeEvidence,
  }
  return {
    packageKey: `hpkg-${canonicalHash(packageEvidence).slice(0, 20)}`,
    sequence,
    planningMethod: 'approved_recipe',
    packagingMaterialGlobalId: option.packagingMaterialGlobalId,
    packagingMaterialRowVersion: option.material.currentRowVersion,
    materialEvidence: {
      innerDimensionsMm: option.material.innerDimensionsMm,
      dimensionBasis: option.material.dimensionBasis,
      dimensionEvidenceType: option.material.dimensionEvidenceType,
      dimensionEvidenceReference:
        option.material.dimensionEvidenceReference ?? '',
      dimensionConfirmedAt: option.material.dimensionConfirmedAt ?? '',
    },
    contentCompatibilityKey: option.contentCompatibilityKey,
    mixedProducts:
      new Set(lineAllocations.map(({ productGlobalId }) => productGlobalId))
        .size > 1,
    maximumInputQuantity: option.maximumInputQuantity,
    minimumInputQuantity: option.minimumInputQuantity,
    minimumBasis: option.minimumBasis,
    lineAllocations,
    totalInputQuantity: targetQuantity,
    contentWeightGrams,
    rateReadiness: {
      status: rateBlockers.length === 0 ? 'ready' : 'blocked',
      ratedOuterDimensionsMm: option.material.ratedOuterDimensionsMm,
      tareWeightGrams: option.material.tareWeightGrams,
      ratedWeightGrams,
      blockers: rateBlockers,
    },
    recipeEvidence,
  }
}

function unique(values: string[]) {
  return [...new Set(values)].sort()
}

function selfPackageEvidenceIsComplete(line: HybridCartonizationLine) {
  const { profile } = line
  const dimensions = profile.outerDimensionsMm
  return (
    profile.shipsAsOwnPackage === true
    && profile.packageLevel === 'case'
    && Number.isSafeInteger(profile.baseEachQuantity)
    && Number(profile.baseEachQuantity) > 1
    && dimensions !== null
    && dimensions !== undefined
    && Number.isSafeInteger(dimensions.length)
    && dimensions.length > 0
    && Number.isSafeInteger(dimensions.width)
    && dimensions.width > 0
    && Number.isSafeInteger(dimensions.height)
    && dimensions.height > 0
    && Number.isSafeInteger(profile.grossWeightGrams)
    && Number(profile.grossWeightGrams) > 0
    && profile.grossWeightGrams === line.unitWeightGrams
  )
}

function allocateSelfPackages(
  line: HybridCartonizationLine,
  startingSequence: number,
): HybridSelfPackage[] {
  if (!selfPackageEvidenceIsComplete(line)) {
    throw new Error(
      `Self-package line ${line.lineGlobalId} lacks complete case evidence`,
    )
  }
  const dimensions = line.profile.outerDimensionsMm
  const baseEachQuantity = line.profile.baseEachQuantity
  if (!dimensions || !baseEachQuantity) {
    throw new Error('Self-package evidence changed during planning')
  }
  return Array.from({ length: line.quantity }, (_, index) => {
    const sequence = startingSequence + index
    const allocation = {
      lineGlobalId: line.lineGlobalId,
      productGlobalId: line.productGlobalId,
      title: line.title,
      quantity: 1 as const,
      profileVersionGlobalId: line.profile.versionGlobalId,
      profileVersionRowVersion: line.profile.currentRowVersion,
      unitWeightGrams: line.unitWeightGrams,
      contentWeightGrams: line.unitWeightGrams,
    }
    const packageEvidence = {
      sequence,
      planningMethod: 'self_package' as const,
      packProfileVersionGlobalId: line.profile.versionGlobalId,
      packProfileVersionRowVersion: line.profile.currentRowVersion,
      lineAllocation: allocation,
    }
    return {
      packageKey: `hpkg-${canonicalHash(packageEvidence).slice(0, 20)}`,
      sequence,
      planningMethod: 'self_package',
      packProfileVersionGlobalId: line.profile.versionGlobalId,
      packProfileVersionRowVersion: line.profile.currentRowVersion,
      packageLevel: 'case',
      baseEachQuantity,
      lineAllocations: [allocation],
      totalInputQuantity: 1,
      contentWeightGrams: line.unitWeightGrams,
      rateReadiness: {
        status: 'ready',
        ratedOuterDimensionsMm: dimensions,
        tareWeightGrams: 0,
        ratedWeightGrams: line.unitWeightGrams,
        blockers: [],
      },
    }
  })
}

/**
 * Performs the evidence-backed recipe phase before geometric cartonization.
 *
 * `approved_recipe_only` lines never enter geometry. Mixed-product packages
 * require the exact same compatibility key and a material/capacity option
 * shared by every participating product. An unknown or under-run customer
 * minimum remains blocked unless a sandbox caller supplies an explicit,
 * retained assumption override.
 */
function planHybridCartonizationWithPreference(
  input: HybridCartonizationInput,
  preferenceMaterialGlobalIdsByPool: Readonly<Record<string, string>>,
): HybridCartonizationResult {
  validateOverrides(input)
  assertUniqueIds(
    input.lines.map(({ lineGlobalId }) => lineGlobalId),
    'Order-line Global ID',
  )
  assertUniqueIds(
    input.recipes.map(({ recipeGlobalId }) => recipeGlobalId),
    'Recipe Global ID',
  )
  assertUniqueIds(
    input.materials.map(({ materialGlobalId }) => materialGlobalId),
    'Material Global ID',
  )
  const inputHash = canonicalHash(canonicalInputSnapshot(input))
  const blockers: HybridCartonizationBlocker[] = []
  const selfPackages: HybridSelfPackage[] = []
  const recipePackages: HybridRecipePackage[] = []
  const geometryFallbackLines:
    HybridCartonizationResult['geometryFallbackLines'] = []
  const assumptions = new Map<
    string,
    HybridCartonizationResult['assumptions'][number]
  >()
  const plannedLines: PlannedLine[] = []
  const materialUsage = new Map<string, number>()

  for (const line of input.lines) {
    positiveInteger(line.quantity, 'Order-line quantity')
    positiveInteger(line.unitWeightGrams, 'Order-line unit weight')
    if (!present(line.title)) {
      throw new Error('Order-line title is required')
    }
    nonNegativeInteger(
      line.profile.capturedRowVersion,
      'Captured profile row version',
    )
    nonNegativeInteger(
      line.profile.currentRowVersion,
      'Current profile row version',
    )
    const profileProblem = profileEvidenceProblem(input, line)
    if (profileProblem) {
      blockers.push(profileProblem)
      continue
    }
    if (line.profile.shipsAsOwnPackage === true) {
      if (!selfPackageEvidenceIsComplete(line)) {
        blockers.push({
          code: 'PROFILE_EVIDENCE_MISSING',
          detail:
            `Line ${line.lineGlobalId} is marked to ship as its own package `
            + 'but lacks an active case quantity, outer dimensions, or '
            + 'matching gross weight.',
          action:
            'Confirm the current case profile, base-each quantity, outer '
            + 'dimensions, and gross weight before checkout rating.',
          lineGlobalIds: [line.lineGlobalId],
          recipeGlobalIds: [],
        })
        continue
      }
      selfPackages.push(
        ...allocateSelfPackages(line, selfPackages.length + 1),
      )
      continue
    }

    const matchingRecipes = input.recipes.filter((recipe) => (
      recipe.productGlobalId === line.productGlobalId
      && recipe.inputPackProfileVersionGlobalId
        === line.profile.versionGlobalId
    ))
    const staleRecipeIds = matchingRecipes
      .filter((recipe) => (
        recipeEvidenceProblem(input, line, recipe) === 'stale'
      ))
      .map(({ recipeGlobalId }) => recipeGlobalId)
    const missingRecipeIds = matchingRecipes
      .filter((recipe) => (
        recipeEvidenceProblem(input, line, recipe) === 'missing'
      ))
      .map(({ recipeGlobalId }) => recipeGlobalId)
    const staleMaterialRecipeIds = matchingRecipes
      .filter((recipe) => {
        if (recipeEvidenceProblem(input, line, recipe)) return false
        const material = input.materials.find(({ materialGlobalId }) => (
          materialGlobalId === recipe.packagingMaterialGlobalId
        ))
        return materialEvidenceProblem(input, material) === 'stale'
      })
      .map(({ recipeGlobalId }) => recipeGlobalId)
    const missingMaterialRecipeIds = matchingRecipes
      .filter((recipe) => {
        if (recipeEvidenceProblem(input, line, recipe)) return false
        const material = input.materials.find(({ materialGlobalId }) => (
          materialGlobalId === recipe.packagingMaterialGlobalId
        ))
        return materialEvidenceProblem(input, material) === 'missing'
      })
      .map(({ recipeGlobalId }) => recipeGlobalId)
    const options = matchingRecipes
      .map((recipe) => validRecipeOption(input, line, recipe))
      .filter((option): option is ValidRecipeOption => option !== null)
    const incompleteOptionRecipeIds = matchingRecipes
      .filter((recipe) => (
        !recipeEvidenceProblem(input, line, recipe)
        && !materialEvidenceProblem(
          input,
          input.materials.find(({ materialGlobalId }) => (
            materialGlobalId === recipe.packagingMaterialGlobalId
          )),
        )
        && !options.some(({ recipe: optionRecipe }) => (
          optionRecipe.recipeGlobalId === recipe.recipeGlobalId
        ))
      ))
      .map(({ recipeGlobalId }) => recipeGlobalId)

    if (options.length === 0) {
      if (line.profile.fitModel !== 'approved_recipe_only') {
        geometryFallbackLines.push({
          lineGlobalId: line.lineGlobalId,
          productGlobalId: line.productGlobalId,
          quantity: line.quantity,
          fitModel: line.profile.fitModel,
        })
        continue
      }
      if (staleRecipeIds.length > 0) {
        blockers.push({
          code: 'RECIPE_EVIDENCE_STALE',
          detail:
            `Line ${line.lineGlobalId} has only stale or nonactive recipe `
            + 'evidence.',
          action:
            'Reload and activate the exact current recipe version before '
            + 'cartonization.',
          lineGlobalIds: [line.lineGlobalId],
          recipeGlobalIds: unique(staleRecipeIds),
        })
      } else if (missingRecipeIds.length > 0) {
        blockers.push({
          code: 'RECIPE_EVIDENCE_MISSING',
          detail:
            `Line ${line.lineGlobalId} has no recipe with complete fit `
            + 'evidence and a known minimum.',
          action:
            'Confirm recipe fit and minimum quantity. A sandbox-only '
            + 'minimum assumption must be supplied explicitly.',
          lineGlobalIds: [line.lineGlobalId],
          recipeGlobalIds: unique(missingRecipeIds),
        })
      } else if (staleMaterialRecipeIds.length > 0) {
        blockers.push({
          code: 'MATERIAL_EVIDENCE_STALE',
          detail:
            `Line ${line.lineGlobalId} references a stale, inactive, or `
            + 'changed packaging-material version.',
          action:
            'Reload the exact active packaging material before '
            + 'cartonization.',
          lineGlobalIds: [line.lineGlobalId],
          recipeGlobalIds: unique(staleMaterialRecipeIds),
        })
      } else if (missingMaterialRecipeIds.length > 0) {
        blockers.push({
          code: 'MATERIAL_EVIDENCE_MISSING',
          detail:
            `Line ${line.lineGlobalId} lacks an active material with `
            + 'confirmed inner-dimension evidence.',
          action:
            'Confirm the packaging material inner dimensions and activate '
            + 'the material before cartonization.',
          lineGlobalIds: [line.lineGlobalId],
          recipeGlobalIds: unique(missingMaterialRecipeIds),
        })
      } else if (incompleteOptionRecipeIds.length > 0) {
        blockers.push({
          code: 'RECIPE_EVIDENCE_MISSING',
          detail:
            `Line ${line.lineGlobalId} has no recipe with a known usable `
            + 'minimum quantity.',
          action:
            'Confirm the max-capacity recipe minimum. A sandbox-only '
            + 'minimum assumption must be supplied explicitly.',
          lineGlobalIds: [line.lineGlobalId],
          recipeGlobalIds: unique(incompleteOptionRecipeIds),
        })
      } else {
        blockers.push({
          code: 'RECIPE_REQUIRED',
          detail:
            `Line ${line.lineGlobalId} is approved-recipe-only but has no `
            + 'eligible recipe.',
          action:
            'Create and activate an evidence-backed recipe for the exact '
            + 'current pack profile.',
          lineGlobalIds: [line.lineGlobalId],
          recipeGlobalIds: [],
        })
      }
      continue
    }

    const identities = unique(options.map(poolIdentity))
    if (identities.length !== 1) {
      blockers.push({
        code: 'RECIPE_COMPATIBILITY_AMBIGUOUS',
        detail:
          `Line ${line.lineGlobalId} resolves to conflicting compatibility `
          + 'classes.',
        action:
          'Retire the conflicting recipe or assign one explicit content '
          + 'compatibility class.',
        lineGlobalIds: [line.lineGlobalId],
        recipeGlobalIds: unique(
          options.map(({ recipe }) => recipe.recipeGlobalId),
        ),
      })
      continue
    }
    plannedLines.push({
      line,
      remainingQuantity: line.quantity,
      options,
    })
  }

  const pools = new Map<string, PlannedLine[]>()
  for (const plannedLine of plannedLines) {
    const identity = poolIdentity(plannedLine.options[0])
    const current = pools.get(identity) ?? []
    current.push(plannedLine)
    pools.set(identity, current)
  }

  for (
    const [identity, unsortedLines]
    of [...pools.entries()].sort(([left], [right]) => (
      left.localeCompare(right)
    ))
  ) {
    const lines = [...unsortedLines].sort((left, right) => (
      left.line.lineGlobalId.localeCompare(right.line.lineGlobalId)
    ))
    const preferenceMaterialGlobalId =
      preferenceMaterialGlobalIdsByPool[identity] ?? null
    const sharedOptions = buildSharedOptions(
      lines,
      preferenceMaterialGlobalId,
    )
    if (sharedOptions.length === 0) {
      blockers.push({
        code: 'RECIPE_OPTION_NOT_SHARED',
        detail:
          `Compatibility pool ${identity} has no material and capacity `
          + 'option shared by every participating product.',
        action:
          'Confirm an identical material, capacity, and minimum recipe for '
          + 'each product before mixed pooling.',
        lineGlobalIds: lines.map(({ line }) => line.lineGlobalId),
        recipeGlobalIds: unique(lines.flatMap(({ options }) => (
          options.map(({ recipe }) => recipe.recipeGlobalId)
        ))),
      })
      continue
    }

    let totalRemaining = lines.reduce(
      (total, line) => total + line.remainingQuantity,
      0,
    )
    while (totalRemaining > 0) {
      const feasibleOptions = sharedOptions.flatMap((option) => {
        if (remainingMaterialQuantity(option.material, materialUsage) < 1) {
          return []
        }
        const maximumInputQuantity = maximumAllocatableQuantity(
          lines,
          option,
          Math.min(totalRemaining, option.maximumInputQuantity),
        )
        if (maximumInputQuantity < option.minimumInputQuantity) return []
        return [{
          option,
          targetQuantity: Math.min(totalRemaining, maximumInputQuantity),
          completesPool: totalRemaining <= maximumInputQuantity,
        }]
      }).sort((left, right) => (
        Number(right.completesPool) - Number(left.completesPool)
        || (
          preferenceMaterialGlobalId === null
            ? 0
            : Number(
              right.option.packagingMaterialGlobalId
                === preferenceMaterialGlobalId,
            )
              - Number(
                left.option.packagingMaterialGlobalId
                  === preferenceMaterialGlobalId,
              )
        )
        || (
          right.targetQuantity - left.targetQuantity
        )
        || recipeTypePriority(left.option.recipeType)
          - recipeTypePriority(right.option.recipeType)
        || left.option.packagingMaterialGlobalId.localeCompare(
          right.option.packagingMaterialGlobalId,
        )
      ))
      const selected = feasibleOptions[0]
      if (!selected) break
      const selectedOption = selected.option
      const targetQuantity = selected.targetQuantity
      const recipePackage = allocatePackage(
        lines,
        selectedOption,
        targetQuantity,
        selfPackages.length + recipePackages.length + 1,
      )
      recipePackages.push(recipePackage)
      materialUsage.set(
        selectedOption.packagingMaterialGlobalId,
        (materialUsage.get(selectedOption.packagingMaterialGlobalId) || 0) + 1,
      )
      for (const allocation of recipePackage.lineAllocations) {
        const option = selectedOption.recipesByProduct.get(
          allocation.productGlobalId,
        )
        const override = option?.override
        if (!option || !override) continue
        const assumptionKey = [
          selectedOption.packagingMaterialGlobalId,
          selectedOption.contentCompatibilityKey ?? '',
          override.minimumInputQuantity,
          override.evidenceReference,
        ].join('|')
        const current = assumptions.get(assumptionKey) ?? {
          packagingMaterialGlobalId:
            selectedOption.packagingMaterialGlobalId,
          contentCompatibilityKey:
            selectedOption.contentCompatibilityKey,
          recipeGlobalIds: [],
          approvedMinimumInputQuantity:
            option.recipe.minimumInputQuantity,
          assumedMinimumInputQuantity: override.minimumInputQuantity,
          reason: override.reason.trim(),
          evidenceReference: override.evidenceReference.trim(),
        }
        current.recipeGlobalIds = unique([
          ...current.recipeGlobalIds,
          option.recipe.recipeGlobalId,
        ])
        assumptions.set(assumptionKey, current)
      }
      totalRemaining -= targetQuantity
    }

    if (totalRemaining > 0) {
      const constrainedMaterialIds = unique(
        sharedOptions
          .filter((option) => (
            remainingMaterialQuantity(option.material, materialUsage) < 1
            || maximumAllocatableQuantity(
              lines,
              option,
              Math.min(totalRemaining, option.maximumInputQuantity),
            ) < option.minimumInputQuantity
          ))
          .map((option) => option.packagingMaterialGlobalId),
      )
      if (constrainedMaterialIds.length > 0) {
        blockers.push({
          code: 'MATERIAL_CAPACITY_UNAVAILABLE',
          detail:
            `${totalRemaining} unit(s) in compatibility pool ${identity} `
            + 'cannot be allocated within the retained material stock and '
            + 'gross-weight limits.',
          action:
            'Add compatible packaging stock, raise an evidenced material '
            + 'weight limit, or confirm another approved recipe.',
          lineGlobalIds: lines
            .filter(({ remainingQuantity }) => remainingQuantity > 0)
            .map(({ line }) => line.lineGlobalId),
          recipeGlobalIds: unique(lines.flatMap(({ options }) => (
            options
              .filter(({ recipe }) => constrainedMaterialIds.includes(
                recipe.packagingMaterialGlobalId,
              ))
              .map(({ recipe }) => recipe.recipeGlobalId)
          ))),
        })
      }
      const recipeOnly = lines.filter(({ line, remainingQuantity }) => (
        remainingQuantity > 0
        && line.profile.fitModel === 'approved_recipe_only'
      ))
      const geometryEligible = lines.filter(({ line, remainingQuantity }) => (
        remainingQuantity > 0
        && line.profile.fitModel !== 'approved_recipe_only'
      ))
      for (const line of geometryEligible) {
        const fitModel = line.line.profile.fitModel
        if (fitModel === 'approved_recipe_only') continue
        geometryFallbackLines.push({
          lineGlobalId: line.line.lineGlobalId,
          productGlobalId: line.line.productGlobalId,
          quantity: line.remainingQuantity,
          fitModel,
        })
      }
      if (recipeOnly.length > 0) {
        blockers.push({
          code: 'RECIPE_CAPACITY_MINIMUM_NOT_MET',
          detail:
            `${totalRemaining} unit(s) in compatibility pool ${identity} `
            + 'do not meet any current approved recipe minimum/capacity.',
          action:
            'Confirm another recipe or change the order quantity. Sandbox '
            + 'demonstrations may retain an explicit minimum assumption.',
          lineGlobalIds: recipeOnly.map(
            ({ line }) => line.lineGlobalId,
          ),
          recipeGlobalIds: unique(recipeOnly.flatMap(({ options }) => (
            options.map(({ recipe }) => recipe.recipeGlobalId)
          ))),
        })
      }
    }
  }

  const resultWithoutHash: Omit<
    HybridCartonizationResult,
    'resultHash'
  > = {
    status: blockers.length === 0 ? 'ready' : 'blocked',
    policyVersion: HYBRID_CARTONIZATION_POLICY_VERSION,
    algorithmVersion: HYBRID_CARTONIZATION_ALGORITHM_VERSION,
    inputHash,
    selfPackages,
    recipePackages,
    geometryFallbackLines,
    assumptions: [...assumptions.values()].sort((left, right) => (
      left.packagingMaterialGlobalId.localeCompare(
        right.packagingMaterialGlobalId,
      )
      || (left.contentCompatibilityKey ?? '').localeCompare(
        right.contentCompatibilityKey ?? '',
      )
    )),
    blockers,
  }
  return {
    ...resultWithoutHash,
    resultHash: canonicalHash(resultWithoutHash),
  }
}

export function planHybridCartonization(
  input: HybridCartonizationInput,
): HybridCartonizationResult {
  return planHybridCartonizationWithPreference(input, {})
}

function poolMaterialPreferenceChoices(
  input: HybridCartonizationInput,
  materialPreferenceOrder: string[],
) {
  const lineProfiles = new Set(input.lines.map((line) => (
    `${line.productGlobalId}|${line.profile.versionGlobalId}`
  )))
  const choices = new Map<string, Set<string>>()
  for (const recipe of input.recipes) {
    if (!lineProfiles.has(
      `${recipe.productGlobalId}|${recipe.inputPackProfileVersionGlobalId}`,
    )) {
      continue
    }
    const identity = recipe.allowsMixedProducts
      ? `mixed:${recipe.contentCompatibilityKey}`
      : `exclusive:${recipe.productGlobalId}`
    const current = choices.get(identity) ?? new Set<string>()
    current.add(recipe.packagingMaterialGlobalId)
    choices.set(identity, current)
  }
  const order = new Map(
    materialPreferenceOrder.map((materialGlobalId, index) => [
      materialGlobalId,
      index,
    ]),
  )
  return [...choices.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([identity, values]) => ({
      identity,
      materialGlobalIds: [...values].sort((left, right) => (
        (order.get(left) ?? Number.MAX_SAFE_INTEGER)
          - (order.get(right) ?? Number.MAX_SAFE_INTEGER)
        || left.localeCompare(right)
      )),
    }))
}

type PoolPreferenceState = {
  materialIndexes: number[]
  changedPoolCount: number
  totalPreferenceRank: number
  maximumPreferenceRank: number
  stableKey: string
}

function poolPreferenceState(materialIndexes: number[]): PoolPreferenceState {
  const changed = materialIndexes.filter((index) => index > 0)
  return {
    materialIndexes,
    changedPoolCount: changed.length,
    totalPreferenceRank: changed.reduce((total, index) => total + index, 0),
    maximumPreferenceRank: changed.length ? Math.max(...changed) : 0,
    stableKey: materialIndexes.map((index) => (
      String(index).padStart(4, '0')
    )).join(':'),
  }
}

function comparePoolPreferenceState(
  left: PoolPreferenceState,
  right: PoolPreferenceState,
) {
  return (
    left.changedPoolCount - right.changedPoolCount
    || left.totalPreferenceRank - right.totalPreferenceRank
    || left.maximumPreferenceRank - right.maximumPreferenceRank
    || left.stableKey.localeCompare(right.stableKey)
  )
}

/**
 * Builds a deterministic, bounded best-first frontier. Material rank already
 * reflects the tenant objective proxy supplied by the caller. Expanding from
 * the all-primary state by one pool at a time guarantees every pool's first
 * alternative is considered before compounded substitutions, rather than
 * truncating the Cartesian product in pool order.
 */
export function boundedPoolPreferenceFrontier(
  pools: ReturnType<typeof poolMaterialPreferenceChoices>,
  limit: number,
) {
  if (pools.length === 0 || limit < 1) return []
  const initial = poolPreferenceState(pools.map(() => 0))
  const frontier = [initial]
  const queued = new Set([initial.stableKey])
  const selected: PoolPreferenceState[] = []
  while (frontier.length > 0 && selected.length < limit) {
    frontier.sort(comparePoolPreferenceState)
    const current = frontier.shift()
    if (!current) break
    selected.push(current)
    for (let poolIndex = 0; poolIndex < pools.length; poolIndex += 1) {
      const nextMaterialIndex = current.materialIndexes[poolIndex] + 1
      if (
        nextMaterialIndex
          >= pools[poolIndex].materialGlobalIds.length
      ) {
        continue
      }
      const nextIndexes = [...current.materialIndexes]
      nextIndexes[poolIndex] = nextMaterialIndex
      const next = poolPreferenceState(nextIndexes)
      if (queued.has(next.stableKey)) continue
      queued.add(next.stableKey)
      frontier.push(next)
    }
  }
  return selected.map((state) => Object.fromEntries(
    pools.map((pool, index) => [
      pool.identity,
      pool.materialGlobalIds[state.materialIndexes[index]],
    ]),
  ))
}

export function planHybridCartonizationCandidates(
  input: HybridCartonizationInput,
  options: {
    maxCandidates: number
    materialPreferenceOrder?: string[]
  },
): HybridCartonizationCandidate[] {
  if (
    !Number.isSafeInteger(options.maxCandidates)
    || options.maxCandidates < 1
    || options.maxCandidates > 8
  ) {
    throw new RangeError(
      'Hybrid cartonization candidate count must be between 1 and 8',
    )
  }
  const knownMaterials = new Set(
    input.materials.map(({ materialGlobalId }) => materialGlobalId),
  )
  const preferenceOrder: string[] = []
  const seenPreferences = new Set<string>()
  for (const materialGlobalId of [
    ...(options.materialPreferenceOrder ?? []),
    ...input.materials
      .map((material) => material.materialGlobalId)
      .sort(),
  ]) {
    if (
      knownMaterials.has(materialGlobalId)
      && !seenPreferences.has(materialGlobalId)
    ) {
      seenPreferences.add(materialGlobalId)
      preferenceOrder.push(materialGlobalId)
    }
  }
  const pools = poolMaterialPreferenceChoices(input, preferenceOrder)
  const beamLimit = Math.min(64, Math.max(16, options.maxCandidates * 16))
  const preferences = [
    {},
    ...boundedPoolPreferenceFrontier(pools, beamLimit),
  ]
  const candidates: HybridCartonizationCandidate[] = []
  const seen = new Set<string>()
  for (const preferenceMaterialGlobalIdsByPool of preferences) {
    const plan = planHybridCartonizationWithPreference(
      input,
      preferenceMaterialGlobalIdsByPool,
    )
    if (
      plan.status !== 'ready'
      || plan.blockers.length > 0
      || seen.has(plan.resultHash)
    ) {
      continue
    }
    seen.add(plan.resultHash)
    const preferredMaterials = unique(
      Object.values(preferenceMaterialGlobalIdsByPool),
    )
    candidates.push({
      candidateKey: `hcan-${plan.resultHash.slice(0, 20)}`,
      preferenceMaterialGlobalId:
        preferredMaterials.length === 1 ? preferredMaterials[0] : null,
      preferenceMaterialGlobalIdsByPool: {
        ...preferenceMaterialGlobalIdsByPool,
      },
      plan,
    })
    if (candidates.length === options.maxCandidates) break
  }
  return candidates
}
import { createHash } from 'node:crypto'

export const HYBRID_CARTONIZATION_POLICY_VERSION =
  'hybrid-cartonization-recipe-first-v1'
export const HYBRID_CARTONIZATION_ALGORITHM_VERSION =
  'hybrid-recipe-pooling-v4'
export const HYBRID_CARTONIZATION_CANDIDATE_POLICY_VERSION =
  'hybrid-cartonization-bounded-pool-beam-v2'
