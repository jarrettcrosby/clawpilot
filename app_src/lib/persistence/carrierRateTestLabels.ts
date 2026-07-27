import crypto from 'crypto'
import type { PoolClient } from 'pg'
import { recordAuditEvent } from '@/lib/auditWriter'
import { enqueueOperationsPrintJobInPostgres } from '@/lib/persistence/operationPrintDelivery'
import { OperationsRequestError } from '@/lib/persistence/operations'
import {
  acquireTransactionAdvisoryLock,
  query,
  withTransaction,
} from '@/lib/persistence/postgres'

type TimestampValue = string | Date
type Provider = 'ups_rest' | 'fedex_rest'
type AttemptState = 'prepared' | 'succeeded' | 'failed' | 'unknown'

export type CarrierRateTestSelectedRate = {
  serviceCode: string
  serviceName: string
  rateType: string | null
  amount: string
  currency: string
}

export type CarrierRateTestLabelListItem = {
  globalId: string
  rateEvidenceGlobalId: string
  createAttemptGlobalId: string
  voidAttemptGlobalId: string | null
  carrierAccountGlobalId: string
  provider: Provider
  environment: 'sandbox'
  credentialVersion: number
  serviceCode: string
  serviceName: string
  rateType: string | null
  ratedAmount: string
  ratedCurrency: string
  trackingNumber: string
  format: 'ZPL' | 'PDF' | 'PNG'
  mediaSize: 'label_4x6' | 'label_4x8'
  sourceKind: 'provider_native'
  providerImageType: 'ZPL' | 'ZPLII' | 'PDF' | 'PNG'
  providerStockType: 'HEIGHT_6_WIDTH_4' | 'STOCK_4X6' | 'PAPER_4X6'
  byteLength: number
  contentSha256: string
  printArtifactGlobalId: string | null
  status: 'created' | 'voided'
  createdBy: string | null
  createdAt: string
  voidedBy: string | null
  voidedAt: string | null
}

export type CarrierRateTestCreateContext = {
  rateRequestId: string
  rateEvidenceGlobalId: string
  integrationAccountId: string
  integrationGlobalId: string
  carrierAccountId: string
  carrierAccountGlobalId: string
  provider: Provider
  credentialVersion: number
  requestHash: string
  billingRelationship: 'sender' | 'recipient' | 'third_party'
  billingSelectionSnapshot: Record<string, unknown>
  redactedRequest: Record<string, unknown>
  redactedResponse: Record<string, unknown>
}

export type CarrierRateTestLabelProviderContext = {
  labelId: string
  labelGlobalId: string
  rateRequestId: string
  rateEvidenceGlobalId: string
  integrationAccountId: string
  integrationGlobalId: string
  carrierAccountId: string
  carrierAccountGlobalId: string
  provider: Provider
  credentialVersion: number
  accountNumberFingerprint: string
  rateRequestHash: string
  destinationFingerprint: string
  serviceCode: string
  serviceName: string
  rateType: string | null
  ratedAmount: string
  ratedCurrency: string
  providerLabelId: string
  trackingNumber: string
  status: 'created' | 'voided'
  createRequest: Record<string, unknown>
}

export type CarrierRateTestLabelAttemptListItem = {
  globalId: string
  rateEvidenceGlobalId: string
  labelGlobalId: string | null
  action: 'create' | 'void'
  state: AttemptState
  provider: Provider
  serviceCode: string
  selectedRate: CarrierRateTestSelectedRate
  reason: string
  errorCode: string | null
  providerReference: string | null
  reconciliationOutcome:
    | 'confirmed_no_active_label'
    | 'confirmed_voided'
    | 'confirmed_active'
    | null
  reconciliationReason: string | null
  reconciledBy: string | null
  reconciledAt: string | null
  requestedAt: string
  completedAt: string | null
  reconciliationEligible: boolean
}

type LabelRow = {
  global_id: string
  rate_evidence_global_id: string
  create_attempt_global_id: string
  void_attempt_global_id: string | null
  carrier_account_global_id: string
  provider: Provider
  environment: 'sandbox'
  credential_version: number
  service_code: string
  service_name: string
  rate_type: string | null
  rated_amount: string
  rated_currency: string
  tracking_number: string
  format: CarrierRateTestLabelListItem['format']
  media_size: CarrierRateTestLabelListItem['mediaSize']
  source_kind: CarrierRateTestLabelListItem['sourceKind']
  provider_image_type: CarrierRateTestLabelListItem['providerImageType']
  provider_stock_type: CarrierRateTestLabelListItem['providerStockType']
  byte_length: string | number
  content_sha256: string
  print_artifact_global_id: string | null
  status: CarrierRateTestLabelListItem['status']
  created_by: string | null
  created_at: TimestampValue
  voided_by: string | null
  voided_at: TimestampValue | null
}

type AttemptRow = {
  global_id: string
  rate_evidence_global_id: string
  label_global_id: string | null
  action: 'create' | 'void'
  state: AttemptState
  provider: Provider
  service_code: string
  selected_rate: Record<string, unknown>
  reason: string
  error_code: string | null
  provider_reference: string | null
  reconciliation_outcome:
    | CarrierRateTestLabelAttemptListItem['reconciliationOutcome']
  reconciliation_reason: string | null
  reconciled_by: string | null
  reconciled_at: TimestampValue | null
  requested_at: TimestampValue
  completed_at: TimestampValue | null
  reconciliation_eligible: boolean
}

const LABEL_SELECT = `
  SELECT label.global_id,
         rate.global_id AS rate_evidence_global_id,
         created.global_id AS create_attempt_global_id,
         voided.global_id AS void_attempt_global_id,
         carrier_account.global_id AS carrier_account_global_id,
         label.provider, label.environment, label.credential_version,
         label.service_code, label.service_name, label.rate_type,
         label.rated_amount, label.rated_currency, label.tracking_number,
         label.format, label.media_size, label.source_kind,
         label.provider_image_type, label.provider_stock_type,
         octet_length(label.label_payload)::text AS byte_length,
         label.content_sha256,
         print_artifact.global_id AS print_artifact_global_id,
         label.status, label.created_by,
         label.created_at, label.voided_by, label.voided_at
    FROM operations_carrier_rate_test_labels label
    JOIN operations_carrier_rate_requests rate
      ON rate.organization_id = label.organization_id
     AND rate.id = label.rate_request_id
    JOIN operations_carrier_accounts carrier_account
      ON carrier_account.organization_id = label.organization_id
     AND carrier_account.id = label.carrier_account_id
    JOIN operations_carrier_rate_test_label_attempts created
      ON created.organization_id = label.organization_id
     AND created.id = label.create_attempt_id
    LEFT JOIN operations_carrier_rate_test_label_attempts voided
      ON voided.organization_id = label.organization_id
     AND voided.id = label.void_attempt_id
    LEFT JOIN operations_print_artifacts print_artifact
      ON print_artifact.organization_id = label.organization_id
     AND print_artifact.source_rate_test_label_id = label.id
     AND print_artifact.format = label.format
     AND print_artifact.media_size = label.media_size`

const ATTEMPT_SELECT = `
  SELECT attempt.global_id,
         rate.global_id AS rate_evidence_global_id,
         label.global_id AS label_global_id,
         attempt.action, attempt.state, attempt.provider,
         attempt.service_code, attempt.selected_rate, attempt.reason,
         attempt.error_code, attempt.provider_reference,
         attempt.reconciliation_outcome, attempt.reconciliation_reason,
         attempt.reconciled_by, attempt.reconciled_at,
         attempt.requested_at, attempt.completed_at,
         (
           attempt.reconciled_at IS NULL
           AND (
             attempt.state = 'unknown'
             OR (
               attempt.state = 'prepared'
               AND attempt.requested_at <= now() - interval '2 minutes'
             )
           )
         ) AS reconciliation_eligible
    FROM operations_carrier_rate_test_label_attempts attempt
    JOIN operations_carrier_rate_requests rate
      ON rate.organization_id = attempt.organization_id
     AND rate.id = attempt.rate_request_id
    LEFT JOIN operations_carrier_rate_test_labels label
      ON label.organization_id = attempt.organization_id
     AND label.id = attempt.label_id`

function iso(value: TimestampValue | null) {
  return value ? new Date(value).toISOString() : null
}

function labelItem(row: LabelRow): CarrierRateTestLabelListItem {
  return {
    globalId: row.global_id,
    rateEvidenceGlobalId: row.rate_evidence_global_id,
    createAttemptGlobalId: row.create_attempt_global_id,
    voidAttemptGlobalId: row.void_attempt_global_id,
    carrierAccountGlobalId: row.carrier_account_global_id,
    provider: row.provider,
    environment: row.environment,
    credentialVersion: row.credential_version,
    serviceCode: row.service_code,
    serviceName: row.service_name,
    rateType: row.rate_type,
    ratedAmount: row.rated_amount,
    ratedCurrency: row.rated_currency,
    trackingNumber: row.tracking_number,
    format: row.format,
    mediaSize: row.media_size,
    sourceKind: row.source_kind,
    providerImageType: row.provider_image_type,
    providerStockType: row.provider_stock_type,
    byteLength: Number(row.byte_length),
    contentSha256: row.content_sha256,
    printArtifactGlobalId: row.print_artifact_global_id,
    status: row.status,
    createdBy: row.created_by,
    createdAt: iso(row.created_at)!,
    voidedBy: row.voided_by,
    voidedAt: iso(row.voided_at),
  }
}

export function carrierRateTestLabelFingerprint(value: unknown) {
  const stable = (item: unknown): string => {
    if (Array.isArray(item)) return `[${item.map(stable).join(',')}]`
    if (item && typeof item === 'object') {
      return `{${Object.entries(item as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => `${JSON.stringify(key)}:${stable(entry)}`)
        .join(',')}}`
    }
    return JSON.stringify(item) ?? 'null'
  }
  return crypto.createHash('sha256')
    .update(`clawpilot:carrier-rate-test-label:v1\n${stable(value)}`)
    .digest('hex')
}

function storedSelectedRate(value: unknown): CarrierRateTestSelectedRate {
  const rate = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
  const selected: CarrierRateTestSelectedRate = {
    serviceCode: typeof rate.serviceCode === 'string' ? rate.serviceCode : '',
    serviceName: typeof rate.serviceName === 'string' ? rate.serviceName : '',
    rateType: rate.rateType === null
      ? null
      : typeof rate.rateType === 'string'
        ? rate.rateType
        : null,
    amount: typeof rate.amount === 'string' ? rate.amount : '',
    currency: typeof rate.currency === 'string' ? rate.currency : '',
  }
  if (
    !selected.serviceCode
    || !selected.serviceName
    || !/^[0-9]+(?:[.][0-9]{1,6})?$/.test(selected.amount)
    || !/^[A-Z]{3}$/.test(selected.currency)
  ) {
    throw new OperationsRequestError(
      'CARRIER_RATE_TEST_SELECTION_INVALID',
      'The prepared carrier rate selection is invalid',
      500,
    )
  }
  return selected
}

function attemptItem(
  row: AttemptRow,
): CarrierRateTestLabelAttemptListItem {
  return {
    globalId: row.global_id,
    rateEvidenceGlobalId: row.rate_evidence_global_id,
    labelGlobalId: row.label_global_id,
    action: row.action,
    state: row.state,
    provider: row.provider,
    serviceCode: row.service_code,
    selectedRate: storedSelectedRate(row.selected_rate),
    reason: row.reason,
    errorCode: row.error_code,
    providerReference: row.provider_reference,
    reconciliationOutcome: row.reconciliation_outcome,
    reconciliationReason: row.reconciliation_reason,
    reconciledBy: row.reconciled_by,
    reconciledAt: iso(row.reconciled_at),
    requestedAt: iso(row.requested_at)!,
    completedAt: iso(row.completed_at),
    reconciliationEligible: row.reconciliation_eligible,
  }
}

async function oneAttempt(
  organizationId: string,
  globalId: string,
  client?: PoolClient,
) {
  const result = client
    ? await client.query<AttemptRow>(
      `${ATTEMPT_SELECT}
       WHERE attempt.organization_id = $1::uuid
         AND attempt.global_id = $2
       LIMIT 1`,
      [organizationId, globalId],
    )
    : await query<AttemptRow>(
      `${ATTEMPT_SELECT}
       WHERE attempt.organization_id = $1::uuid
         AND attempt.global_id = $2
       LIMIT 1`,
      [organizationId, globalId],
    )
  if (!result.rows[0]) {
    throw new OperationsRequestError(
      'CARRIER_RATE_TEST_LABEL_ATTEMPT_NOT_FOUND',
      'Carrier rate-test label attempt was not found',
      404,
    )
  }
  return attemptItem(result.rows[0])
}

async function oneLabel(
  organizationId: string,
  globalId: string,
  client?: PoolClient,
) {
  const result = client
    ? await client.query<LabelRow>(
      `${LABEL_SELECT}
       WHERE label.organization_id = $1::uuid AND label.global_id = $2
       LIMIT 1`,
      [organizationId, globalId],
    )
    : await query<LabelRow>(
      `${LABEL_SELECT}
       WHERE label.organization_id = $1::uuid AND label.global_id = $2
       LIMIT 1`,
      [organizationId, globalId],
    )
  if (!result.rows[0]) {
    throw new OperationsRequestError(
      'CARRIER_RATE_TEST_LABEL_NOT_FOUND',
      'Carrier rate-test label was not found in the active organization',
      404,
    )
  }
  return labelItem(result.rows[0])
}

export async function listCarrierRateTestLabelsInPostgres(input: {
  organizationId: string
  rateEvidenceGlobalId?: string
}) {
  const result = await query<LabelRow>(
    `${LABEL_SELECT}
     WHERE label.organization_id = $1::uuid
       AND ($2::text IS NULL OR rate.global_id = $2)
     ORDER BY label.created_at DESC, label.id DESC
     LIMIT 100`,
    [input.organizationId, input.rateEvidenceGlobalId || null],
  )
  return result.rows.map(labelItem)
}

export async function listCarrierRateTestLabelAttemptsInPostgres(input: {
  organizationId: string
}) {
  const result = await query<AttemptRow>(
    `${ATTEMPT_SELECT}
     WHERE attempt.organization_id = $1::uuid
       AND attempt.action IN ('create', 'void')
     ORDER BY attempt.requested_at DESC, attempt.id DESC
     LIMIT 100`,
    [input.organizationId],
  )
  return result.rows.map(attemptItem)
}

export async function readCarrierRateTestCreateContextInPostgres(input: {
  organizationId: string
  rateEvidenceGlobalId: string
}): Promise<CarrierRateTestCreateContext> {
  const result = await query<{
    id: string
    global_id: string
    integration_account_id: string
    integration_global_id: string
    carrier_account_id: string
    carrier_account_global_id: string
    provider: Provider
    credential_version: number
    request_hash: string
    billing_relationship: CarrierRateTestCreateContext['billingRelationship']
    billing_selection_snapshot: Record<string, unknown>
    redacted_request: Record<string, unknown>
    redacted_response: Record<string, unknown>
    status: 'succeeded' | 'failed'
  }>(
    `SELECT rate.id::text, rate.global_id,
            rate.integration_account_id::text, integration.global_id AS integration_global_id,
            rate.carrier_account_id::text, carrier_account.global_id AS carrier_account_global_id,
            rate.provider, rate.credential_version, rate.request_hash,
            rate.billing_relationship, rate.billing_selection_snapshot,
            rate.redacted_request, rate.redacted_response, rate.status
       FROM operations_carrier_rate_requests rate
       JOIN operations_integration_accounts integration
         ON integration.organization_id = rate.organization_id
        AND integration.id = rate.integration_account_id
       JOIN operations_carrier_accounts carrier_account
         ON carrier_account.organization_id = rate.organization_id
        AND carrier_account.integration_account_id = rate.integration_account_id
        AND carrier_account.id = rate.carrier_account_id
      WHERE rate.organization_id = $1::uuid AND rate.global_id = $2
      LIMIT 1`,
    [input.organizationId, input.rateEvidenceGlobalId],
  )
  const row = result.rows[0]
  if (!row || row.status !== 'succeeded') {
    throw new OperationsRequestError(
      'CARRIER_RATE_EVIDENCE_NOT_FOUND',
      'A successful carrier rate diagnostic is required',
      404,
    )
  }
  if (row.provider !== 'ups_rest' && row.provider !== 'fedex_rest') {
    throw new OperationsRequestError(
      'CARRIER_RATE_TEST_LABEL_UNSUPPORTED',
      'This carrier rate cannot create a sandbox test label',
      409,
    )
  }
  return {
    rateRequestId: row.id,
    rateEvidenceGlobalId: row.global_id,
    integrationAccountId: row.integration_account_id,
    integrationGlobalId: row.integration_global_id,
    carrierAccountId: row.carrier_account_id,
    carrierAccountGlobalId: row.carrier_account_global_id,
    provider: row.provider,
    credentialVersion: row.credential_version,
    requestHash: row.request_hash,
    billingRelationship: row.billing_relationship,
    billingSelectionSnapshot: row.billing_selection_snapshot,
    redactedRequest: row.redacted_request,
    redactedResponse: row.redacted_response,
  }
}

type PrepareCreateInput = CarrierRateTestCreateContext & {
  organizationId: string
  actorEmail: string
  reason: string
  idempotencyKey: string
  attemptRequestHash: string
  destinationFingerprint: string
  selectedRate: CarrierRateTestSelectedRate
  outputFormat: 'ZPL' | 'PDF' | 'PNG'
  adapterVersion: string
}

export async function prepareCarrierRateTestLabelCreateInPostgres(
  input: PrepareCreateInput,
): Promise<
  | { disposition: 'prepared'; attemptId: string; attemptGlobalId: string }
  | { disposition: 'replayed'; label: CarrierRateTestLabelListItem }
> {
  return withTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(
      client,
      `carrier-rate-test-label:create:${input.organizationId}:${input.idempotencyKey}`,
    )
    await acquireTransactionAdvisoryLock(
      client,
      `carrier-rate-test-label:service:${input.organizationId}:${input.rateRequestId}:${input.selectedRate.serviceCode}:${input.selectedRate.rateType || ''}`,
    )
    const replay = await client.query<{
      id: string
      global_id: string
      state: AttemptState
      request_hash: string
      label_global_id: string | null
    }>(
      `SELECT attempt.id::text, attempt.global_id, attempt.state,
              attempt.request_hash, label.global_id AS label_global_id
         FROM operations_carrier_rate_test_label_attempts attempt
         LEFT JOIN operations_carrier_rate_test_labels label
           ON label.organization_id = attempt.organization_id
          AND label.id = attempt.label_id
        WHERE attempt.organization_id = $1::uuid
          AND attempt.action = 'create'
          AND attempt.idempotency_key = $2
        FOR SHARE OF attempt`,
      [input.organizationId, input.idempotencyKey],
    )
    if (replay.rows[0]) {
      const prior = replay.rows[0]
      if (prior.request_hash !== input.attemptRequestHash) {
        throw new OperationsRequestError(
          'CARRIER_RATE_TEST_LABEL_IDEMPOTENCY_REUSED',
          'Idempotency-Key was already used for a different label request',
          409,
        )
      }
      if (prior.state === 'succeeded' && prior.label_global_id) {
        return {
          disposition: 'replayed' as const,
          label: await oneLabel(input.organizationId, prior.label_global_id, client),
        }
      }
      throw new OperationsRequestError(
        prior.state === 'unknown'
          ? 'CARRIER_RATE_TEST_LABEL_OUTCOME_UNKNOWN'
          : prior.state === 'prepared'
            ? 'CARRIER_RATE_TEST_LABEL_IN_PROGRESS'
            : 'CARRIER_RATE_TEST_LABEL_ATTEMPT_FAILED',
        prior.state === 'unknown'
          ? 'The carrier result is unknown and must be reconciled before retrying'
          : prior.state === 'prepared'
            ? 'This carrier label request is already in progress'
            : 'Use a new Idempotency-Key after correcting the failed request',
        409,
      )
    }
    const fence = await client.query<{ state: AttemptState; global_id: string }>(
      `SELECT state, global_id
         FROM operations_carrier_rate_test_label_attempts
        WHERE organization_id = $1::uuid
          AND rate_request_id = $2::uuid
          AND service_code = $3
          AND COALESCE(rate_type, '') = COALESCE($4::text, '')
          AND state IN ('prepared', 'unknown')
        LIMIT 1
        FOR SHARE`,
      [
        input.organizationId,
        input.rateRequestId,
        input.selectedRate.serviceCode,
        input.selectedRate.rateType,
      ],
    )
    if (fence.rows[0]) {
      throw new OperationsRequestError(
        fence.rows[0].state === 'unknown'
          ? 'CARRIER_RATE_TEST_LABEL_OUTCOME_UNKNOWN'
          : 'CARRIER_RATE_TEST_LABEL_IN_PROGRESS',
        'An unresolved carrier label attempt already exists for this exact rate',
        409,
      )
    }
    const active = await client.query<{ global_id: string }>(
      `SELECT global_id
         FROM operations_carrier_rate_test_labels
        WHERE organization_id = $1::uuid
          AND rate_request_id = $2::uuid
          AND service_code = $3
          AND COALESCE(rate_type, '') = COALESCE($4::text, '')
          AND status = 'created'
        LIMIT 1
        FOR SHARE`,
      [
        input.organizationId,
        input.rateRequestId,
        input.selectedRate.serviceCode,
        input.selectedRate.rateType,
      ],
    )
    if (active.rows[0]) {
      throw new OperationsRequestError(
        'CARRIER_RATE_TEST_LABEL_ALREADY_EXISTS',
        `This rate already has active test label ${active.rows[0].global_id}`,
        409,
      )
    }
    const inserted = await client.query<{ id: string; global_id: string }>(
      `INSERT INTO operations_carrier_rate_test_label_attempts (
         organization_id, rate_request_id, integration_account_id,
         carrier_account_id, action, state, provider, environment,
         credential_version, service_code, rate_type, selected_rate,
         destination_fingerprint, adapter_version, reason, idempotency_key,
         request_hash, redacted_request, actor_email
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, 'create', 'prepared',
         $5, 'sandbox', $6, $7, $8, $9::jsonb, $10, $11, $12, $13,
         $14, $15::jsonb, $16
       )
       RETURNING id::text, global_id`,
      [
        input.organizationId,
        input.rateRequestId,
        input.integrationAccountId,
        input.carrierAccountId,
        input.provider,
        input.credentialVersion,
        input.selectedRate.serviceCode,
        input.selectedRate.rateType,
        JSON.stringify(input.selectedRate),
        input.destinationFingerprint,
        input.adapterVersion,
        input.reason,
        input.idempotencyKey,
        input.attemptRequestHash,
        JSON.stringify({
          rateEvidenceGlobalId: input.rateEvidenceGlobalId,
          carrierAccountGlobalId: input.carrierAccountGlobalId,
          destinationFingerprint: input.destinationFingerprint,
          selectedRate: input.selectedRate,
          outputFormat: input.outputFormat,
        }),
        input.actorEmail,
      ],
    )
    return {
      disposition: 'prepared' as const,
      attemptId: inserted.rows[0].id,
      attemptGlobalId: inserted.rows[0].global_id,
    }
  })
}

export async function finalizeCarrierRateTestLabelCreateInPostgres(input: {
  organizationId: string
  attemptGlobalId: string
  actorEmail: string
  accountNumberFingerprint: string
  providerLabelId: string
  trackingNumber: string
  format: 'ZPL' | 'PDF' | 'PNG'
  mediaSize: 'label_4x6'
  sourceKind: 'provider_native'
  providerImageType: 'ZPL' | 'ZPLII' | 'PDF' | 'PNG'
  providerStockType: 'HEIGHT_6_WIDTH_4' | 'STOCK_4X6' | 'PAPER_4X6'
  labelPayload: Buffer
  contentSha256: string
  providerReference: string | null
  redactedProviderEvidence: Record<string, unknown>
}) {
  const bytes = Buffer.from(input.labelPayload)
  const zpl = bytes.toString('utf8')
  const pdfTail = bytes
    .subarray(Math.max(0, bytes.byteLength - 2048))
    .toString('latin1')
  const pngSignature = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ])
  const pngTail = bytes.subarray(Math.max(0, bytes.byteLength - 32))
  const expectedHash = crypto.createHash('sha256').update(bytes).digest('hex')
  const validPayload = (
    bytes.byteLength >= 1
    && bytes.byteLength <= 10 * 1024 * 1024
    && expectedHash === input.contentSha256
    && /^[a-f0-9]{64}$/.test(input.accountNumberFingerprint)
    && (
      (
        input.format === 'ZPL'
        && zpl.trim().startsWith('^XA')
        && zpl.trim().endsWith('^XZ')
        && Buffer.from(zpl, 'utf8').equals(bytes)
        && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(zpl)
      )
      || (
        input.format === 'PDF'
        && bytes.subarray(0, 5).toString('ascii') === '%PDF-'
        && /%%EOF[\u0000\t\n\f\r ]*$/.test(pdfTail)
      )
      || (
        input.format === 'PNG'
        && bytes.byteLength >= 45
        && bytes.subarray(0, 8).equals(pngSignature)
        && bytes.subarray(12, 16).toString('ascii') === 'IHDR'
        && bytes.readUInt32BE(16) === 800
        && bytes.readUInt32BE(20) === 1200
        && pngTail.includes(Buffer.from('IEND', 'ascii'))
      )
    )
    && input.mediaSize === 'label_4x6'
    && input.sourceKind === 'provider_native'
  )
  if (!validPayload) {
    throw new OperationsRequestError(
      'CARRIER_PROVIDER_RESPONSE_INVALID',
      'Carrier label bytes failed durable integrity validation',
      502,
    )
  }
  return withTransaction(async (client) => {
    const attemptResult = await client.query<{
      id: string
      state: AttemptState
      label_global_id: string | null
      rate_request_id: string
      rate_evidence_global_id: string
      rate_request_hash: string
      integration_account_id: string
      carrier_account_id: string
      carrier_account_global_id: string
      provider: Provider
      credential_version: number
      selected_rate: Record<string, unknown>
      destination_fingerprint: string
      requested_output_format: string
    }>(
      `SELECT attempt.id::text, attempt.state,
              label.global_id AS label_global_id,
              attempt.rate_request_id::text,
              rate.global_id AS rate_evidence_global_id,
              rate.request_hash AS rate_request_hash,
              attempt.integration_account_id::text,
              attempt.carrier_account_id::text,
              carrier_account.global_id AS carrier_account_global_id,
              attempt.provider, attempt.credential_version,
              attempt.selected_rate, attempt.destination_fingerprint,
              COALESCE(
                attempt.redacted_request->>'outputFormat',
                'ZPL'
              ) AS requested_output_format
         FROM operations_carrier_rate_test_label_attempts attempt
         JOIN operations_carrier_rate_requests rate
           ON rate.organization_id = attempt.organization_id
          AND rate.id = attempt.rate_request_id
         JOIN operations_carrier_accounts carrier_account
           ON carrier_account.organization_id = attempt.organization_id
          AND carrier_account.integration_account_id = attempt.integration_account_id
          AND carrier_account.id = attempt.carrier_account_id
         LEFT JOIN operations_carrier_rate_test_labels label
           ON label.organization_id = attempt.organization_id
          AND label.id = attempt.label_id
        WHERE attempt.organization_id = $1::uuid
          AND attempt.global_id = $2
          AND attempt.action = 'create'
        FOR UPDATE OF attempt`,
      [input.organizationId, input.attemptGlobalId],
    )
    const attempt = attemptResult.rows[0]
    if (!attempt) {
      throw new OperationsRequestError(
        'CARRIER_RATE_TEST_LABEL_ATTEMPT_NOT_FOUND',
        'Carrier label create attempt was not found',
        404,
      )
    }
    if (attempt.state === 'succeeded' && attempt.label_global_id) {
      return oneLabel(input.organizationId, attempt.label_global_id, client)
    }
    if (attempt.state !== 'prepared') {
      throw new OperationsRequestError(
        'CARRIER_RATE_TEST_LABEL_ATTEMPT_TERMINAL',
        'Carrier label create attempt has already reached a terminal state',
        409,
      )
    }
    if (attempt.requested_output_format !== input.format) {
      throw new OperationsRequestError(
        'CARRIER_RATE_TEST_LABEL_OUTPUT_MISMATCH',
        'Carrier label output does not match the prepared request',
        409,
      )
    }
    const selectedRate = storedSelectedRate(attempt.selected_rate)
    const expectedProviderOutput: Partial<
      Record<'ZPL' | 'PDF' | 'PNG', readonly [string, string]>
    > = attempt.provider === 'ups_rest'
      ? {
          ZPL: ['ZPL', 'HEIGHT_6_WIDTH_4'],
        }
      : {
          ZPL: ['ZPLII', 'STOCK_4X6'],
          PDF: ['PDF', 'PAPER_4X6'],
          PNG: ['PNG', 'PAPER_4X6'],
        }
    const expectedOutput = expectedProviderOutput[input.format]
    if (
      !expectedOutput
      || input.providerImageType !== expectedOutput[0]
      || input.providerStockType !== expectedOutput[1]
    ) {
      throw new OperationsRequestError(
        'CARRIER_PROVIDER_RESPONSE_INVALID',
        'Carrier label source metadata does not match the provider output',
        502,
      )
    }
    const inserted = await client.query<{ id: string; global_id: string }>(
      `INSERT INTO operations_carrier_rate_test_labels (
         organization_id, rate_request_id, integration_account_id,
         carrier_account_id, provider, environment, credential_version,
         account_number_fingerprint, rate_request_hash, destination_fingerprint,
         service_code, service_name, rate_type, rated_amount, rated_currency,
         provider_label_id, tracking_number, format, media_size,
         source_kind, provider_image_type, provider_stock_type, label_payload,
         content_sha256, provider_reference, redacted_provider_evidence,
         create_attempt_id, created_by
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, 'sandbox', $6,
         $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18,
         $19, $20, $21, $22::bytea, $23, $24, $25::jsonb, $26::uuid, $27
       )
       RETURNING id::text, global_id`,
      [
        input.organizationId,
        attempt.rate_request_id,
        attempt.integration_account_id,
        attempt.carrier_account_id,
        attempt.provider,
        attempt.credential_version,
        input.accountNumberFingerprint,
        attempt.rate_request_hash,
        attempt.destination_fingerprint,
        selectedRate.serviceCode,
        selectedRate.serviceName,
        selectedRate.rateType,
        selectedRate.amount,
        selectedRate.currency,
        input.providerLabelId,
        input.trackingNumber,
        input.format,
        input.mediaSize,
        input.sourceKind,
        input.providerImageType,
        input.providerStockType,
        input.labelPayload,
        input.contentSha256,
        input.providerReference,
        JSON.stringify(input.redactedProviderEvidence),
        attempt.id,
        input.actorEmail,
      ],
    )
    await client.query(
      `UPDATE operations_carrier_rate_test_label_attempts
          SET label_id = $3::uuid, state = 'succeeded',
              redacted_response = $4::jsonb, provider_reference = $5,
              completed_at = now()
        WHERE organization_id = $1::uuid AND id = $2::uuid`,
      [
        input.organizationId,
        attempt.id,
        inserted.rows[0].id,
        JSON.stringify({
          format: input.format,
          mediaSize: input.mediaSize,
          sourceKind: input.sourceKind,
          providerImageType: input.providerImageType,
          providerStockType: input.providerStockType,
          byteLength: input.labelPayload.byteLength,
          contentSha256: input.contentSha256,
        }),
        input.providerReference,
      ],
    )
    await recordAuditEvent({
      actor: input.actorEmail,
      eventType: 'carrier.rate_test_label.created',
      aggregateType: 'operations.carrier_rate_test_label',
      aggregateId: inserted.rows[0].global_id,
      eventKey: `carrier:rate-test-label:created:${inserted.rows[0].global_id}`,
      organizationId: input.organizationId,
      payload: {
        rateEvidenceGlobalId: attempt.rate_evidence_global_id,
        createAttemptGlobalId: input.attemptGlobalId,
        carrierAccountGlobalId: attempt.carrier_account_global_id,
        provider: attempt.provider,
        environment: 'sandbox',
        serviceCode: selectedRate.serviceCode,
        rateType: selectedRate.rateType,
        format: input.format,
        mediaSize: input.mediaSize,
        sourceKind: input.sourceKind,
        providerImageType: input.providerImageType,
        providerStockType: input.providerStockType,
        byteLength: input.labelPayload.byteLength,
        contentSha256: input.contentSha256,
      },
    }, client)
    return oneLabel(input.organizationId, inserted.rows[0].global_id, client)
  })
}

export async function finalizeCarrierRateTestLabelAttemptFailureInPostgres(input: {
  organizationId: string
  attemptGlobalId: string
  actorEmail: string
  state: Extract<AttemptState, 'failed' | 'unknown'>
  errorCode: string
  redactedResponse?: Record<string, unknown>
  providerReference?: string | null
}) {
  await withTransaction(async (client) => {
    const result = await client.query<{ action: 'create' | 'void'; state: AttemptState }>(
      `SELECT action, state
         FROM operations_carrier_rate_test_label_attempts
        WHERE organization_id = $1::uuid AND global_id = $2
        FOR UPDATE`,
      [input.organizationId, input.attemptGlobalId],
    )
    if (!result.rows[0] || result.rows[0].state !== 'prepared') return
    await client.query(
      `UPDATE operations_carrier_rate_test_label_attempts
          SET state = $3, error_code = $4,
              redacted_response = $5::jsonb, provider_reference = $6,
              completed_at = now()
        WHERE organization_id = $1::uuid AND global_id = $2`,
      [
        input.organizationId,
        input.attemptGlobalId,
        input.state,
        input.errorCode.slice(0, 240),
        JSON.stringify(input.redactedResponse || {}),
        input.providerReference || null,
      ],
    )
    await recordAuditEvent({
      actor: input.actorEmail,
      eventType: `carrier.rate_test_label.${result.rows[0].action}_${input.state}`,
      aggregateType: 'operations.carrier_rate_test_label_attempt',
      aggregateId: input.attemptGlobalId,
      eventKey: `carrier:rate-test-label:${result.rows[0].action}:${input.state}:${input.attemptGlobalId}`,
      organizationId: input.organizationId,
      payload: { action: result.rows[0].action, state: input.state, errorCode: input.errorCode },
    }, client)
  })
}

export async function readCarrierRateTestLabelProviderContextInPostgres(input: {
  organizationId: string
  labelGlobalId: string
}): Promise<CarrierRateTestLabelProviderContext> {
  const result = await query<{
    label_id: string
    label_global_id: string
    rate_request_id: string
    rate_evidence_global_id: string
    integration_account_id: string
    integration_global_id: string
    carrier_account_id: string
    carrier_account_global_id: string
    provider: Provider
    credential_version: number
    account_number_fingerprint: string
    rate_request_hash: string
    destination_fingerprint: string
    service_code: string
    service_name: string
    rate_type: string | null
    rated_amount: string
    rated_currency: string
    provider_label_id: string
    tracking_number: string
    status: 'created' | 'voided'
    create_request: Record<string, unknown>
  }>(
    `SELECT label.id::text AS label_id, label.global_id AS label_global_id,
            label.rate_request_id::text, rate.global_id AS rate_evidence_global_id,
            label.integration_account_id::text, integration.global_id AS integration_global_id,
            label.carrier_account_id::text, carrier_account.global_id AS carrier_account_global_id,
            label.provider, label.credential_version,
            label.account_number_fingerprint, label.rate_request_hash,
            label.destination_fingerprint, label.service_code, label.service_name,
            label.rate_type, label.rated_amount, label.rated_currency,
            label.provider_label_id, label.tracking_number, label.status,
            created.redacted_request AS create_request
       FROM operations_carrier_rate_test_labels label
       JOIN operations_carrier_rate_requests rate
         ON rate.organization_id = label.organization_id AND rate.id = label.rate_request_id
       JOIN operations_integration_accounts integration
         ON integration.organization_id = label.organization_id
        AND integration.id = label.integration_account_id
       JOIN operations_carrier_accounts carrier_account
         ON carrier_account.organization_id = label.organization_id
        AND carrier_account.id = label.carrier_account_id
       JOIN operations_carrier_rate_test_label_attempts created
         ON created.organization_id = label.organization_id
        AND created.id = label.create_attempt_id
      WHERE label.organization_id = $1::uuid AND label.global_id = $2
      LIMIT 1`,
    [input.organizationId, input.labelGlobalId],
  )
  if (!result.rows[0]) {
    throw new OperationsRequestError(
      'CARRIER_RATE_TEST_LABEL_NOT_FOUND',
      'Carrier rate-test label was not found in the active organization',
      404,
    )
  }
  const row = result.rows[0]
  return {
    labelId: row.label_id,
    labelGlobalId: row.label_global_id,
    rateRequestId: row.rate_request_id,
    rateEvidenceGlobalId: row.rate_evidence_global_id,
    integrationAccountId: row.integration_account_id,
    integrationGlobalId: row.integration_global_id,
    carrierAccountId: row.carrier_account_id,
    carrierAccountGlobalId: row.carrier_account_global_id,
    provider: row.provider,
    credentialVersion: row.credential_version,
    accountNumberFingerprint: row.account_number_fingerprint,
    rateRequestHash: row.rate_request_hash,
    destinationFingerprint: row.destination_fingerprint,
    serviceCode: row.service_code,
    serviceName: row.service_name,
    rateType: row.rate_type,
    ratedAmount: row.rated_amount,
    ratedCurrency: row.rated_currency,
    providerLabelId: row.provider_label_id,
    trackingNumber: row.tracking_number,
    status: row.status,
    createRequest: row.create_request,
  }
}

export async function replayCarrierRateTestLabelVoidInPostgres(input: {
  organizationId: string
  labelGlobalId: string
  idempotencyKey: string
  attemptRequestHash: string
}) {
  const result = await query<{
    state: AttemptState
    request_hash: string
    label_global_id: string | null
  }>(
    `SELECT attempt.state, attempt.request_hash,
            label.global_id AS label_global_id
       FROM operations_carrier_rate_test_label_attempts attempt
       LEFT JOIN operations_carrier_rate_test_labels label
         ON label.organization_id = attempt.organization_id
        AND label.id = attempt.label_id
      WHERE attempt.organization_id = $1::uuid
        AND attempt.action = 'void'
        AND attempt.idempotency_key = $2
      LIMIT 1`,
    [input.organizationId, input.idempotencyKey],
  )
  const prior = result.rows[0]
  if (!prior) return null
  if (prior.request_hash !== input.attemptRequestHash) {
    throw new OperationsRequestError(
      'CARRIER_RATE_TEST_LABEL_IDEMPOTENCY_REUSED',
      'Idempotency-Key was already used for a different void request',
      409,
    )
  }
  if (
    prior.state === 'succeeded'
    && prior.label_global_id === input.labelGlobalId
  ) {
    return oneLabel(input.organizationId, prior.label_global_id)
  }
  throw new OperationsRequestError(
    prior.state === 'unknown'
      ? 'CARRIER_RATE_TEST_LABEL_VOID_OUTCOME_UNKNOWN'
      : prior.state === 'prepared'
        ? 'CARRIER_RATE_TEST_LABEL_VOID_IN_PROGRESS'
        : 'CARRIER_RATE_TEST_LABEL_VOID_FAILED',
    prior.state === 'unknown'
      ? 'This void outcome is unknown; use the reconciliation workflow before retrying'
      : 'This carrier label void attempt cannot be repeated with the same key',
    409,
  )
}

export async function prepareCarrierRateTestLabelVoidInPostgres(input: {
  organizationId: string
  actorEmail: string
  label: CarrierRateTestLabelProviderContext
  credentialVersion: number
  reason: string
  idempotencyKey: string
  attemptRequestHash: string
  adapterVersion: string
}): Promise<
  | { disposition: 'prepared'; attemptId: string; attemptGlobalId: string }
  | { disposition: 'replayed'; label: CarrierRateTestLabelListItem }
> {
  return withTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(
      client,
      `carrier-rate-test-label:void:${input.organizationId}:${input.label.labelGlobalId}`,
    )
    const replay = await client.query<{
      id: string
      global_id: string
      state: AttemptState
      request_hash: string
    }>(
      `SELECT id::text, global_id, state, request_hash
         FROM operations_carrier_rate_test_label_attempts
        WHERE organization_id = $1::uuid AND action = 'void'
          AND idempotency_key = $2
        FOR SHARE`,
      [input.organizationId, input.idempotencyKey],
    )
    if (replay.rows[0]) {
      if (replay.rows[0].request_hash !== input.attemptRequestHash) {
        throw new OperationsRequestError(
          'CARRIER_RATE_TEST_LABEL_IDEMPOTENCY_REUSED',
          'Idempotency-Key was already used for a different void request',
          409,
        )
      }
      if (replay.rows[0].state === 'succeeded') {
        return {
          disposition: 'replayed' as const,
          label: await oneLabel(input.organizationId, input.label.labelGlobalId, client),
        }
      }
      throw new OperationsRequestError(
        replay.rows[0].state === 'unknown'
          ? 'CARRIER_RATE_TEST_LABEL_VOID_OUTCOME_UNKNOWN'
          : replay.rows[0].state === 'prepared'
            ? 'CARRIER_RATE_TEST_LABEL_VOID_IN_PROGRESS'
            : 'CARRIER_RATE_TEST_LABEL_VOID_FAILED',
        'This carrier label void attempt cannot be repeated with the same key',
        409,
      )
    }
    const locked = await client.query<{ status: 'created' | 'voided' }>(
      `SELECT status
         FROM operations_carrier_rate_test_labels
        WHERE organization_id = $1::uuid AND id = $2::uuid
        FOR UPDATE`,
      [input.organizationId, input.label.labelId],
    )
    if (!locked.rows[0]) {
      throw new OperationsRequestError(
        'CARRIER_RATE_TEST_LABEL_NOT_FOUND',
        'Carrier rate-test label was not found',
        404,
      )
    }
    if (locked.rows[0].status !== 'created') {
      throw new OperationsRequestError(
        'CARRIER_RATE_TEST_LABEL_ALREADY_VOIDED',
        'Carrier rate-test label is already voided',
        409,
      )
    }
    const fence = await client.query<{ state: AttemptState }>(
      `SELECT state
         FROM operations_carrier_rate_test_label_attempts
        WHERE organization_id = $1::uuid AND label_id = $2::uuid
          AND action = 'void' AND state IN ('prepared', 'unknown')
        LIMIT 1 FOR SHARE`,
      [input.organizationId, input.label.labelId],
    )
    if (fence.rows[0]) {
      throw new OperationsRequestError(
        fence.rows[0].state === 'unknown'
          ? 'CARRIER_RATE_TEST_LABEL_VOID_OUTCOME_UNKNOWN'
          : 'CARRIER_RATE_TEST_LABEL_VOID_IN_PROGRESS',
        'An unresolved void attempt already exists for this label',
        409,
      )
    }
    const selectedRate: CarrierRateTestSelectedRate = {
      serviceCode: input.label.serviceCode,
      serviceName: input.label.serviceName,
      rateType: input.label.rateType,
      amount: input.label.ratedAmount,
      currency: input.label.ratedCurrency,
    }
    const inserted = await client.query<{ id: string; global_id: string }>(
      `INSERT INTO operations_carrier_rate_test_label_attempts (
         organization_id, rate_request_id, integration_account_id,
         carrier_account_id, label_id, action, state, provider, environment,
         credential_version, service_code, rate_type, selected_rate,
         destination_fingerprint, adapter_version, reason, idempotency_key,
         request_hash, redacted_request, actor_email
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 'void', 'prepared',
         $6, 'sandbox', $7, $8, $9, $10::jsonb, $11, $12, $13, $14, $15,
         $16::jsonb, $17
       ) RETURNING id::text, global_id`,
      [
        input.organizationId,
        input.label.rateRequestId,
        input.label.integrationAccountId,
        input.label.carrierAccountId,
        input.label.labelId,
        input.label.provider,
        input.credentialVersion,
        input.label.serviceCode,
        input.label.rateType,
        JSON.stringify(selectedRate),
        input.label.destinationFingerprint,
        input.adapterVersion,
        input.reason,
        input.idempotencyKey,
        input.attemptRequestHash,
        JSON.stringify({
          labelGlobalId: input.label.labelGlobalId,
          rateEvidenceGlobalId: input.label.rateEvidenceGlobalId,
          carrierAccountGlobalId: input.label.carrierAccountGlobalId,
        }),
        input.actorEmail,
      ],
    )
    return {
      disposition: 'prepared' as const,
      attemptId: inserted.rows[0].id,
      attemptGlobalId: inserted.rows[0].global_id,
    }
  })
}

export async function finalizeCarrierRateTestLabelVoidInPostgres(input: {
  organizationId: string
  actorEmail: string
  attemptGlobalId: string
  providerReference: string | null
  redactedResponse?: Record<string, unknown>
}) {
  return withTransaction(async (client) => {
    const attemptResult = await client.query<{
      id: string
      state: AttemptState
      label_id: string
      label_global_id: string
    }>(
      `SELECT attempt.id::text, attempt.state,
              attempt.label_id::text, label.global_id AS label_global_id
         FROM operations_carrier_rate_test_label_attempts attempt
         JOIN operations_carrier_rate_test_labels label
           ON label.organization_id = attempt.organization_id
          AND label.id = attempt.label_id
        WHERE attempt.organization_id = $1::uuid
          AND attempt.global_id = $2
          AND attempt.action = 'void'
        FOR UPDATE`,
      [input.organizationId, input.attemptGlobalId],
    )
    const attempt = attemptResult.rows[0]
    if (!attempt) {
      throw new OperationsRequestError(
        'CARRIER_RATE_TEST_LABEL_ATTEMPT_NOT_FOUND',
        'Carrier label void attempt was not found',
        404,
      )
    }
    if (attempt.state === 'succeeded') {
      return oneLabel(input.organizationId, attempt.label_global_id, client)
    }
    if (attempt.state !== 'prepared') {
      throw new OperationsRequestError(
        'CARRIER_RATE_TEST_LABEL_ATTEMPT_TERMINAL',
        'Carrier label void attempt has already reached a terminal state',
        409,
      )
    }
    const updated = await client.query<{ global_id: string }>(
      `UPDATE operations_carrier_rate_test_labels
          SET status = 'voided', void_attempt_id = $3::uuid,
              voided_by = $4, voided_at = now()
        WHERE organization_id = $1::uuid AND id = $2::uuid
          AND status = 'created'
       RETURNING global_id`,
      [input.organizationId, attempt.label_id, attempt.id, input.actorEmail],
    )
    if (!updated.rows[0]) {
      throw new OperationsRequestError(
        'CARRIER_RATE_TEST_LABEL_ALREADY_VOIDED',
        'Carrier rate-test label is no longer active',
        409,
      )
    }
    await client.query(
      `UPDATE operations_carrier_rate_test_label_attempts
          SET state = 'succeeded', redacted_response = $3::jsonb,
              provider_reference = $4, completed_at = now()
        WHERE organization_id = $1::uuid AND id = $2::uuid`,
      [
        input.organizationId,
        attempt.id,
        JSON.stringify(input.redactedResponse || { voided: true }),
        input.providerReference,
      ],
    )
    await recordAuditEvent({
      actor: input.actorEmail,
      eventType: 'carrier.rate_test_label.voided',
      aggregateType: 'operations.carrier_rate_test_label',
      aggregateId: attempt.label_global_id,
      eventKey: `carrier:rate-test-label:voided:${attempt.label_global_id}`,
      organizationId: input.organizationId,
      payload: { voidAttemptGlobalId: input.attemptGlobalId, status: 'voided' },
    }, client)
    return oneLabel(input.organizationId, attempt.label_global_id, client)
  })
}

export async function reconcileCarrierRateTestLabelAttemptInPostgres(input: {
  organizationId: string
  actorEmail: string
  attemptGlobalId: string
  outcome:
    | 'confirmed_no_active_label'
    | 'confirmed_voided'
    | 'confirmed_active'
  reason: string
  idempotencyKey: string
}) {
  if (!/^gsa[0-9]{7}$/.test(input.attemptGlobalId)) {
    throw new OperationsRequestError(
      'CARRIER_RATE_TEST_LABEL_ATTEMPT_NOT_FOUND',
      'Carrier rate-test label attempt was not found',
      404,
    )
  }
  const reason = String(input.reason || '').trim()
  if (
    !reason
    || reason.length > 500
    || /[\u0000-\u001f\u007f]/.test(reason)
  ) {
    throw new OperationsRequestError(
      'CARRIER_RATE_TEST_RECONCILIATION_REASON_INVALID',
      'Reconciliation reason must be 1-500 plain-text characters',
    )
  }
  if (!/^[A-Za-z0-9._:-]{8,200}$/.test(input.idempotencyKey)) {
    throw new OperationsRequestError(
      'CARRIER_RATE_TEST_RECONCILIATION_KEY_INVALID',
      'Reconciliation idempotency key is invalid',
    )
  }
  return withTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(
      client,
      `carrier-rate-test-label:reconcile:${input.organizationId}:${input.attemptGlobalId}`,
    )
    await acquireTransactionAdvisoryLock(
      client,
      `carrier-rate-test-label:reconcile-key:${input.organizationId}:${input.idempotencyKey}`,
    )
    const keyOwner = await client.query<{ global_id: string }>(
      `SELECT global_id
         FROM operations_carrier_rate_test_label_attempts
        WHERE organization_id = $1::uuid
          AND reconciliation_idempotency_key = $2
        LIMIT 1
        FOR SHARE`,
      [input.organizationId, input.idempotencyKey],
    )
    if (
      keyOwner.rows[0]
      && keyOwner.rows[0].global_id !== input.attemptGlobalId
    ) {
      throw new OperationsRequestError(
        'CARRIER_RATE_TEST_LABEL_IDEMPOTENCY_REUSED',
        'Idempotency-Key was already used for a different reconciliation',
        409,
      )
    }
    const result = await client.query<{
      id: string
      action: 'create' | 'void'
      state: AttemptState
      label_id: string | null
      requested_at: TimestampValue
      reconciliation_outcome:
        | CarrierRateTestLabelAttemptListItem['reconciliationOutcome']
      reconciliation_idempotency_key: string | null
      reconciled_at: TimestampValue | null
    }>(
      `SELECT id::text, action, state, label_id::text, requested_at,
              reconciliation_outcome, reconciliation_idempotency_key,
              reconciled_at
         FROM operations_carrier_rate_test_label_attempts
        WHERE organization_id = $1::uuid AND global_id = $2
          AND action IN ('create', 'void')
        FOR UPDATE`,
      [input.organizationId, input.attemptGlobalId],
    )
    const attempt = result.rows[0]
    if (!attempt) {
      throw new OperationsRequestError(
        'CARRIER_RATE_TEST_LABEL_ATTEMPT_NOT_FOUND',
        'Carrier rate-test label attempt was not found',
        404,
      )
    }
    if (attempt.reconciled_at) {
      if (
        attempt.reconciliation_outcome === input.outcome
        && attempt.reconciliation_idempotency_key === input.idempotencyKey
      ) {
        return oneAttempt(
          input.organizationId,
          input.attemptGlobalId,
          client,
        )
      }
      throw new OperationsRequestError(
        'CARRIER_RATE_TEST_LABEL_RECONCILED',
        'This carrier attempt already has a different reconciliation outcome',
        409,
      )
    }
    if (attempt.state !== 'unknown' && attempt.state !== 'prepared') {
      throw new OperationsRequestError(
        'CARRIER_RATE_TEST_LABEL_RECONCILIATION_NOT_REQUIRED',
        'Only unknown or stale prepared attempts require reconciliation',
        409,
      )
    }
    if (
      attempt.state === 'prepared'
      && Date.now() - new Date(attempt.requested_at).getTime() < 2 * 60 * 1000
    ) {
      throw new OperationsRequestError(
        'CARRIER_RATE_TEST_LABEL_IN_PROGRESS',
        'Wait two minutes before reconciling an in-progress carrier attempt',
        409,
      )
    }
    const validOutcome = attempt.action === 'create'
      ? input.outcome === 'confirmed_no_active_label'
      : input.outcome === 'confirmed_voided'
        || input.outcome === 'confirmed_active'
    if (!validOutcome) {
      throw new OperationsRequestError(
        'CARRIER_RATE_TEST_RECONCILIATION_OUTCOME_INVALID',
        attempt.action === 'create'
          ? 'A create attempt can only be cleared after confirming no active provider label exists'
          : 'A void attempt must be confirmed as voided or still active',
        409,
      )
    }
    if (input.outcome === 'confirmed_voided') {
      if (!attempt.label_id) {
        throw new OperationsRequestError(
          'CARRIER_RATE_TEST_LABEL_NOT_FOUND',
          'The void attempt is not linked to a carrier test label',
          409,
        )
      }
      const label = await client.query<{ global_id: string }>(
        `UPDATE operations_carrier_rate_test_labels
            SET status = 'voided', void_attempt_id = $3::uuid,
                voided_by = $4, voided_at = now()
          WHERE organization_id = $1::uuid AND id = $2::uuid
            AND status = 'created'
         RETURNING global_id`,
        [
          input.organizationId,
          attempt.label_id,
          attempt.id,
          input.actorEmail,
        ],
      )
      if (!label.rows[0]) {
        throw new OperationsRequestError(
          'CARRIER_RATE_TEST_LABEL_ALREADY_VOIDED',
          'The linked carrier test label is no longer active',
          409,
        )
      }
    }
    const succeeded = input.outcome === 'confirmed_voided'
    const errorCode = input.outcome === 'confirmed_no_active_label'
      ? 'CARRIER_RATE_TEST_RECONCILED_NO_ACTIVE_LABEL'
      : input.outcome === 'confirmed_active'
        ? 'CARRIER_RATE_TEST_RECONCILED_ACTIVE'
        : null
    await client.query(
      `UPDATE operations_carrier_rate_test_label_attempts
          SET state = $3,
              error_code = $4,
              redacted_response = redacted_response || $5::jsonb,
              reconciliation_outcome = $6,
              reconciliation_reason = $7,
              reconciliation_idempotency_key = $8,
              reconciled_by = $9,
              reconciled_at = now(),
              completed_at = COALESCE(completed_at, now())
        WHERE organization_id = $1::uuid AND id = $2::uuid`,
      [
        input.organizationId,
        attempt.id,
        succeeded ? 'succeeded' : 'failed',
        errorCode,
        JSON.stringify({
          reconciliationOutcome: input.outcome,
          reconciledBy: input.actorEmail,
        }),
        input.outcome,
        reason,
        input.idempotencyKey,
        input.actorEmail,
      ],
    )
    await recordAuditEvent({
      actor: input.actorEmail,
      eventType: 'carrier.rate_test_label.attempt_reconciled',
      aggregateType: 'operations.carrier_rate_test_label_attempt',
      aggregateId: input.attemptGlobalId,
      eventKey: `carrier:rate-test-label:reconciled:${input.attemptGlobalId}`,
      organizationId: input.organizationId,
      payload: {
        action: attempt.action,
        outcome: input.outcome,
        reason,
      },
    }, client)
    return oneAttempt(input.organizationId, input.attemptGlobalId, client)
  })
}

export async function queueCarrierRateTestLabelPrintInPostgres(input: {
  organizationId: string
  actorEmail: string
  labelGlobalId: string
  warehouseId: string
  preferredPrinterGlobalId: string
  idempotencyKey: string
}) {
  const label = await oneLabel(input.organizationId, input.labelGlobalId)
  return enqueueOperationsPrintJobInPostgres({
    organizationId: input.organizationId,
    actorEmail: input.actorEmail,
    warehouseId: input.warehouseId,
    preferredPrinterGlobalId: input.preferredPrinterGlobalId,
    idempotencyKey: input.idempotencyKey,
    document: {
      type: 'rate_test_label',
      sourceRateTestLabelGlobalId: label.globalId,
      media: label.mediaSize,
    },
  })
}
