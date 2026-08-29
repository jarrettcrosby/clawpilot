import { createHash, randomUUID } from 'crypto'
import type { PoolClient, QueryResultRow } from 'pg'
import { recordAuditEvent } from '@/lib/auditWriter'
import {
  acquireTransactionAdvisoryLock,
  query,
  withTransaction,
} from '@/lib/persistence/postgres'

const COMMAND_TYPE = 'operations.record_order_unit_weights'

export class OperationsOrderUnitWeightError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message)
    this.name = 'OperationsOrderUnitWeightError'
  }
}

export type OrderUnitWeightLine = {
  lineGlobalId: string
  productTitle: string
  variantTitle: string | null
  quantity: number
  unitWeightGrams: number | null
  weightSource: 'provider_order' | 'provider_catalog' | 'order_specific' | null
  unitDimensionsMm: {
    length: number
    width: number
    height: number
  } | null
  dimensionSource: 'order_specific' | null
  factGlobalId: string | null
  factVersion: number | null
}

export type OrderUnitWeightWorkspace = {
  accountGlobalId: string
  candidateGlobalId: string
  candidateRowVersion: number
  orderGlobalId: string
  missingLines: OrderUnitWeightLine[]
  dimensionMissingLines: OrderUnitWeightLine[]
  effectiveLines: OrderUnitWeightLine[]
}

type CandidateRow = QueryResultRow & {
  id: string
  global_id: string
  row_version: string
  workflow_state: string
  order_id: string
  order_global_id: string
  order_status: string
  integration_account_id: string
  pipeline_id: string
  accepted_revision_application_id: string | null
}

type PlanningLineRow = QueryResultRow & {
  id: string
  global_id: string
  product_title_snapshot: string
  variant_title_snapshot: string | null
  unfulfilled_quantity: string
  line_source_revision: string
  line_source_hash: string
  candidate_line_id: string | null
  revision_application_line_id: string | null
  packaging_weight_source: string | null
  order_weight_grams: number | null
  channel_source_revision: string | null
  channel_source_hash: string | null
  channel_weight_grams: number | null
  fact_global_id: string | null
  fact_id: string | null
  fact_version: number | null
  fact_weight_grams: number | null
  fact_length_mm: number | null
  fact_width_mm: number | null
  fact_height_mm: number | null
  fact_hash: string | null
  fact_request_hash: string | null
}

type CommandReceiptRow = QueryResultRow & {
  id: string
  request_hash: string
  target_global_id: string | null
  status: 'processing' | 'succeeded' | 'failed'
  correlation_id: string
  result_global_id: string | null
  result_payload: Record<string, unknown> | null
  updated_at: Date
}

function fail(code: string, message: string, status = 400): never {
  throw new OperationsOrderUnitWeightError(code, message, status)
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>
    return `{${Object.keys(source).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(source[key])}`
    )).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function requestHash(value: unknown) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

function exactPositiveInteger(value: unknown, label: string) {
  if (
    typeof value !== 'number'
    || !Number.isSafeInteger(value)
    || value < 1
    || value > 1_000_000
  ) {
    fail(
      'OPERATIONS_ORDER_UNIT_WEIGHT_INVALID',
      `${label} must be a positive whole number of grams`,
      422,
    )
  }
  return value
}

function exactDimensions(value: unknown, label: string) {
  if (value === null) return null
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(
      'OPERATIONS_ORDER_UNIT_DIMENSIONS_INVALID',
      `${label} must include positive whole-number millimeters`,
      422,
    )
  }
  const record = value as Record<string, unknown>
  if (
    Object.keys(record).sort().join(',') !== 'height,length,width'
  ) {
    fail(
      'OPERATIONS_ORDER_UNIT_DIMENSIONS_INVALID',
      `${label} includes missing or unsupported fields`,
      422,
    )
  }
  const axis = (name: 'length' | 'width' | 'height') => {
    const millimeters = record[name]
    if (
      typeof millimeters !== 'number'
      || !Number.isSafeInteger(millimeters)
      || millimeters < 1
      || millimeters > 1_000_000
    ) {
      fail(
        'OPERATIONS_ORDER_UNIT_DIMENSIONS_INVALID',
        `${label} ${name} must be positive whole-number millimeters`,
        422,
      )
    }
    return millimeters
  }
  return {
    length: axis('length'),
    width: axis('width'),
    height: axis('height'),
  }
}

async function readCandidate(
  client: PoolClient | null,
  input: {
    organizationId: string
    accountGlobalId: string
    candidateGlobalId: string
    expectedCandidateRowVersion?: number
  },
) {
  const sql = `SELECT candidate.id::text, candidate.global_id,
                      candidate.row_version::text,
                      candidate.workflow_state,
                      candidate.canonical_order_id::text AS order_id,
                      order_row.global_id AS order_global_id,
                      order_row.status AS order_status,
                      candidate.integration_account_id::text,
                      candidate.pipeline_id::text,
                      candidate.accepted_revision_application_id::text
               FROM operations_commerce_order_candidates candidate
               JOIN operations_integration_accounts account
                 ON account.organization_id = candidate.organization_id
                AND account.id = candidate.integration_account_id
               JOIN operations_orders order_row
                 ON order_row.organization_id = candidate.organization_id
                AND order_row.id = candidate.canonical_order_id
               WHERE candidate.organization_id = $1::uuid
                 AND account.global_id = $2
                 AND candidate.global_id = $3
               ${client ? 'FOR SHARE OF candidate, order_row' : ''}`
  const result = client
    ? await client.query<CandidateRow>(sql, [
        input.organizationId,
        input.accountGlobalId,
        input.candidateGlobalId,
      ])
    : await query<CandidateRow>(sql, [
        input.organizationId,
        input.accountGlobalId,
        input.candidateGlobalId,
      ])
  const candidate = result.rows[0]
  if (!candidate) {
    fail(
      'OPERATIONS_ORDER_UNIT_WEIGHT_CONTEXT_NOT_FOUND',
      'The imported order planning context was not found',
      404,
    )
  }
  if (
    input.expectedCandidateRowVersion !== undefined
    && Number(candidate.row_version) !== input.expectedCandidateRowVersion
  ) {
    fail(
      'OPERATIONS_ORDER_UNIT_WEIGHT_CONTEXT_CHANGED',
      'The imported order changed; reopen Prepare order and try again',
      409,
    )
  }
  if (
    candidate.workflow_state !== 'promoted'
    || !['imported', 'validated', 'held'].includes(candidate.order_status)
  ) {
    fail(
      'OPERATIONS_ORDER_UNIT_WEIGHT_STATE_INVALID',
      'Unit weights can only be recorded before warehouse planning begins',
      409,
    )
  }
  return candidate
}

async function readPlanningLines(
  client: PoolClient | null,
  organizationId: string,
  candidate: CandidateRow,
) {
  const sql = `SELECT
                 line.id::text,
                 line.global_id,
                 line.product_title_snapshot,
                 line.variant_title_snapshot,
                 line.unfulfilled_quantity::text,
                 line.source_revision AS line_source_revision,
                 line.source_hash AS line_source_hash,
                 CASE
                   WHEN candidate.accepted_revision_application_id IS NULL
                   THEN line.id::text
                   ELSE NULL
                 END AS candidate_line_id,
                 revision_line.id::text AS revision_application_line_id,
                 line.packaging_weight_source,
                 line.weight_grams AS order_weight_grams,
                 channel_state.source_revision AS channel_source_revision,
                 channel_state.source_hash AS channel_source_hash,
                 channel_state.weight_grams AS channel_weight_grams,
                 fact.global_id AS fact_global_id,
                 fact.id::text AS fact_id,
                 fact.fact_version,
                 fact.unit_weight_grams AS fact_weight_grams,
                 fact.unit_length_mm AS fact_length_mm,
                 fact.unit_width_mm AS fact_width_mm,
                 fact.unit_height_mm AS fact_height_mm,
                 fact.fact_hash,
                 fact.request_hash AS fact_request_hash
               FROM operations_commerce_current_planning_lines line
               JOIN operations_commerce_order_candidates candidate
                 ON candidate.organization_id = line.organization_id
                AND candidate.id = line.order_candidate_id
               LEFT JOIN operations_commerce_order_revision_application_lines
                 revision_line
                 ON revision_line.organization_id = line.organization_id
                AND revision_line.integration_account_id =
                      line.integration_account_id
                AND revision_line.pipeline_id = line.pipeline_id
                AND revision_line.application_id =
                      candidate.accepted_revision_application_id
                AND revision_line.planning_line_id = line.id
                AND revision_line.planning_global_id = line.global_id
                AND revision_line.active = true
               LEFT JOIN operations_product_channel_states channel_state
                 ON channel_state.organization_id = line.organization_id
                AND channel_state.integration_account_id =
                      line.integration_account_id
                AND channel_state.pipeline_id = line.pipeline_id
                AND channel_state.provider = line.provider
                AND channel_state.external_product_id = line.external_product_id
                AND channel_state.external_variant_id = line.external_variant_id
                AND channel_state.product_id = line.product_id
                AND channel_state.product_mapping_id = line.product_mapping_id
               LEFT JOIN LATERAL (
                 SELECT retained.id, retained.global_id, retained.fact_version,
                        retained.unit_weight_grams, retained.unit_length_mm,
                        retained.unit_width_mm, retained.unit_height_mm,
                        retained.fact_hash,
                        retained.request_hash
                 FROM operations_order_unit_weight_facts retained
                 WHERE retained.organization_id = line.organization_id
                   AND retained.candidate_id = line.order_candidate_id
                   AND retained.planning_line_id = line.id
                   AND retained.planning_line_global_id = line.global_id
                   AND retained.line_source_revision = line.source_revision
                   AND retained.line_source_hash = line.source_hash
                   AND (
                     (
                       candidate.accepted_revision_application_id IS NULL
                       AND retained.candidate_line_id = line.id
                       AND retained.revision_application_line_id IS NULL
                     ) OR (
                       candidate.accepted_revision_application_id IS NOT NULL
                       AND retained.candidate_line_id IS NULL
                       AND retained.revision_application_line_id =
                             revision_line.id
                     )
                   )
                 ORDER BY retained.fact_version DESC, retained.id DESC
                 LIMIT 1
               ) fact ON true
               WHERE line.organization_id = $1::uuid
                 AND line.integration_account_id = $2::uuid
                 AND line.pipeline_id = $3::uuid
                 AND line.order_candidate_id = $4::uuid
                 AND line.workflow_state = 'promoted'
                 AND line.requires_shipping = true
                 AND line.unfulfilled_quantity > 0
                 AND line.unit_multiplier = 1
                 AND line.mapping_state = 'resolved'
                 AND line.product_id IS NOT NULL
                 AND line.product_mapping_id IS NOT NULL
                 AND line.packaging_state = 'not_required'
                 AND line.packaging_source = 'none'
                 AND line.commerce_variant_pack_mapping_id IS NULL
                 AND line.pack_profile_version_id IS NULL
                 AND (
                   candidate.accepted_revision_application_id IS NULL
                   OR revision_line.id IS NOT NULL
                 )
               ORDER BY line.created_at, line.id`
  const values = [
    organizationId,
    candidate.integration_account_id,
    candidate.pipeline_id,
    candidate.id,
  ]
  const result = client
    ? await client.query<PlanningLineRow>(sql, values)
    : await query<PlanningLineRow>(sql, values)
  return result.rows
}

function lineWorkspace(row: PlanningLineRow): OrderUnitWeightLine {
  const providerOrderWeight = (
    row.packaging_weight_source === 'provider_order'
    && Number.isSafeInteger(row.order_weight_grams)
    && Number(row.order_weight_grams) > 0
  )
  const providerCatalogWeight = (
    Number.isSafeInteger(row.channel_weight_grams)
    && Number(row.channel_weight_grams) > 0
  )
  const orderSpecificWeight = (
    Number.isSafeInteger(row.fact_weight_grams)
    && Number(row.fact_weight_grams) > 0
  )
  const orderSpecificDimensions = (
    Number.isSafeInteger(row.fact_length_mm)
    && Number(row.fact_length_mm) > 0
    && Number.isSafeInteger(row.fact_width_mm)
    && Number(row.fact_width_mm) > 0
    && Number.isSafeInteger(row.fact_height_mm)
    && Number(row.fact_height_mm) > 0
  )
  return {
    lineGlobalId: row.global_id,
    productTitle: row.product_title_snapshot,
    variantTitle: row.variant_title_snapshot,
    quantity: Number(row.unfulfilled_quantity),
    unitWeightGrams: providerOrderWeight
      ? Number(row.order_weight_grams)
      : providerCatalogWeight
        ? Number(row.channel_weight_grams)
        : orderSpecificWeight
          ? Number(row.fact_weight_grams)
          : null,
    weightSource: orderSpecificWeight
      ? providerOrderWeight
        ? 'provider_order'
        : providerCatalogWeight
          ? 'provider_catalog'
          : 'order_specific'
      : providerOrderWeight
        ? 'provider_order'
        : providerCatalogWeight
          ? 'provider_catalog'
          : null,
    unitDimensionsMm: orderSpecificDimensions
      ? {
          length: Number(row.fact_length_mm),
          width: Number(row.fact_width_mm),
          height: Number(row.fact_height_mm),
        }
      : null,
    dimensionSource: orderSpecificDimensions ? 'order_specific' : null,
    factGlobalId: row.fact_global_id,
    factVersion: row.fact_version,
  }
}

async function workspace(
  client: PoolClient | null,
  input: {
    organizationId: string
    accountGlobalId: string
    candidateGlobalId: string
    expectedCandidateRowVersion?: number
  },
): Promise<OrderUnitWeightWorkspace> {
  const candidate = await readCandidate(client, input)
  const rows = await readPlanningLines(client, input.organizationId, candidate)
  for (const row of rows) {
    if (!row.line_source_revision || !/^[a-f0-9]{64}$/u.test(row.line_source_hash)) {
      fail(
        'OPERATIONS_ORDER_UNIT_WEIGHT_LINEAGE_REQUIRED',
        `${row.product_title_snapshot} is missing exact imported-line evidence`,
        422,
      )
    }
    if (!row.channel_source_revision || !/^[a-f0-9]{64}$/u.test(row.channel_source_hash || '')) {
      fail(
        'OPERATIONS_ORDER_UNIT_WEIGHT_CHANNEL_LINEAGE_REQUIRED',
        `${row.product_title_snapshot} needs current catalog evidence before planning`,
        422,
      )
    }
  }
  const lines = rows.map(lineWorkspace)
  return {
    accountGlobalId: input.accountGlobalId,
    candidateGlobalId: candidate.global_id,
    candidateRowVersion: Number(candidate.row_version),
    orderGlobalId: candidate.order_global_id,
    missingLines: lines.filter((line) => line.unitWeightGrams === null),
    dimensionMissingLines: lines.filter((line) => (
      line.unitWeightGrams !== null && line.unitDimensionsMm === null
    )),
    effectiveLines: lines.filter((line) => line.unitWeightGrams !== null),
  }
}

export async function readOrderUnitWeightWorkspaceInPostgres(input: {
  organizationId: string
  accountGlobalId: string
  candidateGlobalId: string
  expectedCandidateRowVersion: number
}) {
  return workspace(null, input)
}

export async function assertCurrentOrderUnitWeightEvidence(
  client: PoolClient,
  input: {
    organizationId: string
    candidateGlobalId: string
    planSnapshot: Record<string, unknown>
  },
) {
  const readContext = input.planSnapshot.readContext
  const lineEvidence = readContext
    && typeof readContext === 'object'
    && !Array.isArray(readContext)
    ? (readContext as Record<string, unknown>).lineEvidence
    : null
  if (!Array.isArray(lineEvidence)) {
    fail(
      'OPERATIONS_ORDER_UNIT_WEIGHT_EVIDENCE_CORRUPT',
      'Cartonization is missing its retained order-line evidence; run it again',
      409,
    )
  }
  const retained = lineEvidence.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return []
    const value = entry as Record<string, unknown>
    const retainsWeight = value.weightSource === 'order_specific'
    const retainsDimensions = value.dimensionSource === 'order_specific'
    if (!retainsWeight && !retainsDimensions) return []
    const factGlobalId = String(retainsDimensions
      ? value.dimensionEvidenceReference || ''
      : value.weightEvidenceReference || '')
    const factHash = String(retainsDimensions
      ? value.dimensionEvidenceHash || ''
      : value.weightEvidenceHash || '')
    const requestHash = String(retainsDimensions
      ? value.dimensionEvidenceRequestHash || ''
      : value.weightEvidenceRequestHash || '')
    const lineGlobalId = String(value.lineGlobalId || '')
    const weightGrams = Number(value.weightGrams)
    const dimensions = value.unitDimensionsMm
    const dimensionRecord = dimensions
      && typeof dimensions === 'object'
      && !Array.isArray(dimensions)
      ? dimensions as Record<string, unknown>
      : null
    const lengthMm = dimensionRecord ? Number(dimensionRecord.length) : null
    const widthMm = dimensionRecord ? Number(dimensionRecord.width) : null
    const heightMm = dimensionRecord ? Number(dimensionRecord.height) : null
    if (
      !/^gouw(?:[0-9]{7}|[0-9a-v]{12})$/u.test(factGlobalId)
      || !/^[a-f0-9]{64}$/u.test(factHash)
      || !/^[a-f0-9]{64}$/u.test(requestHash)
      || !/^(?:gcol|gcal)(?:[0-9]{7}|[0-9a-v]{12})$/u.test(lineGlobalId)
      || !Number.isSafeInteger(weightGrams)
      || weightGrams < 1
      || (
        retainsDimensions
        && (
          !Number.isSafeInteger(lengthMm)
          || Number(lengthMm) < 1
          || !Number.isSafeInteger(widthMm)
          || Number(widthMm) < 1
          || !Number.isSafeInteger(heightMm)
          || Number(heightMm) < 1
        )
      )
      || (
        !retainsDimensions
        && (lengthMm !== null || widthMm !== null || heightMm !== null)
      )
    ) {
      fail(
        'OPERATIONS_ORDER_UNIT_WEIGHT_EVIDENCE_CORRUPT',
        'Cartonization contains invalid unit-weight evidence; run it again',
        409,
      )
    }
    return [{
      factGlobalId,
      factHash,
      lineGlobalId,
      requestHash,
      weightGrams,
      lengthMm,
      widthMm,
      heightMm,
    }]
  })
  if (!retained.length) return
  if (new Set(retained.map((fact) => fact.lineGlobalId)).size !== retained.length) {
    fail(
      'OPERATIONS_ORDER_UNIT_WEIGHT_EVIDENCE_CORRUPT',
      'Cartonization contains duplicate unit-weight evidence; run it again',
      409,
    )
  }
  const result = await client.query<{ global_id: string }>(
    `SELECT fact.global_id
     FROM operations_order_unit_weight_facts fact
     JOIN operations_commerce_order_candidates candidate
       ON candidate.organization_id = fact.organization_id
      AND candidate.id = fact.candidate_id
     JOIN operations_commerce_current_planning_lines line
       ON line.organization_id = fact.organization_id
      AND line.integration_account_id = fact.integration_account_id
      AND line.pipeline_id = fact.pipeline_id
      AND line.order_candidate_id = fact.candidate_id
      AND line.id = fact.planning_line_id
      AND line.global_id = fact.planning_line_global_id
      AND line.source_revision = fact.line_source_revision
      AND line.source_hash = fact.line_source_hash
     LEFT JOIN operations_commerce_order_revision_application_lines
       revision_line
       ON revision_line.organization_id = line.organization_id
      AND revision_line.integration_account_id = line.integration_account_id
      AND revision_line.pipeline_id = line.pipeline_id
      AND revision_line.application_id =
            candidate.accepted_revision_application_id
      AND revision_line.planning_line_id = line.id
      AND revision_line.planning_global_id = line.global_id
      AND revision_line.active = true
     JOIN jsonb_to_recordset($3::jsonb) retained(
       "factGlobalId" text, "factHash" text, "lineGlobalId" text,
       "requestHash" text, "weightGrams" integer,
       "lengthMm" integer, "widthMm" integer, "heightMm" integer
     )
       ON retained."factGlobalId" = fact.global_id
      AND retained."factHash" = fact.fact_hash
      AND retained."lineGlobalId" = fact.planning_line_global_id
      AND retained."requestHash" = fact.request_hash
      AND retained."weightGrams" = fact.unit_weight_grams
      AND retained."lengthMm" IS NOT DISTINCT FROM fact.unit_length_mm
      AND retained."widthMm" IS NOT DISTINCT FROM fact.unit_width_mm
      AND retained."heightMm" IS NOT DISTINCT FROM fact.unit_height_mm
     WHERE fact.organization_id = $1::uuid
       AND candidate.global_id = $2
       AND candidate.workflow_state = 'promoted'
       AND (
         (
           candidate.accepted_revision_application_id IS NULL
           AND fact.candidate_line_id = line.id
           AND fact.revision_application_line_id IS NULL
         ) OR (
           candidate.accepted_revision_application_id IS NOT NULL
           AND fact.candidate_line_id IS NULL
           AND fact.revision_application_line_id = revision_line.id
         )
       )
       AND NOT EXISTS (
         SELECT 1
         FROM operations_order_unit_weight_facts newer
         WHERE newer.organization_id = fact.organization_id
           AND newer.candidate_id = fact.candidate_id
           AND newer.candidate_line_id IS NOT DISTINCT FROM
                 fact.candidate_line_id
           AND newer.revision_application_line_id IS NOT DISTINCT FROM
                 fact.revision_application_line_id
           AND newer.planning_line_global_id = fact.planning_line_global_id
           AND newer.line_source_revision = fact.line_source_revision
           AND newer.line_source_hash = fact.line_source_hash
           AND newer.fact_version > fact.fact_version
       )`,
    [
      input.organizationId,
      input.candidateGlobalId,
      JSON.stringify(retained),
    ],
  )
  if (result.rows.length !== retained.length) {
    fail(
      'OPERATIONS_ORDER_UNIT_WEIGHT_EVIDENCE_STALE',
      'An order unit weight changed after cartonization; run cartonization again',
      409,
    )
  }
}

async function prepareReceipt(input: {
  organizationId: string
  actorEmail: string
  idempotencyKey: string
  candidateGlobalId: string
  requestHash: string
}) {
  return withTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(
      client,
      `operations:command-receipt:${input.organizationId}:${COMMAND_TYPE}:${input.idempotencyKey}`,
    )
    const existing = await client.query<CommandReceiptRow>(
      `SELECT id::text, request_hash, target_global_id, status,
              correlation_id::text, result_global_id, result_payload,
              updated_at
       FROM operations_command_receipts
       WHERE organization_id = $1::uuid
         AND command_type = $2
         AND idempotency_key = $3
       FOR UPDATE`,
      [input.organizationId, COMMAND_TYPE, input.idempotencyKey],
    )
    const receipt = existing.rows[0]
    if (receipt) {
      if (
        receipt.request_hash !== input.requestHash
        || receipt.target_global_id !== input.candidateGlobalId
      ) {
        fail(
          'OPERATIONS_IDEMPOTENCY_CONFLICT',
          'This idempotency key was already used with different unit weights',
          409,
        )
      }
      if (receipt.status === 'succeeded') return { receipt, replayed: true }
      if (
        receipt.status === 'processing'
        && Date.now() - receipt.updated_at.getTime() < 5 * 60_000
      ) {
        fail(
          'OPERATIONS_COMMAND_IN_PROGRESS',
          'These unit weights are already being saved',
          409,
        )
      }
      const retried = await client.query<CommandReceiptRow>(
        `UPDATE operations_command_receipts
         SET status = 'processing', actor_email = $2,
             attempts = attempts + 1, error_code = NULL,
             error_message = NULL, completed_at = NULL,
             result_global_id = NULL, result_payload = NULL,
             correlation_id = $3::uuid,
             started_at = now(), updated_at = now()
         WHERE id = $1::uuid
         RETURNING id::text, request_hash, target_global_id, status,
                   correlation_id::text, result_global_id, result_payload,
                   updated_at`,
        [receipt.id, input.actorEmail, randomUUID()],
      )
      return { receipt: retried.rows[0], replayed: false }
    }
    const created = await client.query<CommandReceiptRow>(
      `INSERT INTO operations_command_receipts (
         organization_id, command_type, idempotency_key, request_hash,
         actor_email, status, correlation_id, target_global_id
       ) VALUES ($1::uuid, $2, $3, $4, $5, 'processing', $6::uuid, $7)
       RETURNING id::text, request_hash, target_global_id, status,
                 correlation_id::text, result_global_id, result_payload,
                 updated_at`,
      [
        input.organizationId,
        COMMAND_TYPE,
        input.idempotencyKey,
        input.requestHash,
        input.actorEmail,
        randomUUID(),
        input.candidateGlobalId,
      ],
    )
    return { receipt: created.rows[0], replayed: false }
  })
}

async function failReceipt(
  receipt: Pick<CommandReceiptRow, 'id' | 'correlation_id'>,
  error: unknown,
) {
  const code = error instanceof OperationsOrderUnitWeightError
    ? error.code
    : 'OPERATIONS_ORDER_UNIT_WEIGHT_SAVE_FAILED'
  const message = error instanceof Error
    ? error.message.slice(0, 500)
    : 'Unit weights could not be saved'
  try {
    await query(
      `UPDATE operations_command_receipts
       SET status = 'failed', error_code = $2, error_message = $3,
           completed_at = now(), updated_at = now()
       WHERE id = $1::uuid
         AND correlation_id = $4::uuid
         AND status = 'processing'`,
      [receipt.id, code, message, receipt.correlation_id],
    )
  } catch {
    // Preserve the domain failure if receipt persistence is unavailable.
  }
}

export async function recordOrderUnitWeightsInPostgres(input: {
  organizationId: string
  actorEmail: string
  idempotencyKey: string
  accountGlobalId: string
  candidateGlobalId: string
  expectedCandidateRowVersion: number
  reason: string
  lines: Array<{
    lineGlobalId: string
    unitWeightGrams: number
    unitDimensionsMm: {
      length: number
      width: number
      height: number
    } | null
    expectedFactVersion: number | null
  }>
}) {
  const normalized = {
    accountGlobalId: input.accountGlobalId,
    candidateGlobalId: input.candidateGlobalId,
    expectedCandidateRowVersion: input.expectedCandidateRowVersion,
    reason: input.reason.trim(),
    lines: [...input.lines].map((line) => ({
      lineGlobalId: line.lineGlobalId,
      unitWeightGrams: exactPositiveInteger(
        line.unitWeightGrams,
        `${line.lineGlobalId} unit weight`,
      ),
      unitDimensionsMm: exactDimensions(
        line.unitDimensionsMm,
        `${line.lineGlobalId} unit dimensions`,
      ),
      expectedFactVersion: line.expectedFactVersion === null
        ? null
        : exactPositiveInteger(
            line.expectedFactVersion,
            `${line.lineGlobalId} fact version`,
          ),
    })).sort((left, right) => left.lineGlobalId.localeCompare(right.lineGlobalId)),
  }
  if (
    normalized.reason.length < 8
    || normalized.reason.length > 500
    || /[\u0000-\u001f\u007f]/u.test(normalized.reason)
  ) {
    fail(
      'OPERATIONS_ORDER_UNIT_WEIGHT_REASON_INVALID',
      'Enter a short audit reason for these unit weights',
      422,
    )
  }
  if (
    normalized.lines.length < 1
    || normalized.lines.length > 500
    || new Set(normalized.lines.map((line) => line.lineGlobalId)).size !==
      normalized.lines.length
  ) {
    fail(
      'OPERATIONS_ORDER_UNIT_WEIGHT_LINES_INVALID',
      'Provide one unit weight for each missing order line',
      422,
    )
  }
  const hash = requestHash(normalized)
  const command = await prepareReceipt({
    organizationId: input.organizationId,
    actorEmail: input.actorEmail,
    idempotencyKey: input.idempotencyKey,
    candidateGlobalId: input.candidateGlobalId,
    requestHash: hash,
  })
  if (command.replayed) {
    const result = command.receipt.result_payload || {}
    return {
      replayed: true,
      candidateGlobalId: result.candidateGlobalId,
      orderGlobalId: result.orderGlobalId,
      providerWriteCount: result.providerWriteCount,
      factGlobalIds: Array.isArray(result.factGlobalIds)
        ? result.factGlobalIds as string[]
        : [],
      workspace: null,
    }
  }
  try {
    const initial = await workspace(null, {
      organizationId: input.organizationId,
      accountGlobalId: input.accountGlobalId,
      candidateGlobalId: input.candidateGlobalId,
      expectedCandidateRowVersion: input.expectedCandidateRowVersion,
    })
    const saved = await withTransaction(async (client) => {
      await acquireTransactionAdvisoryLock(
        client,
        `operations:order:${input.organizationId}:${initial.orderGlobalId}`,
      )
      await acquireTransactionAdvisoryLock(
        client,
        `operations:order-unit-weight:${input.organizationId}:${input.candidateGlobalId}`,
      )
      const current = await workspace(client, {
        organizationId: input.organizationId,
        accountGlobalId: input.accountGlobalId,
        candidateGlobalId: input.candidateGlobalId,
        expectedCandidateRowVersion: input.expectedCandidateRowVersion,
      })
      const missingIds = current.missingLines
        .map((line) => line.lineGlobalId)
        .sort()
      const suppliedIds = normalized.lines.map((line) => line.lineGlobalId)
      if (missingIds.some((lineGlobalId) => !suppliedIds.includes(lineGlobalId))) {
        fail(
          'OPERATIONS_ORDER_UNIT_WEIGHT_CONTEXT_CHANGED',
          'Missing unit weights changed; reopen Prepare order and try again',
          409,
        )
      }
      const candidate = await readCandidate(client, {
        organizationId: input.organizationId,
        accountGlobalId: input.accountGlobalId,
        candidateGlobalId: input.candidateGlobalId,
        expectedCandidateRowVersion: input.expectedCandidateRowVersion,
      })
      const planningRows = await readPlanningLines(
        client,
        input.organizationId,
        candidate,
      )
      const byGlobalId = new Map(planningRows.map((row) => [row.global_id, row]))
      const facts: Array<{
        globalId: string
        lineGlobalId: string
        factHash: string
      }> = []
      for (const line of normalized.lines) {
        const source = byGlobalId.get(line.lineGlobalId)
        if (!source) {
          fail(
            'OPERATIONS_ORDER_UNIT_WEIGHT_CONTEXT_CHANGED',
            'An imported order line changed; reopen Prepare order and try again',
            409,
          )
        }
        const currentFactVersion = source.fact_version === null
          ? null
          : Number(source.fact_version)
        const providerOrderWeight = (
          source.packaging_weight_source === 'provider_order'
          && Number(source.order_weight_grams) > 0
        )
        const providerCatalogWeight = Number(source.channel_weight_grams) > 0
        const providerWeight = providerOrderWeight
          ? Number(source.order_weight_grams)
          : providerCatalogWeight
            ? Number(source.channel_weight_grams)
            : null
        if (
          providerWeight !== null
          && providerWeight !== line.unitWeightGrams
        ) {
          fail(
            'OPERATIONS_ORDER_UNIT_WEIGHT_PROVIDER_FACT_READ_ONLY',
            `${source.product_title_snapshot} uses a provider weight; record dimensions without changing that weight`,
            409,
          )
        }
        if (currentFactVersion !== line.expectedFactVersion) {
          fail(
            'OPERATIONS_ORDER_UNIT_WEIGHT_CONTEXT_CHANGED',
            'An order unit weight changed; reopen Prepare order and try again',
            409,
          )
        }
        if (
          currentFactVersion !== null
          && Number(source.fact_weight_grams) === line.unitWeightGrams
          && source.fact_length_mm
            === (line.unitDimensionsMm?.length ?? null)
          && source.fact_width_mm
            === (line.unitDimensionsMm?.width ?? null)
          && source.fact_height_mm
            === (line.unitDimensionsMm?.height ?? null)
        ) {
          fail(
            'OPERATIONS_ORDER_UNIT_WEIGHT_UNCHANGED',
            `${source.product_title_snapshot} already has these unit facts`,
            422,
          )
        }
        const factVersion = (currentFactVersion || 0) + 1
        const allocated = await client.query<{ global_id: string }>(
          `SELECT allocate_global_reference('gouw') AS global_id`,
        )
        const globalId = allocated.rows[0].global_id
        const inserted = await client.query<{ fact_hash: string }>(
          `INSERT INTO operations_order_unit_weight_facts (
             global_id, organization_id, integration_account_id, pipeline_id,
             candidate_id, candidate_row_version, order_id, order_line_id,
             planning_line_id, planning_line_global_id,
             candidate_line_id, revision_application_line_id,
             line_source_revision, line_source_hash, fact_version,
             supersedes_fact_id, unit_weight_grams,
             unit_length_mm, unit_width_mm, unit_height_mm,
             dimension_evidence_basis,
             reason, request_hash, fact_hash,
             command_receipt_id, recorded_by
           )
           SELECT $1::text, line.organization_id, line.integration_account_id,
                  line.pipeline_id, line.order_candidate_id,
                  $2::bigint, candidate.canonical_order_id,
                  line.canonical_order_line_id, line.id, line.global_id,
                  $14::uuid, $15::uuid,
                  line.source_revision, line.source_hash, $12::integer,
                  $13::uuid, $3::integer,
                  $18::integer, $19::integer, $20::integer,
                  CASE WHEN $18::integer IS NULL THEN NULL
                    ELSE 'operator_recorded_order_dimensions'
                  END, $4, $5,
                  encode(digest(convert_to(jsonb_build_object(
                    'candidateGlobalId', candidate.global_id,
                    'candidateRowVersion', $2::bigint,
                    'factGlobalId', $1::text,
                    'factVersion', $12::integer,
                    'lineGlobalId', line.global_id,
                    'lineSourceHash', line.source_hash,
                    'lineSourceRevision', line.source_revision,
                    'unitDimensionsMm', CASE
                      WHEN $18::integer IS NULL THEN NULL
                      ELSE jsonb_build_object(
                        'height', $20::integer,
                        'length', $18::integer,
                        'width', $19::integer
                      )
                    END,
                    'unitWeightGrams', $3::integer
                  )::text, 'UTF8'), 'sha256'), 'hex'),
                  $6::uuid, $7
           FROM operations_commerce_current_planning_lines line
           JOIN operations_commerce_order_candidates candidate
             ON candidate.organization_id = line.organization_id
            AND candidate.id = line.order_candidate_id
           WHERE line.organization_id = $8::uuid
             AND line.order_candidate_id = $9::uuid
             AND line.id = $10::uuid
             AND line.global_id = $11
             AND line.source_revision = $16
             AND line.source_hash = $17
           RETURNING fact_hash`,
          [
            globalId,
            input.expectedCandidateRowVersion,
            line.unitWeightGrams,
            normalized.reason,
            hash,
            command.receipt.id,
            input.actorEmail,
            input.organizationId,
            candidate.id,
            source.id,
            source.global_id,
            factVersion,
            source.fact_id,
            source.candidate_line_id,
            source.revision_application_line_id,
            source.line_source_revision,
            source.line_source_hash,
            line.unitDimensionsMm?.length ?? null,
            line.unitDimensionsMm?.width ?? null,
            line.unitDimensionsMm?.height ?? null,
          ],
        )
        if (inserted.rowCount !== 1) {
          fail(
            'OPERATIONS_ORDER_UNIT_WEIGHT_CONTEXT_CHANGED',
            'An imported order line changed; reopen Prepare order and try again',
            409,
          )
        }
        facts.push({
          globalId,
          lineGlobalId: line.lineGlobalId,
          factHash: inserted.rows[0].fact_hash,
        })
      }
      const factGlobalIds = facts.map((fact) => fact.globalId).sort()
      const resultPayload = {
        action: 'record-order-unit-weights',
        candidateGlobalId: input.candidateGlobalId,
        orderGlobalId: current.orderGlobalId,
        factGlobalIds,
        providerWriteCount: 0,
      }
      await client.query(
        `INSERT INTO operations_domain_events (
           organization_id, aggregate_type, aggregate_id,
           aggregate_global_id, event_type, payload, actor_email,
           correlation_id, idempotency_key
         ) VALUES (
           $1::uuid, 'operations.order', $2::uuid, $3,
           'operations.order.unit_weights_recorded', $4::jsonb, $5,
           $6::uuid, $7
         ) ON CONFLICT (organization_id, idempotency_key) DO NOTHING`,
        [
          input.organizationId,
          candidate.order_id,
          candidate.order_global_id,
          JSON.stringify({
            candidateGlobalId: input.candidateGlobalId,
            facts,
            providerWriteCount: 0,
            reason: normalized.reason,
          }),
          input.actorEmail,
          command.receipt.correlation_id,
          `order-unit-weight:${input.idempotencyKey}`,
        ],
      )
      await recordAuditEvent({
        actor: input.actorEmail,
        eventType: 'operations.order.unit_weights_recorded',
        aggregateType: 'operations.order',
        aggregateId: candidate.order_global_id,
        subject: candidate.order_global_id,
        organizationId: input.organizationId,
        eventKey: `operations:order-unit-weight:${command.receipt.id}`,
        payload: {
          candidateGlobalId: input.candidateGlobalId,
          facts,
          providerWriteCount: 0,
          reason: normalized.reason,
        },
      }, client)
      const completed = await client.query(
        `UPDATE operations_command_receipts
         SET status = 'succeeded', result_global_id = $2,
             result_payload = $3::jsonb, error_code = NULL,
             error_message = NULL, completed_at = now(), updated_at = now()
         WHERE id = $1::uuid
           AND correlation_id = $4::uuid
           AND status = 'processing'`,
        [
          command.receipt.id,
          input.candidateGlobalId,
          JSON.stringify(resultPayload),
          command.receipt.correlation_id,
        ],
      )
      if (completed.rowCount !== 1) {
        fail(
          'OPERATIONS_COMMAND_ATTEMPT_EXPIRED',
          'This unit-weight save attempt expired; reopen Prepare order',
          409,
        )
      }
      return { factGlobalIds, resultPayload }
    })
    let currentWorkspace: OrderUnitWeightWorkspace | null = null
    try {
      currentWorkspace = await workspace(null, {
        organizationId: input.organizationId,
        accountGlobalId: input.accountGlobalId,
        candidateGlobalId: input.candidateGlobalId,
      })
    } catch {
      // The sealed receipt remains the durable response if the order advances
      // immediately after commit or a follow-up read is unavailable.
    }
    return {
      replayed: false,
      ...saved.resultPayload,
      workspace: currentWorkspace,
    }
  } catch (error) {
    await failReceipt(command.receipt, error)
    throw error
  }
}
