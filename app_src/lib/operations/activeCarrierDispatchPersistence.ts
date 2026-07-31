import type { PoolClient, QueryResultRow } from 'pg'
import {
  ActiveCarrierDispatchSnapshotError,
  createActiveCarrierDispatchSnapshot,
  type ActiveCarrierDispatchSnapshot,
  type ActiveCarrierDispatchSnapshotInput,
} from '@/lib/operations/activeCarrierDispatchSnapshot'
import {
  ProductionFulfillmentReratePersistenceError,
  loadProductionFulfillmentRerateDispatchContextInPostgres,
} from '@/lib/operations/productionFulfillmentRerates'
import {
  acquireTransactionAdvisoryLock,
  withTransaction,
} from '@/lib/persistence/postgres'

type JsonObject = Record<string, unknown>
type ActiveCarrierDispatchAttemptState =
  | 'prepared'
  | 'succeeded'
  | 'failed'
  | 'unknown'

const UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u
const SELECTION_GLOBAL_ID = /^gars[0-9]{7}$/u
const ATTEMPT_GLOBAL_ID = /^gaca[0-9]{7}$/u
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u
const ERROR_CODE = /^[A-Z0-9_]+$/u
const PROVIDER_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/u
const PROVIDER_CODE = /^[A-Z0-9][A-Z0-9_.:-]{0,63}$/u
const SENSITIVE_DIAGNOSTIC_SCALARS = new Set([
  'ACCOUNTNUMBER',
  'ACCESSTOKEN',
  'APIKEY',
  'AUTHORIZATION',
  'BEARERTOKEN',
  'CLIENTSECRET',
  'OAUTHTOKEN',
  'PASSWORD',
  'PAYERACCOUNTNUMBER',
  'PRIVATEKEY',
  'REFRESHTOKEN',
  'SECRET',
  'SECRETID',
  'TOKEN',
  'XSHOPIFYACCESSTOKEN',
])
const TERMINAL_DIAGNOSTIC_KEYS = new Set([
  'diagnosticVersion',
  'providerStatus',
  'shipmentOutcome',
  'retryable',
  'requestMayHaveReachedProvider',
  'responseReceived',
  'httpStatus',
  'providerCode',
])
const TERMINAL_PROVIDER_STATUSES = new Set([
  'ambiguous_response',
  'connection_lost',
  'invalid_response',
  'provider_rejected',
  'provider_unavailable',
  'safety_evidence_rejected',
  'succeeded',
  'timeout',
  'transport_error',
])

const SAFE_UNKNOWN_DIAGNOSTICS = Object.freeze({
  diagnosticVersion: 1 as const,
  providerStatus: 'safety_evidence_rejected' as const,
  shipmentOutcome: 'unknown' as const,
  retryable: false,
  requestMayHaveReachedProvider: true,
  responseReceived: false,
})

export class ActiveCarrierDispatchPersistenceError extends Error {
  readonly code: string
  readonly status: number

  constructor(code: string, message: string, status = 409) {
    super(message)
    this.name = 'ActiveCarrierDispatchPersistenceError'
    this.code = code
    this.status = status
  }
}

export type PrepareActiveCarrierDispatchAttemptInput = {
  organizationId: unknown
  productionRerateSelectionGlobalId: unknown
  actorEmail: unknown
}

export type FinalizeActiveCarrierDispatchAttemptInput = {
  organizationId: unknown
  attemptGlobalId: unknown
  outcome: {
    state: 'failed' | 'unknown' | 'succeeded'
    dispatchedAt: unknown
    completedAt: unknown
    errorCode?: unknown
    providerReference?: unknown
    redactedResponse: unknown
  }
}

export type ActiveCarrierDispatchAttempt = {
  id: string
  globalId: string
  activeExecutionGlobalId: string
  activeShipmentGroupGlobalId: string
  productionRerateSelectionGlobalId: string
  attemptNumber: number
  state: ActiveCarrierDispatchAttemptState
  environment: 'production'
  provider: 'ups_rest' | 'fedex_rest'
  serviceCode: string
  serviceName: string
  packageCount: number
  adapterVersion: string
  providerIdempotencyIdentity: string
  requestHash: string
  requestSnapshot: ActiveCarrierDispatchSnapshot
  redactedResponse: JsonObject
  providerReference: string | null
  errorCode: string | null
  persistedAt: string
  dispatchedAt: string | null
  completedAt: string | null
  dispatchOwner: boolean
  replayed: boolean
}

export type ActiveCarrierDispatchTerminalDiagnostics = {
  diagnosticVersion: 1
  providerStatus:
    | 'ambiguous_response'
    | 'connection_lost'
    | 'invalid_response'
    | 'provider_rejected'
    | 'provider_unavailable'
    | 'safety_evidence_rejected'
    | 'succeeded'
    | 'timeout'
    | 'transport_error'
  shipmentOutcome: 'not_created' | 'unknown' | 'created'
  retryable: boolean
  requestMayHaveReachedProvider: boolean
  responseReceived: boolean
  httpStatus?: number
  providerCode?: string
}

type DispatchAuthorityRow = QueryResultRow & {
  selection_id: string
  selection_global_id: string
  active_execution_id: string
  active_execution_global_id: string
  active_shipment_group_id: string
  active_shipment_group_global_id: string
}

type AttemptRow = QueryResultRow & {
  id: string
  global_id: string
  active_execution_global_id: string
  active_shipment_group_global_id: string
  selection_global_id: string
  attempt_number: number
  state: ActiveCarrierDispatchAttemptState
  environment: 'production'
  selected_provider: 'ups_rest' | 'fedex_rest'
  selected_service_code: string
  selected_service_name: string
  package_count: number
  adapter_version: string
  idempotency_key: string
  request_hash: string
  redacted_request: JsonObject
  redacted_response: JsonObject
  provider_reference: string | null
  error_code: string | null
  persisted_at: Date | string
  dispatched_at: Date | string | null
  completed_at: Date | string | null
}

function fail(code: string, message: string, status = 409): never {
  throw new ActiveCarrierDispatchPersistenceError(code, message, status)
}

function requiredText(value: unknown, label: string, maximum = 200): string {
  if (typeof value !== 'string') {
    fail('OPERATIONS_ACTIVE_DISPATCH_INPUT_INVALID', `${label} is required`, 400)
  }
  const normalized = value.trim().replace(/\s+/gu, ' ')
  if (
    !normalized
    || normalized.length > maximum
    || /[\u0000-\u001f\u007f]/u.test(normalized)
  ) {
    fail('OPERATIONS_ACTIVE_DISPATCH_INPUT_INVALID', `${label} is invalid`, 400)
  }
  return normalized
}

function requiredUuid(value: unknown, label: string): string {
  const normalized = requiredText(value, label, 36).toLowerCase()
  if (!UUID.test(normalized)) {
    fail('OPERATIONS_ACTIVE_DISPATCH_INPUT_INVALID', `${label} is invalid`, 400)
  }
  return normalized
}

function requiredGlobalId(value: unknown, label: string, pattern: RegExp): string {
  const normalized = requiredText(value, label, 20).toLowerCase()
  if (!pattern.test(normalized)) {
    fail('OPERATIONS_ACTIVE_DISPATCH_INPUT_INVALID', `${label} is invalid`, 400)
  }
  return normalized
}

function actorEmail(value: unknown): string {
  const normalized = requiredText(value, 'Actor email', 320).toLowerCase()
  if (!EMAIL.test(normalized)) {
    fail('OPERATIONS_ACTIVE_DISPATCH_INPUT_INVALID', 'Actor email is invalid', 400)
  }
  return normalized
}

function requiredInstant(value: unknown, label: string): string {
  const normalized = requiredText(value, label, 48)
  const timestamp = Date.parse(normalized)
  if (!Number.isFinite(timestamp)) {
    fail('OPERATIONS_ACTIVE_DISPATCH_INPUT_INVALID', `${label} is invalid`, 400)
  }
  return new Date(timestamp).toISOString()
}

function optionalText(value: unknown, label: string, maximum = 200): string | null {
  if (value === undefined || value === null || value === '') return null
  return requiredText(value, label, maximum)
}

function jsonObject(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('OPERATIONS_ACTIVE_DISPATCH_INPUT_INVALID', `${label} must be an object`, 400)
  }
  return value as JsonObject
}

export function createActiveCarrierDispatchTerminalDiagnostics(
  value: unknown,
): ActiveCarrierDispatchTerminalDiagnostics {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(
      'OPERATIONS_ACTIVE_DISPATCH_TERMINAL_DIAGNOSTICS_INVALID',
      'Carrier terminal diagnostics must use the strict redacted allowlist',
      400,
    )
  }
  const candidate = value as JsonObject
  if (
    Object.keys(candidate).some((key) => !TERMINAL_DIAGNOSTIC_KEYS.has(key))
    || candidate.diagnosticVersion !== 1
    || typeof candidate.providerStatus !== 'string'
    || !TERMINAL_PROVIDER_STATUSES.has(candidate.providerStatus)
    || ![
      'not_created',
      'unknown',
      'created',
    ].includes(String(candidate.shipmentOutcome))
    || typeof candidate.retryable !== 'boolean'
    || typeof candidate.requestMayHaveReachedProvider !== 'boolean'
    || typeof candidate.responseReceived !== 'boolean'
    || (
      candidate.httpStatus !== undefined
      && (
        !Number.isInteger(candidate.httpStatus)
        || Number(candidate.httpStatus) < 100
        || Number(candidate.httpStatus) > 599
      )
    )
    || (
      candidate.providerCode !== undefined
      && (
        typeof candidate.providerCode !== 'string'
        || !PROVIDER_CODE.test(candidate.providerCode)
        || SENSITIVE_DIAGNOSTIC_SCALARS.has(
          candidate.providerCode.replace(/[^A-Z0-9]/gu, ''),
        )
      )
    )
  ) {
    fail(
      'OPERATIONS_ACTIVE_DISPATCH_TERMINAL_DIAGNOSTICS_INVALID',
      'Carrier terminal diagnostics must use the strict redacted allowlist',
      400,
    )
  }
  return Object.freeze({
    diagnosticVersion: 1,
    providerStatus: candidate.providerStatus,
    shipmentOutcome: candidate.shipmentOutcome,
    retryable: candidate.retryable,
    requestMayHaveReachedProvider: candidate.requestMayHaveReachedProvider,
    responseReceived: candidate.responseReceived,
    ...(candidate.httpStatus === undefined
      ? {}
      : { httpStatus: Number(candidate.httpStatus) }),
    ...(candidate.providerCode === undefined
      ? {}
      : { providerCode: candidate.providerCode }),
  }) as ActiveCarrierDispatchTerminalDiagnostics
}

function diagnosticsProveKnownNoncreation(
  diagnostics: ActiveCarrierDispatchTerminalDiagnostics,
): boolean {
  return diagnostics.shipmentOutcome === 'not_created'
    && (
      diagnostics.requestMayHaveReachedProvider === false
      || (
        diagnostics.responseReceived === true
        && diagnostics.providerStatus === 'provider_rejected'
      )
    )
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as JsonObject)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)]),
    )
  }
  return value
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right))
}

function instantOrNull(value: Date | string | null): string | null {
  return value === null ? null : new Date(value).toISOString()
}

function validateStoredSnapshot(value: unknown, requestHash: string) {
  const stored = jsonObject(value, 'Stored dispatch request')
  const candidate = stored as unknown as ActiveCarrierDispatchSnapshot
  const snapshotInput: ActiveCarrierDispatchSnapshotInput = {
    snapshotAt: candidate.snapshotAt,
    environment: candidate.environment,
    organization: candidate.organization,
    order: candidate.order,
    plan: candidate.plan,
    warehouse: candidate.warehouse,
    carrierAttempt: candidate.carrierAttempt,
    provider: candidate.provider,
    integrationAccount: candidate.integrationAccount,
    carrierAccount: candidate.carrierAccount,
    credential: candidate.credential,
    billing: candidate.billing,
    origin: candidate.origin,
    destination: candidate.destination,
    selectedRateEvidence: candidate.selectedRateEvidence,
    packages: candidate.packages,
    adapterVersion: candidate.adapterVersion,
  }
  const rebuilt = createActiveCarrierDispatchSnapshot(snapshotInput)
  if (
    requestHash !== rebuilt.snapshotHash
    || !sameJson(stored, rebuilt)
  ) {
    fail(
      'OPERATIONS_ACTIVE_DISPATCH_PERSISTED_EVIDENCE_INVALID',
      'Persisted carrier dispatch request no longer reproduces its immutable hash',
      500,
    )
  }
  return rebuilt
}

function mapAttempt(
  row: AttemptRow,
  options: { dispatchOwner: boolean; replayed: boolean },
): ActiveCarrierDispatchAttempt {
  const requestSnapshot = validateStoredSnapshot(row.redacted_request, row.request_hash)
  if (
    row.global_id !== requestSnapshot.carrierAttempt.globalId
    || row.id !== requestSnapshot.carrierAttempt.id
    || Number(row.attempt_number) !== requestSnapshot.carrierAttempt.attemptNumber
    || row.idempotency_key !== requestSnapshot.providerIdempotencyIdentity
    || row.selected_provider !== requestSnapshot.provider
    || row.selected_service_code !== requestSnapshot.service.code
    || row.selected_service_name !== requestSnapshot.service.name
    || Number(row.package_count) !== requestSnapshot.packageCount
    || row.adapter_version !== requestSnapshot.adapterVersion
  ) {
    fail(
      'OPERATIONS_ACTIVE_DISPATCH_PERSISTED_EVIDENCE_INVALID',
      'Persisted carrier attempt identity no longer matches its immutable request snapshot',
      500,
    )
  }
  return Object.freeze({
    id: row.id,
    globalId: row.global_id,
    activeExecutionGlobalId: row.active_execution_global_id,
    activeShipmentGroupGlobalId: row.active_shipment_group_global_id,
    productionRerateSelectionGlobalId: row.selection_global_id,
    attemptNumber: Number(row.attempt_number),
    state: row.state,
    environment: row.environment,
    provider: row.selected_provider,
    serviceCode: row.selected_service_code,
    serviceName: row.selected_service_name,
    packageCount: Number(row.package_count),
    adapterVersion: row.adapter_version,
    providerIdempotencyIdentity: row.idempotency_key,
    requestHash: row.request_hash,
    requestSnapshot,
    redactedResponse: Object.freeze(row.redacted_response || {}),
    providerReference: row.provider_reference,
    errorCode: row.error_code,
    persistedAt: new Date(row.persisted_at).toISOString(),
    dispatchedAt: instantOrNull(row.dispatched_at),
    completedAt: instantOrNull(row.completed_at),
    dispatchOwner: options.dispatchOwner,
    replayed: options.replayed,
  })
}

async function loadAttempt(
  client: PoolClient,
  organizationId: string,
  attemptGlobalId: string,
  options: { dispatchOwner: boolean; replayed: boolean },
  forUpdate = false,
): Promise<ActiveCarrierDispatchAttempt> {
  const result = await client.query<AttemptRow>(
    `SELECT attempt.id::text, attempt.global_id,
            execution.global_id AS active_execution_global_id,
            shipment_group.global_id AS active_shipment_group_global_id,
            selection.global_id AS selection_global_id,
            attempt.attempt_number, attempt.state, attempt.environment,
            attempt.selected_provider, attempt.selected_service_code,
            attempt.selected_service_name, attempt.package_count,
            attempt.adapter_version, attempt.idempotency_key,
            attempt.request_hash, attempt.redacted_request,
            attempt.redacted_response, attempt.provider_reference,
            attempt.error_code, attempt.persisted_at,
            attempt.dispatched_at, attempt.completed_at
     FROM operations_active_carrier_group_attempts attempt
     JOIN operations_active_fulfillment_executions execution
       ON execution.organization_id = attempt.organization_id
      AND execution.id = attempt.active_fulfillment_execution_id
     JOIN operations_active_shipment_groups shipment_group
       ON shipment_group.organization_id = attempt.organization_id
      AND shipment_group.id = attempt.active_shipment_group_id
     JOIN operations_production_fulfillment_rerate_selections selection
       ON selection.organization_id = attempt.organization_id
      AND selection.id = attempt.production_rerate_selection_id
     WHERE attempt.organization_id = $1::uuid
       AND attempt.global_id = $2
     LIMIT 1
     ${forUpdate ? 'FOR UPDATE OF attempt' : ''}`,
    [organizationId, attemptGlobalId],
  )
  if (!result.rows[0]) {
    fail('OPERATIONS_ACTIVE_DISPATCH_ATTEMPT_NOT_FOUND', 'Carrier dispatch attempt was not found', 404)
  }
  return mapAttempt(result.rows[0], options)
}

function mapPersistenceError(error: unknown): never {
  if (error instanceof ActiveCarrierDispatchPersistenceError) throw error
  if (
    error instanceof ActiveCarrierDispatchSnapshotError
    || error instanceof ProductionFulfillmentReratePersistenceError
  ) {
    fail(error.code, error.message, 'status' in error ? Number(error.status) : 409)
  }
  const code = typeof error === 'object' && error
    ? String((error as { code?: unknown }).code || '')
    : ''
  const message = error instanceof Error ? error.message : String(error)
  if (
    ['23503', '23505', '23514', '40001', '40P01'].includes(code)
    || /constraint|immutable|requires|mismatch|cannot be retried/iu.test(message)
  ) {
    fail(
      'OPERATIONS_ACTIVE_DISPATCH_CONFLICT',
      'Carrier dispatch attempt conflicted with current immutable Active authority',
    )
  }
  throw error
}

export async function prepareActiveCarrierDispatchAttemptInPostgres(
  input: PrepareActiveCarrierDispatchAttemptInput,
): Promise<ActiveCarrierDispatchAttempt> {
  const organizationId = requiredUuid(input.organizationId, 'Organization ID')
  const selectionGlobalId = requiredGlobalId(
    input.productionRerateSelectionGlobalId,
    'Production rerate selection Global ID',
    SELECTION_GLOBAL_ID,
  )
  const email = actorEmail(input.actorEmail)

  try {
    return await withTransaction(async (client) => {
      const authorityResult = await client.query<DispatchAuthorityRow>(
        `SELECT selection.id::text AS selection_id,
                selection.global_id AS selection_global_id,
                execution.id::text AS active_execution_id,
                execution.global_id AS active_execution_global_id,
                shipment_group.id::text AS active_shipment_group_id,
                shipment_group.global_id AS active_shipment_group_global_id
         FROM operations_production_fulfillment_rerate_selections selection
         JOIN operations_active_fulfillment_executions execution
           ON execution.organization_id = selection.organization_id
          AND execution.id = selection.active_fulfillment_execution_id
         JOIN operations_active_shipment_groups shipment_group
           ON shipment_group.organization_id = selection.organization_id
          AND shipment_group.id = selection.active_shipment_group_id
         WHERE selection.organization_id = $1::uuid
           AND selection.global_id = $2
         LIMIT 1
         FOR UPDATE OF shipment_group`,
        [organizationId, selectionGlobalId],
      )
      const authority = authorityResult.rows[0]
      if (!authority) {
        fail(
          'OPERATIONS_ACTIVE_DISPATCH_SELECTION_NOT_FOUND',
          'Production rerate selection was not found',
          404,
        )
      }
      await acquireTransactionAdvisoryLock(
        client,
        `operations:active-carrier-dispatch:${organizationId}:${authority.active_shipment_group_id}`,
      )

      const latestResult = await client.query<AttemptRow>(
        `SELECT attempt.id::text, attempt.global_id,
                execution.global_id AS active_execution_global_id,
                shipment_group.global_id AS active_shipment_group_global_id,
                selection.global_id AS selection_global_id,
                attempt.attempt_number, attempt.state, attempt.environment,
                attempt.selected_provider, attempt.selected_service_code,
                attempt.selected_service_name, attempt.package_count,
                attempt.adapter_version, attempt.idempotency_key,
                attempt.request_hash, attempt.redacted_request,
                attempt.redacted_response, attempt.provider_reference,
                attempt.error_code, attempt.persisted_at,
                attempt.dispatched_at, attempt.completed_at
         FROM operations_active_carrier_group_attempts attempt
         JOIN operations_active_fulfillment_executions execution
           ON execution.organization_id = attempt.organization_id
          AND execution.id = attempt.active_fulfillment_execution_id
         JOIN operations_active_shipment_groups shipment_group
           ON shipment_group.organization_id = attempt.organization_id
          AND shipment_group.id = attempt.active_shipment_group_id
         JOIN operations_production_fulfillment_rerate_selections selection
           ON selection.organization_id = attempt.organization_id
          AND selection.id = attempt.production_rerate_selection_id
         WHERE attempt.organization_id = $1::uuid
           AND attempt.active_shipment_group_id = $2::uuid
         ORDER BY attempt.attempt_number DESC
         LIMIT 1
         FOR UPDATE OF attempt`,
        [organizationId, authority.active_shipment_group_id],
      )
      const latest = latestResult.rows[0]
      if (latest && latest.state !== 'failed') {
        if (latest.selection_global_id !== selectionGlobalId) {
          fail(
            latest.state === 'unknown'
              ? 'OPERATIONS_ACTIVE_DISPATCH_UNKNOWN_RECONCILIATION_REQUIRED'
              : 'OPERATIONS_ACTIVE_DISPATCH_ATTEMPT_ALREADY_BOUND',
            'A prepared, succeeded, or unknown carrier attempt already owns this shipment group',
          )
        }
        return mapAttempt(latest, { dispatchOwner: false, replayed: true })
      }
      if (latest?.state === 'failed') {
        const diagnostics = createActiveCarrierDispatchTerminalDiagnostics(
          latest.redacted_response,
        )
        if (
          !diagnosticsProveKnownNoncreation(diagnostics)
          || diagnostics.retryable !== true
        ) {
          fail(
            'OPERATIONS_ACTIVE_DISPATCH_RETRY_NOT_PROVEN_SAFE',
            'Carrier dispatch retry requires retryable proof that no shipment was created',
          )
        }
      }

      const dispatchContext =
        await loadProductionFulfillmentRerateDispatchContextInPostgres(
          organizationId,
          selectionGlobalId,
          client,
        )
      if (
        latest
        && (
          latest.selected_provider !== dispatchContext.provider
          || latest.selected_service_code
            !== dispatchContext.selectedRateEvidence.service.code
          || latest.selected_service_name
            !== dispatchContext.selectedRateEvidence.service.name
          || Number(latest.package_count) !== dispatchContext.packages.length
        )
      ) {
        fail(
          'OPERATIONS_ACTIVE_DISPATCH_RETRY_LINEAGE_CHANGED',
          'A known-failure retry must retain the exact provider, service, and package group',
        )
      }

      const identityResult = await client.query<{
        id: string
        global_id: string
        snapshot_at: Date | string
      }>(
        `SELECT gen_random_uuid()::text AS id,
                allocate_global_reference('gaca') AS global_id,
                clock_timestamp() AS snapshot_at`,
      )
      const identity = identityResult.rows[0]
      if (
        latest?.completed_at
        && Date.parse(new Date(identity.snapshot_at).toISOString())
          < Date.parse(new Date(latest.completed_at).toISOString())
      ) {
        fail(
          'OPERATIONS_ACTIVE_DISPATCH_RETRY_CHRONOLOGY_INVALID',
          'A retry cannot be prepared before the prior attempt completed',
        )
      }
      const attemptNumber = latest ? Number(latest.attempt_number) + 1 : 1
      const requestSnapshot = createActiveCarrierDispatchSnapshot({
        snapshotAt: new Date(identity.snapshot_at).toISOString(),
        environment: dispatchContext.environment,
        organization: dispatchContext.organization,
        order: dispatchContext.order,
        plan: dispatchContext.plan,
        warehouse: dispatchContext.warehouse,
        carrierAttempt: {
          id: identity.id,
          globalId: identity.global_id,
          attemptNumber,
        },
        provider: dispatchContext.provider,
        integrationAccount: dispatchContext.integrationAccount,
        carrierAccount: dispatchContext.carrierAccount,
        credential: dispatchContext.credential,
        billing: dispatchContext.billing,
        origin: dispatchContext.origin,
        destination: dispatchContext.destination,
        selectedRateEvidence: dispatchContext.selectedRateEvidence,
        packages: dispatchContext.packages,
        adapterVersion: dispatchContext.adapterVersion,
      })

      await client.query(
        `INSERT INTO operations_active_carrier_group_attempts (
           id, global_id, organization_id, active_fulfillment_execution_id,
           active_shipment_group_id, production_rerate_selection_id,
           attempt_number, state, environment, selected_provider,
           selected_service_code, selected_service_name, package_count,
           adapter_version, idempotency_key, request_hash,
           redacted_request, actor_email, persisted_at
         ) VALUES (
           $1::uuid, $2, $3::uuid, $4::uuid, $5::uuid, $6::uuid,
           $7, 'prepared', 'production', $8, $9, $10, $11,
           $12, $13, $14, $15::jsonb, $16, $17::timestamptz
         )`,
        [
          identity.id,
          identity.global_id,
          organizationId,
          authority.active_execution_id,
          authority.active_shipment_group_id,
          authority.selection_id,
          attemptNumber,
          requestSnapshot.provider,
          requestSnapshot.service.code,
          requestSnapshot.service.name,
          requestSnapshot.packageCount,
          requestSnapshot.adapterVersion,
          requestSnapshot.providerIdempotencyIdentity,
          requestSnapshot.snapshotHash,
          JSON.stringify(requestSnapshot),
          email,
          requestSnapshot.snapshotAt,
        ],
      )
      return loadAttempt(
        client,
        organizationId,
        identity.global_id,
        { dispatchOwner: true, replayed: false },
      )
    })
  } catch (error) {
    mapPersistenceError(error)
  }
}

export async function finalizeActiveCarrierDispatchAttemptInPostgres(
  input: FinalizeActiveCarrierDispatchAttemptInput,
): Promise<ActiveCarrierDispatchAttempt> {
  const organizationId = requiredUuid(input.organizationId, 'Organization ID')
  const attemptGlobalId = requiredGlobalId(
    input.attemptGlobalId,
    'Carrier attempt Global ID',
    ATTEMPT_GLOBAL_ID,
  )
  if (input.outcome.state === 'succeeded') {
    fail(
      'OPERATIONS_ACTIVE_DISPATCH_SUCCESS_MATERIALIZATION_NOT_IMPLEMENTED',
      'Successful dispatch cannot finalize until package labels, shipments, tracking, and inventory are materialized atomically',
      501,
    )
  }
  const dispatchedAt = requiredInstant(input.outcome.dispatchedAt, 'Dispatched at')
  const completedAt = requiredInstant(input.outcome.completedAt, 'Completed at')
  if (Date.parse(completedAt) < Date.parse(dispatchedAt)) {
    fail(
      'OPERATIONS_ACTIVE_DISPATCH_INPUT_INVALID',
      'Completed at cannot precede dispatched at',
      400,
    )
  }
  let terminalEvidenceRejected = false
  let terminalErrorCode = 'UNSAFE_PROVIDER_EVIDENCE_REJECTED'
  let terminalProviderReference: string | null = null
  try {
    const requestedErrorCode = requiredText(
      input.outcome.errorCode,
      'Error code',
      128,
    )
    if (!ERROR_CODE.test(requestedErrorCode)) {
      fail('OPERATIONS_ACTIVE_DISPATCH_INPUT_INVALID', 'Error code is invalid', 400)
    }
    const requestedProviderReference = optionalText(
      input.outcome.providerReference,
      'Provider reference',
      200,
    )
    if (
      requestedProviderReference !== null
      && !PROVIDER_REFERENCE.test(requestedProviderReference)
    ) {
      fail(
        'OPERATIONS_ACTIVE_DISPATCH_INPUT_INVALID',
        'Provider reference is invalid',
        400,
      )
    }
    if (
      input.outcome.state === 'failed'
      && requestedProviderReference !== null
    ) {
      fail(
        'OPERATIONS_ACTIVE_DISPATCH_INPUT_INVALID',
        'A known failed dispatch cannot retain a provider reference',
        400,
      )
    }
    terminalErrorCode = requestedErrorCode
    terminalProviderReference = requestedProviderReference
  } catch (error) {
    if (
      !(error instanceof ActiveCarrierDispatchPersistenceError)
      || error.code !== 'OPERATIONS_ACTIVE_DISPATCH_INPUT_INVALID'
    ) {
      throw error
    }
    terminalEvidenceRejected = true
  }
  let terminalState: 'failed' | 'unknown' = terminalEvidenceRejected
    ? 'unknown'
    : input.outcome.state
  let redactedResponse: ActiveCarrierDispatchTerminalDiagnostics
  try {
    redactedResponse = createActiveCarrierDispatchTerminalDiagnostics(
      input.outcome.redactedResponse,
    )
  } catch (error) {
    if (
      !(error instanceof ActiveCarrierDispatchPersistenceError)
      || error.code !== 'OPERATIONS_ACTIVE_DISPATCH_TERMINAL_DIAGNOSTICS_INVALID'
    ) {
      throw error
    }
    // Once a provider call may have occurred, unsafe evidence can never leave
    // the durable attempt prepared or permit a known-failure retry. Persist a
    // constant-safe unknown result and require provider reconciliation.
    terminalState = 'unknown'
    terminalEvidenceRejected = true
    terminalErrorCode = 'UNSAFE_PROVIDER_EVIDENCE_REJECTED'
    terminalProviderReference = null
    redactedResponse = SAFE_UNKNOWN_DIAGNOSTICS
  }
  if (
    !terminalEvidenceRejected
    && (
      (
        input.outcome.state === 'failed'
        && (
          redactedResponse.providerStatus === 'succeeded'
          || !diagnosticsProveKnownNoncreation(redactedResponse)
        )
      )
      || (
        input.outcome.state === 'unknown'
        && (
          redactedResponse.providerStatus === 'succeeded'
          || redactedResponse.shipmentOutcome !== 'unknown'
          || redactedResponse.retryable !== false
        )
      )
    )
  ) {
    terminalEvidenceRejected = true
  }
  if (terminalEvidenceRejected) {
    terminalState = 'unknown'
    terminalErrorCode = 'UNSAFE_PROVIDER_EVIDENCE_REJECTED'
    terminalProviderReference = null
    redactedResponse = SAFE_UNKNOWN_DIAGNOSTICS
  }

  try {
    return await withTransaction(async (client) => {
      await acquireTransactionAdvisoryLock(
        client,
        `operations:active-carrier-attempt:${organizationId}:${attemptGlobalId}`,
      )
      const existing = await loadAttempt(
        client,
        organizationId,
        attemptGlobalId,
        { dispatchOwner: false, replayed: false },
        true,
      )
      const databaseClockResult = await client.query<{ current_time: Date | string }>(
        'SELECT clock_timestamp() AS current_time',
      )
      const maximumTerminalTime = Date.parse(
        new Date(databaseClockResult.rows[0].current_time).toISOString(),
      ) + 5_000
      if (Date.parse(dispatchedAt) < Date.parse(existing.persistedAt)) {
        fail(
          'OPERATIONS_ACTIVE_DISPATCH_TIMESTAMP_INVALID',
          'Dispatched at cannot precede the durable prepare boundary',
          409,
        )
      }
      if (
        Date.parse(dispatchedAt) > maximumTerminalTime
        || Date.parse(completedAt) > maximumTerminalTime
      ) {
        fail(
          'OPERATIONS_ACTIVE_DISPATCH_TIMESTAMP_INVALID',
          'Carrier terminal timestamps exceed the database clock skew allowance',
          409,
        )
      }
      if (existing.state !== 'prepared') {
        if (
          existing.state === terminalState
          && existing.dispatchedAt === dispatchedAt
          && existing.completedAt === completedAt
          && existing.errorCode === terminalErrorCode
          && existing.providerReference === terminalProviderReference
          && sameJson(existing.redactedResponse, redactedResponse)
        ) {
          return Object.freeze({ ...existing, replayed: true })
        }
        fail(
          'OPERATIONS_ACTIVE_DISPATCH_FINALIZATION_CONFLICT',
          'Carrier attempt is already bound to different terminal evidence',
        )
      }
      const updated = await client.query(
        `UPDATE operations_active_carrier_group_attempts
         SET state = $3,
             redacted_response = $4::jsonb,
             provider_reference = $5,
             error_code = $6,
             dispatched_at = $7::timestamptz,
             completed_at = $8::timestamptz
         WHERE organization_id = $1::uuid
           AND global_id = $2
           AND state = 'prepared'`,
        [
          organizationId,
          attemptGlobalId,
          terminalState,
          JSON.stringify(redactedResponse),
          terminalProviderReference,
          terminalErrorCode,
          dispatchedAt,
          completedAt,
        ],
      )
      if (updated.rowCount !== 1) {
        fail(
          'OPERATIONS_ACTIVE_DISPATCH_FINALIZATION_CONFLICT',
          'Carrier attempt could not be finalized exactly once',
        )
      }
      return loadAttempt(
        client,
        organizationId,
        attemptGlobalId,
        { dispatchOwner: false, replayed: false },
      )
    })
  } catch (error) {
    mapPersistenceError(error)
  }
}

export function finalizeActiveCarrierDispatchFailureInPostgres(
  input: Omit<FinalizeActiveCarrierDispatchAttemptInput, 'outcome'> & {
    outcome: Omit<FinalizeActiveCarrierDispatchAttemptInput['outcome'], 'state'>
  },
) {
  return finalizeActiveCarrierDispatchAttemptInPostgres({
    ...input,
    outcome: { ...input.outcome, state: 'failed' },
  })
}

export function finalizeActiveCarrierDispatchUnknownInPostgres(
  input: Omit<FinalizeActiveCarrierDispatchAttemptInput, 'outcome'> & {
    outcome: Omit<FinalizeActiveCarrierDispatchAttemptInput['outcome'], 'state'>
  },
) {
  return finalizeActiveCarrierDispatchAttemptInPostgres({
    ...input,
    outcome: { ...input.outcome, state: 'unknown' },
  })
}
