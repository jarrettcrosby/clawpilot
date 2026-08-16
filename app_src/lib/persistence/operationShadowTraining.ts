import { createHash } from 'node:crypto'
import type { PoolClient, QueryResultRow } from 'pg'
import {
  assertShadowTrainingCommandState,
  assertShadowTrainingEligibility,
  OperationsShadowTrainingError,
  shadowTrainingAvailableActions,
  shadowTrainingUndoTarget,
  type OperationsShadowTrainingAction,
  type OperationsShadowTrainingState,
} from '@/lib/operations/shadowTraining'
import { readCartonizationRateEvidenceByGlobalId } from '@/lib/persistence/cartonizationRateEvidence'
import {
  acquireTransactionAdvisoryLock,
  getPostgresPool,
  withTransaction,
} from '@/lib/persistence/postgres'

const ORDER_GLOBAL_ID = /^gor(?:[0-9]{7}|[0-9a-v]{12})$/
const RUN_GLOBAL_ID = /^gtrn(?:[0-9]{7}|[0-9a-v]{12})$/
const EVIDENCE_GLOBAL_ID = /^gcte(?:[0-9]{7}|[0-9a-v]{12})$/
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,200}$/

type Queryable = Pick<PoolClient, 'query'>

type TrainingRunRow = QueryResultRow & {
  id: string
  global_id: string
  source_order_id: string
  source_order_global_id: string
  source_order_number: string
  current_order_status: string
  current_order_row_version: string
  integration_account_id: string
  integration_account_global_id: string
  source_candidate_id: string
  source_candidate_global_id: string
  current_candidate_row_version: string
  current_candidate_source_hash: string
  training_evidence_sealed: boolean
  generation: number
  provider: 'shopify' | 'faire'
  account_environment: 'sandbox' | 'production'
  authorization_activation_revision: number
  authorization_order_row_version: string
  authorization_candidate_row_version: string
  authorization_candidate_source_hash: string
  authorization_credential_generation: number
  authorization_reason: string
  authorized_by: string
  authorized_at: Date
  source_snapshot_sha256: string
  cartonization_evidence_global_id: string | null
  warehouse_global_id: string | null
  warehouse_name: string | null
  state: OperationsShadowTrainingState
  commerce_provider_read_count: number
  commerce_provider_write_count: number
  carrier_sandbox_write_count: number
  production_postage_count: number
  inventory_mutation_count: number
  packaging_stock_mutation_count: number
  row_version: string
  completed_at: Date | null
  reset_at: Date | null
  reset_reason: string | null
  reset_blocker_code: string | null
  current_activation_state: string
  current_activation_revision: number
  created_at: Date
  updated_at: Date
}

type TrainingPackageRow = QueryResultRow & {
  id: string
  global_id: string
  package_sequence: number
  evidence_package_key: string
  packaging_material_global_id: string
  packaging_material_name: string
  rated_outer_dimensions_mm: { length: number; width: number; height: number }
  content_weight_grams: number
  tare_weight_grams: number
  rated_gross_weight_grams: number
  allocations: Array<{
    lineGlobalId: string
    productGlobalId: string
    quantity: number
    title: string
  }>
  status: 'planned' | 'packed' | 'labeled' | 'completed'
  packed_by: string | null
  packed_at: Date | null
  completed_at: Date | null
}

type TrainingPickRow = QueryResultRow & {
  global_id: string
  training_package_global_id: string
  task_sequence: number
  source_line_global_id: string
  product_global_id: string
  title: string
  quantity: string
  status: 'ready' | 'picked'
  picked_by: string | null
  picked_at: Date | null
}

export type OperationsShadowTrainingRun = {
  globalId: string
  sourceOrderGlobalId: string
  sourceOrderNumber: string
  generation: number
  provider: 'shopify' | 'faire'
  accountEnvironment: 'sandbox' | 'production'
  integrationAccountGlobalId: string
  state: OperationsShadowTrainingState
  rowVersion: number
  trainingEnabled: true
  sourceChanged: boolean
  candidateChanged: boolean
  trainingEvidenceSealed: boolean
  restartRequiredBeforePlan: boolean
  activationChanged: boolean
  sourceStatus: string
  sourceSnapshotSha256: string
  cartonizationEvidenceGlobalId: string | null
  warehouse: null | { globalId: string; name: string }
  availableActions: OperationsShadowTrainingAction[]
  counters: {
    commerceProviderReads: number
    commerceProviderWrites: 0
    carrierSandboxWrites: number
    productionPostage: 0
    inventoryMutations: 0
    packagingStockMutations: 0
  }
  labelAndPrint: {
    available: false
    code: 'OPERATIONS_SHADOW_TRAINING_LABEL_EVIDENCE_NOT_BOUND'
    message: string
  }
  packages: Array<{
    globalId: string
    sequence: number
    evidencePackageKey: string
    materialGlobalId: string
    materialName: string
    dimensionsMm: { length: number; width: number; height: number }
    contentWeightGrams: number
    tareWeightGrams: number
    grossWeightGrams: number
    status: 'planned' | 'packed' | 'labeled' | 'completed'
  }>
  pickTasks: Array<{
    globalId: string
    packageGlobalId: string
    sequence: number
    sourceLineGlobalId: string
    productGlobalId: string
    title: string
    quantity: number
    status: 'ready' | 'picked'
    pickedBy: string | null
    pickedAt: string | null
  }>
  authorization: {
    activationRevision: number
    reason: string
    actorEmail: string
    authorizedAt: string
  }
  completedAt: string | null
  resetBlockerCode: string | null
  createdAt: string
  updatedAt: string
}

export type OperationsShadowTrainingOrderState = {
  eligible: boolean
  eligibilityCode: string | null
  run: OperationsShadowTrainingRun | null
}

function iso(value: Date | null) {
  return value ? value.toISOString() : null
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stableValue(item)]),
    )
  }
  return value
}

function fingerprint(value: unknown) {
  return createHash('sha256')
    .update(JSON.stringify(stableValue(value)))
    .digest('hex')
}

function requireOrganizationId(value: string) {
  const normalized = String(value || '').trim()
  if (!/^[0-9a-f-]{36}$/i.test(normalized)) {
    throw new OperationsShadowTrainingError(
      'Select an active organization first.',
      409,
      'ACTIVE_ORGANIZATION_REQUIRED',
    )
  }
  return normalized
}

function requireActorEmail(value: string) {
  const normalized = String(value || '').trim().toLowerCase()
  if (!normalized || normalized.length > 254) {
    throw new OperationsShadowTrainingError(
      'A signed-in user is required.',
      401,
      'UNAUTHORIZED',
    )
  }
  return normalized
}

function requireReason(value: string) {
  const normalized = String(value || '').trim()
  if (!normalized || normalized.length > 500 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new OperationsShadowTrainingError(
      'A training reason is required.',
      400,
      'OPERATIONS_SHADOW_TRAINING_REASON_INVALID',
    )
  }
  return normalized
}

function requireIdempotencyKey(value: string) {
  const normalized = String(value || '').trim()
  if (!IDEMPOTENCY_KEY.test(normalized)) {
    throw new OperationsShadowTrainingError(
      'A valid Idempotency-Key header is required.',
      400,
      'OPERATIONS_IDEMPOTENCY_KEY_INVALID',
    )
  }
  return normalized
}

function requireExpectedRowVersion(value: number) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new OperationsShadowTrainingError(
      'Training run version is invalid.',
      400,
      'OPERATIONS_SHADOW_TRAINING_VERSION_INVALID',
    )
  }
  return value
}

async function readRunRows(
  db: Queryable,
  organizationId: string,
  whereSql: string,
  value: string,
) {
  const runResult = await db.query<TrainingRunRow>(
    `SELECT
       run.id::text, run.global_id,
       run.source_order_id::text, source_order.global_id AS source_order_global_id,
       source_order.order_number AS source_order_number,
       source_order.status AS current_order_status,
       source_order.row_version::text AS current_order_row_version,
       run.integration_account_id::text,
       account.global_id AS integration_account_global_id,
       run.source_candidate_id::text,
       candidate.global_id AS source_candidate_global_id,
       candidate.row_version::text AS current_candidate_row_version,
       candidate.source_hash AS current_candidate_source_hash,
       sealed_evidence.global_id IS NOT NULL AS training_evidence_sealed,
       run.generation, run.provider, run.account_environment,
       run.authorization_activation_revision,
       run.authorization_order_row_version::text,
       run.authorization_candidate_row_version::text,
       run.authorization_candidate_source_hash,
       run.authorization_credential_generation,
       run.authorization_reason, run.authorized_by, run.authorized_at,
       run.source_snapshot_sha256,
       COALESCE(
         run.cartonization_evidence_global_id,
         sealed_evidence.global_id
       ) AS cartonization_evidence_global_id,
       warehouse.global_id AS warehouse_global_id,
       warehouse.name AS warehouse_name,
       run.state, run.commerce_provider_read_count,
       run.commerce_provider_write_count, run.carrier_sandbox_write_count,
       run.production_postage_count, run.inventory_mutation_count,
       run.packaging_stock_mutation_count, run.row_version::text,
       run.completed_at, run.reset_at, run.reset_reason,
       run.reset_blocker_code, activation.state AS current_activation_state,
       activation.revision AS current_activation_revision,
       run.created_at, run.updated_at
     FROM operations_shadow_training_runs run
     JOIN operations_orders source_order
       ON source_order.organization_id = run.organization_id
      AND source_order.id = run.source_order_id
     JOIN operations_integration_accounts account
       ON account.organization_id = run.organization_id
      AND account.id = run.integration_account_id
     JOIN operations_commerce_order_candidates candidate
       ON candidate.organization_id = run.organization_id
      AND candidate.integration_account_id = run.integration_account_id
      AND candidate.id = run.source_candidate_id
      AND candidate.canonical_order_id = run.source_order_id
     JOIN operations_activation_scopes activation
       ON activation.organization_id = run.organization_id
     LEFT JOIN LATERAL (
       SELECT evidence.global_id, evidence.warehouse_id
       FROM operations_cartonization_rate_evidence evidence
       WHERE evidence.organization_id = run.organization_id
         AND evidence.integration_account_id = run.integration_account_id
         AND evidence.order_candidate_id = run.source_candidate_id
         AND evidence.status IN ('succeeded', 'partial')
         AND evidence.candidate_row_version = run.authorization_candidate_row_version
         AND evidence.candidate_source_hash = run.authorization_candidate_source_hash
         AND evidence.plan_snapshot->'shadowTraining'->>'version' =
           'shadow-training-evidence-v1'
         AND evidence.plan_snapshot->'shadowTraining'->>'runGlobalId' = run.global_id
         AND (
           (
             run.cartonization_evidence_id IS NOT NULL
             AND evidence.id = run.cartonization_evidence_id
           )
           OR (
             run.cartonization_evidence_id IS NULL
             AND evidence.plan_snapshot->'shadowTraining'->>'runRowVersion' =
               run.row_version::text
           )
         )
       ORDER BY evidence.created_at DESC, evidence.id DESC
       LIMIT 1
     ) sealed_evidence ON true
     LEFT JOIN operations_warehouses warehouse
       ON warehouse.organization_id = run.organization_id
      AND warehouse.id = COALESCE(run.warehouse_id, sealed_evidence.warehouse_id)
     WHERE run.organization_id = $1::uuid
       AND ${whereSql}
     LIMIT 1`,
    [organizationId, value],
  )
  const row = runResult.rows[0]
  if (!row) return null
  const [packagesResult, picksResult] = await Promise.all([
    db.query<TrainingPackageRow>(
      `SELECT id::text, global_id, package_sequence, evidence_package_key,
              packaging_material_global_id, packaging_material_name,
              rated_outer_dimensions_mm, content_weight_grams,
              tare_weight_grams, rated_gross_weight_grams, allocations,
              status, packed_by, packed_at, completed_at
       FROM operations_shadow_training_packages
       WHERE organization_id = $1::uuid AND training_run_id = $2::uuid
       ORDER BY package_sequence, id`,
      [organizationId, row.id],
    ),
    db.query<TrainingPickRow>(
      `SELECT task.global_id,
              package.global_id AS training_package_global_id,
              task.task_sequence, task.source_line_global_id,
              task.product_global_id, task.title, task.quantity::text,
              task.status, task.picked_by, task.picked_at
       FROM operations_shadow_training_pick_tasks task
       JOIN operations_shadow_training_packages package
         ON package.organization_id = task.organization_id
        AND package.training_run_id = task.training_run_id
        AND package.id = task.training_package_id
       WHERE task.organization_id = $1::uuid
         AND task.training_run_id = $2::uuid
       ORDER BY task.task_sequence, task.id`,
      [organizationId, row.id],
    ),
  ])
  return mapRun(row, packagesResult.rows, picksResult.rows)
}

function mapRun(
  row: TrainingRunRow,
  packages: TrainingPackageRow[],
  picks: TrainingPickRow[],
): OperationsShadowTrainingRun {
  const sourceChanged = (
    row.current_order_status !== 'imported'
    || Number(row.current_order_row_version) !== Number(row.authorization_order_row_version)
    || Number(row.current_candidate_row_version) !== Number(row.authorization_candidate_row_version)
    || row.current_candidate_source_hash !== row.authorization_candidate_source_hash
  )
  const candidateChanged = (
    Number(row.current_candidate_row_version) !== Number(row.authorization_candidate_row_version)
    || row.current_candidate_source_hash !== row.authorization_candidate_source_hash
  )
  const activationChanged = (
    row.current_activation_revision !== row.authorization_activation_revision
  )
  const restartRequiredBeforePlan = (
    row.state === 'enabled'
    && candidateChanged
    && !row.training_evidence_sealed
  )
  return {
    globalId: row.global_id,
    sourceOrderGlobalId: row.source_order_global_id,
    sourceOrderNumber: row.source_order_number,
    generation: row.generation,
    provider: row.provider,
    accountEnvironment: row.account_environment,
    integrationAccountGlobalId: row.integration_account_global_id,
    state: row.state,
    rowVersion: Number(row.row_version),
    trainingEnabled: true,
    sourceChanged,
    candidateChanged,
    trainingEvidenceSealed: row.training_evidence_sealed,
    restartRequiredBeforePlan,
    activationChanged,
    sourceStatus: row.current_order_status,
    sourceSnapshotSha256: row.source_snapshot_sha256,
    cartonizationEvidenceGlobalId: row.cartonization_evidence_global_id,
    warehouse: row.warehouse_global_id && row.warehouse_name
      ? { globalId: row.warehouse_global_id, name: row.warehouse_name }
      : null,
    availableActions: restartRequiredBeforePlan
      ? shadowTrainingAvailableActions(row.state).filter((action) => action === 'reset')
      : shadowTrainingAvailableActions(row.state),
    counters: {
      commerceProviderReads: row.commerce_provider_read_count,
      commerceProviderWrites: 0,
      carrierSandboxWrites: row.carrier_sandbox_write_count,
      productionPostage: 0,
      inventoryMutations: 0,
      packagingStockMutations: 0,
    },
    labelAndPrint: {
      available: false,
      code: 'OPERATIONS_SHADOW_TRAINING_LABEL_EVIDENCE_NOT_BOUND',
      message: 'Order-bound training labels remain locked until this exact training package owns matching sandbox_rate_test evidence. Use Shipping Settings for separate account and printer diagnostics.',
    },
    packages: packages.map((item) => ({
      globalId: item.global_id,
      sequence: item.package_sequence,
      evidencePackageKey: item.evidence_package_key,
      materialGlobalId: item.packaging_material_global_id,
      materialName: item.packaging_material_name,
      dimensionsMm: item.rated_outer_dimensions_mm,
      contentWeightGrams: item.content_weight_grams,
      tareWeightGrams: item.tare_weight_grams,
      grossWeightGrams: item.rated_gross_weight_grams,
      status: item.status,
    })),
    pickTasks: picks.map((item) => ({
      globalId: item.global_id,
      packageGlobalId: item.training_package_global_id,
      sequence: item.task_sequence,
      sourceLineGlobalId: item.source_line_global_id,
      productGlobalId: item.product_global_id,
      title: item.title,
      quantity: Number(item.quantity),
      status: item.status,
      pickedBy: item.picked_by,
      pickedAt: iso(item.picked_at),
    })),
    authorization: {
      activationRevision: row.authorization_activation_revision,
      reason: row.authorization_reason,
      actorEmail: row.authorized_by,
      authorizedAt: row.authorized_at.toISOString(),
    },
    completedAt: iso(row.completed_at),
    resetBlockerCode: row.reset_blocker_code,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  }
}

async function activeRunForOrder(
  db: Queryable,
  organizationId: string,
  orderGlobalId: string,
) {
  return readRunRows(
    db,
    organizationId,
    `run.source_order_id = (
       SELECT id FROM operations_orders
       WHERE organization_id = $1::uuid AND global_id = $2
     ) AND run.state <> 'reset'`,
    orderGlobalId,
  )
}

export async function readOperationsShadowTrainingForOrderInPostgres(input: {
  organizationId: string
  orderGlobalId: string
}): Promise<OperationsShadowTrainingOrderState> {
  const organizationId = requireOrganizationId(input.organizationId)
  const orderGlobalId = String(input.orderGlobalId || '').trim()
  if (!ORDER_GLOBAL_ID.test(orderGlobalId)) {
    throw new OperationsShadowTrainingError(
      'Order is invalid.',
      400,
      'OPERATIONS_ORDER_INVALID',
    )
  }
  const pool = getPostgresPool()
  const run = await activeRunForOrder(pool, organizationId, orderGlobalId)
  if (run) return { eligible: false, eligibilityCode: 'TRAINING_ALREADY_ENABLED', run }

  const context = await pool.query<{
    activation_state: string
    order_status: string
    source_provider: string
    integration_type: string
    account_status: string
    account_environment: string
    verification_status: string
    zero_downstream: boolean
    promoted_candidate: boolean
    resolved_training_lines: boolean
  }>(
    `SELECT activation.state AS activation_state,
            source_order.status AS order_status,
            source_order.source_provider,
            account.integration_type,
            account.status AS account_status,
            account.environment AS account_environment,
            credential.verification_status,
            ocr_order_has_zero_downstream(
              source_order.organization_id,
              source_order.id
            ) AS zero_downstream,
            EXISTS (
              SELECT 1
              FROM operations_commerce_order_candidates candidate
              WHERE candidate.organization_id = source_order.organization_id
                AND candidate.integration_account_id = source_order.integration_account_id
                AND candidate.canonical_order_id = source_order.id
                AND candidate.workflow_state = 'promoted'
            ) AS promoted_candidate,
            EXISTS (
              SELECT 1
              FROM operations_commerce_order_candidates candidate
              JOIN operations_commerce_order_candidate_lines line
                ON line.organization_id = candidate.organization_id
               AND line.integration_account_id = candidate.integration_account_id
               AND line.order_candidate_id = candidate.id
              WHERE candidate.organization_id = source_order.organization_id
                AND candidate.integration_account_id = source_order.integration_account_id
                AND candidate.canonical_order_id = source_order.id
                AND candidate.workflow_state = 'promoted'
            ) AND NOT EXISTS (
              SELECT 1
              FROM operations_commerce_order_candidates candidate
              JOIN operations_commerce_order_candidate_lines line
                ON line.organization_id = candidate.organization_id
               AND line.integration_account_id = candidate.integration_account_id
               AND line.order_candidate_id = candidate.id
              LEFT JOIN crm_products product
                ON product.pipeline_id = line.pipeline_id
               AND product.id = line.product_id
              WHERE candidate.organization_id = source_order.organization_id
                AND candidate.integration_account_id = source_order.integration_account_id
                AND candidate.canonical_order_id = source_order.id
                AND candidate.workflow_state = 'promoted'
                AND product.id IS NULL
            ) AS resolved_training_lines
     FROM operations_orders source_order
     JOIN operations_activation_scopes activation
       ON activation.organization_id = source_order.organization_id
     JOIN operations_integration_accounts account
       ON account.organization_id = source_order.organization_id
      AND account.id = source_order.integration_account_id
     LEFT JOIN operations_commerce_credentials credential
       ON credential.organization_id = account.organization_id
      AND credential.integration_account_id = account.id
     WHERE source_order.organization_id = $1::uuid
       AND source_order.global_id = $2
     LIMIT 1`,
    [organizationId, orderGlobalId],
  )
  const row = context.rows[0]
  if (!row) {
    throw new OperationsShadowTrainingError(
      'Order was not found.',
      404,
      'OPERATIONS_ORDER_NOT_FOUND',
    )
  }
  try {
    assertShadowTrainingEligibility({
      activationState: row.activation_state,
      orderStatus: row.order_status,
      sourceProvider: row.source_provider,
      integrationType: row.integration_type,
      accountStatus: row.account_status,
      accountEnvironment: row.account_environment,
      credentialVerificationStatus: row.verification_status || '',
    })
    if (row.zero_downstream !== true) {
      return {
        eligible: false,
        eligibilityCode: 'OPERATIONS_SHADOW_TRAINING_DOWNSTREAM_EXISTS',
        run: null,
      }
    }
    if (row.promoted_candidate !== true) {
      return {
        eligible: false,
        eligibilityCode: 'OPERATIONS_SHADOW_TRAINING_SOURCE_NOT_CURRENT',
        run: null,
      }
    }
    if (row.resolved_training_lines !== true) {
      return {
        eligible: false,
        eligibilityCode: 'OPERATIONS_SHADOW_TRAINING_LINES_REQUIRED',
        run: null,
      }
    }
    return { eligible: true, eligibilityCode: null, run: null }
  } catch (error) {
    if (!(error instanceof OperationsShadowTrainingError)) throw error
    return { eligible: false, eligibilityCode: error.code, run: null }
  }
}

async function recordEvent(input: {
  client: PoolClient
  organizationId: string
  runId: string
  eventType: string
  fromState: OperationsShadowTrainingState | null
  toState: OperationsShadowTrainingState
  requestHash: string
  idempotencyKey: string
  actorEmail: string
  payload?: Record<string, unknown>
}) {
  await input.client.query(
    `INSERT INTO operations_shadow_training_events (
       organization_id, training_run_id, event_type, from_state, to_state,
       request_hash, idempotency_key, payload, actor_email
     ) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8::jsonb, $9)`,
    [
      input.organizationId, input.runId, input.eventType, input.fromState,
      input.toState, input.requestHash, input.idempotencyKey,
      JSON.stringify(input.payload || {}), input.actorEmail,
    ],
  )
}

async function priorEvent(
  client: PoolClient,
  organizationId: string,
  idempotencyKey: string,
  requestHash: string,
) {
  const result = await client.query<{ request_hash: string }>(
    `SELECT request_hash
     FROM operations_shadow_training_events
     WHERE organization_id = $1::uuid AND idempotency_key = $2
     FOR SHARE`,
    [organizationId, idempotencyKey],
  )
  if (!result.rows[0]) return false
  if (result.rows[0].request_hash !== requestHash) {
    throw new OperationsShadowTrainingError(
      'Idempotency-Key was already used for a different training command.',
      409,
      'OPERATIONS_SHADOW_TRAINING_IDEMPOTENCY_REUSED',
    )
  }
  return true
}

export async function enableOperationsShadowTrainingInPostgres(input: {
  organizationId: string
  actorEmail: string
  orderGlobalId: string
  confirmation: string
  reason: string
  idempotencyKey: string
}) {
  const organizationId = requireOrganizationId(input.organizationId)
  const actorEmail = requireActorEmail(input.actorEmail)
  const orderGlobalId = String(input.orderGlobalId || '').trim()
  const reason = requireReason(input.reason)
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey)
  if (!ORDER_GLOBAL_ID.test(orderGlobalId)) {
    throw new OperationsShadowTrainingError('Order is invalid.', 400, 'OPERATIONS_ORDER_INVALID')
  }
  if (input.confirmation !== 'local_training_only') {
    throw new OperationsShadowTrainingError(
      'Confirm that this exact order is being enabled for local-only training.',
      400,
      'OPERATIONS_SHADOW_TRAINING_CONFIRMATION_REQUIRED',
    )
  }
  const requestHash = fingerprint({
    action: 'enable', organizationId, actorEmail, orderGlobalId,
    confirmation: input.confirmation, reason,
  })

  const runGlobalId = await withTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(client, `operations:activation:${organizationId}`)
    await acquireTransactionAdvisoryLock(
      client,
      `operations:shadow-training:order:${organizationId}:${orderGlobalId}`,
    )
    const replay = await client.query<{ global_id: string; authorization_request_hash: string }>(
      `SELECT global_id, authorization_request_hash
       FROM operations_shadow_training_runs
       WHERE organization_id = $1::uuid AND authorization_idempotency_key = $2
       FOR SHARE`,
      [organizationId, idempotencyKey],
    )
    if (replay.rows[0]) {
      if (replay.rows[0].authorization_request_hash !== requestHash) {
        throw new OperationsShadowTrainingError(
          'Idempotency-Key was already used for a different training authorization.',
          409,
          'OPERATIONS_SHADOW_TRAINING_IDEMPOTENCY_REUSED',
        )
      }
      return replay.rows[0].global_id
    }

    const context = await client.query<{
      order_id: string
      order_global_id: string
      order_number: string
      order_status: string
      order_row_version: string
      external_order_id: string
      source_provider: 'shopify' | 'faire'
      integration_account_id: string
      integration_account_global_id: string
      integration_type: string
      account_status: string
      account_environment: 'sandbox' | 'production'
      candidate_id: string
      candidate_global_id: string
      candidate_row_version: string
      candidate_source_hash: string
      candidate_workflow_state: string
      candidate_order_status: string
      candidate_fulfillment_status: string
      activation_state: string
      activation_revision: number
      credential_version: number
      verification_status: string
      zero_downstream: boolean
    }>(
      `SELECT source_order.id::text AS order_id,
              source_order.global_id AS order_global_id,
              source_order.order_number,
              source_order.status AS order_status,
              source_order.row_version::text AS order_row_version,
              source_order.external_order_id,
              source_order.source_provider,
              account.id::text AS integration_account_id,
              account.global_id AS integration_account_global_id,
              account.integration_type, account.status AS account_status,
              account.environment AS account_environment,
              candidate.id::text AS candidate_id,
              candidate.global_id AS candidate_global_id,
              candidate.row_version::text AS candidate_row_version,
              candidate.source_hash AS candidate_source_hash,
              candidate.workflow_state AS candidate_workflow_state,
              candidate.normalized_order_status AS candidate_order_status,
              candidate.normalized_fulfillment_status AS candidate_fulfillment_status,
              activation.state AS activation_state,
              activation.revision AS activation_revision,
              credential.credential_version,
              credential.verification_status,
              ocr_order_has_zero_downstream(
                source_order.organization_id,
                source_order.id
              ) AS zero_downstream
       FROM operations_orders source_order
       JOIN operations_integration_accounts account
         ON account.organization_id = source_order.organization_id
        AND account.id = source_order.integration_account_id
       JOIN operations_commerce_credentials credential
         ON credential.organization_id = account.organization_id
        AND credential.integration_account_id = account.id
       JOIN operations_commerce_order_candidates candidate
         ON candidate.organization_id = source_order.organization_id
        AND candidate.integration_account_id = source_order.integration_account_id
        AND candidate.canonical_order_id = source_order.id
        AND candidate.workflow_state = 'promoted'
       JOIN operations_activation_scopes activation
         ON activation.organization_id = source_order.organization_id
       WHERE source_order.organization_id = $1::uuid
         AND source_order.global_id = $2
       FOR UPDATE OF source_order, account, credential, candidate, activation`,
      [organizationId, orderGlobalId],
    )
    const row = context.rows[0]
    if (!row) {
      throw new OperationsShadowTrainingError('Order was not found.', 404, 'OPERATIONS_ORDER_NOT_FOUND')
    }
    assertShadowTrainingEligibility({
      activationState: row.activation_state,
      orderStatus: row.order_status,
      sourceProvider: row.source_provider,
      integrationType: row.integration_type,
      accountStatus: row.account_status,
      accountEnvironment: row.account_environment,
      credentialVerificationStatus: row.verification_status,
    })
    if (row.zero_downstream !== true) {
      throw new OperationsShadowTrainingError(
        'This order already has canonical fulfillment work. Use an untouched imported order for training.',
        409,
        'OPERATIONS_SHADOW_TRAINING_DOWNSTREAM_EXISTS',
      )
    }
    if (row.candidate_workflow_state !== 'promoted') {
      throw new OperationsShadowTrainingError(
        'The imported order candidate is not the promoted canonical source.',
        409,
        'OPERATIONS_SHADOW_TRAINING_SOURCE_NOT_CURRENT',
      )
    }
    const existing = await client.query<{ global_id: string }>(
      `SELECT global_id
       FROM operations_shadow_training_runs
       WHERE organization_id = $1::uuid
         AND source_order_id = $2::uuid
         AND state <> 'reset'
       FOR SHARE`,
      [organizationId, row.order_id],
    )
    if (existing.rows[0]) {
      throw new OperationsShadowTrainingError(
        `Training is already enabled as ${existing.rows[0].global_id}.`,
        409,
        'OPERATIONS_SHADOW_TRAINING_ALREADY_ENABLED',
      )
    }
    const lineResult = await client.query<{
      line_global_id: string
      external_line_id: string
      product_global_id: string | null
      title: string
      ordered_quantity: string
      current_quantity: string
      fulfilled_quantity: string
      source_hash: string
    }>(
      `SELECT line.global_id AS line_global_id,
              line.external_line_id,
              product.reference_code AS product_global_id,
              line.product_title_snapshot AS title,
              line.ordered_quantity::text,
              line.current_quantity::text,
              line.fulfilled_quantity::text,
              line.source_hash
       FROM operations_commerce_order_candidate_lines line
       LEFT JOIN crm_products product
         ON product.pipeline_id = line.pipeline_id
        AND product.id = line.product_id
       WHERE line.organization_id = $1::uuid
         AND line.integration_account_id = $2::uuid
         AND line.order_candidate_id = $3::uuid
       ORDER BY line.global_id`,
      [organizationId, row.integration_account_id, row.candidate_id],
    )
    if (
      lineResult.rows.length < 1
      || lineResult.rows.some((line) => !line.product_global_id)
    ) {
      throw new OperationsShadowTrainingError(
        'The imported order has no resolved training lines.',
        409,
        'OPERATIONS_SHADOW_TRAINING_LINES_REQUIRED',
      )
    }
    const sourceSnapshot = {
      order: {
        globalId: row.order_global_id,
        externalOrderId: row.external_order_id,
        orderNumber: row.order_number,
        status: row.order_status,
        rowVersion: Number(row.order_row_version),
        provider: row.source_provider,
      },
      account: {
        globalId: row.integration_account_global_id,
        environment: row.account_environment,
        credentialVersion: row.credential_version,
      },
      candidate: {
        globalId: row.candidate_global_id,
        rowVersion: Number(row.candidate_row_version),
        sourceHash: row.candidate_source_hash,
        orderStatus: row.candidate_order_status,
        fulfillmentStatus: row.candidate_fulfillment_status,
      },
      lines: lineResult.rows.map((line) => ({
        globalId: line.line_global_id,
        externalLineId: line.external_line_id,
        productGlobalId: line.product_global_id!,
        title: line.title,
        orderedQuantity: Number(line.ordered_quantity),
        currentQuantity: Number(line.current_quantity),
        fulfilledQuantity: Number(line.fulfilled_quantity),
        sourceHash: line.source_hash,
      })),
    }
    const generation = await client.query<{ next_generation: number }>(
      `SELECT COALESCE(MAX(generation), 0) + 1 AS next_generation
       FROM operations_shadow_training_runs
       WHERE organization_id = $1::uuid AND source_order_id = $2::uuid`,
      [organizationId, row.order_id],
    )
    const inserted = await client.query<{ id: string; global_id: string }>(
      `INSERT INTO operations_shadow_training_runs (
         organization_id, source_order_id, integration_account_id,
         source_candidate_id, generation, provider, account_environment,
         authorization_activation_revision, authorization_order_row_version,
         authorization_candidate_row_version,
         authorization_candidate_source_hash,
         authorization_credential_generation,
         authorization_idempotency_key, authorization_request_hash,
         authorization_reason, authorized_by, source_snapshot,
         source_snapshot_sha256, updated_by
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $8, $9, $10,
         $11, $12, $13, $14, $15, $16, $17::jsonb, $18, $16
       ) RETURNING id::text, global_id`,
      [
        organizationId, row.order_id, row.integration_account_id,
        row.candidate_id, generation.rows[0].next_generation,
        row.source_provider, row.account_environment, row.activation_revision,
        Number(row.order_row_version), Number(row.candidate_row_version),
        row.candidate_source_hash, row.credential_version, idempotencyKey,
        requestHash, reason, actorEmail, JSON.stringify(sourceSnapshot),
        fingerprint(sourceSnapshot),
      ],
    )
    await recordEvent({
      client, organizationId, runId: inserted.rows[0].id,
      eventType: 'shadow_training.enabled', fromState: null, toState: 'enabled',
      requestHash, idempotencyKey, actorEmail,
      payload: {
        sourceOrderGlobalId: row.order_global_id,
        provider: row.source_provider,
        accountEnvironment: row.account_environment,
        commerceProviderWrites: 0,
      },
    })
    return inserted.rows[0].global_id
  })
  return readRunByGlobalId(organizationId, runGlobalId)
}

async function lockedRun(
  client: PoolClient,
  organizationId: string,
  runGlobalId: string,
) {
  const result = await client.query<{
    id: string
    global_id: string
    state: OperationsShadowTrainingState
    row_version: string
    authorization_activation_revision: number
    authorization_candidate_row_version: string
    authorization_candidate_source_hash: string
    source_candidate_id: string
    integration_account_id: string
    activation_state: string
    activation_revision: number
  }>(
    `SELECT run.id::text, run.global_id, run.state, run.row_version::text,
            run.authorization_activation_revision,
            run.authorization_candidate_row_version::text,
            run.authorization_candidate_source_hash,
            run.source_candidate_id::text, run.integration_account_id::text,
            activation.state AS activation_state,
            activation.revision AS activation_revision
     FROM operations_shadow_training_runs run
     JOIN operations_activation_scopes activation
       ON activation.organization_id = run.organization_id
     WHERE run.organization_id = $1::uuid AND run.global_id = $2
     FOR UPDATE OF run, activation`,
    [organizationId, runGlobalId],
  )
  const row = result.rows[0]
  if (!row) {
    throw new OperationsShadowTrainingError(
      'Training run was not found.',
      404,
      'OPERATIONS_SHADOW_TRAINING_NOT_FOUND',
    )
  }
  return row
}

function assertLockedRun(input: {
  run: Awaited<ReturnType<typeof lockedRun>>
  action: OperationsShadowTrainingAction
  expectedRowVersion: number
}) {
  if (Number(input.run.row_version) !== input.expectedRowVersion) {
    throw new OperationsShadowTrainingError(
      'Training changed after it was opened. Refresh before continuing.',
      409,
      'OPERATIONS_SHADOW_TRAINING_VERSION_CONFLICT',
    )
  }
  assertShadowTrainingCommandState({ state: input.run.state, action: input.action })
}

async function readRunByGlobalId(organizationId: string, runGlobalId: string) {
  const run = await readRunRows(
    getPostgresPool(),
    organizationId,
    'run.global_id = $2',
    runGlobalId,
  )
  if (!run) {
    throw new OperationsShadowTrainingError(
      'Training run was not found.', 404, 'OPERATIONS_SHADOW_TRAINING_NOT_FOUND',
    )
  }
  return run
}

export async function planOperationsShadowTrainingInPostgres(input: {
  organizationId: string
  actorEmail: string
  runGlobalId: string
  cartonizationEvidenceGlobalId: string
  expectedRowVersion: number
  reason: string
  idempotencyKey: string
}) {
  const organizationId = requireOrganizationId(input.organizationId)
  const actorEmail = requireActorEmail(input.actorEmail)
  const runGlobalId = String(input.runGlobalId || '').trim()
  const evidenceGlobalId = String(input.cartonizationEvidenceGlobalId || '').trim()
  const expectedRowVersion = requireExpectedRowVersion(input.expectedRowVersion)
  const reason = requireReason(input.reason)
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey)
  if (!RUN_GLOBAL_ID.test(runGlobalId) || !EVIDENCE_GLOBAL_ID.test(evidenceGlobalId)) {
    throw new OperationsShadowTrainingError(
      'Training run or cartonization evidence is invalid.',
      400,
      'OPERATIONS_SHADOW_TRAINING_PLAN_INVALID',
    )
  }
  const evidence = await readCartonizationRateEvidenceByGlobalId({
    organizationId,
    evidenceGlobalId,
  })
  if (!evidence || evidence.status === 'failed' || evidence.packages.length < 1) {
    throw new OperationsShadowTrainingError(
      'Successful sealed cartonization evidence is required for training.',
      409,
      'OPERATIONS_SHADOW_TRAINING_EVIDENCE_REQUIRED',
    )
  }
  const evidenceHash = fingerprint({
    globalId: evidence.globalId,
    accountGlobalId: evidence.accountGlobalId,
    candidateGlobalId: evidence.candidateGlobalId,
    candidateRowVersion: evidence.candidateRowVersion,
    candidateSourceHash: evidence.candidateSourceHash,
    warehouse: evidence.warehouse,
    evidenceMode: evidence.evidenceMode,
    planInputHash: evidence.planInputHash,
    planResultHash: evidence.planResultHash,
    packages: evidence.packages.map((item) => item.packageHash),
  })
  const requestHash = fingerprint({
    action: 'plan', runGlobalId, evidenceGlobalId, evidenceHash,
    expectedRowVersion, reason,
  })
  await withTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(
      client,
      `operations:shadow-training:run:${organizationId}:${runGlobalId}`,
    )
    const run = await lockedRun(client, organizationId, runGlobalId)
    if (await priorEvent(client, organizationId, idempotencyKey, requestHash)) return
    assertLockedRun({ run, action: 'plan', expectedRowVersion })
    const exactEvidence = await client.query<{
      id: string
      integration_account_id: string
      order_candidate_id: string
      warehouse_id: string
      sealed_at: Date | null
      shadow_training_run_global_id: string | null
      shadow_training_run_row_version: string | null
      shadow_training_version: string | null
    }>(
      `SELECT evidence.id::text,
              evidence.integration_account_id::text,
              evidence.order_candidate_id::text,
              evidence.warehouse_id::text,
              evidence.sealed_at,
              evidence.plan_snapshot
                ->'shadowTraining'
                ->>'runGlobalId' AS shadow_training_run_global_id,
              evidence.plan_snapshot
                ->'shadowTraining'
                ->>'runRowVersion' AS shadow_training_run_row_version,
              evidence.plan_snapshot
                ->'shadowTraining'
                ->>'version' AS shadow_training_version
       FROM operations_cartonization_rate_evidence evidence
       WHERE evidence.organization_id = $1::uuid AND evidence.global_id = $2
       FOR SHARE OF evidence`,
      [organizationId, evidenceGlobalId],
    )
    const exact = exactEvidence.rows[0]
    if (
      !exact || !exact.sealed_at
      || exact.integration_account_id !== run.integration_account_id
      || exact.order_candidate_id !== run.source_candidate_id
      || exact.shadow_training_run_global_id !== run.global_id
      || Number(exact.shadow_training_run_row_version) !== Number(run.row_version)
      || exact.shadow_training_version !== 'shadow-training-evidence-v1'
      || evidence.candidateRowVersion !== Number(run.authorization_candidate_row_version)
      || evidence.candidateSourceHash !== run.authorization_candidate_source_hash
      || evidence.accountGlobalId === ''
    ) {
      throw new OperationsShadowTrainingError(
        'Cartonization evidence does not belong to this exact authorized order.',
        409,
        'OPERATIONS_SHADOW_TRAINING_EVIDENCE_MISMATCH',
      )
    }
    let taskSequence = 0
    for (const item of evidence.packages) {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO operations_shadow_training_packages (
           organization_id, training_run_id, package_sequence,
           evidence_package_key, packaging_material_global_id,
           packaging_material_name, rated_outer_dimensions_mm,
           content_weight_grams, tare_weight_grams,
           rated_gross_weight_grams, allocations, source_package_hash
         ) VALUES (
           $1::uuid, $2::uuid, $3, $4, $5, $6, $7::jsonb,
           $8, $9, $10, $11::jsonb, $12
         ) RETURNING id::text`,
        [
          organizationId, run.id, item.packageSequence, item.packageKey,
          item.packagingMaterialGlobalId, item.packagingMaterialName,
          JSON.stringify(item.ratedOuterDimensionsMm),
          item.contentWeightGrams, item.tareWeightGrams,
          item.ratedGrossWeightGrams, JSON.stringify(item.allocations),
          item.packageHash,
        ],
      )
      for (const allocation of item.allocations) {
        taskSequence += 1
        await client.query(
          `INSERT INTO operations_shadow_training_pick_tasks (
             organization_id, training_run_id, training_package_id,
             task_sequence, source_line_global_id, product_global_id,
             title, quantity
           ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8)`,
          [
            organizationId, run.id, inserted.rows[0].id, taskSequence,
            allocation.lineGlobalId, allocation.productGlobalId,
            allocation.title, allocation.quantity,
          ],
        )
      }
    }
    await client.query(
      `UPDATE operations_shadow_training_runs
       SET cartonization_evidence_id = $3::uuid,
           cartonization_evidence_global_id = $4,
           cartonization_evidence_sha256 = $5,
           warehouse_id = $6::uuid,
           state = 'planned', row_version = row_version + 1,
           updated_by = $7, updated_at = now()
       WHERE organization_id = $1::uuid AND id = $2::uuid`,
      [
        organizationId, run.id, exact.id, evidenceGlobalId, evidenceHash,
        exact.warehouse_id, actorEmail,
      ],
    )
    await recordEvent({
      client, organizationId, runId: run.id,
      eventType: 'shadow_training.planned', fromState: 'enabled', toState: 'planned',
      requestHash, idempotencyKey, actorEmail,
      payload: {
        evidenceGlobalId,
        evidenceMode: evidence.evidenceMode,
        packageCount: evidence.packages.length,
        commerceProviderWrites: 0,
        inventoryMutations: 0,
        packagingStockMutations: 0,
      },
    })
  })
  return readRunByGlobalId(organizationId, runGlobalId)
}

async function transitionTrainingRun(input: {
  organizationId: string
  actorEmail: string
  runGlobalId: string
  expectedRowVersion: number
  reason: string
  idempotencyKey: string
  action: Extract<OperationsShadowTrainingAction, 'release' | 'confirm-picks' | 'verify-pack' | 'complete'>
  toState: Extract<OperationsShadowTrainingState, 'released' | 'picked' | 'packed' | 'completed'>
}) {
  const organizationId = requireOrganizationId(input.organizationId)
  const actorEmail = requireActorEmail(input.actorEmail)
  const runGlobalId = String(input.runGlobalId || '').trim()
  const expectedRowVersion = requireExpectedRowVersion(input.expectedRowVersion)
  const reason = requireReason(input.reason)
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey)
  if (!RUN_GLOBAL_ID.test(runGlobalId)) {
    throw new OperationsShadowTrainingError(
      'Training run is invalid.', 400, 'OPERATIONS_SHADOW_TRAINING_RUN_INVALID',
    )
  }
  const requestHash = fingerprint({
    action: input.action, runGlobalId, expectedRowVersion, reason,
  })
  await withTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(
      client,
      `operations:shadow-training:run:${organizationId}:${runGlobalId}`,
    )
    const run = await lockedRun(client, organizationId, runGlobalId)
    if (await priorEvent(client, organizationId, idempotencyKey, requestHash)) return
    assertLockedRun({ run, action: input.action, expectedRowVersion })
    if (input.action === 'confirm-picks') {
      const changed = await client.query(
        `UPDATE operations_shadow_training_pick_tasks
         SET status = 'picked', picked_by = $3, picked_at = now(), updated_at = now()
         WHERE organization_id = $1::uuid AND training_run_id = $2::uuid
           AND status = 'ready'`,
        [organizationId, run.id, actorEmail],
      )
      if (changed.rowCount === 0) {
        throw new OperationsShadowTrainingError(
          'Training has no ready pick tasks.',
          409,
          'OPERATIONS_SHADOW_TRAINING_PICK_TASKS_REQUIRED',
        )
      }
    }
    if (input.action === 'verify-pack') {
      const unpicked = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count
         FROM operations_shadow_training_pick_tasks
         WHERE organization_id = $1::uuid AND training_run_id = $2::uuid
           AND status <> 'picked'`,
        [organizationId, run.id],
      )
      if (Number(unpicked.rows[0].count) > 0) {
        throw new OperationsShadowTrainingError(
          'All training picks must be confirmed before packing.',
          409,
          'OPERATIONS_SHADOW_TRAINING_PICKS_INCOMPLETE',
        )
      }
      await client.query(
        `UPDATE operations_shadow_training_packages
         SET status = 'packed', packed_by = $3, packed_at = now(), updated_at = now()
         WHERE organization_id = $1::uuid AND training_run_id = $2::uuid
           AND status = 'planned'`,
        [organizationId, run.id, actorEmail],
      )
    }
    if (input.action === 'complete') {
      await client.query(
        `UPDATE operations_shadow_training_packages
         SET status = 'completed', completed_at = now(), updated_at = now()
         WHERE organization_id = $1::uuid AND training_run_id = $2::uuid
           AND status = 'packed'`,
        [organizationId, run.id],
      )
    }
    await client.query(
      `UPDATE operations_shadow_training_runs
       SET state = $3,
           completed_at = CASE WHEN $3 = 'completed' THEN now() ELSE NULL END,
           row_version = row_version + 1,
           updated_by = $4, updated_at = now()
       WHERE organization_id = $1::uuid AND id = $2::uuid`,
      [organizationId, run.id, input.toState, actorEmail],
    )
    await recordEvent({
      client, organizationId, runId: run.id,
      eventType: `shadow_training.${input.toState}`,
      fromState: run.state, toState: input.toState,
      requestHash, idempotencyKey, actorEmail,
      payload: {
        reason,
        simulated: true,
        commerceProviderWrites: 0,
        productionPostage: 0,
        inventoryMutations: 0,
        packagingStockMutations: 0,
      },
    })
  })
  return readRunByGlobalId(organizationId, runGlobalId)
}

export function releaseOperationsShadowTrainingInPostgres(
  input: Omit<Parameters<typeof transitionTrainingRun>[0], 'action' | 'toState'>,
) {
  return transitionTrainingRun({ ...input, action: 'release', toState: 'released' })
}

export function confirmOperationsShadowTrainingPicksInPostgres(
  input: Omit<Parameters<typeof transitionTrainingRun>[0], 'action' | 'toState'>,
) {
  return transitionTrainingRun({ ...input, action: 'confirm-picks', toState: 'picked' })
}

export function verifyOperationsShadowTrainingPackInPostgres(
  input: Omit<Parameters<typeof transitionTrainingRun>[0], 'action' | 'toState'>,
) {
  return transitionTrainingRun({ ...input, action: 'verify-pack', toState: 'packed' })
}

export function completeOperationsShadowTrainingInPostgres(
  input: Omit<Parameters<typeof transitionTrainingRun>[0], 'action' | 'toState'>,
) {
  return transitionTrainingRun({ ...input, action: 'complete', toState: 'completed' })
}

export async function undoOperationsShadowTrainingInPostgres(input: {
  organizationId: string
  actorEmail: string
  runGlobalId: string
  expectedRowVersion: number
  reason: string
  idempotencyKey: string
}) {
  const organizationId = requireOrganizationId(input.organizationId)
  const actorEmail = requireActorEmail(input.actorEmail)
  const runGlobalId = String(input.runGlobalId || '').trim()
  const expectedRowVersion = requireExpectedRowVersion(input.expectedRowVersion)
  const reason = requireReason(input.reason)
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey)
  if (!RUN_GLOBAL_ID.test(runGlobalId)) {
    throw new OperationsShadowTrainingError(
      'Training run is invalid.', 400, 'OPERATIONS_SHADOW_TRAINING_RUN_INVALID',
    )
  }
  const requestHash = fingerprint({
    action: 'undo', runGlobalId, expectedRowVersion, reason,
  })
  await withTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(
      client,
      `operations:shadow-training:run:${organizationId}:${runGlobalId}`,
    )
    const run = await lockedRun(client, organizationId, runGlobalId)
    if (await priorEvent(client, organizationId, idempotencyKey, requestHash)) return
    assertLockedRun({ run, action: 'undo', expectedRowVersion })
    const toState = shadowTrainingUndoTarget(run.state)
    const facts = await client.query<{
      package_count: string
      planned_packages: string
      packed_packages: string
      completed_packages: string
      pick_count: string
      ready_picks: string
      picked_picks: string
    }>(
      `SELECT
         (SELECT count(*) FROM operations_shadow_training_packages package
          WHERE package.organization_id = $1::uuid
            AND package.training_run_id = $2::uuid)::text AS package_count,
         (SELECT count(*) FROM operations_shadow_training_packages package
          WHERE package.organization_id = $1::uuid
            AND package.training_run_id = $2::uuid
            AND package.status = 'planned')::text AS planned_packages,
         (SELECT count(*) FROM operations_shadow_training_packages package
          WHERE package.organization_id = $1::uuid
            AND package.training_run_id = $2::uuid
            AND package.status = 'packed')::text AS packed_packages,
         (SELECT count(*) FROM operations_shadow_training_packages package
          WHERE package.organization_id = $1::uuid
            AND package.training_run_id = $2::uuid
            AND package.status = 'completed')::text AS completed_packages,
         (SELECT count(*) FROM operations_shadow_training_pick_tasks task
          WHERE task.organization_id = $1::uuid
            AND task.training_run_id = $2::uuid)::text AS pick_count,
         (SELECT count(*) FROM operations_shadow_training_pick_tasks task
          WHERE task.organization_id = $1::uuid
            AND task.training_run_id = $2::uuid
            AND task.status = 'ready')::text AS ready_picks,
         (SELECT count(*) FROM operations_shadow_training_pick_tasks task
          WHERE task.organization_id = $1::uuid
            AND task.training_run_id = $2::uuid
            AND task.status = 'picked')::text AS picked_picks`,
      [organizationId, run.id],
    )
    const counts = facts.rows[0]
    const packageCount = Number(counts.package_count)
    const pickCount = Number(counts.pick_count)
    const consistent = packageCount > 0 && pickCount > 0 && (
      (run.state === 'released'
        && Number(counts.planned_packages) === packageCount
        && Number(counts.ready_picks) === pickCount)
      || (run.state === 'picked'
        && Number(counts.planned_packages) === packageCount
        && Number(counts.picked_picks) === pickCount)
      || (run.state === 'packed'
        && Number(counts.packed_packages) === packageCount
        && Number(counts.picked_picks) === pickCount)
      || (run.state === 'completed'
        && Number(counts.completed_packages) === packageCount
        && Number(counts.picked_picks) === pickCount)
    )
    if (!consistent) {
      throw new OperationsShadowTrainingError(
        'The local training facts do not match the last completed step. Reset the run instead.',
        409,
        'OPERATIONS_SHADOW_TRAINING_UNDO_FACTS_MISMATCH',
      )
    }
    if (run.state === 'completed') {
      await client.query(
        `UPDATE operations_shadow_training_packages
         SET status = 'packed', completed_at = NULL, updated_at = now()
         WHERE organization_id = $1::uuid AND training_run_id = $2::uuid
           AND status = 'completed'`,
        [organizationId, run.id],
      )
    } else if (run.state === 'packed') {
      await client.query(
        `UPDATE operations_shadow_training_packages
         SET status = 'planned', packed_by = NULL, packed_at = NULL,
             completed_at = NULL, updated_at = now()
         WHERE organization_id = $1::uuid AND training_run_id = $2::uuid
           AND status = 'packed'`,
        [organizationId, run.id],
      )
    } else if (run.state === 'picked') {
      await client.query(
        `UPDATE operations_shadow_training_pick_tasks
         SET status = 'ready', picked_by = NULL, picked_at = NULL,
             updated_at = now()
         WHERE organization_id = $1::uuid AND training_run_id = $2::uuid
           AND status = 'picked'`,
        [organizationId, run.id],
      )
    }
    await client.query(
      `UPDATE operations_shadow_training_runs
       SET state = $3, completed_at = NULL,
           row_version = row_version + 1,
           updated_by = $4, updated_at = now()
       WHERE organization_id = $1::uuid AND id = $2::uuid`,
      [organizationId, run.id, toState, actorEmail],
    )
    await recordEvent({
      client, organizationId, runId: run.id,
      eventType: 'shadow_training.undo',
      fromState: run.state, toState,
      requestHash, idempotencyKey, actorEmail,
      payload: {
        reason,
        undoneStep: run.state,
        trainingOnly: true,
        historyPreserved: true,
        commerceProviderWrites: 0,
        productionPostage: 0,
        inventoryMutations: 0,
        packagingStockMutations: 0,
      },
    })
  })
  return readRunByGlobalId(organizationId, runGlobalId)
}

export async function resetOperationsShadowTrainingInPostgres(input: {
  organizationId: string
  actorEmail: string
  runGlobalId: string
  expectedRowVersion: number
  reason: string
  idempotencyKey: string
}) {
  const organizationId = requireOrganizationId(input.organizationId)
  const actorEmail = requireActorEmail(input.actorEmail)
  const runGlobalId = String(input.runGlobalId || '').trim()
  const expectedRowVersion = requireExpectedRowVersion(input.expectedRowVersion)
  const reason = requireReason(input.reason)
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey)
  if (!RUN_GLOBAL_ID.test(runGlobalId)) {
    throw new OperationsShadowTrainingError(
      'Training run is invalid.', 400, 'OPERATIONS_SHADOW_TRAINING_RUN_INVALID',
    )
  }
  const requestHash = fingerprint({
    action: 'reset', runGlobalId, expectedRowVersion, reason,
  })
  await withTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(
      client,
      `operations:shadow-training:run:${organizationId}:${runGlobalId}`,
    )
    const run = await lockedRun(client, organizationId, runGlobalId)
    if (await priorEvent(client, organizationId, idempotencyKey, requestHash)) return
    assertLockedRun({
      run,
      action: 'reset',
      expectedRowVersion,
    })
    const unresolved = await client.query<{ status: string }>(
      `SELECT status
       FROM operations_shadow_training_label_links
       WHERE organization_id = $1::uuid AND training_run_id = $2::uuid
         AND status NOT IN ('voided', 'create_reconciled_none')
       ORDER BY created_at, id
       LIMIT 1
       FOR SHARE`,
      [organizationId, run.id],
    )
    if (unresolved.rows[0]) {
      if (run.state === 'reset_blocked') {
        throw new OperationsShadowTrainingError(
          'The carrier label outcome must be positively reconciled before reset.',
          409,
          'OPERATIONS_SHADOW_TRAINING_RESET_BLOCKED',
        )
      }
      const blockerCode = ['create_unknown', 'void_unknown'].includes(unresolved.rows[0].status)
        ? 'OPERATIONS_SHADOW_TRAINING_LABEL_OUTCOME_UNKNOWN'
        : 'OPERATIONS_SHADOW_TRAINING_LABEL_CLEANUP_REQUIRED'
      await client.query(
        `UPDATE operations_shadow_training_runs
         SET state = 'reset_blocked', reset_blocker_code = $3,
             row_version = row_version + 1,
             updated_by = $4, updated_at = now()
         WHERE organization_id = $1::uuid AND id = $2::uuid`,
        [organizationId, run.id, blockerCode, actorEmail],
      )
      await recordEvent({
        client, organizationId, runId: run.id,
        eventType: 'shadow_training.reset_blocked',
        fromState: run.state, toState: 'reset_blocked',
        requestHash, idempotencyKey, actorEmail,
        payload: { blockerCode, labelStatus: unresolved.rows[0].status },
      })
      return
    }
    await client.query(
      `UPDATE operations_shadow_training_runs
       SET state = 'reset', reset_at = now(), reset_reason = $3,
           reset_blocker_code = NULL, row_version = row_version + 1,
           updated_by = $4, updated_at = now()
       WHERE organization_id = $1::uuid AND id = $2::uuid`,
      [organizationId, run.id, reason, actorEmail],
    )
    await recordEvent({
      client, organizationId, runId: run.id,
      eventType: 'shadow_training.reset', fromState: run.state, toState: 'reset',
      requestHash, idempotencyKey, actorEmail,
      payload: {
        reason,
        historyPreserved: true,
        commerceProviderWrites: 0,
        productionPostage: 0,
        inventoryMutations: 0,
        packagingStockMutations: 0,
      },
    })
  })
  return readRunByGlobalId(organizationId, runGlobalId)
}

export async function assertCanonicalShadowCommerceOrderIsMirrorOnlyInPostgres(input: {
  organizationId: string
  orderGlobalId: string
}) {
  const result = await getPostgresPool().query<{
    activation_state: string
    order_status: string
    source_provider: string
    integration_type: string
    open_training: boolean
  }>(
    `SELECT activation.state AS activation_state,
            source_order.status AS order_status,
            source_order.source_provider,
            account.integration_type,
            EXISTS (
              SELECT 1
              FROM operations_shadow_training_runs training_run
              WHERE training_run.organization_id = source_order.organization_id
                AND training_run.source_order_id = source_order.id
                AND training_run.state <> 'reset'
            ) AS open_training
     FROM operations_orders source_order
     JOIN operations_integration_accounts account
       ON account.organization_id = source_order.organization_id
      AND account.id = source_order.integration_account_id
     JOIN operations_activation_scopes activation
       ON activation.organization_id = source_order.organization_id
     WHERE source_order.organization_id = $1::uuid
       AND source_order.global_id = $2
     LIMIT 1`,
    [input.organizationId, input.orderGlobalId],
  )
  const row = result.rows[0]
  if (row?.open_training === true) {
    throw new OperationsShadowTrainingError(
      'This order has an open local training run. Reset that run before creating canonical fulfillment work.',
      409,
      'OPERATIONS_SHADOW_TRAINING_OVERLAY_REQUIRED',
    )
  }
  if (
    row?.activation_state === 'shadow'
    && (row.source_provider === 'shopify' || row.source_provider === 'faire')
    && row.integration_type === 'commerce'
  ) {
    throw new OperationsShadowTrainingError(
      'Shopify and Faire orders remain provider-mirrored in Shadow. Enable training for an untouched imported order to run a local simulation.',
      409,
      'OPERATIONS_SHADOW_TRAINING_OVERLAY_REQUIRED',
    )
  }
}

export async function assertOperationsShadowTrainingEvidenceRequestInPostgres(input: {
  organizationId: string
  runGlobalId: string
  expectedRunRowVersion: number
  accountGlobalId: string
  candidateGlobalId: string
  expectedCandidateRowVersion: number
  warehouseGlobalId: string
}) {
  return withTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(
      client,
      `operations:shadow-training:run:${input.organizationId}:${input.runGlobalId}`,
    )
    const result = await client.query<{
      global_id: string
      row_version: string
    }>(
      `SELECT run.global_id, run.row_version::text
       FROM operations_shadow_training_runs run
       JOIN operations_orders source_order
         ON source_order.organization_id = run.organization_id
        AND source_order.id = run.source_order_id
       JOIN operations_integration_accounts account
         ON account.organization_id = run.organization_id
        AND account.id = run.integration_account_id
       JOIN operations_commerce_credentials credential
         ON credential.organization_id = account.organization_id
        AND credential.integration_account_id = account.id
       JOIN operations_commerce_order_candidates candidate
         ON candidate.organization_id = run.organization_id
        AND candidate.integration_account_id = run.integration_account_id
        AND candidate.id = run.source_candidate_id
        AND candidate.canonical_order_id = run.source_order_id
       JOIN operations_activation_scopes activation
         ON activation.organization_id = run.organization_id
       JOIN operations_warehouses warehouse
         ON warehouse.organization_id = run.organization_id
        AND warehouse.global_id = $6
        AND warehouse.status = 'active'
       WHERE run.organization_id = $1::uuid
         AND run.global_id = $2
         AND run.row_version = $7
         AND run.state = 'enabled'
         AND run.commerce_provider_write_count = 0
         AND run.production_postage_count = 0
         AND run.inventory_mutation_count = 0
         AND run.packaging_stock_mutation_count = 0
         AND account.global_id = $3
         AND account.integration_type = 'commerce'
         AND account.status = 'active'
         AND account.environment = run.account_environment
         AND account.environment IN ('sandbox', 'production')
         AND credential.verification_status = 'verified'
         AND credential.credential_version = run.authorization_credential_generation
         AND candidate.global_id = $4
         AND candidate.workflow_state = 'promoted'
         AND candidate.row_version = $5
         AND candidate.row_version = run.authorization_candidate_row_version
         AND candidate.source_hash = run.authorization_candidate_source_hash
       LIMIT 1
       FOR SHARE OF run, source_order, account, credential, candidate, activation, warehouse`,
      [
        input.organizationId,
        input.runGlobalId,
        input.accountGlobalId,
        input.candidateGlobalId,
        input.expectedCandidateRowVersion,
        input.warehouseGlobalId,
        input.expectedRunRowVersion,
      ],
    )
    if (!result.rows[0]) {
      throw new OperationsShadowTrainingError(
        'The exact enabled training run no longer matches this order, connection, candidate, or warehouse request. Reset and enable a new run.',
        409,
        'OPERATIONS_SHADOW_TRAINING_EVIDENCE_AUTHORITY_INVALID',
      )
    }
    return {
      runGlobalId: result.rows[0].global_id,
      runRowVersion: Number(result.rows[0].row_version),
    }
  })
}
