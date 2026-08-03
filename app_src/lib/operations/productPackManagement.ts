export const PRODUCT_PACK_LEVELS = ['each', 'case'] as const
export const PRODUCT_PACK_PROFILE_STATUSES = ['draft', 'active'] as const
export const PRODUCT_PACK_VERSION_STATES = [
  'draft',
  'customer_confirmed',
  'active',
] as const
export const PRODUCT_PACK_DIMENSION_BASES = [
  'outer',
  'unspecified',
] as const
export const PRODUCT_PACK_WEIGHT_BASES = [
  'measured',
  'provider',
  'customer_stated',
  'derived',
  'unspecified',
] as const
export const PRODUCT_PACK_FIT_MODELS = [
  'rigid_3d',
  'compressible',
  'approved_recipe_only',
] as const
export const PRODUCT_PACK_ASSEMBLY_POLICIES = [
  'never',
  'allow_from_child',
  'required_from_child',
] as const
export const PRODUCT_PACK_EVIDENCE_TYPES = [
  'unknown',
  'customer_confirmed',
  'measured',
  'provider',
  'derived',
] as const
export const PRODUCT_PACK_SOURCES = [
  'manual',
  'csv_import',
  'provider_sync',
  'customer_supplied',
] as const
export const PRODUCT_PACK_MAPPING_PURPOSES = [
  'catalog',
  'shopify_checkout',
] as const
export const PRODUCT_PACK_RECIPE_TYPES = [
  'exact_case',
  'max_capacity',
  'ship_ready_unit',
] as const
export const PRODUCT_PACK_FULFILLMENT_POLICIES = [
  'case_required',
  'prefer_full_case',
  'each_pick_only',
] as const
export const PRODUCT_PACK_REMAINDER_POLICIES = [
  'case_plus_each',
  'all_each',
  'block',
] as const
export const PRODUCT_PACK_INVENTORY_REQUIREMENTS = [
  'pack_level_required',
  'each_assembly_allowed',
  'either',
] as const
export const PRODUCT_PACK_RECIPE_ASSEMBLY_POLICIES = [
  'never',
  'allowed',
  'required',
] as const
export const PRODUCT_PACK_RECIPE_STATES = [
  'draft',
  'customer_confirmed',
  'active',
] as const

export type ProductPackLevel = typeof PRODUCT_PACK_LEVELS[number]
export type ProductPackProfileStatus =
  typeof PRODUCT_PACK_PROFILE_STATUSES[number]
export type ProductPackVersionState =
  typeof PRODUCT_PACK_VERSION_STATES[number]
export type ProductPackDimensionBasis =
  typeof PRODUCT_PACK_DIMENSION_BASES[number]
export type ProductPackWeightBasis =
  typeof PRODUCT_PACK_WEIGHT_BASES[number]
export type ProductPackFitModel =
  typeof PRODUCT_PACK_FIT_MODELS[number]
export type ProductPackAssemblyPolicy =
  typeof PRODUCT_PACK_ASSEMBLY_POLICIES[number]
export type ProductPackEvidenceType =
  typeof PRODUCT_PACK_EVIDENCE_TYPES[number]
export type ProductPackSource = typeof PRODUCT_PACK_SOURCES[number]
export type ProductPackMappingPurpose =
  typeof PRODUCT_PACK_MAPPING_PURPOSES[number]
export type ProductPackRecipeType =
  typeof PRODUCT_PACK_RECIPE_TYPES[number]
export type ProductPackFulfillmentPolicy =
  typeof PRODUCT_PACK_FULFILLMENT_POLICIES[number]
export type ProductPackRemainderPolicy =
  typeof PRODUCT_PACK_REMAINDER_POLICIES[number]
export type ProductPackInventoryRequirement =
  typeof PRODUCT_PACK_INVENTORY_REQUIREMENTS[number]
export type ProductPackRecipeAssemblyPolicy =
  typeof PRODUCT_PACK_RECIPE_ASSEMBLY_POLICIES[number]
export type ProductPackRecipeState =
  typeof PRODUCT_PACK_RECIPE_STATES[number]

export type ProductPackProfileVersionInput = {
  productGlobalId: string
  profileGlobalId: string | null
  expectedProfileRowVersion: number | null
  expectedCurrentVersionGlobalId: string | null
  expectedCurrentVersionRowVersion: number | null
  profileKey: string
  profileName: string
  packageLevel: ProductPackLevel
  isDefault: boolean
  profileStatus: ProductPackProfileStatus
  lifecycleState: ProductPackVersionState
  baseEachQuantity: number
  unitOfMeasure: 'each' | 'case'
  dimensionsMm: {
    length: number
    width: number
    height: number
  } | null
  dimensionBasis: ProductPackDimensionBasis
  grossWeightGrams: number | null
  weightBasis: ProductPackWeightBasis
  fitModel: ProductPackFitModel
  shipsAsOwnPackage: boolean
  assemblyPolicy: ProductPackAssemblyPolicy
  evidenceType: ProductPackEvidenceType
  evidenceReference: string | null
  source: ProductPackSource
  providerWeightEvidence: {
    channelStateGlobalId: string
    expectedChannelStateRowVersion: number
  } | null
}

export type ProductPackVariantMappingInput = {
  productGlobalId: string
  channelStateGlobalId: string
  expectedChannelStateRowVersion: number
  profileVersionGlobalId: string
  expectedProfileVersionRowVersion: number
  expectedCurrentMappingGlobalId: string | null
  expectedCurrentMappingRowVersion: number | null
  purpose: ProductPackMappingPurpose
}

export type ApprovedPackRecipeInput = {
  productGlobalId: string
  recipeGlobalId: string | null
  expectedRecipeRowVersion: number | null
  recipeKey: string
  recipeName: string
  inputProfileVersionGlobalId: string
  expectedInputProfileVersionRowVersion: number
  outputProfileVersionGlobalId: string
  expectedOutputProfileVersionRowVersion: number
  packagingMaterialGlobalId: string
  expectedPackagingMaterialRowVersion: number
  inputQuantity: number
  outputQuantity: number
  packagingMaterialQuantity: number
  recipeType: ProductPackRecipeType
  minimumInputQuantity: number | null
  contentCompatibilityKey: string | null
  allowsMixedProducts: boolean
  fulfillmentPolicy: ProductPackFulfillmentPolicy
  remainderPolicy: ProductPackRemainderPolicy
  inventoryEvidenceRequirement: ProductPackInventoryRequirement
  assemblyPolicy: ProductPackRecipeAssemblyPolicy
  exclusiveContents: boolean
  lifecycleState: ProductPackRecipeState
  fitEvidenceType: ProductPackEvidenceType
  fitEvidenceReference: string | null
  source: ProductPackSource
}

export class ProductPackInputError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'ProductPackInputError'
    this.code = code
  }
}

function invalid(code: string, message: string): never {
  throw new ProductPackInputError(code, message)
}

function completeDimensions(
  dimensions: ProductPackProfileVersionInput['dimensionsMm'],
) {
  return Boolean(
    dimensions
    && Number.isSafeInteger(dimensions.length)
    && dimensions.length > 0
    && Number.isSafeInteger(dimensions.width)
    && dimensions.width > 0
    && Number.isSafeInteger(dimensions.height)
    && dimensions.height > 0,
  )
}

export function validateProductPackProfileVersionInput(
  input: ProductPackProfileVersionInput,
) {
  if (
    (input.dimensionsMm === null)
    !== (input.dimensionBasis === 'unspecified')
  ) {
    invalid(
      'PRODUCT_PACK_DIMENSION_EVIDENCE_INVALID',
      'Outer dimensions and their basis must be supplied together',
    )
  }
  if (
    (input.grossWeightGrams === null)
    !== (input.weightBasis === 'unspecified')
  ) {
    invalid(
      'PRODUCT_PACK_WEIGHT_EVIDENCE_INVALID',
      'Gross weight and its basis must be supplied together',
    )
  }
  if (
    input.packageLevel === 'each'
    && (
      input.unitOfMeasure !== 'each'
      || input.baseEachQuantity !== 1
    )
  ) {
    invalid(
      'PRODUCT_PACK_EACH_QUANTITY_INVALID',
      'An each profile must use the each unit of measure and represent exactly one base each',
    )
  }
  if (
    input.packageLevel === 'case'
    && (
      input.unitOfMeasure !== 'case'
      || !Number.isSafeInteger(input.baseEachQuantity)
      || input.baseEachQuantity < 2
    )
  ) {
    invalid(
      'PRODUCT_PACK_CASE_QUANTITY_INVALID',
      'A case profile must use the case unit of measure and contain at least two base eaches',
    )
  }
  if (
    (input.profileStatus === 'active')
    !== (input.lifecycleState === 'active')
  ) {
    invalid(
      'PRODUCT_PACK_ACTIVATION_STATE_INVALID',
      'The stable profile and its new version must be activated together',
    )
  }
  if (input.lifecycleState === 'active') {
    if (
      !completeDimensions(input.dimensionsMm)
      || input.dimensionBasis !== 'outer'
    ) {
      invalid(
        'PRODUCT_PACK_ACTIVE_DIMENSIONS_REQUIRED',
        'Activation requires complete positive outer dimensions',
      )
    }
    if (
      !Number.isSafeInteger(input.grossWeightGrams)
      || Number(input.grossWeightGrams) < 1
      || input.weightBasis === 'unspecified'
    ) {
      invalid(
        'PRODUCT_PACK_ACTIVE_WEIGHT_REQUIRED',
        'Activation requires a positive evidenced gross weight',
      )
    }
    if (
      input.evidenceType === 'unknown'
      || !input.evidenceReference?.trim()
    ) {
      invalid(
        'PRODUCT_PACK_ACTIVE_EVIDENCE_REQUIRED',
        'Activation requires an evidence type and reference',
      )
    }
  }
  if (
    input.weightBasis === 'provider'
    && (
      !input.providerWeightEvidence
      || input.evidenceType !== 'provider'
    )
  ) {
    invalid(
      'PRODUCT_PACK_PROVIDER_WEIGHT_EVIDENCE_REQUIRED',
      'Provider weight requires provider evidence and the exact retained channel-state revision',
    )
  }
  if (
    input.weightBasis !== 'provider'
    && input.providerWeightEvidence
  ) {
    invalid(
      'PRODUCT_PACK_PROVIDER_WEIGHT_EVIDENCE_INVALID',
      'Provider weight evidence is valid only when the weight basis is provider',
    )
  }
  if (
    input.fitModel === 'approved_recipe_only'
    && (
      input.evidenceType === 'unknown'
      || !input.evidenceReference?.trim()
    )
  ) {
    invalid(
      'PRODUCT_PACK_RECIPE_ONLY_EVIDENCE_REQUIRED',
      'Recipe-only pack profiles require explicit evidence',
    )
  }
  return input
}

export function validateApprovedPackRecipeInput(
  input: ApprovedPackRecipeInput,
) {
  if (
    input.inputProfileVersionGlobalId
    === input.outputProfileVersionGlobalId
  ) {
    invalid(
      'PRODUCT_PACK_RECIPE_ENDPOINTS_INVALID',
      'Recipe input and output pack versions must be different',
    )
  }
  for (const [label, value] of [
    ['input quantity', input.inputQuantity],
    ['output quantity', input.outputQuantity],
    ['packaging material quantity', input.packagingMaterialQuantity],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 1) {
      invalid(
        'PRODUCT_PACK_RECIPE_QUANTITY_INVALID',
        `Recipe ${label} must be a positive integer`,
      )
    }
  }
  if (
    input.recipeType === 'exact_case'
    && input.outputQuantity !== 1
  ) {
    invalid(
      'PRODUCT_PACK_EXACT_CASE_OUTPUT_INVALID',
      'An exact-case recipe must produce exactly one case',
    )
  }
  if (
    input.recipeType === 'max_capacity'
    && input.lifecycleState === 'active'
    && (
      !Number.isSafeInteger(input.minimumInputQuantity)
      || Number(input.minimumInputQuantity) < 1
      || Number(input.minimumInputQuantity) > input.inputQuantity
    )
  ) {
    invalid(
      'PRODUCT_PACK_RECIPE_MINIMUM_REQUIRED',
      'An active max-capacity recipe requires a confirmed minimum no greater than its maximum',
    )
  }
  if (
    input.recipeType !== 'max_capacity'
    && input.minimumInputQuantity !== null
  ) {
    invalid(
      'PRODUCT_PACK_RECIPE_MINIMUM_INVALID',
      'Only a max-capacity recipe may define a minimum input quantity',
    )
  }
  if (
    input.allowsMixedProducts
    && (
      input.recipeType !== 'max_capacity'
      || input.exclusiveContents
      || !input.contentCompatibilityKey
      || !['customer_confirmed', 'measured'].includes(
        input.fitEvidenceType,
      )
      || !input.fitEvidenceReference?.trim()
    )
  ) {
    invalid(
      'PRODUCT_PACK_MIXED_RECIPE_EVIDENCE_REQUIRED',
      'Mixed-product recipes require a nonexclusive max-capacity compatibility class and customer-confirmed or measured fit evidence',
    )
  }
  if (
    input.lifecycleState === 'active'
    && (
      input.fitEvidenceType === 'unknown'
      || !input.fitEvidenceReference?.trim()
    )
  ) {
    invalid(
      'PRODUCT_PACK_ACTIVE_RECIPE_EVIDENCE_REQUIRED',
      'Recipe activation requires confirmed fit evidence',
    )
  }
  return input
}
