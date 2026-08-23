import { createHash } from 'node:crypto'
import type {
  HybridCartonizationLine,
  HybridCartonizationMaterial,
  HybridCartonizationResult,
} from '@/lib/operations/hybridCartonization'

export const SANDBOX_GEOMETRY_RATE_POLICY_VERSION =
  'sandbox-fixed-axis-one-unit-per-parcel-v1'

type DimensionsMm = {
  length: number
  width: number
  height: number
}

export type SandboxGeometryMaterialAssumption = {
  materialGlobalId: string
  expectedRowVersion: number
  ratedOuterDimensionsMm: DimensionsMm
  tareWeightGrams: number
}

export type SandboxGeometryRatePackage = {
  packageKey: string
  packageSequence: number
  /**
   * Truthful planner provenance for this deliberately narrow sandbox-only
   * path. This must never be presented or persisted as an OR-Tools result.
   */
  planningMethod: 'sandbox_fixed_axis'
  packagingMaterialGlobalId: string
  materialRowVersion: number
  recipes: []
  innerDimensionsMm: DimensionsMm
  ratedOuterDimensionsMm: DimensionsMm
  contentWeightGrams: number
  tareWeightGrams: number
  ratedGrossWeightGrams: number
  maxWeightGrams: number | null
  allocations: Array<{
    lineGlobalId: string
    productGlobalId: string
    title: string
    quantity: 1
  }>
  geometryEvidence: {
    policyVersion: typeof SANDBOX_GEOMETRY_RATE_POLICY_VERSION
    fitEnvelopeBasis: 'retained_material_fit_dimensions'
    rotationAllowed: false
    unitsPerPackage: 1
    linePackDimensionsMm: DimensionsMm
    packProfileVersionGlobalId: string
    packProfileVersionRowVersion: number
    materialDimensionBasis: HybridCartonizationMaterial['dimensionBasis']
    materialDimensionEvidenceType:
      HybridCartonizationMaterial['dimensionEvidenceType']
    materialDimensionEvidenceReference: string | null
    materialDimensionConfirmedAt: string
  }
}

export type SandboxGeometryRatePlanResult =
  | {
      status: 'ready'
      packages: SandboxGeometryRatePackage[]
      evidence: {
        policyVersion: typeof SANDBOX_GEOMETRY_RATE_POLICY_VERSION
        fitEnvelopeBasis: 'retained_material_fit_dimensions'
        rotationAllowed: false
        unitsPerPackage: 1
        materialStockAuthority: 'not_used_for_sandbox_comparison'
      }
    }
  | {
      status: 'blocked'
      packages: []
      blocker: {
        code: string
        detail: string
      }
    }

function dimensionsAreExact(value: DimensionsMm | null | undefined) {
  return Boolean(
    value
    && Number.isSafeInteger(value.length)
    && value.length > 0
    && Number.isSafeInteger(value.width)
    && value.width > 0
    && Number.isSafeInteger(value.height)
    && value.height > 0,
  )
}

function fixedAxisFit(item: DimensionsMm, envelope: DimensionsMm) {
  return (
    item.length <= envelope.length
    && item.width <= envelope.width
    && item.height <= envelope.height
  )
}

function volume(value: DimensionsMm) {
  return value.length * value.width * value.height
}

function packageKey(value: Record<string, unknown>) {
  return `sbgp-${createHash('sha256')
    .update(JSON.stringify(value))
    .digest('hex')
    .slice(0, 20)}`
}

function blocked(
  code: string,
  detail: string,
): SandboxGeometryRatePlanResult {
  return { status: 'blocked', packages: [], blocker: { code, detail } }
}

/**
 * Builds a deliberately conservative package-per-unit comparison for hybrid
 * lines that have current mapped pack evidence but no approved recipe.
 *
 * This function is not an operational cartonizer. It consumes the operator's
 * explicitly acknowledged exterior/tare assumptions only for carrier rating.
 * Physical fit uses the retained material dimensions with their actual basis,
 * never writes stock,
 * and never combines units. That keeps the comparison deterministic and
 * prevents an assumption-backed fit from being mistaken for
 * warehouse-executable packaging evidence.
 */
export function planSandboxGeometryRatePackages(input: {
  lines: HybridCartonizationLine[]
  fallbackLines: HybridCartonizationResult['geometryFallbackLines']
  materials: HybridCartonizationMaterial[]
  materialAssumptions: SandboxGeometryMaterialAssumption[]
  startingSequence: number
  maximumPackages: number
}): SandboxGeometryRatePlanResult {
  if (
    !Number.isSafeInteger(input.startingSequence)
    || input.startingSequence < 1
    || !Number.isSafeInteger(input.maximumPackages)
    || input.maximumPackages < 1
  ) {
    return blocked(
      'CARTONIZATION_RATE_EVIDENCE_SANDBOX_GEOMETRY_REQUEST_INVALID',
      'The sandbox geometry package bound is invalid.',
    )
  }
  const fallbackQuantity = input.fallbackLines.reduce(
    (total, line) => total + line.quantity,
    0,
  )
  if (
    !Number.isSafeInteger(fallbackQuantity)
    || fallbackQuantity < 1
    || fallbackQuantity > input.maximumPackages
  ) {
    return blocked(
      'CARTONIZATION_RATE_EVIDENCE_PACKAGE_COUNT_INVALID',
      `The sandbox geometry plan requires ${fallbackQuantity} package(s); `
        + `the remaining comparison bound is ${input.maximumPackages}.`,
    )
  }

  const linesByGlobalId = new Map(
    input.lines.map((line) => [line.lineGlobalId, line]),
  )
  const assumptionsByMaterial = new Map(
    input.materialAssumptions.map((assumption) => [
      assumption.materialGlobalId,
      assumption,
    ]),
  )
  const usableMaterials = input.materials
    .flatMap((material) => {
      const assumption = assumptionsByMaterial.get(
        material.materialGlobalId,
      )
      if (
        !assumption
        || assumption.expectedRowVersion !== material.currentRowVersion
        || material.capturedRowVersion !== material.currentRowVersion
        || material.isCurrent !== true
        || material.dimensionEvidenceType === 'unknown'
        || (
          material.dimensionEvidenceType !== 'measured'
          && (
            typeof material.dimensionEvidenceReference !== 'string'
            || material.dimensionEvidenceReference.trim().length < 1
          )
        )
        || typeof material.dimensionConfirmedAt !== 'string'
        || !Number.isFinite(Date.parse(material.dimensionConfirmedAt))
        || !dimensionsAreExact(material.innerDimensionsMm)
        || !dimensionsAreExact(assumption.ratedOuterDimensionsMm)
        || !fixedAxisFit(
          material.innerDimensionsMm,
          assumption.ratedOuterDimensionsMm,
        )
        || !Number.isSafeInteger(assumption.tareWeightGrams)
        || assumption.tareWeightGrams <= 0
      ) {
        return []
      }
      return [{ material, assumption }]
    })
    .sort((left, right) => (
      volume(left.assumption.ratedOuterDimensionsMm)
        - volume(right.assumption.ratedOuterDimensionsMm)
      || left.assumption.tareWeightGrams
        - right.assumption.tareWeightGrams
      || left.material.materialGlobalId.localeCompare(
        right.material.materialGlobalId,
      )
    ))
  if (usableMaterials.length < 1) {
    return blocked(
      'CARTONIZATION_RATE_EVIDENCE_MATERIAL_ASSUMPTIONS_MISSING',
      'No current selected material has retained dimension evidence plus exact sandbox exterior and tare assumptions.',
    )
  }

  const packages: SandboxGeometryRatePackage[] = []
  const fallbackLineIds = new Set<string>()
  for (const fallback of [...input.fallbackLines].sort((left, right) => (
    left.lineGlobalId.localeCompare(right.lineGlobalId)
  ))) {
    if (fallbackLineIds.has(fallback.lineGlobalId)) {
      return blocked(
        'CARTONIZATION_RATE_EVIDENCE_SANDBOX_GEOMETRY_LINE_INVALID',
        `Fallback line ${fallback.lineGlobalId} is duplicated.`,
      )
    }
    fallbackLineIds.add(fallback.lineGlobalId)
    const line = linesByGlobalId.get(fallback.lineGlobalId)
    const lineDimensions = line?.profile.outerDimensionsMm
    if (
      !line
      || line.productGlobalId !== fallback.productGlobalId
      || line.profile.fitModel !== fallback.fitModel
      || line.profile.isCurrent !== true
      || line.profile.capturedRowVersion
        !== line.profile.currentRowVersion
      || !dimensionsAreExact(lineDimensions)
      || !Number.isSafeInteger(line.unitWeightGrams)
      || line.unitWeightGrams <= 0
      || !Number.isSafeInteger(fallback.quantity)
      || fallback.quantity < 1
      || fallback.quantity > line.quantity
    ) {
      return blocked(
        'CARTONIZATION_RATE_EVIDENCE_SANDBOX_LINE_PACK_REQUIRED',
        `Line ${fallback.lineGlobalId} needs exact current mapped outer pack dimensions and weight for sandbox geometry rating.`,
      )
    }
    const exactLineDimensions = lineDimensions as DimensionsMm
    const selected = usableMaterials.find(({ material, assumption }) => {
      const grossWeight = line.unitWeightGrams + assumption.tareWeightGrams
      return (
        fixedAxisFit(
          exactLineDimensions,
          material.innerDimensionsMm,
        )
        && (
          material.maximumGrossWeightGrams === undefined
          || material.maximumGrossWeightGrams === null
          || grossWeight <= material.maximumGrossWeightGrams
        )
      )
    })
    if (!selected) {
      return blocked(
        'CARTONIZATION_RATE_EVIDENCE_SANDBOX_GEOMETRY_NO_FIT',
        `No selected material's retained dimensions fit one exact pack of ${line.title} without rotation.`,
      )
    }
    for (let unit = 1; unit <= fallback.quantity; unit += 1) {
      const sequence = input.startingSequence + packages.length
      const grossWeightGrams = line.unitWeightGrams
        + selected.assumption.tareWeightGrams
      const keyEvidence = {
        policyVersion: SANDBOX_GEOMETRY_RATE_POLICY_VERSION,
        sequence,
        lineGlobalId: line.lineGlobalId,
        productGlobalId: line.productGlobalId,
        unit,
        packProfileVersionGlobalId: line.profile.versionGlobalId,
        packProfileVersionRowVersion: line.profile.currentRowVersion,
        materialGlobalId: selected.material.materialGlobalId,
        materialRowVersion: selected.material.currentRowVersion,
        linePackDimensionsMm: exactLineDimensions,
        ratedOuterDimensionsMm:
          selected.assumption.ratedOuterDimensionsMm,
        contentWeightGrams: line.unitWeightGrams,
        tareWeightGrams: selected.assumption.tareWeightGrams,
      }
      packages.push({
        packageKey: packageKey(keyEvidence),
        packageSequence: sequence,
        planningMethod: 'sandbox_fixed_axis',
        packagingMaterialGlobalId:
          selected.material.materialGlobalId,
        materialRowVersion: selected.material.currentRowVersion,
        recipes: [],
        innerDimensionsMm: selected.material.innerDimensionsMm,
        ratedOuterDimensionsMm:
          selected.assumption.ratedOuterDimensionsMm,
        contentWeightGrams: line.unitWeightGrams,
        tareWeightGrams: selected.assumption.tareWeightGrams,
        ratedGrossWeightGrams: grossWeightGrams,
        maxWeightGrams:
          selected.material.maximumGrossWeightGrams ?? null,
        allocations: [{
          lineGlobalId: line.lineGlobalId,
          productGlobalId: line.productGlobalId,
          title: line.title,
          quantity: 1,
        }],
        geometryEvidence: {
          policyVersion: SANDBOX_GEOMETRY_RATE_POLICY_VERSION,
          fitEnvelopeBasis:
            'retained_material_fit_dimensions',
          rotationAllowed: false,
          unitsPerPackage: 1,
          linePackDimensionsMm: exactLineDimensions,
          packProfileVersionGlobalId: line.profile.versionGlobalId,
          packProfileVersionRowVersion:
            line.profile.currentRowVersion,
          materialDimensionBasis: selected.material.dimensionBasis,
          materialDimensionEvidenceType:
            selected.material.dimensionEvidenceType,
          materialDimensionEvidenceReference:
            selected.material.dimensionEvidenceReference,
          materialDimensionConfirmedAt:
            selected.material.dimensionConfirmedAt || '',
        },
      })
    }
  }
  return {
    status: 'ready',
    packages,
    evidence: {
      policyVersion: SANDBOX_GEOMETRY_RATE_POLICY_VERSION,
      fitEnvelopeBasis: 'retained_material_fit_dimensions',
      rotationAllowed: false,
      unitsPerPackage: 1,
      materialStockAuthority: 'not_used_for_sandbox_comparison',
    },
  }
}
