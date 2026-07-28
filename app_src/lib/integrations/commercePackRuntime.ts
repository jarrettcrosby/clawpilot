export type CommerceRuntimeDimensions = {
  length: number
  width: number
  height: number
}

export type CommerceRuntimeProviderPackaging = {
  weightGrams: number
  dimensionsMm: CommerceRuntimeDimensions
}

export type CommerceRuntimePackageLevel =
  | 'each'
  | 'inner_pack'
  | 'case'
  | 'pallet'

export type CommerceRuntimePackMapping = {
  id: string
  globalId: string
  rowVersion: number
  productId: string
  productMappingId: string
  externalProductId: string
  externalVariantId: string
  projectionState: string
  isCurrent: boolean
  sourceRevision: string | null
  sourceHash: string | null
  profileVersionId: string
  profileVersionGlobalId: string
  profileVersionRowVersion: number
  profileVersionIsCurrent: boolean
  profileLifecycleState: string
  profileStatus: string
  packageLevel: string
  baseEachQuantity: number
  lengthMm: number | null
  widthMm: number | null
  heightMm: number | null
  dimensionBasis: string
  grossWeightGrams: number | null
  weightBasis: string
  evidenceType: string
  channelSourceRevision: string | null
  channelSourceHash: string | null
  channelWeightGrams: number | null
}

export type CommerceRuntimePackResolution = {
  association: {
    mappingId: string
    mappingGlobalId: string
    mappingRowVersion: number
    profileVersionId: string
    profileVersionGlobalId: string
    profileVersionRowVersion: number
    packageLevel: CommerceRuntimePackageLevel
    baseEachQuantity: number
  } | null
  packaging: {
    source: 'variant_pack_mapping'
    weightSource:
      | 'profile_version'
      | 'provider_order'
      | 'provider_catalog'
    weightGrams: number
    dimensionsMm: CommerceRuntimeDimensions
  } | null
  reason:
    | 'no_mapping'
    | 'mapping_stale'
    | 'pack_evidence_ineligible'
    | 'pack_quantity_conflict'
    | 'provider_dimensions_conflict'
    | 'weight_required'
    | 'resolved'
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0
}

function exactDimensions(
  value: CommerceRuntimeDimensions | null,
): value is CommerceRuntimeDimensions {
  return Boolean(
    value
    && positiveInteger(value.length)
    && positiveInteger(value.width)
    && positiveInteger(value.height),
  )
}

function sameDimensions(
  left: CommerceRuntimeDimensions,
  right: CommerceRuntimeDimensions,
) {
  return left.length === right.length
    && left.width === right.width
    && left.height === right.height
}

export function resolveCommerceRuntimePack(input: {
  mapping: CommerceRuntimePackMapping | null
  providerUnitMultiplier: number | null
  providerPackaging: CommerceRuntimeProviderPackaging | null
}): CommerceRuntimePackResolution {
  const mapping = input.mapping
  if (!mapping) {
    return {
      association: null,
      packaging: null,
      reason: 'no_mapping',
    }
  }
  if (
    !mapping.isCurrent
    || mapping.projectionState !== 'current'
    || !mapping.sourceRevision
    || !mapping.sourceHash
    || mapping.sourceRevision !== mapping.channelSourceRevision
    || mapping.sourceHash !== mapping.channelSourceHash
  ) {
    return {
      association: null,
      packaging: null,
      reason: 'mapping_stale',
    }
  }
  const dimensions = (
    positiveInteger(mapping.lengthMm)
    && positiveInteger(mapping.widthMm)
    && positiveInteger(mapping.heightMm)
  )
    ? {
        length: mapping.lengthMm,
        width: mapping.widthMm,
        height: mapping.heightMm,
      }
    : null
  if (
    !mapping.profileVersionIsCurrent
    || !['customer_confirmed', 'active'].includes(
      mapping.profileLifecycleState,
    )
    || mapping.profileStatus === 'retired'
    || !['customer_confirmed', 'measured', 'provider'].includes(
      mapping.evidenceType,
    )
    || mapping.dimensionBasis !== 'outer'
    || !exactDimensions(dimensions)
    || !positiveInteger(mapping.baseEachQuantity)
    || !['each', 'inner_pack', 'case', 'pallet'].includes(
      mapping.packageLevel,
    )
  ) {
    return {
      association: null,
      packaging: null,
      reason: 'pack_evidence_ineligible',
    }
  }
  const association = {
    mappingId: mapping.id,
    mappingGlobalId: mapping.globalId,
    mappingRowVersion: mapping.rowVersion,
    profileVersionId: mapping.profileVersionId,
    profileVersionGlobalId: mapping.profileVersionGlobalId,
    profileVersionRowVersion: mapping.profileVersionRowVersion,
    packageLevel: mapping.packageLevel as CommerceRuntimePackageLevel,
    baseEachQuantity: mapping.baseEachQuantity,
  }
  if (
    input.providerUnitMultiplier !== null
    && (
      !positiveInteger(input.providerUnitMultiplier)
      || input.providerUnitMultiplier !== mapping.baseEachQuantity
    )
  ) {
    return {
      association,
      packaging: null,
      reason: 'pack_quantity_conflict',
    }
  }
  if (
    input.providerPackaging
    && !sameDimensions(input.providerPackaging.dimensionsMm, dimensions)
  ) {
    return {
      association,
      packaging: null,
      reason: 'provider_dimensions_conflict',
    }
  }
  const weight = positiveInteger(mapping.grossWeightGrams)
    && mapping.weightBasis !== 'unspecified'
    ? {
        source: 'profile_version' as const,
        value: mapping.grossWeightGrams,
      }
    : input.providerPackaging
      && positiveInteger(input.providerPackaging.weightGrams)
      ? {
          source: 'provider_order' as const,
          value: input.providerPackaging.weightGrams,
        }
      : positiveInteger(mapping.channelWeightGrams)
        ? {
            source: 'provider_catalog' as const,
            value: mapping.channelWeightGrams,
          }
        : null
  if (!weight) {
    return {
      association,
      packaging: null,
      reason: 'weight_required',
    }
  }
  return {
    association,
    packaging: {
      source: 'variant_pack_mapping',
      weightSource: weight.source,
      weightGrams: weight.value,
      dimensionsMm: dimensions,
    },
    reason: 'resolved',
  }
}
