import { createHash } from 'node:crypto'

import { recordAuditEvent } from '@/lib/auditWriter'
import {
  buildLtlDensityClassificationEvidence,
  calculateLtlDensityClassification,
  type LtlDensityClassificationAssessment,
} from '@/lib/operations/freightClassification'
import type { FreightClassificationEvidence } from '@/lib/operations/transport'
import {
  acquireTransactionAdvisoryLock,
  withTransaction,
} from '@/lib/persistence/postgres'

export class LtlFreightClassificationPersistenceError extends Error {
  readonly code: string
  readonly status: number

  constructor(code: string, message: string, status = 400) {
    super(message)
    this.name = 'LtlFreightClassificationPersistenceError'
    this.code = code
    this.status = status
  }
}

type AssessmentRow = {
  global_id: string
  request_hash: string
  input_hash: string
  contract_version: string
  handling_unit_key: string
  description: string
  length_mm: number
  width_mm: number
  height_mm: number
  gross_weight_grams: string | number
  volume_cubic_feet: string | number
  density_pcf: string | number
  recommended_freight_class: string | number
  full_density_scale_confirmed: boolean
  mixed_commodities: boolean
  handling_concern: boolean
  stowability_concern: boolean
  liability_concern: boolean
  classification_reference: string
  nmfc_code: string | null
  attestation: string
  classification_evidence: FreightClassificationEvidence
  created_at: string | Date
}

export type PersistedLtlFreightClassificationAssessment = Readonly<{
  assessmentGlobalId: string
  assessment: LtlDensityClassificationAssessment
  attestation: string
  classificationEvidence: FreightClassificationEvidence
  capturedAt: string
  replayed: boolean
}>

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/

function normalizeIdempotencyKey(value: unknown) {
  if (typeof value !== 'string') {
    throw new LtlFreightClassificationPersistenceError(
      'LTL_CLASSIFICATION_IDEMPOTENCY_REQUIRED',
      'A stable Idempotency-Key is required to save freight classification evidence',
    )
  }
  const normalized = value.trim()
  if (
    normalized.length < 16
    || normalized.length > 200
    || CONTROL_CHARACTER.test(normalized)
  ) {
    throw new LtlFreightClassificationPersistenceError(
      'LTL_CLASSIFICATION_IDEMPOTENCY_INVALID',
      'The freight classification Idempotency-Key is invalid',
    )
  }
  return normalized
}

function normalizeAttestation(value: unknown) {
  if (typeof value !== 'string') {
    throw new LtlFreightClassificationPersistenceError(
      'LTL_CLASSIFICATION_ATTESTATION_REQUIRED',
      'An operator attestation is required to save freight classification evidence',
    )
  }
  const normalized = value.trim().replace(/\s+/g, ' ')
  if (
    normalized.length < 10
    || normalized.length > 120
    || CONTROL_CHARACTER.test(normalized)
  ) {
    throw new LtlFreightClassificationPersistenceError(
      'LTL_CLASSIFICATION_ATTESTATION_INVALID',
      'Freight classification attestation must be 10-120 printable characters',
    )
  }
  return normalized
}

function requestHash(
  assessment: LtlDensityClassificationAssessment,
  attestation: string,
) {
  return createHash('sha256').update(JSON.stringify({
    action: 'attest_ltl_density_classification',
    contractVersion: assessment.contractVersion,
    inputHash: assessment.inputHash,
    attestation,
  })).digest('hex')
}

function iso(value: string | Date) {
  return new Date(value).toISOString()
}

function number(value: string | number) {
  return Number(value)
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

function assessmentFromRow(row: AssessmentRow): LtlDensityClassificationAssessment {
  const assessment = calculateLtlDensityClassification({
    handlingUnitKey: row.handling_unit_key,
    description: row.description,
    dimensionsMm: {
      length: Number(row.length_mm),
      width: Number(row.width_mm),
      height: Number(row.height_mm),
    },
    grossWeightGrams: number(row.gross_weight_grams),
    mixedCommodities: row.mixed_commodities,
    fullDensityScaleConfirmed: row.full_density_scale_confirmed,
    handlingConcern: row.handling_concern,
    stowabilityConcern: row.stowability_concern,
    liabilityConcern: row.liability_concern,
    classificationReference: row.classification_reference,
    nmfcCode: row.nmfc_code,
  })
  if (
    assessment.inputHash !== row.input_hash
    || assessment.contractVersion !== row.contract_version
    || assessment.volumeCubicFeet !== number(row.volume_cubic_feet)
    || assessment.densityPcf !== number(row.density_pcf)
    || assessment.recommendedFreightClass
      !== String(number(row.recommended_freight_class))
  ) {
    throw new LtlFreightClassificationPersistenceError(
      'LTL_CLASSIFICATION_EVIDENCE_INVALID',
      'Stored freight classification evidence failed its integrity check',
      500,
    )
  }
  return assessment
}

function resultFromRow(
  row: AssessmentRow,
  replayed: boolean,
): PersistedLtlFreightClassificationAssessment {
  const assessment = assessmentFromRow(row)
  const capturedAt = iso(row.created_at)
  const expectedEvidence = buildLtlDensityClassificationEvidence({
    assessment,
    assessmentGlobalId: row.global_id,
    capturedAt,
    attestation: row.attestation,
  })
  if (
    canonicalJson(expectedEvidence)
      !== canonicalJson(row.classification_evidence)
  ) {
    throw new LtlFreightClassificationPersistenceError(
      'LTL_CLASSIFICATION_EVIDENCE_INVALID',
      'Stored freight classification evidence failed its integrity check',
      500,
    )
  }
  return Object.freeze({
    assessmentGlobalId: row.global_id,
    assessment,
    attestation: row.attestation,
    classificationEvidence: expectedEvidence,
    capturedAt,
    replayed,
  })
}

export async function attestLtlFreightClassificationInPostgres(input: {
  organizationId: string
  actorEmail: string
  idempotencyKey: unknown
  assessment: unknown
  attestation: unknown
}) {
  const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey)
  const attestation = normalizeAttestation(input.attestation)
  let assessment: LtlDensityClassificationAssessment
  try {
    assessment = calculateLtlDensityClassification(input.assessment)
  } catch (error) {
    throw new LtlFreightClassificationPersistenceError(
      'LTL_CLASSIFICATION_INPUT_INVALID',
      error instanceof Error ? error.message : 'Freight classification input is invalid',
    )
  }
  if (!assessment.evidenceEligible || assessment.blockers.length > 0) {
    throw new LtlFreightClassificationPersistenceError(
      'LTL_CLASSIFICATION_REVIEW_REQUIRED',
      'This density result is advisory only; resolve every classification blocker before LTL rating',
      409,
    )
  }
  const hash = requestHash(assessment, attestation)
  return withTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(
      client,
      `ltl-freight-class:${input.organizationId}:${idempotencyKey}`,
    )
    const existing = await client.query<AssessmentRow>(
      `SELECT *
       FROM operations_ltl_freight_class_assessments
       WHERE organization_id = $1::uuid AND idempotency_key = $2
       FOR SHARE`,
      [input.organizationId, idempotencyKey],
    )
    if (existing.rowCount) {
      if (existing.rows[0].request_hash !== hash) {
        throw new LtlFreightClassificationPersistenceError(
          'LTL_CLASSIFICATION_IDEMPOTENCY_CONFLICT',
          'The freight classification Idempotency-Key was already used for different evidence',
          409,
        )
      }
      return resultFromRow(existing.rows[0], true)
    }

    const identity = await client.query<{
      id: string
      global_id: string
      captured_at: string | Date
    }>(
      `SELECT gen_random_uuid()::text AS id,
              allocate_global_reference('gfca') AS global_id,
              clock_timestamp() AS captured_at`,
    )
    const capturedAt = iso(identity.rows[0].captured_at)
    const classificationEvidence = buildLtlDensityClassificationEvidence({
      assessment,
      assessmentGlobalId: identity.rows[0].global_id,
      capturedAt,
      attestation,
    })
    const inserted = await client.query<AssessmentRow>(
      `INSERT INTO operations_ltl_freight_class_assessments (
         id, global_id, organization_id, idempotency_key,
         request_hash, input_hash, contract_version,
         handling_unit_key, description,
         length_mm, width_mm, height_mm, gross_weight_grams,
         volume_cubic_feet, density_pcf, recommended_freight_class,
         full_density_scale_confirmed, mixed_commodities,
         handling_concern, stowability_concern, liability_concern,
         classification_reference, nmfc_code, attestation,
         classification_evidence, created_by, created_at
       ) VALUES (
         $1::uuid, $2, $3::uuid, $4,
         $5, $6, $7,
         $8, $9,
         $10, $11, $12, $13,
         $14, $15, $16,
         $17, $18, $19, $20, $21,
         $22, $23, $24,
         $25::jsonb, $26, $27::timestamptz
       )
       RETURNING *`,
      [
        identity.rows[0].id,
        identity.rows[0].global_id,
        input.organizationId,
        idempotencyKey,
        hash,
        assessment.inputHash,
        assessment.contractVersion,
        assessment.handlingUnitKey,
        assessment.description,
        assessment.dimensionsMm.length,
        assessment.dimensionsMm.width,
        assessment.dimensionsMm.height,
        assessment.grossWeightGrams,
        assessment.volumeCubicFeet,
        assessment.densityPcf,
        assessment.recommendedFreightClass,
        assessment.fullDensityScaleConfirmed,
        assessment.mixedCommodities,
        assessment.handlingConcern,
        assessment.stowabilityConcern,
        assessment.liabilityConcern,
        assessment.classificationReference,
        assessment.nmfcCode,
        attestation,
        JSON.stringify(classificationEvidence),
        input.actorEmail,
        capturedAt,
      ],
    )
    await recordAuditEvent({
      actor: input.actorEmail,
      eventType: 'operations.ltl_freight_class.attested',
      aggregateType: 'operations_ltl_freight_class_assessment',
      aggregateId: identity.rows[0].global_id,
      organizationId: input.organizationId,
      payload: {
        contractVersion: assessment.contractVersion,
        inputHash: assessment.inputHash,
        handlingUnitKey: assessment.handlingUnitKey,
        freightClass: assessment.recommendedFreightClass,
        nmfcCode: assessment.nmfcCode,
      },
    }, client)
    return resultFromRow(inserted.rows[0], false)
  })
}
