import { createHash } from 'node:crypto'

import type {
  FreightClassificationEvidence,
  TransportDimensionsMm,
} from '@/lib/operations/transport'

/**
 * This is the public NMFTA 13-subprovision density scale that took effect on
 * July 19, 2025. It is a density recommendation, not an NMFC item database.
 * Handling, stowability, liability, or a commodity-specific rule can require
 * a different class and must be resolved before this output becomes evidence.
 */
export const LTL_DENSITY_CLASSIFIER_VERSION =
  'clawpilot.ltl_density_classification.v1' as const

export const LTL_DENSITY_CLASS_BANDS = Object.freeze([
  Object.freeze({ minimumPcf: 50, freightClass: '50' }),
  Object.freeze({ minimumPcf: 35, freightClass: '55' }),
  Object.freeze({ minimumPcf: 30, freightClass: '60' }),
  Object.freeze({ minimumPcf: 22.5, freightClass: '65' }),
  Object.freeze({ minimumPcf: 15, freightClass: '70' }),
  Object.freeze({ minimumPcf: 12, freightClass: '85' }),
  Object.freeze({ minimumPcf: 10, freightClass: '92.5' }),
  Object.freeze({ minimumPcf: 8, freightClass: '100' }),
  Object.freeze({ minimumPcf: 6, freightClass: '125' }),
  Object.freeze({ minimumPcf: 4, freightClass: '175' }),
  Object.freeze({ minimumPcf: 2, freightClass: '250' }),
  Object.freeze({ minimumPcf: 1, freightClass: '300' }),
  Object.freeze({ minimumPcf: 0, freightClass: '400' }),
] as const)

export const LTL_DENSITY_CLASSIFICATION_BLOCKERS = Object.freeze([
  'full_density_scale_not_confirmed',
  'mixed_commodities_require_item_classification',
  'handling_concern_requires_review',
  'stowability_concern_requires_review',
  'liability_concern_requires_review',
] as const)

export type LtlDensityClassificationBlocker =
  typeof LTL_DENSITY_CLASSIFICATION_BLOCKERS[number]

export type LtlDensityClassificationInput = Readonly<{
  handlingUnitKey: string
  description: string
  dimensionsMm: TransportDimensionsMm
  grossWeightGrams: number
  mixedCommodities: boolean
  fullDensityScaleConfirmed: boolean
  handlingConcern: boolean
  stowabilityConcern: boolean
  liabilityConcern: boolean
  classificationReference: string | null
  nmfcCode: string | null
}>

export type LtlDensityClassificationAssessment = Readonly<{
  contractVersion: typeof LTL_DENSITY_CLASSIFIER_VERSION
  inputHash: string
  handlingUnitKey: string
  description: string
  dimensionsMm: TransportDimensionsMm
  grossWeightGrams: number
  volumeCubicFeet: number
  densityPcf: number
  recommendedFreightClass: string
  mixedCommodities: boolean
  fullDensityScaleConfirmed: boolean
  handlingConcern: boolean
  stowabilityConcern: boolean
  liabilityConcern: boolean
  classificationReference: string | null
  nmfcCode: string | null
  evidenceEligible: boolean
  blockers: readonly LtlDensityClassificationBlocker[]
}>

const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/
const NMFC = /^[0-9]{3,6}(?:-[0-9]{1,2})?$/
const SHA256 = /^[a-f0-9]{64}$/
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/
const MAX_DIMENSION_MM = 10_000
const MAX_WEIGHT_GRAMS = 100_000_000

// International avoirdupois and inch definitions are exact.
const GRAMS_PER_POUND = 453.59237
const CUBIC_MILLIMETERS_PER_CUBIC_FOOT = 28_316_846.592

function fail(message: string): never {
  throw new Error(`LTL_FREIGHT_CLASSIFICATION_INVALID: ${message}`)
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be an object`)
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== null && prototype !== Object.prototype) {
    fail(`${label} must be a plain object`)
  }
  return value as Record<string, unknown>
}

function exactKeys(
  value: Record<string, unknown>,
  label: string,
  expected: readonly string[],
) {
  const unexpected = Object.keys(value).filter((key) => !expected.includes(key))
  const missing = expected.filter((key) => !(key in value))
  if (unexpected.length) fail(`${label}.${unexpected[0]} is not supported`)
  if (missing.length) fail(`${label}.${missing[0]} is required`)
}

function text(value: unknown, label: string, minimum: number, maximum: number) {
  if (typeof value !== 'string') fail(`${label} must be text`)
  const normalized = value.trim().replace(/\s+/g, ' ')
  if (
    normalized.length < minimum
    || normalized.length > maximum
    || CONTROL_CHARACTER.test(normalized)
  ) {
    fail(`${label} must be ${minimum}-${maximum} printable characters`)
  }
  return normalized
}

function optionalText(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
) {
  if (value === null) return null
  return text(value, label, minimum, maximum)
}

function integer(value: unknown, label: string, minimum: number, maximum: number) {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    fail(`${label} must be an integer from ${minimum} through ${maximum}`)
  }
  return Number(value)
}

function bool(value: unknown, label: string) {
  if (typeof value !== 'boolean') fail(`${label} must be boolean`)
  return value
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>
    return `{${Object.keys(source).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(source[key])}`
    )).join(',')}}`
  }
  return JSON.stringify(value)
}

function sha256(value: unknown) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const nested of Object.values(value as Record<string, unknown>)) {
    deepFreeze(nested)
  }
  return Object.freeze(value)
}

function rounded(value: number, places: number) {
  return Number(value.toFixed(places))
}

function normalizeDimensions(value: unknown): TransportDimensionsMm {
  const dimensions = record(value, 'assessment.dimensionsMm')
  exactKeys(dimensions, 'assessment.dimensionsMm', ['length', 'width', 'height'])
  return deepFreeze({
    length: integer(
      dimensions.length,
      'assessment.dimensionsMm.length',
      1,
      MAX_DIMENSION_MM,
    ),
    width: integer(
      dimensions.width,
      'assessment.dimensionsMm.width',
      1,
      MAX_DIMENSION_MM,
    ),
    height: integer(
      dimensions.height,
      'assessment.dimensionsMm.height',
      1,
      MAX_DIMENSION_MM,
    ),
  })
}

function normalizeInput(value: unknown): LtlDensityClassificationInput {
  const input = record(value, 'assessment')
  exactKeys(input, 'assessment', [
    'handlingUnitKey',
    'description',
    'dimensionsMm',
    'grossWeightGrams',
    'mixedCommodities',
    'fullDensityScaleConfirmed',
    'handlingConcern',
    'stowabilityConcern',
    'liabilityConcern',
    'classificationReference',
    'nmfcCode',
  ])
  const handlingUnitKey = text(input.handlingUnitKey, 'assessment.handlingUnitKey', 1, 120)
  if (!SAFE_KEY.test(handlingUnitKey)) {
    fail('assessment.handlingUnitKey contains unsupported characters')
  }
  const fullDensityScaleConfirmed = bool(
    input.fullDensityScaleConfirmed,
    'assessment.fullDensityScaleConfirmed',
  )
  const classificationReference = optionalText(
    input.classificationReference,
    'assessment.classificationReference',
    3,
    120,
  )
  if (fullDensityScaleConfirmed && classificationReference === null) {
    fail('assessment.classificationReference is required when the full density scale is confirmed')
  }
  const nmfcCode = optionalText(input.nmfcCode, 'assessment.nmfcCode', 3, 9)
  if (nmfcCode !== null && !NMFC.test(nmfcCode)) {
    fail('assessment.nmfcCode is invalid')
  }
  return deepFreeze({
    handlingUnitKey,
    description: text(input.description, 'assessment.description', 3, 160),
    dimensionsMm: normalizeDimensions(input.dimensionsMm),
    grossWeightGrams: integer(
      input.grossWeightGrams,
      'assessment.grossWeightGrams',
      1,
      MAX_WEIGHT_GRAMS,
    ),
    mixedCommodities: bool(
      input.mixedCommodities,
      'assessment.mixedCommodities',
    ),
    fullDensityScaleConfirmed,
    handlingConcern: bool(input.handlingConcern, 'assessment.handlingConcern'),
    stowabilityConcern: bool(
      input.stowabilityConcern,
      'assessment.stowabilityConcern',
    ),
    liabilityConcern: bool(input.liabilityConcern, 'assessment.liabilityConcern'),
    classificationReference,
    nmfcCode,
  })
}

function recommendedClass(densityPcf: number) {
  return LTL_DENSITY_CLASS_BANDS.find((band) => densityPcf >= band.minimumPcf)
    ?.freightClass || '400'
}

export function calculateLtlDensityClassification(
  value: unknown,
): LtlDensityClassificationAssessment {
  const input = normalizeInput(value)
  const cubicMillimeters = input.dimensionsMm.length
    * input.dimensionsMm.width
    * input.dimensionsMm.height
  const volumeCubicFeet = cubicMillimeters / CUBIC_MILLIMETERS_PER_CUBIC_FOOT
  const densityPcf = (input.grossWeightGrams / GRAMS_PER_POUND)
    / volumeCubicFeet
  if (!Number.isFinite(densityPcf) || densityPcf <= 0) {
    fail('assessment density could not be calculated')
  }
  const blockers: LtlDensityClassificationBlocker[] = []
  if (!input.fullDensityScaleConfirmed) {
    blockers.push('full_density_scale_not_confirmed')
  }
  if (input.mixedCommodities) {
    blockers.push('mixed_commodities_require_item_classification')
  }
  if (input.handlingConcern) blockers.push('handling_concern_requires_review')
  if (input.stowabilityConcern) blockers.push('stowability_concern_requires_review')
  if (input.liabilityConcern) blockers.push('liability_concern_requires_review')
  const hashInput = {
    contractVersion: LTL_DENSITY_CLASSIFIER_VERSION,
    ...input,
  }
  return deepFreeze({
    contractVersion: LTL_DENSITY_CLASSIFIER_VERSION,
    inputHash: sha256(hashInput),
    ...input,
    volumeCubicFeet: rounded(volumeCubicFeet, 6),
    densityPcf: rounded(densityPcf, 6),
    recommendedFreightClass: recommendedClass(densityPcf),
    evidenceEligible: blockers.length === 0,
    blockers,
  })
}

export function assertLtlDensityClassificationIntegrity(
  value: LtlDensityClassificationAssessment,
) {
  if (!value || value.contractVersion !== LTL_DENSITY_CLASSIFIER_VERSION) {
    fail('assessment contract version is invalid')
  }
  const recalculated = calculateLtlDensityClassification({
    handlingUnitKey: value.handlingUnitKey,
    description: value.description,
    dimensionsMm: value.dimensionsMm,
    grossWeightGrams: value.grossWeightGrams,
    mixedCommodities: value.mixedCommodities,
    fullDensityScaleConfirmed: value.fullDensityScaleConfirmed,
    handlingConcern: value.handlingConcern,
    stowabilityConcern: value.stowabilityConcern,
    liabilityConcern: value.liabilityConcern,
    classificationReference: value.classificationReference,
    nmfcCode: value.nmfcCode,
  })
  if (
    !SHA256.test(value.inputHash)
    || canonicalJson(recalculated) !== canonicalJson(value)
  ) {
    fail('assessment integrity check failed')
  }
  return recalculated
}

export function buildLtlDensityClassificationEvidence(input: {
  assessment: LtlDensityClassificationAssessment
  assessmentGlobalId: string
  capturedAt: string
  attestation: string
}): FreightClassificationEvidence {
  const assessment = assertLtlDensityClassificationIntegrity(input.assessment)
  if (!assessment.evidenceEligible || assessment.blockers.length > 0) {
    fail('assessment is advisory only and cannot authorize an LTL rate')
  }
  const assessmentGlobalId = text(
    input.assessmentGlobalId,
    'assessmentGlobalId',
    10,
    20,
  )
  if (!/^gfca(?:[0-9]{7}|[0-9a-v]{12})$/.test(assessmentGlobalId)) {
    fail('assessmentGlobalId is invalid')
  }
  const capturedAt = text(input.capturedAt, 'capturedAt', 24, 24)
  if (!ISO_INSTANT.test(capturedAt) || new Date(capturedAt).toISOString() !== capturedAt) {
    fail('capturedAt must be a canonical UTC instant')
  }
  const attestation = text(input.attestation, 'attestation', 10, 120)
  return deepFreeze({
    freightClass: assessment.recommendedFreightClass,
    nmfcCode: assessment.nmfcCode,
    source: 'density_calculation',
    reference: assessmentGlobalId,
    description: [
      `${assessment.description}; ${assessment.densityPcf.toFixed(6)} pcf`,
      `using ${LTL_DENSITY_CLASSIFIER_VERSION}`,
      `eligibility: ${assessment.classificationReference}`,
      `attestation: ${attestation}`,
    ].join('; '),
    capturedAt,
  })
}
