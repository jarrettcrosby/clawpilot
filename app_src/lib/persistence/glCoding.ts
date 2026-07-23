import type { PoolClient, QueryResult, QueryResultRow } from 'pg'
import { recordAuditEvent } from '@/lib/auditWriter'
import {
  glCodingChecksum,
  normalizeCarrierTrackingNumber,
  selectGlCodingRule,
  validateGlCodingConditions,
  type GlCodingChargeFacts,
  type GlCodingRuleConditions,
  type GlCodingRuleSnapshot,
} from '@/lib/operations/glCoding'
import type { CarrierRateNetworkCapabilities } from '@/lib/operations/authorization'
import {
  acquireTransactionAdvisoryLock,
  query,
  withTransaction,
} from '@/lib/persistence/postgres'

type SqlExecutor = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<T>>
}

type NetworkRow = QueryResultRow & {
  id: string
  global_id: string
  name: string
  platform_organization_id: string
  default_currency: string
}

type BatchRow = QueryResultRow & {
  id: string
  global_id: string
  provider: string
  environment: 'sandbox' | 'production'
  source_format: string
  source_filename: string
  source_checksum: string
  status: string
  imported_row_count: number
  rejected_row_count: number
  charge_count: string
  received_at: Date
  completed_at: Date | null
}

type RuleRow = QueryResultRow & {
  id: string
  global_id: string
  name: string
  priority: number
  match_mode: 'all' | 'any'
  conditions: unknown
  outputs: unknown
  target_shipper_party_id: string
  target_shipper_party_global_id: string
  target_shipper_name: string
  version_number: number
  status: string
  effective_from: Date
  effective_to: Date | null
  created_at: Date
}

type ChargeRow = QueryResultRow & {
  id: string
  global_id: string
  statement_id: string
  batch_id: string
  batch_global_id: string
  provider: string
  environment: 'sandbox' | 'production'
  source_filename: string
  billed_account_masked_reference: string
  billed_account_fingerprint: string
  external_charge_id: string
  tracking_number: string | null
  provider_label_id: string | null
  package_reference: string | null
  service_code: string | null
  charge_category: string
  description: string | null
  amount_minor: string
  currency: string
  shipment_date: string | null
  billed_at: Date | null
  sender_address_fingerprint: string | null
  recipient_address_fingerprint: string | null
  routing_attributes: unknown
  raw_evidence: unknown
  current_match_id: string | null
  current_match_global_id: string | null
  current_match_decision: 'matched' | 'unmatched' | 'ambiguous' | 'rejected' | null
  current_match_shipment_id: string | null
  current_match_candidate_snapshot: unknown
  current_assignment_id: string | null
  current_assignment_global_id: string | null
  current_assignment_decision: 'assigned' | 'unassigned' | 'ambiguous' | 'excluded' | null
  current_shipper_party_id: string | null
  current_assignment_source: 'shipment_match' | 'manual' | 'routing_rule' | 'none' | null
  current_assignment_match_id: string | null
  current_assignment_rule_id: string | null
  current_assignment_rule_version: number | null
  current_assignment_outputs: unknown
}

type ShipmentCandidateRow = QueryResultRow & {
  id: string
  global_id: string
  organization_id: string
  package_id: string
  label_id: string
  tracking_number: string
  order_global_id: string
  order_number: string
  customer_global_id: string
  customer_name: string
  crm_shipper_party_id: string | null
  crm_shipper_party_global_id: string | null
  workspace_shipper_party_id: string | null
  workspace_shipper_party_global_id: string | null
}

type DecisionRow = QueryResultRow & {
  id: string
  global_id: string
}

type ExistingRunRow = QueryResultRow & {
  id: string
  global_id: string
  input_checksum: string
  selection_snapshot: unknown
  status: string
  selected_batch_count: number
  selected_charge_count: number
  shipment_matched_count: number
  shipper_assigned_count: number
  orphan_count: number
  excluded_count: number
  error_count: number
  summary: unknown
}

export class GlCodingRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message)
  }
}

function requestError(code: string, message: string, status = 400): never {
  throw new GlCodingRequestError(code, message, status)
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return glCodingChecksum(left) === glCodingChecksum(right)
}

function iso(value: Date | string | null): string | null {
  if (!value) return null
  return new Date(value).toISOString()
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Unknown GL Coding error'
  return message.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 500)
}

function runResult(row: ExistingRunRow, duplicate = false) {
  return {
    globalId: row.global_id,
    status: row.status,
    selectedBatchCount: Number(row.selected_batch_count),
    selectedChargeCount: Number(row.selected_charge_count),
    shipmentMatchedCount: Number(row.shipment_matched_count),
    shipperAssignedCount: Number(row.shipper_assigned_count),
    orphanCount: Number(row.orphan_count),
    excludedCount: Number(row.excluded_count),
    errorCount: Number(row.error_count),
    summary: objectValue(row.summary),
    duplicate,
  }
}

async function findNetwork(
  executor: SqlExecutor,
  organizationId: string,
): Promise<NetworkRow | null> {
  const result = await executor.query<NetworkRow>(
    `SELECT network.id::text, network.global_id, network.name,
            network.platform_organization_id::text, network.default_currency
       FROM operations_carrier_rate_networks network
      WHERE network.status = 'active'
        AND (
          network.platform_organization_id = $1::uuid
          OR EXISTS (
            SELECT 1
              FROM operations_carrier_rate_parties party
             WHERE party.network_id = network.id
               AND party.workspace_organization_id = $1::uuid
               AND party.role = 'platform_operator'
          )
        )
      ORDER BY (network.platform_organization_id = $1::uuid) DESC,
               network.created_at, network.id
      LIMIT 1`,
    [organizationId],
  )
  return result.rows[0] || null
}

async function requireNetwork(
  executor: SqlExecutor,
  organizationId: string,
): Promise<NetworkRow> {
  const network = await findNetwork(executor, organizationId)
  if (!network) {
    requestError(
      'GL_CODING_NETWORK_REQUIRED',
      'Configure a carrier rate network before running GL Coding',
      409,
    )
  }
  return network
}

async function readRules(
  executor: SqlExecutor,
  networkId: string,
): Promise<GlCodingRuleSnapshot[]> {
  const result = await executor.query<RuleRow>(
    `SELECT latest.id::text, latest.global_id, latest.name, latest.priority,
            latest.match_mode, latest.conditions, latest.outputs,
            latest.target_shipper_party_id::text,
            party.global_id AS target_shipper_party_global_id,
            party.display_name AS target_shipper_name,
            latest.version_number, latest.status, latest.effective_from,
            latest.effective_to, latest.created_at
       FROM (
         SELECT DISTINCT ON (lower(btrim(rule.name)) COLLATE "C") rule.*
           FROM operations_carrier_billing_routing_rules rule
          WHERE rule.network_id = $1::uuid
            AND rule.status = 'active'
            AND rule.effective_from <= now()
            AND (rule.effective_to IS NULL OR rule.effective_to > now())
          ORDER BY lower(btrim(rule.name)) COLLATE "C",
                   rule.version_number DESC, rule.created_at DESC
       ) latest
       JOIN operations_carrier_rate_parties party
         ON party.network_id = latest.network_id
        AND party.id = latest.target_shipper_party_id
      ORDER BY latest.priority, lower(latest.name) COLLATE "C",
               latest.version_number DESC`,
    [networkId],
  )
  return result.rows.map((row) => ({
    id: row.id,
    globalId: row.global_id,
    name: row.name,
    priority: Number(row.priority),
    matchMode: row.match_mode,
    conditions: validateGlCodingConditions(row.conditions),
    outputs: objectValue(row.outputs),
    targetShipperPartyId: row.target_shipper_party_id,
    targetShipperPartyGlobalId: row.target_shipper_party_global_id,
    targetShipperName: row.target_shipper_name,
    versionNumber: Number(row.version_number),
  }))
}

function chargeFacts(row: ChargeRow): GlCodingChargeFacts {
  const amountMinor = safeMinorUnits(row.amount_minor)
  return {
    provider: row.provider,
    environment: row.environment,
    billedAccountFingerprint: row.billed_account_fingerprint,
    trackingNumber: row.tracking_number,
    providerLabelId: row.provider_label_id,
    packageReference: row.package_reference,
    serviceCode: row.service_code,
    chargeCategory: row.charge_category,
    description: row.description,
    amountMinor,
    currency: row.currency,
    shipmentDate: row.shipment_date,
    senderAddressFingerprint: row.sender_address_fingerprint,
    recipientAddressFingerprint: row.recipient_address_fingerprint,
    routingAttributes: objectValue(row.routing_attributes),
  }
}

function safeMinorUnits(value: string): string {
  const amountMinor = String(value || '').trim()
  if (!/^-?\d+$/.test(amountMinor)) {
    requestError('GL_CODING_AMOUNT_INVALID', 'Carrier charge amount is invalid')
  }
  try {
    return BigInt(amountMinor).toString()
  } catch {
    requestError('GL_CODING_AMOUNT_INVALID', 'Carrier charge amount is invalid')
  }
}

async function readChargesForBatches(
  executor: SqlExecutor,
  networkId: string,
  batchIds: string[],
): Promise<ChargeRow[]> {
  const result = await executor.query<ChargeRow>(
    `SELECT charge.id::text, charge.global_id, charge.statement_id::text,
            statement.batch_id::text, batch.global_id AS batch_global_id,
            batch.provider, batch.environment, batch.source_filename,
            statement.billed_account_masked_reference,
            statement.billed_account_fingerprint,
            charge.external_charge_id, charge.tracking_number,
            charge.provider_label_id, charge.package_reference,
            charge.service_code, charge.charge_category, charge.description,
            charge.amount_minor::text, charge.currency,
            charge.shipment_date::text, charge.billed_at,
            charge.sender_address_fingerprint,
            charge.recipient_address_fingerprint,
            charge.routing_attributes, charge.raw_evidence,
            current_match.id::text AS current_match_id,
            current_match.global_id AS current_match_global_id,
            current_match.decision AS current_match_decision,
            current_match.shipment_id::text AS current_match_shipment_id,
            current_match.candidate_snapshot AS current_match_candidate_snapshot,
            current_assignment.id::text AS current_assignment_id,
            current_assignment.global_id AS current_assignment_global_id,
            current_assignment.decision AS current_assignment_decision,
            current_assignment.shipper_party_id::text AS current_shipper_party_id,
            current_assignment.assignment_source AS current_assignment_source,
            current_assignment.billing_match_id::text AS current_assignment_match_id,
            current_assignment.routing_rule_id::text AS current_assignment_rule_id,
            current_assignment.routing_rule_version AS current_assignment_rule_version,
            current_assignment.coding_outputs AS current_assignment_outputs
       FROM operations_carrier_billing_charges charge
       JOIN operations_carrier_billing_statements statement
         ON statement.network_id = charge.network_id
        AND statement.id = charge.statement_id
       JOIN operations_carrier_billing_batches batch
         ON batch.network_id = statement.network_id
        AND batch.id = statement.batch_id
       LEFT JOIN operations_carrier_billing_current_matches current_match
         ON current_match.network_id = charge.network_id
        AND current_match.charge_id = charge.id
       LEFT JOIN operations_carrier_billing_current_shipper_assignments current_assignment
         ON current_assignment.network_id = charge.network_id
        AND current_assignment.charge_id = charge.id
      WHERE charge.network_id = $1::uuid
        AND statement.batch_id = ANY($2::uuid[])
      ORDER BY batch.received_at, statement.id, charge.line_sequence, charge.id`,
    [networkId, batchIds],
  )
  return result.rows
}

async function readShipmentCandidates(
  executor: SqlExecutor,
  networkId: string,
  provider: string,
  trackingNumbers: string[],
): Promise<Map<string, ShipmentCandidateRow[]>> {
  const candidates = new Map<string, ShipmentCandidateRow[]>()
  if (trackingNumbers.length === 0) return candidates
  const result = await executor.query<ShipmentCandidateRow>(
    `SELECT shipment.id::text, shipment.global_id,
            shipment.organization_id::text, shipment.package_id::text,
            shipment.label_id::text, shipment.tracking_number,
            orders.global_id AS order_global_id, orders.order_number,
            customer.reference_code AS customer_global_id,
            customer.name AS customer_name,
            crm_party.id::text AS crm_shipper_party_id,
            crm_party.global_id AS crm_shipper_party_global_id,
            workspace_party.id::text AS workspace_shipper_party_id,
            workspace_party.global_id AS workspace_shipper_party_global_id
       FROM operations_shipments shipment
       JOIN operations_labels label
         ON label.organization_id = shipment.organization_id
        AND label.id = shipment.label_id
       JOIN operations_orders orders
         ON orders.organization_id = shipment.organization_id
        AND orders.id = shipment.order_id
       JOIN crm_organizations customer
         ON customer.pipeline_id = orders.pipeline_id
        AND customer.id = orders.customer_id
       LEFT JOIN operations_carrier_rate_parties crm_party
         ON crm_party.network_id = $1::uuid
        AND crm_party.role = 'shipper'
        AND crm_party.entity_type = 'crm_customer'
        AND crm_party.crm_pipeline_id = orders.pipeline_id
        AND crm_party.crm_customer_id = orders.customer_id
       LEFT JOIN operations_carrier_rate_parties workspace_party
         ON workspace_party.network_id = $1::uuid
        AND workspace_party.role = 'shipper'
        AND workspace_party.entity_type = 'workspace_organization'
        AND workspace_party.workspace_organization_id = shipment.organization_id
      WHERE lower(label.carrier) = lower($2)
        AND regexp_replace(upper(shipment.tracking_number), '[^A-Z0-9]', '', 'g')
            = ANY($3::text[])
        AND EXISTS (
          SELECT 1
            FROM operations_carrier_rate_parties network_party
           WHERE network_party.network_id = $1::uuid
             AND network_party.workspace_organization_id = shipment.organization_id
        )
      ORDER BY shipment.shipped_at DESC, shipment.id`,
    [networkId, provider, trackingNumbers],
  )
  for (const row of result.rows) {
    const key = normalizeCarrierTrackingNumber(row.tracking_number)
    const group = candidates.get(key) || []
    group.push(row)
    candidates.set(key, group)
  }
  return candidates
}

function candidateSnapshot(candidates: ShipmentCandidateRow[]) {
  return candidates.map((candidate) => ({
    shipmentGlobalId: candidate.global_id,
    orderGlobalId: candidate.order_global_id,
    orderNumber: candidate.order_number,
    customerGlobalId: candidate.customer_global_id,
    customerName: candidate.customer_name,
  }))
}

async function persistShipmentMatch(
  client: PoolClient,
  input: {
    networkId: string
    charge: ChargeRow
    candidates: ShipmentCandidateRow[]
    actorEmail: string
  },
): Promise<{
  id: string
  globalId: string
  decision: 'matched' | 'unmatched' | 'ambiguous'
  candidate: ShipmentCandidateRow | null
  reused: boolean
}> {
  const decision = input.candidates.length === 1
    ? 'matched'
    : input.candidates.length > 1 ? 'ambiguous' : 'unmatched'
  const candidate = decision === 'matched' ? input.candidates[0] : null
  const snapshot = candidateSnapshot(input.candidates)
  const currentEquivalent = input.charge.current_match_id
    && input.charge.current_match_decision === decision
    && input.charge.current_match_shipment_id === (candidate?.id || null)
    && jsonEqual(input.charge.current_match_candidate_snapshot, snapshot)
  if (currentEquivalent) {
    return {
      id: input.charge.current_match_id!,
      globalId: input.charge.current_match_global_id!,
      decision,
      candidate,
      reused: true,
    }
  }

  const result = await client.query<DecisionRow>(
    `INSERT INTO operations_carrier_billing_matches (
       network_id, charge_id, decision, executing_organization_id,
       shipment_id, package_id, label_id, supersedes_match_id,
       match_method, confidence_basis_points, evidence,
       candidate_snapshot, reason, decided_by
     ) VALUES (
       $1::uuid, $2::uuid, $3, $4::uuid, $5::uuid, $6::uuid, $7::uuid,
       $8::uuid, $9, $10, $11::jsonb, $12::jsonb, $13, $14
     )
     RETURNING id::text, global_id`,
    [
      input.networkId,
      input.charge.id,
      decision,
      candidate?.organization_id || null,
      candidate?.id || null,
      candidate?.package_id || null,
      candidate?.label_id || null,
      input.charge.current_match_id,
      candidate ? 'tracking_number' : 'none',
      candidate ? 10_000 : 0,
      JSON.stringify({
        source: 'gl_coding',
        normalizedTrackingNumber: normalizeCarrierTrackingNumber(input.charge.tracking_number),
      }),
      JSON.stringify(snapshot),
      candidate
        ? 'Unique carrier and tracking-number match'
        : decision === 'ambiguous'
          ? 'Several shipments share the carrier and tracking number'
          : 'No shipment matched the carrier and tracking number',
      input.actorEmail,
    ],
  )
  return {
    id: result.rows[0].id,
    globalId: result.rows[0].global_id,
    decision,
    candidate,
    reused: false,
  }
}

function currentAssignmentEquivalent(
  charge: ChargeRow,
  expected: {
    decision: 'assigned' | 'unassigned' | 'ambiguous' | 'excluded'
    shipperPartyId: string | null
    source: 'shipment_match' | 'manual' | 'routing_rule' | 'none'
    billingMatchId: string | null
    ruleId: string | null
    ruleVersion: number | null
    outputs: Record<string, unknown>
  },
): boolean {
  return Boolean(
    charge.current_assignment_id
    && charge.current_assignment_decision === expected.decision
    && charge.current_shipper_party_id === expected.shipperPartyId
    && charge.current_assignment_source === expected.source
    && charge.current_assignment_match_id === expected.billingMatchId
    && charge.current_assignment_rule_id === expected.ruleId
    && Number(charge.current_assignment_rule_version || 0) === Number(expected.ruleVersion || 0)
    && jsonEqual(charge.current_assignment_outputs, expected.outputs),
  )
}

async function persistShipperAssignment(
  client: PoolClient,
  input: {
    networkId: string
    runId: string
    charge: ChargeRow
    match: {
      id: string
      decision: 'matched' | 'unmatched' | 'ambiguous'
      candidate: ShipmentCandidateRow | null
    }
    rules: GlCodingRuleSnapshot[]
    actorEmail: string
  },
): Promise<{
  id: string
  globalId: string
  decision: 'assigned' | 'unassigned' | 'ambiguous' | 'excluded'
  source: 'shipment_match' | 'manual' | 'routing_rule' | 'none'
  shipperPartyId: string | null
  rule: GlCodingRuleSnapshot | null
  codingOutputs: Record<string, unknown>
  explanation: string
  evidence: Record<string, unknown>
  reused: boolean
}> {
  if (
    input.charge.current_assignment_decision === 'assigned'
    && input.charge.current_assignment_source === 'manual'
    && input.charge.current_assignment_id
  ) {
    return {
      id: input.charge.current_assignment_id,
      globalId: input.charge.current_assignment_global_id!,
      decision: 'assigned',
      source: 'manual',
      shipperPartyId: input.charge.current_shipper_party_id,
      rule: null,
      codingOutputs: objectValue(input.charge.current_assignment_outputs),
      explanation: 'Retained the operator-approved manual shipper assignment',
      evidence: { source: 'manual_override', retained: true },
      reused: true,
    }
  }

  const candidate = input.match.candidate
  const shipmentShipperPartyId = candidate?.crm_shipper_party_id
    || candidate?.workspace_shipper_party_id
    || null
  const ruleSelection = shipmentShipperPartyId
    ? { rule: null, evaluation: null }
    : selectGlCodingRule(input.rules, chargeFacts(input.charge))
  const decision = shipmentShipperPartyId || ruleSelection.rule ? 'assigned' : 'unassigned'
  const source = shipmentShipperPartyId
    ? 'shipment_match'
    : ruleSelection.rule ? 'routing_rule' : 'none'
  const shipperPartyId = shipmentShipperPartyId
    || ruleSelection.rule?.targetShipperPartyId
    || null
  const codingOutputs = ruleSelection.rule?.outputs || {}
  const expected = {
    decision,
    shipperPartyId,
    source,
    billingMatchId: source === 'shipment_match' ? input.match.id : null,
    ruleId: ruleSelection.rule?.id || null,
    ruleVersion: ruleSelection.rule?.versionNumber || null,
    outputs: codingOutputs,
  } as const
  const evidence = source === 'shipment_match'
    ? {
        source,
        shipmentGlobalId: candidate?.global_id,
        customerGlobalId: candidate?.customer_global_id,
        partySource: candidate?.crm_shipper_party_id ? 'crm_customer' : 'workspace_organization',
      }
    : source === 'routing_rule'
      ? {
          source,
          ruleGlobalId: ruleSelection.rule?.globalId,
          ruleVersion: ruleSelection.rule?.versionNumber,
          clauseResults: ruleSelection.evaluation?.clauseResults || [],
        }
      : {
          source,
          reason: input.match.decision === 'ambiguous'
            ? 'Shipment match is ambiguous and no routing rule matched'
            : 'No shipment-derived shipper or routing rule matched',
        }
  const explanation = source === 'shipment_match'
    ? `Assigned from shipment customer ${candidate?.customer_global_id || ''}`.trim()
    : source === 'routing_rule'
      ? `Assigned by ${ruleSelection.rule?.name} v${ruleSelection.rule?.versionNumber}`
      : 'Requires a manual shipper assignment'

  if (currentAssignmentEquivalent(input.charge, expected)) {
    return {
      id: input.charge.current_assignment_id!,
      globalId: input.charge.current_assignment_global_id!,
      decision,
      source,
      shipperPartyId,
      rule: ruleSelection.rule,
      codingOutputs,
      explanation,
      evidence,
      reused: true,
    }
  }

  const result = await client.query<DecisionRow>(
    `INSERT INTO operations_carrier_billing_shipper_assignments (
       network_id, charge_id, decision, shipper_party_id, assignment_source,
       billing_match_id, routing_rule_id, routing_rule_version,
       supersedes_assignment_id, evidence, candidate_snapshot, reason,
       decided_by, gl_coding_run_id, coding_outputs
     ) VALUES (
       $1::uuid, $2::uuid, $3, $4::uuid, $5, $6::uuid, $7::uuid, $8,
       $9::uuid, $10::jsonb, $11::jsonb, $12, $13, $14::uuid, $15::jsonb
     )
     RETURNING id::text, global_id`,
    [
      input.networkId,
      input.charge.id,
      decision,
      shipperPartyId,
      source,
      source === 'shipment_match' ? input.match.id : null,
      ruleSelection.rule?.id || null,
      ruleSelection.rule?.versionNumber || null,
      input.charge.current_assignment_id,
      JSON.stringify(evidence),
      JSON.stringify([]),
      explanation,
      input.actorEmail,
      input.runId,
      JSON.stringify(codingOutputs),
    ],
  )
  return {
    id: result.rows[0].id,
    globalId: result.rows[0].global_id,
    decision,
    source,
    shipperPartyId,
    rule: ruleSelection.rule,
    codingOutputs,
    explanation,
    evidence,
    reused: false,
  }
}

async function existingRun(
  executor: SqlExecutor,
  networkId: string,
  idempotencyKey: string,
): Promise<ExistingRunRow | null> {
  const result = await executor.query<ExistingRunRow>(
    `SELECT id::text, global_id, input_checksum, selection_snapshot, status,
            selected_batch_count, selected_charge_count,
            shipment_matched_count, shipper_assigned_count,
            orphan_count, excluded_count, error_count, summary
       FROM operations_gl_coding_runs
      WHERE network_id = $1::uuid AND idempotency_key = $2
      LIMIT 1`,
    [networkId, idempotencyKey],
  )
  return result.rows[0] || null
}

export async function readGlCodingWorkspaceFromPostgres(input: {
  organizationId: string
  capabilities: CarrierRateNetworkCapabilities
}) {
  const network = await findNetwork({ query }, input.organizationId)
  if (!network) {
    return {
      capabilities: input.capabilities,
      network: null,
      batches: [],
      runs: [],
      orphans: [],
      rules: [],
      shippers: [],
    }
  }

  const batches = await query<BatchRow>(
    `SELECT batch.id::text, batch.global_id, batch.provider, batch.environment,
            batch.source_format, batch.source_filename, batch.source_checksum,
            batch.status, batch.imported_row_count, batch.rejected_row_count,
            count(charge.id)::text AS charge_count,
            batch.received_at, batch.completed_at
       FROM operations_carrier_billing_batches batch
       LEFT JOIN operations_carrier_billing_statements statement
         ON statement.network_id = batch.network_id
        AND statement.batch_id = batch.id
       LEFT JOIN operations_carrier_billing_charges charge
         ON charge.network_id = statement.network_id
        AND charge.statement_id = statement.id
      WHERE batch.network_id = $1::uuid
      GROUP BY batch.id
      ORDER BY batch.received_at DESC, batch.id DESC
      LIMIT 100`,
    [network.id],
  )
  const runs = await query<QueryResultRow & {
    global_id: string
    status: string
    selected_batch_count: number
    selected_charge_count: number
    shipment_matched_count: number
    shipper_assigned_count: number
    orphan_count: number
    excluded_count: number
    error_count: number
    requested_by: string | null
    requested_at: Date
    completed_at: Date | null
  }>(
    `SELECT global_id, status, selected_batch_count, selected_charge_count,
            shipment_matched_count, shipper_assigned_count, orphan_count,
            excluded_count, error_count, requested_by, requested_at, completed_at
       FROM operations_gl_coding_runs
      WHERE network_id = $1::uuid
      ORDER BY requested_at DESC, id DESC
      LIMIT 50`,
    [network.id],
  )
  const orphans = await query<ChargeRow & {
    current_shipper_name: string | null
    latest_explanation: string | null
  }>(
    `SELECT charge.id::text, charge.global_id, charge.statement_id::text,
            statement.batch_id::text, batch.global_id AS batch_global_id,
            batch.provider, batch.environment, batch.source_filename,
            statement.billed_account_masked_reference,
            statement.billed_account_fingerprint,
            charge.external_charge_id, charge.tracking_number,
            charge.provider_label_id, charge.package_reference,
            charge.service_code, charge.charge_category, charge.description,
            charge.amount_minor::text, charge.currency,
            charge.shipment_date::text, charge.billed_at,
            charge.sender_address_fingerprint,
            charge.recipient_address_fingerprint,
            charge.routing_attributes, charge.raw_evidence,
            current_match.id::text AS current_match_id,
            current_match.global_id AS current_match_global_id,
            current_match.decision AS current_match_decision,
            current_match.shipment_id::text AS current_match_shipment_id,
            current_match.candidate_snapshot AS current_match_candidate_snapshot,
            current_assignment.id::text AS current_assignment_id,
            current_assignment.global_id AS current_assignment_global_id,
            current_assignment.decision AS current_assignment_decision,
            current_assignment.shipper_party_id::text AS current_shipper_party_id,
            current_assignment.assignment_source AS current_assignment_source,
            current_assignment.billing_match_id::text AS current_assignment_match_id,
            current_assignment.routing_rule_id::text AS current_assignment_rule_id,
            current_assignment.routing_rule_version AS current_assignment_rule_version,
            current_assignment.coding_outputs AS current_assignment_outputs,
            shipper.display_name AS current_shipper_name,
            latest_item.explanation AS latest_explanation
       FROM operations_carrier_billing_charges charge
       JOIN operations_carrier_billing_statements statement
         ON statement.network_id = charge.network_id
        AND statement.id = charge.statement_id
       JOIN operations_carrier_billing_batches batch
         ON batch.network_id = statement.network_id
        AND batch.id = statement.batch_id
       LEFT JOIN operations_carrier_billing_current_matches current_match
         ON current_match.network_id = charge.network_id
        AND current_match.charge_id = charge.id
       LEFT JOIN operations_carrier_billing_current_shipper_assignments current_assignment
         ON current_assignment.network_id = charge.network_id
        AND current_assignment.charge_id = charge.id
       LEFT JOIN operations_carrier_rate_parties shipper
         ON shipper.network_id = current_assignment.network_id
        AND shipper.id = current_assignment.shipper_party_id
       LEFT JOIN LATERAL (
         SELECT item.explanation
           FROM operations_gl_coding_run_items item
          WHERE item.network_id = charge.network_id
            AND item.charge_id = charge.id
          ORDER BY item.created_at DESC, item.id DESC
          LIMIT 1
       ) latest_item ON true
      WHERE charge.network_id = $1::uuid
        AND (
          current_assignment.id IS NULL
          OR current_assignment.decision IN ('unassigned', 'ambiguous')
        )
      ORDER BY COALESCE(charge.billed_at, batch.received_at) DESC, charge.id
      LIMIT 500`,
    [network.id],
  )
  const rules = await readRules({ query }, network.id)
  const shippers = await query<QueryResultRow & {
    global_id: string
    display_name: string
    entity_type: string
    workspace_organization_id: string | null
    crm_customer_global_id: string | null
  }>(
    `SELECT party.global_id, party.display_name, party.entity_type,
            party.workspace_organization_id::text,
            customer.reference_code AS crm_customer_global_id
       FROM operations_carrier_rate_parties party
       LEFT JOIN crm_organizations customer
         ON customer.pipeline_id = party.crm_pipeline_id
        AND customer.id = party.crm_customer_id
      WHERE party.network_id = $1::uuid
        AND party.role = 'shipper'
      ORDER BY lower(party.display_name), party.global_id`,
    [network.id],
  )

  return {
    capabilities: input.capabilities,
    network: {
      globalId: network.global_id,
      name: network.name,
      defaultCurrency: network.default_currency,
    },
    batches: batches.rows.map((row) => ({
      globalId: row.global_id,
      provider: row.provider,
      environment: row.environment,
      sourceFormat: row.source_format,
      sourceFilename: row.source_filename,
      status: row.status,
      importedRowCount: Number(row.imported_row_count),
      rejectedRowCount: Number(row.rejected_row_count),
      chargeCount: Number(row.charge_count),
      selectable: row.status === 'completed' && Number(row.charge_count) > 0,
      receivedAt: iso(row.received_at),
      completedAt: iso(row.completed_at),
    })),
    runs: runs.rows.map((row) => ({
      globalId: row.global_id,
      status: row.status,
      selectedBatchCount: Number(row.selected_batch_count),
      selectedChargeCount: Number(row.selected_charge_count),
      shipmentMatchedCount: Number(row.shipment_matched_count),
      shipperAssignedCount: Number(row.shipper_assigned_count),
      orphanCount: Number(row.orphan_count),
      excludedCount: Number(row.excluded_count),
      errorCount: Number(row.error_count),
      requestedBy: row.requested_by,
      requestedAt: iso(row.requested_at),
      completedAt: iso(row.completed_at),
    })),
    orphans: orphans.rows.map((row) => ({
      chargeGlobalId: row.global_id,
      batchGlobalId: row.batch_global_id,
      sourceFilename: row.source_filename,
      provider: row.provider,
      environment: row.environment,
      billedAccount: row.billed_account_masked_reference,
      externalChargeId: row.external_charge_id,
      trackingNumber: row.tracking_number,
      serviceCode: row.service_code,
      chargeCategory: row.charge_category,
      description: row.description,
      amountMinor: safeMinorUnits(row.amount_minor),
      currency: row.currency,
      shipmentDate: row.shipment_date,
      shipmentMatchStatus: row.current_match_decision || 'unmatched',
      shipperAssignmentStatus: row.current_assignment_decision || 'unassigned',
      explanation: row.latest_explanation || 'Run GL Coding or assign this charge manually',
    })),
    rules: rules.map((rule) => ({
      globalId: rule.globalId,
      name: rule.name,
      priority: rule.priority,
      matchMode: rule.matchMode,
      conditions: rule.conditions,
      outputs: rule.outputs,
      targetShipperPartyGlobalId: rule.targetShipperPartyGlobalId,
      targetShipperName: rule.targetShipperName,
      versionNumber: rule.versionNumber,
    })),
    shippers: shippers.rows.map((row) => ({
      globalId: row.global_id,
      name: row.display_name,
      entityType: row.entity_type,
      organizationId: row.workspace_organization_id,
      crmCustomerGlobalId: row.crm_customer_global_id,
    })),
  }
}

export async function runSelectedGlCodingFilesInPostgres(input: {
  organizationId: string
  actorEmail: string
  batchGlobalIds: string[]
  idempotencyKey: string
}) {
  return withTransaction(async (client) => {
    const network = await requireNetwork(client, input.organizationId)
    await acquireTransactionAdvisoryLock(client, `gl-coding:${network.id}`)
    const prior = await existingRun(client, network.id, input.idempotencyKey)
    if (prior) {
      const snapshot = objectValue(prior.selection_snapshot)
      const priorBatchIds = Array.isArray(snapshot.batches)
        ? snapshot.batches
          .map((batch) => objectValue(batch).globalId)
          .filter((globalId): globalId is string => typeof globalId === 'string')
          .sort()
        : []
      const requestedBatchIds = [...input.batchGlobalIds].sort()
      if (!jsonEqual(priorBatchIds, requestedBatchIds)) {
        requestError(
          'GL_CODING_IDEMPOTENCY_CONFLICT',
          'This idempotency key was already used for a different GL Coding selection',
          409,
        )
      }
      return runResult(prior, true)
    }
    const selected = await client.query<BatchRow>(
      `SELECT batch.id::text, batch.global_id, batch.provider, batch.environment,
              batch.source_format, batch.source_filename, batch.source_checksum,
              batch.status, batch.imported_row_count, batch.rejected_row_count,
              count(charge.id)::text AS charge_count,
              batch.received_at, batch.completed_at
         FROM operations_carrier_billing_batches batch
         LEFT JOIN operations_carrier_billing_statements statement
           ON statement.network_id = batch.network_id
          AND statement.batch_id = batch.id
         LEFT JOIN operations_carrier_billing_charges charge
           ON charge.network_id = statement.network_id
          AND charge.statement_id = statement.id
        WHERE batch.network_id = $1::uuid
          AND batch.global_id = ANY($2::text[])
        GROUP BY batch.id
        ORDER BY batch.global_id`,
      [network.id, input.batchGlobalIds],
    )
    if (selected.rows.length !== input.batchGlobalIds.length) {
      requestError('GL_CODING_BATCH_NOT_FOUND', 'One or more billing files were not found', 404)
    }
    if (selected.rows.some((batch) => batch.status !== 'completed')) {
      requestError('GL_CODING_BATCH_NOT_READY', 'Only completed billing files may be coded', 409)
    }
    const providers = new Set(selected.rows.map((batch) => batch.provider.toLowerCase()))
    const environments = new Set(selected.rows.map((batch) => batch.environment))
    if (providers.size !== 1 || environments.size !== 1) {
      requestError(
        'GL_CODING_BATCH_SCOPE_MISMATCH',
        'A GL Coding run may only combine files from one carrier and environment',
        409,
      )
    }
    const rules = await readRules(client, network.id)
    const inputChecksum = glCodingChecksum({
      batches: selected.rows.map((batch) => ({
        globalId: batch.global_id,
        checksum: batch.source_checksum,
      })),
      rules: rules.map((rule) => ({
        globalId: rule.globalId,
        versionNumber: rule.versionNumber,
      })),
    })
    const charges = await readChargesForBatches(
      client,
      network.id,
      selected.rows.map((batch) => batch.id),
    )
    if (charges.length > 2_500) {
      requestError(
        'GL_CODING_RUN_TOO_LARGE',
        'Select fewer billing files so the run contains no more than 2,500 charges',
        413,
      )
    }
    const runInsert = await client.query<ExistingRunRow>(
      `INSERT INTO operations_gl_coding_runs (
         network_id, status, selection_snapshot, rule_snapshot, input_checksum,
         idempotency_key, selected_batch_count, selected_charge_count,
         requested_by, started_at
       ) VALUES (
         $1::uuid, 'running', $2::jsonb, $3::jsonb, $4, $5, $6, $7, $8, now()
       )
       RETURNING id::text, global_id, input_checksum, selection_snapshot, status,
                 selected_batch_count, selected_charge_count,
                 shipment_matched_count, shipper_assigned_count,
                 orphan_count, excluded_count, error_count, summary`,
      [
        network.id,
        JSON.stringify({
          mode: 'selected_billing_files',
          provider: selected.rows[0].provider,
          environment: selected.rows[0].environment,
          batches: selected.rows.map((batch) => ({
            globalId: batch.global_id,
            sourceFilename: batch.source_filename,
            sourceChecksum: batch.source_checksum,
          })),
        }),
        JSON.stringify(rules.map((rule) => ({
          globalId: rule.globalId,
          name: rule.name,
          versionNumber: rule.versionNumber,
          priority: rule.priority,
          matchMode: rule.matchMode,
          conditions: rule.conditions,
          outputs: rule.outputs,
          targetShipperPartyGlobalId: rule.targetShipperPartyGlobalId,
        }))),
        inputChecksum,
        input.idempotencyKey,
        selected.rows.length,
        charges.length,
        input.actorEmail,
      ],
    )
    const run = runInsert.rows[0]
    for (const batch of selected.rows) {
      await client.query(
        `INSERT INTO operations_gl_coding_run_batches (network_id, run_id, batch_id)
         VALUES ($1::uuid, $2::uuid, $3::uuid)`,
        [network.id, run.id, batch.id],
      )
    }

    const trackingNumbers = Array.from(new Set(
      charges
        .map((charge) => normalizeCarrierTrackingNumber(charge.tracking_number))
        .filter(Boolean),
    ))
    const candidateMap = await readShipmentCandidates(
      client,
      network.id,
      selected.rows[0].provider,
      trackingNumbers,
    )
    let shipmentMatchedCount = 0
    let shipperAssignedCount = 0
    let orphanCount = 0
    let excludedCount = 0
    let errorCount = 0
    for (const charge of charges) {
      await client.query('SAVEPOINT gl_coding_charge')
      try {
        const candidates = candidateMap.get(
          normalizeCarrierTrackingNumber(charge.tracking_number),
        ) || []
        const match = await persistShipmentMatch(client, {
          networkId: network.id,
          charge,
          candidates,
          actorEmail: input.actorEmail,
        })
        const assignment = await persistShipperAssignment(client, {
          networkId: network.id,
          runId: run.id,
          charge,
          match,
          rules,
          actorEmail: input.actorEmail,
        })
        const result = assignment.decision === 'assigned'
          ? 'assigned'
          : assignment.decision === 'excluded' ? 'excluded' : 'orphan'
        if (match.decision === 'matched') shipmentMatchedCount += 1
        if (assignment.decision === 'assigned') shipperAssignedCount += 1
        else if (assignment.decision === 'excluded') excludedCount += 1
        else orphanCount += 1
        await client.query(
          `INSERT INTO operations_gl_coding_run_items (
             network_id, run_id, charge_id, billing_match_id,
             shipper_assignment_id, routing_rule_id, routing_rule_version,
             result, shipment_match_status, shipper_assignment_status,
             coding_outputs, evidence, explanation
           ) VALUES (
             $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7,
             $8, $9, $10, $11::jsonb, $12::jsonb, $13
           )`,
          [
            network.id,
            run.id,
            charge.id,
            match.id,
            assignment.id,
            assignment.rule?.id || null,
            assignment.rule?.versionNumber || null,
            result,
            match.decision,
            assignment.decision,
            JSON.stringify(assignment.codingOutputs),
            JSON.stringify({
              shipmentMatch: {
                decision: match.decision,
                reused: match.reused,
              },
              shipperAssignment: {
                source: assignment.source,
                reused: assignment.reused,
                ...assignment.evidence,
              },
            }),
            assignment.explanation,
          ],
        )
        await client.query('RELEASE SAVEPOINT gl_coding_charge')
      } catch (error) {
        await client.query('ROLLBACK TO SAVEPOINT gl_coding_charge')
        errorCount += 1
        await client.query(
          `INSERT INTO operations_gl_coding_run_items (
             network_id, run_id, charge_id, result,
             shipment_match_status, shipper_assignment_status,
             error_summary, evidence
           ) VALUES (
             $1::uuid, $2::uuid, $3::uuid, 'error', $4, $5, $6, $7::jsonb
           )`,
          [
            network.id,
            run.id,
            charge.id,
            charge.current_match_decision || 'unmatched',
            charge.current_assignment_decision || 'unassigned',
            safeError(error),
            JSON.stringify({ source: 'gl_coding', recoverable: true }),
          ],
        )
        await client.query('RELEASE SAVEPOINT gl_coding_charge')
      }
    }
    const finalStatus = orphanCount > 0 || errorCount > 0 ? 'needs_review' : 'completed'
    const summary = {
      provider: selected.rows[0].provider,
      environment: selected.rows[0].environment,
      selectedFiles: selected.rows.map((batch) => batch.source_filename),
      shipmentAndShipperDecisionsAreIndependent: true,
    }
    const updated = await client.query<ExistingRunRow>(
      `UPDATE operations_gl_coding_runs
          SET status = $3,
              shipment_matched_count = $4,
              shipper_assigned_count = $5,
              orphan_count = $6,
              excluded_count = $7,
              error_count = $8,
              summary = $9::jsonb,
              completed_at = now(),
              updated_at = now()
        WHERE network_id = $1::uuid AND id = $2::uuid
        RETURNING id::text, global_id, input_checksum, selection_snapshot, status,
                  selected_batch_count, selected_charge_count,
                  shipment_matched_count, shipper_assigned_count,
                  orphan_count, excluded_count, error_count, summary`,
      [
        network.id,
        run.id,
        finalStatus,
        shipmentMatchedCount,
        shipperAssignedCount,
        orphanCount,
        excludedCount,
        errorCount,
        JSON.stringify(summary),
      ],
    )
    await recordAuditEvent({
      actor: input.actorEmail,
      eventType: 'operations.gl_coding.run_completed',
      aggregateType: 'operations.gl_coding_run',
      aggregateId: run.global_id,
      eventKey: `gl-coding:${network.global_id}:${input.idempotencyKey}`,
      organizationId: input.organizationId,
      payload: {
        networkGlobalId: network.global_id,
        ...runResult(updated.rows[0]),
      },
    }, client)
    return runResult(updated.rows[0])
  })
}

export async function assignGlCodingOrphanInPostgres(input: {
  organizationId: string
  actorEmail: string
  chargeGlobalId: string
  shipperPartyGlobalId: string
  reason: string
  idempotencyKey: string
}) {
  return withTransaction(async (client) => {
    const network = await requireNetwork(client, input.organizationId)
    await acquireTransactionAdvisoryLock(client, `gl-coding:${network.id}`)
    const chargeResult = await client.query<ChargeRow>(
      `SELECT charge.id::text, charge.global_id, charge.statement_id::text,
              statement.batch_id::text, batch.global_id AS batch_global_id,
              batch.provider, batch.environment, batch.source_filename,
              statement.billed_account_masked_reference,
              statement.billed_account_fingerprint,
              charge.external_charge_id, charge.tracking_number,
              charge.provider_label_id, charge.package_reference,
              charge.service_code, charge.charge_category, charge.description,
              charge.amount_minor::text, charge.currency,
              charge.shipment_date::text, charge.billed_at,
              charge.sender_address_fingerprint,
              charge.recipient_address_fingerprint,
              charge.routing_attributes, charge.raw_evidence,
              current_match.id::text AS current_match_id,
              current_match.global_id AS current_match_global_id,
              current_match.decision AS current_match_decision,
              current_match.shipment_id::text AS current_match_shipment_id,
              current_match.candidate_snapshot AS current_match_candidate_snapshot,
              current_assignment.id::text AS current_assignment_id,
              current_assignment.global_id AS current_assignment_global_id,
              current_assignment.decision AS current_assignment_decision,
              current_assignment.shipper_party_id::text AS current_shipper_party_id,
              current_assignment.assignment_source AS current_assignment_source,
              current_assignment.billing_match_id::text AS current_assignment_match_id,
              current_assignment.routing_rule_id::text AS current_assignment_rule_id,
              current_assignment.routing_rule_version AS current_assignment_rule_version,
              current_assignment.coding_outputs AS current_assignment_outputs
         FROM operations_carrier_billing_charges charge
         JOIN operations_carrier_billing_statements statement
           ON statement.network_id = charge.network_id
          AND statement.id = charge.statement_id
         JOIN operations_carrier_billing_batches batch
           ON batch.network_id = statement.network_id
          AND batch.id = statement.batch_id
         LEFT JOIN operations_carrier_billing_current_matches current_match
           ON current_match.network_id = charge.network_id
          AND current_match.charge_id = charge.id
         LEFT JOIN operations_carrier_billing_current_shipper_assignments current_assignment
           ON current_assignment.network_id = charge.network_id
          AND current_assignment.charge_id = charge.id
        WHERE charge.network_id = $1::uuid AND charge.global_id = $2
        LIMIT 1`,
      [network.id, input.chargeGlobalId],
    )
    const charge = chargeResult.rows[0]
    if (!charge) requestError('GL_CODING_CHARGE_NOT_FOUND', 'Carrier charge was not found', 404)
    const shipperResult = await client.query<QueryResultRow & {
      id: string
      global_id: string
      display_name: string
    }>(
      `SELECT id::text, global_id, display_name
         FROM operations_carrier_rate_parties
        WHERE network_id = $1::uuid
          AND global_id = $2
          AND role = 'shipper'
        LIMIT 1`,
      [network.id, input.shipperPartyGlobalId],
    )
    const shipper = shipperResult.rows[0]
    if (!shipper) requestError('GL_CODING_SHIPPER_NOT_FOUND', 'Shipper was not found', 404)
    const inputChecksum = glCodingChecksum({
      mode: 'manual_orphan_resolution',
      chargeGlobalId: input.chargeGlobalId,
      shipperPartyGlobalId: input.shipperPartyGlobalId,
      reason: input.reason,
    })
    const prior = await existingRun(client, network.id, input.idempotencyKey)
    if (prior) {
      if (prior.input_checksum !== inputChecksum) {
        requestError(
          'GL_CODING_IDEMPOTENCY_CONFLICT',
          'This idempotency key was already used for a different manual assignment',
          409,
        )
      }
      return runResult(prior, true)
    }
    if (
      charge.current_assignment_id
      && !['unassigned', 'ambiguous'].includes(charge.current_assignment_decision || '')
    ) {
      requestError(
        'GL_CODING_ASSIGNMENT_STALE',
        'This carrier charge was already resolved; refresh GL Coding before assigning it again',
        409,
      )
    }
    const runInsert = await client.query<ExistingRunRow>(
      `INSERT INTO operations_gl_coding_runs (
         network_id, status, selection_snapshot, rule_snapshot, input_checksum,
         idempotency_key, selected_batch_count, selected_charge_count,
         requested_by, started_at
       ) VALUES (
         $1::uuid, 'running', $2::jsonb, '[]'::jsonb, $3, $4, 1, 1, $5, now()
       )
       RETURNING id::text, global_id, input_checksum, selection_snapshot, status,
                 selected_batch_count, selected_charge_count,
                 shipment_matched_count, shipper_assigned_count,
                 orphan_count, excluded_count, error_count, summary`,
      [
        network.id,
        JSON.stringify({
          mode: 'manual_orphan_resolution',
          chargeGlobalId: charge.global_id,
          batchGlobalId: charge.batch_global_id,
        }),
        inputChecksum,
        input.idempotencyKey,
        input.actorEmail,
      ],
    )
    const run = runInsert.rows[0]
    await client.query(
      `INSERT INTO operations_gl_coding_run_batches (network_id, run_id, batch_id)
       VALUES ($1::uuid, $2::uuid, $3::uuid)`,
      [network.id, run.id, charge.batch_id],
    )
    const assignment = await client.query<DecisionRow>(
      `INSERT INTO operations_carrier_billing_shipper_assignments (
         network_id, charge_id, decision, shipper_party_id, assignment_source,
         supersedes_assignment_id, evidence, candidate_snapshot, reason,
         decided_by, gl_coding_run_id, coding_outputs
       ) VALUES (
         $1::uuid, $2::uuid, 'assigned', $3::uuid, 'manual', $4::uuid,
         $5::jsonb, '[]'::jsonb, $6, $7, $8::uuid, '{}'::jsonb
       )
       RETURNING id::text, global_id`,
      [
        network.id,
        charge.id,
        shipper.id,
        charge.current_assignment_id,
        JSON.stringify({
          source: 'manual',
          shipperPartyGlobalId: shipper.global_id,
          shipperName: shipper.display_name,
        }),
        input.reason,
        input.actorEmail,
        run.id,
      ],
    )
    await client.query(
      `INSERT INTO operations_gl_coding_run_items (
         network_id, run_id, charge_id, billing_match_id,
         shipper_assignment_id, result, shipment_match_status,
         shipper_assignment_status, coding_outputs, evidence, explanation
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 'assigned',
         $6, 'assigned', '{}'::jsonb, $7::jsonb, $8
       )`,
      [
        network.id,
        run.id,
        charge.id,
        charge.current_match_id,
        assignment.rows[0].id,
        charge.current_match_decision || 'unmatched',
        JSON.stringify({
          source: 'manual',
          shipmentMatchPreserved: true,
          reason: input.reason,
        }),
        `Assigned manually to ${shipper.display_name}`,
      ],
    )
    const updated = await client.query<ExistingRunRow>(
      `UPDATE operations_gl_coding_runs
          SET status = 'completed',
              shipment_matched_count = $3,
              shipper_assigned_count = 1,
              summary = $4::jsonb,
              completed_at = now(),
              updated_at = now()
        WHERE network_id = $1::uuid AND id = $2::uuid
        RETURNING id::text, global_id, input_checksum, selection_snapshot, status,
                  selected_batch_count, selected_charge_count,
                  shipment_matched_count, shipper_assigned_count,
                  orphan_count, excluded_count, error_count, summary`,
      [
        network.id,
        run.id,
        charge.current_match_decision === 'matched' ? 1 : 0,
        JSON.stringify({
          mode: 'manual_orphan_resolution',
          chargeGlobalId: charge.global_id,
          shipperPartyGlobalId: shipper.global_id,
          shipmentMatchPreserved: true,
        }),
      ],
    )
    await recordAuditEvent({
      actor: input.actorEmail,
      eventType: 'operations.gl_coding.orphan_assigned',
      aggregateType: 'operations.carrier_billing_charge',
      aggregateId: charge.global_id,
      eventKey: `gl-coding-manual:${network.global_id}:${input.idempotencyKey}`,
      organizationId: input.organizationId,
      payload: {
        glCodingRunGlobalId: run.global_id,
        shipperPartyGlobalId: shipper.global_id,
        reason: input.reason,
        shipmentMatchPreserved: true,
      },
    }, client)
    return runResult(updated.rows[0])
  })
}

export async function createGlCodingRuleInPostgres(input: {
  organizationId: string
  actorEmail: string
  name: string
  priority: number
  matchMode: 'all' | 'any'
  conditions: GlCodingRuleConditions
  outputs: Record<string, unknown>
  targetShipperPartyGlobalId: string
  effectiveFrom: string
  idempotencyKey: string
}) {
  return withTransaction(async (client) => {
    const network = await requireNetwork(client, input.organizationId)
    await acquireTransactionAdvisoryLock(client, `gl-coding-rules:${network.id}`)
    const eventKey = `gl-coding-rule:${network.global_id}:${input.idempotencyKey}`
    const requestChecksum = glCodingChecksum({
      name: input.name.trim(),
      priority: input.priority,
      matchMode: input.matchMode,
      conditions: input.conditions,
      outputs: input.outputs,
      targetShipperPartyGlobalId: input.targetShipperPartyGlobalId,
      effectiveFrom: new Date(input.effectiveFrom).toISOString(),
    })
    const priorRequest = await client.query<QueryResultRow & {
      global_id: string
      version_number: number
      request_checksum: string
    }>(
      `SELECT global_id, version_number, request_checksum
         FROM operations_carrier_billing_routing_rules
        WHERE network_id = $1::uuid AND idempotency_key = $2
        LIMIT 1`,
      [network.id, input.idempotencyKey],
    )
    if (priorRequest.rows[0]) {
      if (priorRequest.rows[0].request_checksum !== requestChecksum) {
        requestError(
          'GL_CODING_IDEMPOTENCY_CONFLICT',
          'This idempotency key was already used for a different GL Coding rule',
          409,
        )
      }
      return {
        globalId: priorRequest.rows[0].global_id,
        versionNumber: Number(priorRequest.rows[0].version_number),
        duplicate: true,
      }
    }
    const shipper = await client.query<QueryResultRow & { id: string }>(
      `SELECT id::text
         FROM operations_carrier_rate_parties
        WHERE network_id = $1::uuid
          AND global_id = $2
          AND role = 'shipper'
        LIMIT 1`,
      [network.id, input.targetShipperPartyGlobalId],
    )
    if (!shipper.rows[0]) {
      requestError('GL_CODING_SHIPPER_NOT_FOUND', 'Rule target shipper was not found', 404)
    }
    const prior = await client.query<QueryResultRow & {
      id: string
      name: string
      version_number: number
    }>(
      `SELECT id::text, name, version_number
         FROM operations_carrier_billing_routing_rules
        WHERE network_id = $1::uuid AND lower(btrim(name)) = lower(btrim($2))
        ORDER BY version_number DESC, created_at DESC
        LIMIT 1`,
      [network.id, input.name],
    )
    const priorRule = prior.rows[0] || null
    const name = priorRule?.name || input.name
    const created = await client.query<DecisionRow & { version_number: number }>(
      `INSERT INTO operations_carrier_billing_routing_rules (
         network_id, name, priority, match_mode, conditions, outputs,
         target_shipper_party_id, version_number, supersedes_rule_id,
         status, effective_from, created_by, approved_by,
         idempotency_key, request_checksum
       ) VALUES (
         $1::uuid, $2, $3, $4, $5::jsonb, $6::jsonb, $7::uuid, $8,
         $9::uuid, 'active', $10::timestamptz, $11, $11, $12, $13
       )
       RETURNING id::text, global_id, version_number`,
      [
        network.id,
        name,
        input.priority,
        input.matchMode,
        JSON.stringify(input.conditions),
        JSON.stringify(input.outputs),
        shipper.rows[0].id,
        Number(priorRule?.version_number || 0) + 1,
        priorRule?.id || null,
        input.effectiveFrom,
        input.actorEmail,
        input.idempotencyKey,
        requestChecksum,
      ],
    )
    await recordAuditEvent({
      actor: input.actorEmail,
      eventType: 'operations.gl_coding.rule_activated',
      aggregateType: 'operations.carrier_billing_routing_rule',
      aggregateId: created.rows[0].global_id,
      eventKey,
      organizationId: input.organizationId,
      payload: {
        networkGlobalId: network.global_id,
        name,
        versionNumber: Number(created.rows[0].version_number),
        targetShipperPartyGlobalId: input.targetShipperPartyGlobalId,
      },
    }, client)
    return {
      globalId: created.rows[0].global_id,
      versionNumber: Number(created.rows[0].version_number),
      duplicate: false,
    }
  })
}
