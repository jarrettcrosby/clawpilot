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

export type HybridCartonizationResult = {
  status: 'ready' | 'blocked'
  policyVersion: typeof HYBRID_CARTONIZATION_POLICY_VERSION
  algorithmVersion: typeof HYBRID_CARTONIZATION_ALGORITHM_VERSION
  inputHash: string
  resultHash: string
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
    recipe.maximumInputQuantity,
    option.appliedMinimumInputQuantity,
    option.minimumBasis,
  ].join('|')
}

function buildSharedOptions(lines: PlannedLine[]): SharedOption[] {
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
      left.maximumInputQuantity - right.maximumInputQuantity
      || left.packagingMaterialGlobalId.localeCompare(
        right.packagingMaterialGlobalId,
      )
    ))
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
      ratedWeightGrams: option.material.tareWeightGrams === null
        ? null
        : contentWeightGrams + option.material.tareWeightGrams,
      blockers: rateBlockers,
    },
    recipeEvidence,
  }
}

function unique(values: string[]) {
  return [...new Set(values)].sort()
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
export function planHybridCartonization(
  input: HybridCartonizationInput,
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
  const recipePackages: HybridRecipePackage[] = []
  const geometryFallbackLines:
    HybridCartonizationResult['geometryFallbackLines'] = []
  const assumptions = new Map<
    string,
    HybridCartonizationResult['assumptions'][number]
  >()
  const plannedLines: PlannedLine[] = []

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
    const sharedOptions = buildSharedOptions(lines)
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
      const singlePackage = sharedOptions.find((option) => (
        totalRemaining >= option.minimumInputQuantity
        && totalRemaining <= option.maximumInputQuantity
      ))
      const overflowPackage = [...sharedOptions]
        .reverse()
        .find((option) => (
          totalRemaining > option.maximumInputQuantity
          && option.maximumInputQuantity >= option.minimumInputQuantity
        ))
      const selectedOption = singlePackage ?? overflowPackage
      if (!selectedOption) break
      const targetQuantity = singlePackage
        ? totalRemaining
        : selectedOption.maximumInputQuantity
      const recipePackage = allocatePackage(
        lines,
        selectedOption,
        targetQuantity,
        recipePackages.length + 1,
      )
      recipePackages.push(recipePackage)
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
import { createHash } from 'node:crypto'

export const HYBRID_CARTONIZATION_POLICY_VERSION =
  'hybrid-cartonization-recipe-first-v1'
export const HYBRID_CARTONIZATION_ALGORITHM_VERSION =
  'hybrid-recipe-pooling-v1'
