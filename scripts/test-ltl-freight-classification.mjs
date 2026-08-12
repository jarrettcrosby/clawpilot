#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()
const sourcePath = 'app_src/lib/operations/freightClassification.ts'
const migrationPath = 'db/migrations/0271_operations_ltl_freight_classification.sql'
const requireFromApp = createRequire(
  new URL('../app_src/package.json', import.meta.url),
)
const nodeRequire = createRequire(import.meta.url)
const ts = requireFromApp('typescript')

function read(path) {
  return readFileSync(resolve(root, path), 'utf8')
}

function plain(value) {
  return JSON.parse(JSON.stringify(value))
}

function clone(value) {
  return plain(value)
}

function assertDeepFrozen(value, label = 'value') {
  if (!value || typeof value !== 'object') return
  assert.equal(Object.isFrozen(value), true, `${label} must be frozen`)
  for (const [key, nested] of Object.entries(value)) {
    assertDeepFrozen(nested, `${label}.${key}`)
  }
}

function loadFoundation() {
  const source = read(sourcePath)
  const result = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: sourcePath,
    reportDiagnostics: true,
  })
  const errors = (result.diagnostics || []).filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  )
  assert.deepEqual(errors, [], 'The freight-classification foundation must transpile')
  const module = { exports: {} }
  const execute = new Function(
    'exports',
    'module',
    'require',
    `${result.outputText}\n//# sourceURL=${sourcePath}`,
  )
  execute(module.exports, module, nodeRequire)
  return module.exports
}

const source = read(sourcePath)
assert.deepEqual(
  [...source.matchAll(/^import .* from ['"]([^'"]+)['"]$/gm)]
    .map((match) => match[1]),
  ['node:crypto'],
  'The clean-room classifier may import only deterministic hashing support',
)
assert.doesNotMatch(source, /\bfetch\s*\(/)
assert.doesNotMatch(source, /process\.env|DATABASE_URL|credential_ciphertext/)

const classification = loadFoundation()
assert.deepEqual(
  Object.keys(classification).sort(),
  [
    'LTL_DENSITY_CLASSIFICATION_BLOCKERS',
    'LTL_DENSITY_CLASSIFIER_VERSION',
    'LTL_DENSITY_CLASS_BANDS',
    'assertLtlDensityClassificationIntegrity',
    'buildLtlDensityClassificationEvidence',
    'calculateLtlDensityClassification',
  ].sort(),
)

const {
  LTL_DENSITY_CLASSIFICATION_BLOCKERS,
  LTL_DENSITY_CLASSIFIER_VERSION,
  LTL_DENSITY_CLASS_BANDS,
  assertLtlDensityClassificationIntegrity,
  buildLtlDensityClassificationEvidence,
  calculateLtlDensityClassification,
} = classification

assert.equal(
  LTL_DENSITY_CLASSIFIER_VERSION,
  'clawpilot.ltl_density_classification.v1',
)

// NMFTA's public 13-subprovision full-density scale, effective July 19, 2025.
// The values here intentionally stand independently from the implementation.
const officialBands = [
  { minimumPcf: 50, freightClass: '50' },
  { minimumPcf: 35, freightClass: '55' },
  { minimumPcf: 30, freightClass: '60' },
  { minimumPcf: 22.5, freightClass: '65' },
  { minimumPcf: 15, freightClass: '70' },
  { minimumPcf: 12, freightClass: '85' },
  { minimumPcf: 10, freightClass: '92.5' },
  { minimumPcf: 8, freightClass: '100' },
  { minimumPcf: 6, freightClass: '125' },
  { minimumPcf: 4, freightClass: '175' },
  { minimumPcf: 2, freightClass: '250' },
  { minimumPcf: 1, freightClass: '300' },
  { minimumPcf: 0, freightClass: '400' },
]
assert.deepEqual(plain(LTL_DENSITY_CLASS_BANDS), officialBands)
assert.deepEqual(plain(LTL_DENSITY_CLASSIFICATION_BLOCKERS), [
  'full_density_scale_not_confirmed',
  'mixed_commodities_require_item_classification',
  'handling_concern_requires_review',
  'stowability_concern_requires_review',
  'liability_concern_requires_review',
])
assertDeepFrozen(LTL_DENSITY_CLASS_BANDS, 'LTL_DENSITY_CLASS_BANDS')
assertDeepFrozen(
  LTL_DENSITY_CLASSIFICATION_BLOCKERS,
  'LTL_DENSITY_CLASSIFICATION_BLOCKERS',
)

const GRAMS_PER_POUND = 453.59237
const CUBIC_MILLIMETERS_PER_CUBIC_FOOT = 28_316_846.592
const boundaryDimensions = { length: 1_000, width: 1_000, height: 1_000 }
const boundaryVolumeCubicFeet = (
  boundaryDimensions.length
  * boundaryDimensions.width
  * boundaryDimensions.height
) / CUBIC_MILLIMETERS_PER_CUBIC_FOOT

function input(overrides = {}) {
  return {
    handlingUnitKey: 'pallet-density-1',
    description: 'Single commodity pallet as tendered',
    dimensionsMm: { ...boundaryDimensions },
    grossWeightGrams: 250_000,
    mixedCommodities: false,
    fullDensityScaleConfirmed: true,
    handlingConcern: false,
    stowabilityConcern: false,
    liabilityConcern: false,
    classificationReference: 'operator-confirmed-full-density-scale',
    nmfcCode: null,
    ...overrides,
  }
}

function rawDensityPcf(grossWeightGrams, dimensionsMm = boundaryDimensions) {
  const volumeCubicFeet = (
    dimensionsMm.length * dimensionsMm.width * dimensionsMm.height
  ) / CUBIC_MILLIMETERS_PER_CUBIC_FOOT
  return (grossWeightGrams / GRAMS_PER_POUND) / volumeCubicFeet
}

// One gram on either side of every nonzero threshold proves the inclusive
// lower bound without depending on the rounded density exposed to callers.
for (let index = 0; index < officialBands.length - 1; index += 1) {
  const band = officialBands[index]
  const nextBand = officialBands[index + 1]
  const exactBoundaryWeight = (
    band.minimumPcf * boundaryVolumeCubicFeet * GRAMS_PER_POUND
  )
  const atOrAboveWeight = Math.ceil(exactBoundaryWeight)
  const belowWeight = atOrAboveWeight - 1
  assert.ok(rawDensityPcf(atOrAboveWeight) >= band.minimumPcf)
  assert.ok(rawDensityPcf(belowWeight) < band.minimumPcf)

  const atOrAbove = calculateLtlDensityClassification(input({
    handlingUnitKey: `boundary-${band.freightClass}-at-or-above`,
    grossWeightGrams: atOrAboveWeight,
  }))
  const below = calculateLtlDensityClassification(input({
    handlingUnitKey: `boundary-${band.freightClass}-below`,
    grossWeightGrams: belowWeight,
  }))
  assert.equal(
    atOrAbove.recommendedFreightClass,
    band.freightClass,
    `${band.minimumPcf} pcf must enter class ${band.freightClass}`,
  )
  assert.equal(
    below.recommendedFreightClass,
    nextBand.freightClass,
    `A value immediately below ${band.minimumPcf} pcf must remain class ${nextBand.freightClass}`,
  )
}

assert.equal(
  calculateLtlDensityClassification(input({ grossWeightGrams: 1 }))
    .recommendedFreightClass,
  '400',
  'Every positive density below 1 pcf must remain class 400',
)

const invalidCases = [
  [null, /assessment must be an object/],
  [{ ...input(), unexpected: true }, /assessment\.unexpected is not supported/],
  [(() => {
    const value = input()
    delete value.description
    return value
  })(), /assessment\.description is required/],
  [{ ...input(), handlingUnitKey: 'bad key' }, /unsupported characters/],
  [{ ...input(), description: 'x' }, /description must be 3-160/],
  [{ ...input(), dimensionsMm: { ...boundaryDimensions, length: 0 } }, /length must be an integer/],
  [{ ...input(), dimensionsMm: { ...boundaryDimensions, width: 10_001 } }, /width must be an integer/],
  [{ ...input(), dimensionsMm: { ...boundaryDimensions, height: 1.5 } }, /height must be an integer/],
  [{ ...input(), dimensionsMm: { ...boundaryDimensions, depth: 1 } }, /depth is not supported/],
  [{ ...input(), grossWeightGrams: 0 }, /grossWeightGrams must be an integer/],
  [{ ...input(), grossWeightGrams: 1.5 }, /grossWeightGrams must be an integer/],
  [{ ...input(), grossWeightGrams: 100_000_001 }, /grossWeightGrams must be an integer/],
  [{ ...input(), mixedCommodities: 'false' }, /mixedCommodities must be boolean/],
  [{ ...input(), fullDensityScaleConfirmed: true, classificationReference: null }, /classificationReference is required/],
  [{ ...input(), classificationReference: 'x' }, /classificationReference must be 3-120/],
  [{ ...input(), nmfcCode: '12A456' }, /nmfcCode is invalid/],
  [{ ...input(), nmfcCode: '123456-123' }, /nmfcCode must be 3-9/],
]
for (const [value, expected] of invalidCases) {
  assert.throws(() => calculateLtlDensityClassification(value), expected)
}
const inheritedInput = Object.assign(Object.create({ inherited: true }), input())
assert.throws(
  () => calculateLtlDensityClassification(inheritedInput),
  /assessment must be a plain object/,
)

const blockerCases = [
  [
    { fullDensityScaleConfirmed: false, classificationReference: null },
    'full_density_scale_not_confirmed',
  ],
  [{ mixedCommodities: true }, 'mixed_commodities_require_item_classification'],
  [{ handlingConcern: true }, 'handling_concern_requires_review'],
  [{ stowabilityConcern: true }, 'stowability_concern_requires_review'],
  [{ liabilityConcern: true }, 'liability_concern_requires_review'],
]
for (const [override, expectedBlocker] of blockerCases) {
  const assessment = calculateLtlDensityClassification(input(override))
  assert.equal(assessment.evidenceEligible, false)
  assert.deepEqual(plain(assessment.blockers), [expectedBlocker])
  assert.throws(
    () => buildLtlDensityClassificationEvidence({
      assessment,
      assessmentGlobalId: 'gfca0000001',
      capturedAt: '2026-08-11T12:00:00.000Z',
      attestation: 'I verified this exact handling unit',
    }),
    /advisory only and cannot authorize an LTL rate/,
  )
}

const allBlocked = calculateLtlDensityClassification(input({
  fullDensityScaleConfirmed: false,
  classificationReference: null,
  mixedCommodities: true,
  handlingConcern: true,
  stowabilityConcern: true,
  liabilityConcern: true,
}))
assert.deepEqual(plain(allBlocked.blockers), plain(LTL_DENSITY_CLASSIFICATION_BLOCKERS))
assert.equal(allBlocked.evidenceEligible, false)
assert.equal('classificationEvidence' in allBlocked, false)
assertDeepFrozen(allBlocked, 'allBlocked')

const eligibleAssessment = calculateLtlDensityClassification(input({
  handlingUnitKey: 'eligible-pallet-1',
  grossWeightGrams: Math.ceil(
    15 * boundaryVolumeCubicFeet * GRAMS_PER_POUND,
  ),
  classificationReference: 'nmfta-full-density-item-confirmed-by-operator',
  nmfcCode: '123456-12',
}))
assert.equal(eligibleAssessment.recommendedFreightClass, '70')
assert.equal(eligibleAssessment.evidenceEligible, true)
assert.deepEqual(plain(eligibleAssessment.blockers), [])
assert.match(eligibleAssessment.inputHash, /^[a-f0-9]{64}$/)
assertDeepFrozen(eligibleAssessment, 'eligibleAssessment')

const reorderedInput = Object.fromEntries(Object.entries(input({
  handlingUnitKey: 'eligible-pallet-1',
  grossWeightGrams: eligibleAssessment.grossWeightGrams,
  classificationReference: 'nmfta-full-density-item-confirmed-by-operator',
  nmfcCode: '123456-12',
})).reverse())
assert.equal(
  calculateLtlDensityClassification(reorderedInput).inputHash,
  eligibleAssessment.inputHash,
  'The input seal must be independent of object key order',
)
assert.notEqual(
  calculateLtlDensityClassification(input({
    handlingUnitKey: 'eligible-pallet-1',
    grossWeightGrams: eligibleAssessment.grossWeightGrams + 1,
    classificationReference: 'nmfta-full-density-item-confirmed-by-operator',
    nmfcCode: '123456-12',
  })).inputHash,
  eligibleAssessment.inputHash,
  'A one-gram tendered-weight change must change the input seal',
)

const verifiedClone = assertLtlDensityClassificationIntegrity(
  clone(eligibleAssessment),
)
assert.deepEqual(plain(verifiedClone), plain(eligibleAssessment))
assertDeepFrozen(verifiedClone, 'verifiedClone')

const tamperCases = [
  { inputHash: '0'.repeat(64) },
  { recommendedFreightClass: '55' },
  { densityPcf: eligibleAssessment.densityPcf + 1 },
  { evidenceEligible: false },
  { blockers: ['handling_concern_requires_review'] },
  { dimensionsMm: { ...eligibleAssessment.dimensionsMm, height: 1_001 } },
  { extraAuthority: true },
]
for (const tamper of tamperCases) {
  assert.throws(
    () => assertLtlDensityClassificationIntegrity({
      ...clone(eligibleAssessment),
      ...tamper,
    }),
    /assessment integrity check failed/,
  )
}
assert.throws(
  () => assertLtlDensityClassificationIntegrity({
    ...clone(eligibleAssessment),
    contractVersion: 'clawpilot.ltl_density_classification.v0',
  }),
  /contract version is invalid/,
)

const evidence = buildLtlDensityClassificationEvidence({
  assessment: clone(eligibleAssessment),
  assessmentGlobalId: 'gfca0000001',
  capturedAt: '2026-08-11T12:00:00.000Z',
  attestation: 'I verified this exact as-tendered pallet',
})
assert.deepEqual(plain(evidence), {
  freightClass: '70',
  nmfcCode: '123456-12',
  source: 'density_calculation',
  reference: 'gfca0000001',
  description: [
    `${eligibleAssessment.description}; ${eligibleAssessment.densityPcf.toFixed(6)} pcf`,
    `using ${LTL_DENSITY_CLASSIFIER_VERSION}`,
    `eligibility: ${eligibleAssessment.classificationReference}`,
    'attestation: I verified this exact as-tendered pallet',
  ].join('; '),
  capturedAt: '2026-08-11T12:00:00.000Z',
})
assertDeepFrozen(evidence, 'evidence')
assert.throws(
  () => buildLtlDensityClassificationEvidence({
    assessment: eligibleAssessment,
    assessmentGlobalId: 'bad-assessment-id',
    capturedAt: '2026-08-11T12:00:00.000Z',
    attestation: 'I verified this exact as-tendered pallet',
  }),
  /assessmentGlobalId is invalid/,
)
assert.throws(
  () => buildLtlDensityClassificationEvidence({
    assessment: eligibleAssessment,
    assessmentGlobalId: 'gfca0000001',
    capturedAt: '2026-08-11t12:00:00.000z',
    attestation: 'I verified this exact as-tendered pallet',
  }),
  /capturedAt must be a canonical UTC instant/,
)

// Mixed commodities must never acquire tender evidence from an aggregate
// pallet-density calculation, even when every other operator flag is clear.
const mixedAssessment = calculateLtlDensityClassification(input({
  mixedCommodities: true,
}))
assert.deepEqual(plain(mixedAssessment.blockers), [
  'mixed_commodities_require_item_classification',
])
assert.throws(
  () => buildLtlDensityClassificationEvidence({
    assessment: mixedAssessment,
    assessmentGlobalId: 'gfca0000001',
    capturedAt: '2026-08-11T12:00:00.000Z',
    attestation: 'I verified this exact as-tendered pallet',
  }),
  /advisory only and cannot authorize an LTL rate/,
)

const migration = read(migrationPath)
assert.match(
  migration,
  /CREATE TABLE IF NOT EXISTS operations_ltl_freight_class_assessments/,
)
assert.match(
  migration,
  /recommended_freight_class IN \(\s*50, 55, 60, 65, 70, 85, 92\.5, 100, 125, 175, 250, 300, 400\s*\)/s,
)
assert.match(
  migration,
  /full_density_scale_confirmed\s+AND NOT mixed_commodities\s+AND NOT handling_concern\s+AND NOT stowability_concern\s+AND NOT liability_concern/s,
)
assert.match(
  migration,
  /\(classification_evidence->>'source' = 'density_calculation'\)\s*= \(classification_assessment_id IS NOT NULL\)/s,
)
assert.match(
  migration,
  /unit\.mixed_commodities = false[\s\S]*unit\.length_mm = assessment\.length_mm[\s\S]*unit\.gross_weight_grams = assessment\.gross_weight_grams/,
)
assert.match(
  migration,
  /BEFORE UPDATE OR DELETE ON operations_ltl_freight_class_assessments/,
)

console.log('LTL freight-classification contract tests passed.')
