import type { PoolClient, QueryResultRow } from 'pg'
import { recordAuditEvent } from '@/lib/auditWriter'
import {
  carrierAccountNumberFingerprint,
  normalizeDirectCarrierProvider,
  unresolvedCarrierBillingAccountFingerprint,
  type CarrierEnvironment,
  type DirectCarrierProvider,
} from '@/lib/integrations/carrierCredentialCrypto'
import {
  CarrierBillingImportError,
  normalizeCarrierBillingCurrency,
  normalizeCarrierBillingEnvironment,
  normalizeCarrierBillingProvider,
  parseCarrierBillingCsv,
  type CarrierBillingAccountFingerprintInput,
  type CarrierBillingHeaderMapping,
  type NormalizedCarrierBillingRow,
  type NormalizedCarrierBillingStatement,
  type RejectedCarrierBillingRow,
} from '@/lib/operations/carrierBillingImport'
import type { CarrierRateNetworkCapabilities } from '@/lib/operations/authorization'
import {
  acquireTransactionAdvisoryLock,
  withTransaction,
} from '@/lib/persistence/postgres'

export const MAX_CARRIER_BILLING_CSV_BYTES = 10 * 1024 * 1024

const IMPORT_SCHEMA_VERSION = 1
const INSERT_CHUNK_SIZE = 500
const RATE_NETWORK_GLOBAL_ID = /^grn\d{7}$/

type CarrierBillingResolutionDecision = 'matched' | 'unmatched' | 'ambiguous'

type NetworkRow = QueryResultRow & {
  id: string
  global_id: string
  name: string
  default_currency: string
  importing_party_role: 'platform_operator' | 'reseller'
}

export type CarrierBillingAccountCandidate = {
  authorizationId: string
  authorizationGlobalId: string
  accountOwnerOrganizationId: string
  accountOwnerOrganizationReference: string
  accountOwnerOrganizationName: string
  integrationAccountId: string
  integrationAccountGlobalId: string
  integrationAccountName: string
  carrierAccountId: string
  carrierAccountGlobalId: string
  carrierAccountName: string
  accountNumberLastFour: string
  accountNumberFingerprint: string
  provider: DirectCarrierProvider
  environment: CarrierEnvironment
}

type CandidateRow = QueryResultRow & {
  authorization_id: string
  authorization_global_id: string
  account_owner_organization_id: string
  account_owner_organization_reference: string
  account_owner_organization_name: string
  integration_account_id: string
  integration_account_global_id: string
  integration_account_name: string
  carrier_account_id: string
  carrier_account_global_id: string
  carrier_account_name: string
  account_number_last_four: string
  account_number_fingerprint: string
  provider: DirectCarrierProvider
  environment: CarrierEnvironment
}

type SafeCandidateSnapshot = {
  authorizationGlobalId: string
  accountOwnerOrganizationReference: string
  accountOwnerOrganizationName: string
  integrationAccountGlobalId: string
  integrationAccountName: string
  carrierAccountGlobalId: string
  carrierAccountName: string
  maskedAccountReference: string
  provider: DirectCarrierProvider
  environment: CarrierEnvironment
}

export type CarrierBillingAccountResolution = {
  decision: CarrierBillingResolutionDecision
  fingerprint: string
  matchedCandidate: CarrierBillingAccountCandidate | null
  candidateSnapshot: SafeCandidateSnapshot[]
}

type StatementInsertRow = QueryResultRow & {
  id: string
  global_id: string
  billed_account_fingerprint: string
  external_statement_id: string
}

type ExistingStatementRow = QueryResultRow & {
  id: string
  version_number: number
}

type BatchRow = QueryResultRow & {
  id: string
  global_id: string
  status: string
  imported_row_count: number
  rejected_row_count: number
  source_checksum: string
  provider: string
  environment: CarrierEnvironment
  statement_count: number
  charge_count: number
  matched_count: number
  unmatched_count: number
  ambiguous_count: number
}

export type CarrierBillingImportResult = {
  duplicate: boolean
  batchGlobalId: string
  networkGlobalId: string
  networkName: string
  provider: DirectCarrierProvider
  environment: CarrierEnvironment
  status: string
  sourceChecksum: string
  importedRowCount: number
  rejectedRowCount: number
  statementCount: number
  chargeCount: number
  accountResolutionCounts: {
    matched: number
    unmatched: number
    ambiguous: number
  }
}

export class CarrierBillingRequestError extends Error {
  readonly code: string
  readonly status: number

  constructor(code: string, message: string, status = 400) {
    super(message)
    this.name = 'CarrierBillingRequestError'
    this.code = code
    this.status = status
  }
}

function requestError(code: string, message: string, status = 400): never {
  throw new CarrierBillingRequestError(code, message, status)
}

function normalizeProvider(value: unknown): DirectCarrierProvider {
  try {
    return normalizeDirectCarrierProvider(normalizeCarrierBillingProvider(value))
  } catch {
    requestError(
      'CARRIER_BILLING_PROVIDER_INVALID',
      'Select a supported carrier billing provider',
    )
  }
}

function normalizeEnvironment(value: unknown): CarrierEnvironment {
  try {
    return normalizeCarrierBillingEnvironment(value)
  } catch {
    requestError(
      'CARRIER_BILLING_ENVIRONMENT_INVALID',
      'Carrier billing environment must be sandbox or production',
    )
  }
}

function normalizeDefaultCurrency(value: unknown): string | undefined {
  if (value === undefined || value === null || String(value).trim() === '') return undefined
  try {
    return normalizeCarrierBillingCurrency(value)
  } catch {
    requestError(
      'CARRIER_BILLING_CURRENCY_INVALID',
      'Carrier billing currency must be a three-letter currency code',
    )
  }
}

function safeCandidate(candidate: CarrierBillingAccountCandidate): SafeCandidateSnapshot {
  return {
    authorizationGlobalId: candidate.authorizationGlobalId,
    accountOwnerOrganizationReference: candidate.accountOwnerOrganizationReference,
    accountOwnerOrganizationName: candidate.accountOwnerOrganizationName,
    integrationAccountGlobalId: candidate.integrationAccountGlobalId,
    integrationAccountName: candidate.integrationAccountName,
    carrierAccountGlobalId: candidate.carrierAccountGlobalId,
    carrierAccountName: candidate.carrierAccountName,
    maskedAccountReference: `****${candidate.accountNumberLastFour}`,
    provider: candidate.provider,
    environment: candidate.environment,
  }
}

export function resolveCarrierBillingAccount(input: {
  networkIdentity: string
  provider: DirectCarrierProvider
  environment: CarrierEnvironment
  rawAccountNumber: string
  candidates: CarrierBillingAccountCandidate[]
}): CarrierBillingAccountResolution {
  const matches = input.candidates.filter((candidate) => (
    carrierAccountNumberFingerprint(
      candidate.accountOwnerOrganizationId,
      input.provider,
      input.environment,
      input.rawAccountNumber,
    ) === candidate.accountNumberFingerprint
  ))
  if (matches.length === 1) {
    return {
      decision: 'matched',
      fingerprint: matches[0].accountNumberFingerprint,
      matchedCandidate: matches[0],
      candidateSnapshot: [safeCandidate(matches[0])],
    }
  }
  return {
    decision: matches.length === 0 ? 'unmatched' : 'ambiguous',
    fingerprint: unresolvedCarrierBillingAccountFingerprint(
      input.networkIdentity,
      input.provider,
      input.environment,
      input.rawAccountNumber,
    ),
    matchedCandidate: null,
    candidateSnapshot: matches.map(safeCandidate),
  }
}

function candidate(row: CandidateRow): CarrierBillingAccountCandidate {
  return {
    authorizationId: row.authorization_id,
    authorizationGlobalId: row.authorization_global_id,
    accountOwnerOrganizationId: row.account_owner_organization_id,
    accountOwnerOrganizationReference: row.account_owner_organization_reference,
    accountOwnerOrganizationName: row.account_owner_organization_name,
    integrationAccountId: row.integration_account_id,
    integrationAccountGlobalId: row.integration_account_global_id,
    integrationAccountName: row.integration_account_name,
    carrierAccountId: row.carrier_account_id,
    carrierAccountGlobalId: row.carrier_account_global_id,
    carrierAccountName: row.carrier_account_name,
    accountNumberLastFour: row.account_number_last_four,
    accountNumberFingerprint: row.account_number_fingerprint,
    provider: row.provider,
    environment: row.environment,
  }
}

async function requireRateNetwork(
  client: PoolClient,
  organizationId: string,
  requestedGlobalId: string | null,
): Promise<NetworkRow> {
  if (requestedGlobalId && !RATE_NETWORK_GLOBAL_ID.test(requestedGlobalId)) {
    requestError(
      'CARRIER_BILLING_NETWORK_INVALID',
      'Carrier rate network is invalid',
    )
  }
  const result = await client.query<NetworkRow>(
    `SELECT network.id::text, network.global_id, network.name,
            network.default_currency, party.role AS importing_party_role
       FROM operations_carrier_rate_networks network
       JOIN operations_carrier_rate_parties party
         ON party.network_id = network.id
        AND party.entity_type = 'workspace_organization'
        AND party.workspace_organization_id = $1::uuid
        AND party.role IN ('platform_operator', 'reseller')
      WHERE network.status = 'active'
        AND ($2::text IS NULL OR network.global_id = $2)
      ORDER BY CASE party.role WHEN 'platform_operator' THEN 0 ELSE 1 END,
               network.created_at, network.id
      LIMIT 2`,
    [organizationId, requestedGlobalId],
  )
  if (result.rows.length === 0) {
    requestError(
      'CARRIER_BILLING_NETWORK_REQUIRED',
      requestedGlobalId
        ? 'The selected active carrier rate network is unavailable'
        : 'Configure an active carrier rate network before importing carrier billing',
      requestedGlobalId ? 404 : 409,
    )
  }
  if (!requestedGlobalId && result.rows.length > 1) {
    requestError(
      'CARRIER_BILLING_NETWORK_SELECTION_REQUIRED',
      'Select the carrier rate network for this billing file',
      409,
    )
  }
  return result.rows[0]
}

async function activeAccountCandidates(
  client: PoolClient,
  networkId: string,
  provider: DirectCarrierProvider,
  environment: CarrierEnvironment,
): Promise<CarrierBillingAccountCandidate[]> {
  const result = await client.query<CandidateRow>(
    `SELECT authorization.id::text AS authorization_id,
            authorization.global_id AS authorization_global_id,
            authorization.account_owner_organization_id::text
              AS account_owner_organization_id,
            owner.reference_code AS account_owner_organization_reference,
            owner.name AS account_owner_organization_name,
            integration.id::text AS integration_account_id,
            integration.global_id AS integration_account_global_id,
            integration.display_name AS integration_account_name,
            carrier_account.id::text AS carrier_account_id,
            carrier_account.global_id AS carrier_account_global_id,
            carrier_account.display_name AS carrier_account_name,
            carrier_account.account_number_last_four,
            carrier_account.account_number_fingerprint,
            integration.provider,
            integration.environment
       FROM operations_carrier_account_authorizations authorization
       JOIN operations_carrier_accounts carrier_account
         ON carrier_account.organization_id =
              authorization.account_owner_organization_id
        AND carrier_account.integration_account_id =
              authorization.integration_account_id
        AND carrier_account.id = authorization.carrier_account_id
       JOIN operations_integration_accounts integration
         ON integration.organization_id = carrier_account.organization_id
        AND integration.id = carrier_account.integration_account_id
       JOIN workspace_organizations owner
         ON owner.id = authorization.account_owner_organization_id
       JOIN operations_carrier_rate_parties owner_party
         ON owner_party.network_id = authorization.network_id
        AND owner_party.entity_type = 'workspace_organization'
        AND owner_party.workspace_organization_id =
              authorization.account_owner_organization_id
        AND owner_party.role IN ('platform_operator', 'reseller')
      WHERE authorization.network_id = $1::uuid
        AND authorization.status = 'active'
        AND authorization.effective_from <= now()
        AND (
          authorization.effective_to IS NULL
          OR authorization.effective_to > now()
        )
        AND authorization.carrier_account_id IS NOT NULL
        AND carrier_account.status = 'active'
        AND integration.status = 'active'
        AND integration.integration_type = 'carrier'
        AND integration.provider = $2
        AND integration.environment = $3
        AND NOT EXISTS (
          SELECT 1
            FROM operations_carrier_account_authorizations child
           WHERE child.network_id = authorization.network_id
             AND child.carrier_account_id = authorization.carrier_account_id
             AND child.supersedes_authorization_id = authorization.id
        )
      ORDER BY authorization.global_id, carrier_account.global_id`,
    [networkId, provider, environment],
  )
  return result.rows.map(candidate)
}

function statementKey(value: {
  billedAccountFingerprint: string
  externalStatementId: string
}) {
  return `${value.billedAccountFingerprint}\0${value.externalStatementId}`
}

async function existingBatch(
  client: PoolClient,
  networkId: string,
  provider: DirectCarrierProvider,
  environment: CarrierEnvironment,
  sourceChecksum: string,
): Promise<BatchRow | null> {
  const result = await client.query<BatchRow>(
    `SELECT batch.id::text, batch.global_id, batch.status,
            batch.imported_row_count, batch.rejected_row_count,
            batch.source_checksum, batch.provider, batch.environment,
            (
              SELECT count(*)::integer
                FROM operations_carrier_billing_statements statement
               WHERE statement.network_id = batch.network_id
                 AND statement.batch_id = batch.id
            ) AS statement_count,
            (
              SELECT count(*)::integer
                FROM operations_carrier_billing_charges charge
                JOIN operations_carrier_billing_statements statement
                  ON statement.network_id = charge.network_id
                 AND statement.id = charge.statement_id
               WHERE statement.network_id = batch.network_id
                 AND statement.batch_id = batch.id
            ) AS charge_count,
            (
              SELECT count(*)::integer
                FROM operations_carrier_billing_account_resolutions resolution
                JOIN operations_carrier_billing_statements statement
                  ON statement.network_id = resolution.network_id
                 AND statement.id = resolution.statement_id
               WHERE statement.network_id = batch.network_id
                 AND statement.batch_id = batch.id
                 AND resolution.decision = 'matched'
            ) AS matched_count,
            (
              SELECT count(*)::integer
                FROM operations_carrier_billing_account_resolutions resolution
                JOIN operations_carrier_billing_statements statement
                  ON statement.network_id = resolution.network_id
                 AND statement.id = resolution.statement_id
               WHERE statement.network_id = batch.network_id
                 AND statement.batch_id = batch.id
                 AND resolution.decision = 'unmatched'
            ) AS unmatched_count,
            (
              SELECT count(*)::integer
                FROM operations_carrier_billing_account_resolutions resolution
                JOIN operations_carrier_billing_statements statement
                  ON statement.network_id = resolution.network_id
                 AND statement.id = resolution.statement_id
               WHERE statement.network_id = batch.network_id
                 AND statement.batch_id = batch.id
                 AND resolution.decision = 'ambiguous'
            ) AS ambiguous_count
       FROM operations_carrier_billing_batches batch
      WHERE batch.network_id = $1::uuid
        AND batch.provider = $2
        AND batch.environment = $3
        AND batch.source_checksum = $4
      LIMIT 1`,
    [networkId, provider, environment, sourceChecksum],
  )
  return result.rows[0] || null
}

function resultFromBatch(
  batch: BatchRow,
  network: NetworkRow,
  duplicate: boolean,
): CarrierBillingImportResult {
  return {
    duplicate,
    batchGlobalId: batch.global_id,
    networkGlobalId: network.global_id,
    networkName: network.name,
    provider: batch.provider as DirectCarrierProvider,
    environment: batch.environment,
    status: batch.status,
    sourceChecksum: batch.source_checksum,
    importedRowCount: Number(batch.imported_row_count),
    rejectedRowCount: Number(batch.rejected_row_count),
    statementCount: Number(batch.statement_count),
    chargeCount: Number(batch.charge_count),
    accountResolutionCounts: {
      matched: Number(batch.matched_count),
      unmatched: Number(batch.unmatched_count),
      ambiguous: Number(batch.ambiguous_count),
    },
  }
}

async function insertStatement(
  client: PoolClient,
  input: {
    networkId: string
    networkGlobalId: string
    batchId: string
    sourceChecksum: string
    statement: NormalizedCarrierBillingStatement
  },
): Promise<StatementInsertRow> {
  const key = statementKey(input.statement)
  await acquireTransactionAdvisoryLock(
    client,
    `carrier-billing-statement:${input.networkGlobalId}:${key}`,
  )
  const prior = await client.query<ExistingStatementRow>(
    `SELECT statement.id::text, statement.version_number
       FROM operations_carrier_billing_statements statement
      WHERE statement.network_id = $1::uuid
        AND statement.billed_account_fingerprint = $2
        AND statement.external_statement_id = $3
      ORDER BY statement.version_number DESC, statement.created_at DESC, statement.id
      LIMIT 1
      FOR UPDATE`,
    [
      input.networkId,
      input.statement.billedAccountFingerprint,
      input.statement.externalStatementId,
    ],
  )
  const previous = prior.rows[0] || null
  const inserted = await client.query<StatementInsertRow>(
    `INSERT INTO operations_carrier_billing_statements (
       network_id, batch_id, external_statement_id,
       billed_account_masked_reference, billed_account_fingerprint,
       version_number, supersedes_statement_id, statement_period_start,
       statement_period_end, issued_at, currency, statement_total_minor,
       finalized, evidence_snapshot
     )
     VALUES (
       $1::uuid, $2::uuid, $3, $4, $5, $6, $7::uuid, $8::date,
       $9::date, $10::timestamptz, $11, $12::bigint, false, $13::jsonb
     )
     RETURNING id::text, global_id, billed_account_fingerprint,
               external_statement_id`,
    [
      input.networkId,
      input.batchId,
      input.statement.externalStatementId,
      input.statement.billedAccountMaskedReference,
      input.statement.billedAccountFingerprint,
      previous ? Number(previous.version_number) + 1 : 1,
      previous?.id || null,
      input.statement.statementPeriodStart,
      input.statement.statementPeriodEnd,
      input.statement.issuedAt,
      input.statement.currency,
      input.statement.statementTotalMinor?.toString() || null,
      JSON.stringify({
        source: 'carrier_billing_csv',
        sourceChecksum: input.sourceChecksum,
        billedAccountMaskedReference: input.statement.billedAccountMaskedReference,
        chargeCount: input.statement.chargeCount,
        importSchemaVersion: IMPORT_SCHEMA_VERSION,
      }),
    ],
  )
  return inserted.rows[0]
}

async function insertAccountResolution(
  client: PoolClient,
  input: {
    networkId: string
    statementId: string
    statement: NormalizedCarrierBillingStatement
    resolution: CarrierBillingAccountResolution
    actorEmail: string
    provider: DirectCarrierProvider
    environment: CarrierEnvironment
  },
) {
  const matched = input.resolution.matchedCandidate
  await client.query(
    `INSERT INTO operations_carrier_billing_account_resolutions (
       network_id, statement_id, decision, account_authorization_id,
       account_owner_organization_id, integration_account_id,
       carrier_account_id, match_method, confidence_basis_points,
       evidence, candidate_snapshot, reason, decided_by,
       provider_snapshot, environment_snapshot,
       account_number_fingerprint_snapshot
     )
     VALUES (
       $1::uuid, $2::uuid, $3, $4::uuid, $5::uuid, $6::uuid,
       $7::uuid, $8, $9, $10::jsonb, $11::jsonb, $12, $13,
       $14, $15, $16
     )`,
    [
      input.networkId,
      input.statementId,
      input.resolution.decision,
      matched?.authorizationId || null,
      matched?.accountOwnerOrganizationId || null,
      matched?.integrationAccountId || null,
      matched?.carrierAccountId || null,
      matched ? 'account_fingerprint' : 'none',
      matched ? 10_000 : 0,
      JSON.stringify({
        source: 'carrier_billing_csv',
        billedAccountMaskedReference: input.statement.billedAccountMaskedReference,
        candidateCount: input.resolution.candidateSnapshot.length,
      }),
      JSON.stringify(input.resolution.candidateSnapshot),
      input.resolution.decision === 'unmatched'
        ? 'No active authorized carrier account matched the billed account'
        : input.resolution.decision === 'ambiguous'
          ? 'More than one active authorized carrier account matched the billed account'
          : null,
      input.actorEmail,
      matched ? input.provider : null,
      matched ? input.environment : null,
      matched?.accountNumberFingerprint || null,
    ],
  )
}

function chunks<T>(values: T[], size: number): T[][] {
  const result: T[][] = []
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size))
  }
  return result
}

async function insertImportedRows(
  client: PoolClient,
  input: {
    networkId: string
    batchId: string
    rows: NormalizedCarrierBillingRow[]
    statementIds: Map<string, string>
  },
) {
  for (const group of chunks(input.rows, INSERT_CHUNK_SIZE)) {
    const records = group.map((row) => {
      const statementId = input.statementIds.get(statementKey(row))
      if (!statementId) {
        requestError(
          'CARRIER_BILLING_STATEMENT_PERSISTENCE_FAILED',
          'Carrier billing statement persistence failed',
          500,
        )
      }
      return {
        statementId,
        rowNumber: row.rowNumber,
        lineNumber: row.lineNumber,
        lineSequence: row.lineSequence,
        externalChargeId: row.externalChargeId,
        billedAccountMaskedReference: row.billedAccountMaskedReference,
        billedAccountFingerprint: row.billedAccountFingerprint,
        trackingNumber: row.trackingNumber,
        providerLabelId: row.providerLabelId,
        packageReference: row.packageReference,
        serviceCode: row.serviceCode,
        chargeCategory: row.chargeCategory,
        description: row.description,
        amountMinor: row.amountMinor.toString(),
        currency: row.currency,
        shipmentDate: row.shipmentDate,
        billedAt: row.billedAt,
        sourceRowHash: row.sourceRowHash,
        routingAttributes: {
          importRowNumber: row.rowNumber,
          importLineNumber: row.lineNumber,
        },
        redactedEvidence: row.redactedEvidence,
      }
    })
    await client.query(
      `WITH source_rows AS (
         SELECT *
           FROM jsonb_to_recordset($3::jsonb) AS source (
             "statementId" uuid,
             "rowNumber" integer,
             "lineNumber" integer,
             "lineSequence" integer,
             "externalChargeId" text,
             "billedAccountMaskedReference" text,
             "billedAccountFingerprint" text,
             "trackingNumber" text,
             "providerLabelId" text,
             "packageReference" text,
             "serviceCode" text,
             "chargeCategory" text,
             "description" text,
             "amountMinor" text,
             "currency" text,
             "shipmentDate" text,
             "billedAt" text,
             "sourceRowHash" text,
             "routingAttributes" jsonb,
             "redactedEvidence" jsonb
           )
       ),
       inserted_charges AS (
         INSERT INTO operations_carrier_billing_charges (
           network_id, statement_id, external_charge_id, source_row_hash,
           tracking_number, provider_label_id, package_reference, service_code,
           charge_category, description, amount_minor, currency, shipment_date,
           billed_at, line_sequence, routing_attributes, raw_evidence
         )
         SELECT $1::uuid, source."statementId", source."externalChargeId",
                source."sourceRowHash", source."trackingNumber",
                source."providerLabelId", source."packageReference",
                source."serviceCode", source."chargeCategory",
                source."description", source."amountMinor"::bigint,
                source."currency", source."shipmentDate"::date,
                source."billedAt"::timestamptz, source."lineSequence",
                source."routingAttributes", source."redactedEvidence"
           FROM source_rows source
         RETURNING id, statement_id, source_row_hash
       )
       INSERT INTO operations_carrier_billing_import_rows (
         network_id, batch_id, row_number, line_number, status,
         billing_statement_id, billing_charge_id,
         billed_account_masked_reference, billed_account_fingerprint,
         source_row_hash, issues, redacted_evidence
       )
       SELECT $1::uuid, $2::uuid, source."rowNumber", source."lineNumber",
              'imported', inserted.statement_id, inserted.id,
              source."billedAccountMaskedReference",
              source."billedAccountFingerprint", source."sourceRowHash",
              '[]'::jsonb, source."redactedEvidence"
         FROM source_rows source
         JOIN inserted_charges inserted
           ON inserted.statement_id = source."statementId"
          AND inserted.source_row_hash = source."sourceRowHash"`,
      [input.networkId, input.batchId, JSON.stringify(records)],
    )
  }
}

async function insertRejectedRows(
  client: PoolClient,
  input: {
    networkId: string
    batchId: string
    rows: RejectedCarrierBillingRow[]
  },
) {
  for (const group of chunks(input.rows, INSERT_CHUNK_SIZE)) {
    const records = group.map((row) => ({
      rowNumber: row.rowNumber,
      lineNumber: row.lineNumber,
      billedAccountMaskedReference: row.billedAccountMaskedReference,
      sourceRowHash: row.sourceRowHash,
      issues: row.issues,
      redactedEvidence: row.redactedEvidence,
    }))
    await client.query(
      `INSERT INTO operations_carrier_billing_import_rows (
         network_id, batch_id, row_number, line_number, status,
         billing_statement_id, billing_charge_id,
         billed_account_masked_reference, billed_account_fingerprint,
         source_row_hash, issues, redacted_evidence
       )
       SELECT $1::uuid, $2::uuid, source."rowNumber", source."lineNumber",
              'rejected', NULL, NULL, source."billedAccountMaskedReference",
              NULL, source."sourceRowHash", source."issues",
              source."redactedEvidence"
         FROM jsonb_to_recordset($3::jsonb) AS source (
           "rowNumber" integer,
           "lineNumber" integer,
           "billedAccountMaskedReference" text,
           "sourceRowHash" text,
           "issues" jsonb,
           "redactedEvidence" jsonb
         )`,
      [input.networkId, input.batchId, JSON.stringify(records)],
    )
  }
}

function normalizeActorEmail(value: unknown): string {
  const email = String(value ?? '').trim().toLowerCase()
  if (!email || email.length > 320 || !email.includes('@')) {
    requestError('CARRIER_BILLING_ACTOR_INVALID', 'Signed user is invalid', 401)
  }
  return email
}

export async function importCarrierBillingCsvInPostgres(input: {
  organizationId: string
  actorEmail: string
  capabilities: CarrierRateNetworkCapabilities
  csv: string | Buffer | Uint8Array
  provider: unknown
  environment: unknown
  networkGlobalId?: string | null
  headerMapping?: CarrierBillingHeaderMapping
  defaultCurrency?: unknown
}): Promise<CarrierBillingImportResult> {
  if (!input.capabilities.canReconcileCarrierBilling) {
    requestError(
      'CARRIER_BILLING_RECONCILE_REQUIRED',
      'You do not have permission to reconcile carrier billing',
      403,
    )
  }
  const organizationId = String(input.organizationId || '').trim()
  if (!organizationId) {
    requestError(
      'ACTIVE_ORGANIZATION_REQUIRED',
      'Select an active organization first',
      409,
    )
  }
  const actorEmail = normalizeActorEmail(input.actorEmail)
  const provider = normalizeProvider(input.provider)
  const environment = normalizeEnvironment(input.environment)
  const networkGlobalId = String(input.networkGlobalId || '').trim() || null
  const requestedCurrency = normalizeDefaultCurrency(input.defaultCurrency)

  try {
    return await withTransaction(async (client) => {
      const network = await requireRateNetwork(client, organizationId, networkGlobalId)
      const candidates = await activeAccountCandidates(
        client,
        network.id,
        provider,
        environment,
      )
      const resolutionByFingerprint = new Map<string, CarrierBillingAccountResolution>()
      const fingerprintAccountNumber = (
        account: Readonly<CarrierBillingAccountFingerprintInput>,
      ) => {
        const resolution = resolveCarrierBillingAccount({
          networkIdentity: network.global_id,
          provider,
          environment,
          rawAccountNumber: account.accountNumber,
          candidates,
        })
        const existing = resolutionByFingerprint.get(resolution.fingerprint)
        if (
          existing
          && (
            existing.decision !== resolution.decision
            || existing.matchedCandidate?.carrierAccountId
              !== resolution.matchedCandidate?.carrierAccountId
          )
        ) {
          requestError(
            'CARRIER_BILLING_ACCOUNT_RESOLUTION_CONFLICT',
            'Carrier billing account resolution was not deterministic',
            409,
          )
        }
        resolutionByFingerprint.set(resolution.fingerprint, resolution)
        return resolution.fingerprint
      }
      const parsed = parseCarrierBillingCsv(input.csv, {
        provider,
        environment,
        headerMapping: input.headerMapping,
        defaultCurrency: requestedCurrency || network.default_currency,
        maxBytes: MAX_CARRIER_BILLING_CSV_BYTES,
        failOnRejectedRows: false,
        fingerprintAccountNumber,
      })
      const sourceFilename =
        `carrier-billing-${parsed.sourceChecksum.slice(0, 12)}.csv`

      await acquireTransactionAdvisoryLock(
        client,
        `carrier-billing-import:${network.global_id}:${provider}:${environment}:${parsed.sourceChecksum}`,
      )
      const duplicate = await existingBatch(
        client,
        network.id,
        provider,
        environment,
        parsed.sourceChecksum,
      )
      if (duplicate) return resultFromBatch(duplicate, network, true)

      const batchInsert = await client.query<QueryResultRow & {
        id: string
        global_id: string
      }>(
        `INSERT INTO operations_carrier_billing_batches (
           network_id, importing_organization_id, provider, environment,
           source_format, source_filename, source_checksum, status,
           imported_row_count, rejected_row_count, imported_by,
           source_byte_length, header_mapping, import_schema_version
         )
         VALUES (
           $1::uuid, $2::uuid, $3, $4, 'csv', $5, $6, 'processing',
           0, 0, $7, $8::bigint, $9::jsonb, $10
         )
         RETURNING id::text, global_id`,
        [
          network.id,
          organizationId,
          provider,
          environment,
          sourceFilename,
          parsed.sourceChecksum,
          actorEmail,
          parsed.sourceByteLength,
          JSON.stringify(parsed.resolvedHeaders),
          IMPORT_SCHEMA_VERSION,
        ],
      )
      const batch = batchInsert.rows[0]
      const statementIds = new Map<string, string>()
      const sortedStatements = [...parsed.statements].sort((left, right) => (
        statementKey(left).localeCompare(statementKey(right))
      ))
      const resolutionCounts = { matched: 0, unmatched: 0, ambiguous: 0 }
      for (const statement of sortedStatements) {
        const inserted = await insertStatement(client, {
          networkId: network.id,
          networkGlobalId: network.global_id,
          batchId: batch.id,
          sourceChecksum: parsed.sourceChecksum,
          statement,
        })
        statementIds.set(statementKey(statement), inserted.id)
        const resolution = resolutionByFingerprint.get(statement.billedAccountFingerprint)
        if (!resolution) {
          requestError(
            'CARRIER_BILLING_ACCOUNT_RESOLUTION_MISSING',
            'Carrier billing account resolution is unavailable',
            500,
          )
        }
        await insertAccountResolution(client, {
          networkId: network.id,
          statementId: inserted.id,
          statement,
          resolution,
          actorEmail,
          provider,
          environment,
        })
        resolutionCounts[resolution.decision] += 1
      }

      await insertImportedRows(client, {
        networkId: network.id,
        batchId: batch.id,
        rows: parsed.rows,
        statementIds,
      })
      await insertRejectedRows(client, {
        networkId: network.id,
        batchId: batch.id,
        rows: parsed.rejectedRows,
      })
      await client.query(
        `UPDATE operations_carrier_billing_batches
            SET status = 'completed',
                imported_row_count = $3,
                rejected_row_count = $4,
                completed_at = now(),
                updated_at = now()
          WHERE network_id = $1::uuid
            AND id = $2::uuid`,
        [
          network.id,
          batch.id,
          parsed.importedRowCount,
          parsed.rejectedRowCount,
        ],
      )
      await recordAuditEvent({
        actor: actorEmail,
        eventType: 'carrier.billing.imported',
        aggregateType: 'operations_carrier_billing_batches',
        aggregateId: batch.global_id,
        eventKey: [
          'carrier-billing-import',
          network.global_id,
          provider,
          environment,
          parsed.sourceChecksum,
        ].join(':'),
        organizationId,
        payload: {
          networkGlobalId: network.global_id,
          provider,
          environment,
          importedRowCount: parsed.importedRowCount,
          rejectedRowCount: parsed.rejectedRowCount,
          statementCount: parsed.statements.length,
          accountResolutionCounts: resolutionCounts,
          sourceChecksum: parsed.sourceChecksum,
        },
      }, client)

      return {
        duplicate: false,
        batchGlobalId: batch.global_id,
        networkGlobalId: network.global_id,
        networkName: network.name,
        provider,
        environment,
        status: 'completed',
        sourceChecksum: parsed.sourceChecksum,
        importedRowCount: parsed.importedRowCount,
        rejectedRowCount: parsed.rejectedRowCount,
        statementCount: parsed.statements.length,
        chargeCount: parsed.rows.length,
        accountResolutionCounts: resolutionCounts,
      }
    })
  } catch (error) {
    if (
      error instanceof CarrierBillingRequestError
      || error instanceof CarrierBillingImportError
    ) {
      throw error
    }
    throw new CarrierBillingRequestError(
      'CARRIER_BILLING_IMPORT_FAILED',
      'Carrier billing import failed',
      500,
    )
  }
}
