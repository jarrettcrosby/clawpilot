import type { PoolClient, QueryResult, QueryResultRow } from 'pg'
import { recordAuditEvent } from '@/lib/auditWriter'
import {
  calculateBillingMud,
  glCodingChecksum,
  normalizeCarrierTrackingNumber,
  selectGlCodingRule,
  validateGlCodingConditions,
  type BillingMudDirective,
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

type ReviewableRunItemRow = QueryResultRow & {
  run_item_id: string
  run_item_global_id: string
  charge_id: string
  charge_global_id: string
  statement_id: string
  statement_global_id: string
  batch_provider: string
  source_filename: string
  amount_minor: string
  currency: string
  account_resolution_id: string
  account_resolution_global_id: string
  account_authorization_id: string
  account_authorization_global_id: string
  carrier_account_id: string
  carrier_account_global_id: string
  shipper_assignment_id: string
  shipper_assignment_global_id: string
  shipper_party_id: string
  shipper_party_global_id: string
  shipper_party_name: string
  account_owner_party_id: string
  account_owner_party_global_id: string
  account_owner_party_name: string
  executing_organization_id: string
  coding_outputs: unknown
  billing_match_id: string | null
  billing_match_global_id: string | null
  match_executing_organization_id: string | null
  shipment_id: string | null
  shipment_global_id: string | null
  shipment_order_id: string | null
  shipment_shipped_at: Date | null
  quote_snapshot_id: string | null
  quote_snapshot_global_id: string | null
  order_global_id: string | null
  contract_version_id: string | null
  contract_version_global_id: string | null
  contract_version_number: number | null
  statement_version_number: number
  statement_lineage_key: string
  commerce_order_candidate_id: string | null
  commerce_order_candidate_global_id: string | null
  candidate_provider: string | null
  candidate_currency: string | null
  candidate_shipping_minor: string | null
  candidate_payment_status: string | null
  candidate_header_money_state: string | null
  active_shipment_count: string | null
}

type ExistingReviewRow = QueryResultRow & {
  id: string
  global_id: string
  run_id: string
  run_global_id: string
  decision: 'approved' | 'rejected'
  reason: string
  idempotency_key: string
  reviewed_by: string
  reviewed_at: Date
}

type SettlementRow = QueryResultRow & {
  id: string
  global_id: string
  settlement_type: string
  amount_minor: string
  source_charge_amount_minor: string | null
  currency: string
  current_status: string
  payer_name: string
  payer_global_id: string | null
  payee_name: string
  payee_global_id: string | null
  review_role: string | null
  charge_global_id: string | null
  source_global_id: string
  actor_email: string | null
  occurred_at: Date
  calculation_snapshot: unknown
  latest_event_global_id: string | null
  latest_event_details: unknown
  latest_event_actor: string | null
  latest_event_at: Date | null
}

type BillingMudDirectiveRow = QueryResultRow & {
  grant_id: string
  grant_global_id: string
  directive_id: string
  directive_global_id: string
  directive_version: number
  directive_priority: number
  directive_type: BillingMudDirective['type']
  amount_minor: string | null
  basis_points: number | null
  approved_by: string
}

type BillingMudWorkspaceRow = QueryResultRow & {
  global_id: string
  status: 'not_configured' | 'calculated' | 'blocked'
  blocker_code: string | null
  statement_global_id: string
  billing_statement_version: number
  shipment_global_id: string
  order_global_id: string
  shipper_global_id: string
  shipper_name: string
  quote_snapshot_global_id: string
  contract_version_global_id: string | null
  contract_version_number: number | null
  commerce_order_candidate_global_id: string | null
  currency: string
  checkout_charge_status: string
  customer_paid_checkout_shipping_minor: string | null
  carrier_billed_actual_minor: string
  mud_adjustment_minor: string | null
  contract_billed_shipping_minor: string | null
  checkout_to_carrier_actual_variance_minor: string | null
  checkout_to_contract_bill_variance_minor: string | null
  charge_count: number
  directive_snapshot: unknown
  calculation_snapshot: unknown
  created_at: Date
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

function reviewResult(
  row: ExistingReviewRow,
  itemCount: number,
  settlementCount: number,
  duplicate = false,
) {
  return {
    globalId: row.global_id,
    runGlobalId: row.run_global_id,
    decision: row.decision,
    reason: row.reason,
    reviewedBy: row.reviewed_by,
    reviewedAt: iso(row.reviewed_at),
    itemCount,
    settlementCount,
    duplicate,
  }
}

function settlementEventTransitionAllowed(
  currentStatus: string,
  eventType:
    | 'approved'
    | 'billed'
    | 'paid'
    | 'disputed'
    | 'resolved'
    | 'reversed'
    | 'voided',
) {
  const allowed: Record<
    | 'approved'
    | 'billed'
    | 'paid'
    | 'disputed'
    | 'resolved'
    | 'reversed'
    | 'voided',
    string[]
  > = {
    approved: ['accrued'],
    billed: ['approved', 'resolved'],
    paid: ['approved', 'billed', 'resolved'],
    disputed: ['approved', 'billed'],
    resolved: ['disputed'],
    reversed: ['approved', 'billed', 'resolved'],
    voided: ['accrued', 'approved', 'billed', 'disputed', 'resolved'],
  }
  return allowed[eventType].includes(currentStatus)
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
               AND party.role IN ('platform_operator', 'reseller')
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

type ApprovedBillingMudEvidence = {
  reviewItemId: string
  item: ReviewableRunItemRow
}

async function persistApprovedBillingMudCalculations(
  client: PoolClient,
  input: {
    networkId: string
    reviewId: string
    reviewGlobalId: string
    actorEmail: string
    evidence: ApprovedBillingMudEvidence[]
  },
): Promise<number> {
  const groups = new Map<string, ApprovedBillingMudEvidence[]>()
  for (const evidence of input.evidence) {
    const item = evidence.item
    // An assigned GL row is not enough. Billing-time MUD requires the exact
    // current carrier-bill-to-shipment match and quote lineage.
    if (
      !item.billing_match_id
      || !item.shipment_id
      || !item.shipment_order_id
      || !item.shipment_shipped_at
      || !item.quote_snapshot_id
      || !item.match_executing_organization_id
    ) {
      continue
    }
    const key = [
      item.statement_lineage_key,
      item.statement_version_number,
      item.shipment_id,
      item.currency,
    ].join(':')
    const group = groups.get(key) || []
    group.push(evidence)
    groups.set(key, group)
  }

  let calculationCount = 0
  for (const evidenceGroup of groups.values()) {
    const first = evidenceGroup[0].item
    const shipmentShippedAt = first.shipment_shipped_at
    if (
      !first.shipment_id
      || !first.shipment_order_id
      || !first.quote_snapshot_id
      || !first.match_executing_organization_id
      || !shipmentShippedAt
    ) {
      continue
    }
    const evidenceIsConsistent = evidenceGroup.every(({ item }) => (
      item.statement_id === first.statement_id
      && item.shipment_id === first.shipment_id
      && item.shipment_order_id === first.shipment_order_id
      && item.quote_snapshot_id === first.quote_snapshot_id
      && item.account_authorization_id === first.account_authorization_id
      && item.carrier_account_id === first.carrier_account_id
      && item.shipper_party_id === first.shipper_party_id
      && item.match_executing_organization_id
        === first.match_executing_organization_id
    ))
    if (!evidenceIsConsistent) {
      // Conflicting exact-match evidence cannot be represented as one
      // shipment calculation and must be resolved before any MUD is persisted.
      continue
    }

    const carrierBilledActualMinor = evidenceGroup.reduce(
      (sum, { item }) => sum + BigInt(item.amount_minor),
      BigInt(0),
    )
    let checkoutChargeStatus:
      | 'customer_paid'
      | 'not_captured'
      | 'unallocated_multi_shipment'
      | 'unavailable' = 'unavailable'
    let commerceOrderCandidateId: string | null = null
    let customerPaidCheckoutShippingMinor: bigint | null = null
    const candidateCurrencyMatches = (
      first.commerce_order_candidate_id
      && first.candidate_currency === first.currency
    )
    if (candidateCurrencyMatches) {
      commerceOrderCandidateId = first.commerce_order_candidate_id
      if (
        first.candidate_provider === 'shopify'
        && first.candidate_header_money_state === 'complete'
        && first.candidate_payment_status === 'paid'
        && first.candidate_shipping_minor !== null
      ) {
        const shipmentCount = Number(first.active_shipment_count || 0)
        if (shipmentCount === 1) {
          checkoutChargeStatus = 'customer_paid'
          customerPaidCheckoutShippingMinor = BigInt(
            first.candidate_shipping_minor,
          )
        } else if (shipmentCount > 1) {
          checkoutChargeStatus = 'unallocated_multi_shipment'
        } else {
          checkoutChargeStatus = 'unavailable'
          commerceOrderCandidateId = null
        }
      } else {
        checkoutChargeStatus = 'not_captured'
      }
    }

    let status: 'not_configured' | 'calculated' | 'blocked'
      = 'not_configured'
    let blockerCode: string | null = null
    let mudAdjustmentMinor: bigint | null = null
    let contractBilledShippingMinor: bigint | null = null
    let directiveRows: BillingMudDirectiveRow[] = []
    let directiveSnapshot: Array<Record<string, unknown>> = []
    let directiveCandidateSnapshot: Array<Record<string, unknown>> = []
    let configurationReason = first.contract_version_id
      ? 'MUD_ACTUAL_COST_DIRECTIVE_NOT_CONFIGURED'
      : 'MUD_CONTRACT_NOT_CONFIGURED'

    if (first.contract_version_id) {
      const applicable = await client.query<BillingMudDirectiveRow>(
        `SELECT rate_grant.id::text AS grant_id,
                rate_grant.global_id AS grant_global_id,
                directive.id::text AS directive_id,
                directive.global_id AS directive_global_id,
                directive.version_number AS directive_version,
                directive.priority AS directive_priority,
                directive.directive_type,
                directive.amount_minor::text,
                directive.basis_points,
                directive.approved_by
           FROM operations_carrier_rate_grants rate_grant
           JOIN operations_carrier_rate_directives directive
             ON directive.network_id = rate_grant.network_id
            AND directive.grant_id = rate_grant.id
            AND directive.calculation_basis = 'actual_cost'
            AND directive.currency = $4
            AND directive.contract_version_id = $5::uuid
            AND directive.status = 'active'
            AND directive.approved_by IS NOT NULL
            AND directive.effective_from <= $6::timestamptz
            AND (
              directive.effective_to IS NULL
              OR directive.effective_to > $6::timestamptz
            )
            AND NOT EXISTS (
              SELECT 1
                FROM operations_carrier_rate_directives child
               WHERE child.network_id = directive.network_id
                 AND child.supersedes_directive_id = directive.id
                 AND child.status = 'active'
                 AND child.effective_from <= $6::timestamptz
                 AND (
                   child.effective_to IS NULL
                   OR child.effective_to > $6::timestamptz
                 )
            )
          WHERE rate_grant.network_id = $1::uuid
            AND rate_grant.account_authorization_id = $2::uuid
            AND rate_grant.grantee_party_id = $3::uuid
            AND rate_grant.status = 'active'
            AND rate_grant.allow_rating = true
            AND rate_grant.effective_from <= $6::timestamptz
            AND (
              rate_grant.effective_to IS NULL
              OR rate_grant.effective_to > $6::timestamptz
            )
            AND NOT EXISTS (
              SELECT 1
                FROM operations_carrier_rate_grants child
               WHERE child.network_id = rate_grant.network_id
                 AND child.supersedes_grant_id = rate_grant.id
                 AND child.status = 'active'
                 AND child.allow_rating = true
                 AND child.effective_from <= $6::timestamptz
                 AND (
                   child.effective_to IS NULL
                   OR child.effective_to > $6::timestamptz
                 )
            )
          ORDER BY rate_grant.global_id, directive.priority, directive.global_id`,
        [
          input.networkId,
          first.account_authorization_id,
          first.shipper_party_id,
          first.currency,
          first.contract_version_id,
          shipmentShippedAt.toISOString(),
        ],
      )
      const grantIds = new Set(applicable.rows.map((row) => row.grant_id))
      directiveRows = applicable.rows
      directiveCandidateSnapshot = directiveRows.map((row) => ({
        grantGlobalId: row.grant_global_id,
        directiveGlobalId: row.directive_global_id,
        versionNumber: row.directive_version,
        priority: row.directive_priority,
        type: row.directive_type,
        amountMinor: row.amount_minor,
        basisPoints: row.basis_points,
        calculationBasis: 'actual_cost',
        approvedBy: row.approved_by,
        contractVersionGlobalId: first.contract_version_global_id,
      }))
      if (grantIds.size > 1) {
        status = 'blocked'
        blockerCode = 'MUD_GRANT_AMBIGUOUS'
        configurationReason = blockerCode
      } else if (directiveRows.length > 0) {
        const directives = directiveRows.map((row) => ({
          globalId: String(row.directive_global_id),
          priority: Number(row.directive_priority),
          type: row.directive_type as BillingMudDirective['type'],
          amountMinor: row.amount_minor === null
            ? null
            : BigInt(row.amount_minor),
          basisPoints: row.basis_points === null
            ? null
            : Number(row.basis_points),
        }))
        directiveSnapshot = directiveCandidateSnapshot
        try {
          const result = calculateBillingMud(
            carrierBilledActualMinor,
            directives,
          )
          status = 'calculated'
          mudAdjustmentMinor = result.mudAdjustmentMinor
          contractBilledShippingMinor =
            result.contractBilledShippingMinor
          configurationReason = 'MUD_CALCULATED_FROM_BILLED_ACTUAL'
        } catch (error) {
          status = 'blocked'
          blockerCode = error instanceof Error
            ? error.message
            : 'BILLING_MUD_CALCULATION_FAILED'
          configurationReason = blockerCode
          directiveRows = []
          directiveSnapshot = []
        }
      }
    }

    const checkoutToCarrierActualVarianceMinor =
      customerPaidCheckoutShippingMinor === null
        ? null
        : customerPaidCheckoutShippingMinor - carrierBilledActualMinor
    const checkoutToContractBillVarianceMinor = (
      customerPaidCheckoutShippingMinor === null
      || contractBilledShippingMinor === null
    )
      ? null
      : customerPaidCheckoutShippingMinor - contractBilledShippingMinor
    const chargeSnapshot = [...evidenceGroup]
      .sort((left, right) => (
        left.item.charge_global_id.localeCompare(
          right.item.charge_global_id,
        )
      ))
      .map(({ item }) => ({
        chargeGlobalId: item.charge_global_id,
        billingMatchGlobalId: item.billing_match_global_id,
        amountMinor: item.amount_minor,
        currency: item.currency,
      }))
    const calculationSnapshot = {
      model: 'billing_actual_mud_v1',
      configurationReason,
      reviewGlobalId: input.reviewGlobalId,
      statementGlobalId: first.statement_global_id,
      statementVersion: first.statement_version_number,
      shipmentGlobalId: first.shipment_global_id,
      orderGlobalId: first.order_global_id,
      quoteSnapshotGlobalId: first.quote_snapshot_global_id,
      contractVersionGlobalId: first.contract_version_global_id,
      shipperPartyGlobalId: first.shipper_party_global_id,
      directiveCandidates: directiveCandidateSnapshot,
      checkoutEvidence: {
        status: checkoutChargeStatus,
        commerceOrderCandidateGlobalId:
          commerceOrderCandidateId
            ? first.commerce_order_candidate_global_id
            : null,
        paymentStatus: commerceOrderCandidateId
          ? first.candidate_payment_status
          : null,
        provider: commerceOrderCandidateId
          ? first.candidate_provider
          : null,
        headerMoneyState: commerceOrderCandidateId
          ? first.candidate_header_money_state
          : null,
        activeShipmentCount: Number(first.active_shipment_count || 0),
        noMultiShipmentAllocationInferred: true,
      },
      carrierBillingEvidence: chargeSnapshot,
      signConvention: {
        checkoutToCarrierActual:
          'customer_paid_checkout_shipping_minus_carrier_billed_actual',
        checkoutToContractBill:
          'customer_paid_checkout_shipping_minus_contract_billed_shipping',
      },
    }
    const inputHash = glCodingChecksum({
      networkId: input.networkId,
      reviewId: input.reviewId,
      statementLineageKey: first.statement_lineage_key,
      statementVersion: first.statement_version_number,
      shipmentId: first.shipment_id,
      currency: first.currency,
      carrierBillingEvidence: chargeSnapshot,
      directiveSnapshot,
      directiveCandidates: directiveCandidateSnapshot,
      checkoutEvidence: calculationSnapshot.checkoutEvidence,
    })
    const idempotencyKey = [
      'billing-mud',
      first.statement_lineage_key,
      first.statement_version_number,
      first.shipment_id,
      first.currency,
    ].join(':')
    const calculation = await client.query<DecisionRow>(
      `INSERT INTO operations_carrier_billing_mud_calculations (
         network_id, gl_coding_review_id,
         billing_statement_id, billing_statement_lineage_key,
         billing_statement_version, executing_organization_id,
         shipment_id, order_id, shipper_party_id, quote_snapshot_id,
         account_authorization_id, carrier_account_id,
         contract_version_id, commerce_order_candidate_id,
         status, blocker_code, currency, checkout_charge_status,
         customer_paid_checkout_shipping_minor,
         carrier_billed_actual_minor, mud_adjustment_minor,
         contract_billed_shipping_minor,
         checkout_to_carrier_actual_variance_minor,
         checkout_to_contract_bill_variance_minor,
         charge_count, directive_snapshot, calculation_snapshot,
         input_hash, idempotency_key, actor_email
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4, $5,
         $6::uuid, $7::uuid, $8::uuid, $9::uuid, $10::uuid,
         $11::uuid, $12::uuid, $13::uuid, $14::uuid,
         $15, $16, $17, $18, $19::bigint, $20::bigint,
         $21::bigint, $22::bigint, $23::bigint, $24::bigint,
         $25, $26::jsonb, $27::jsonb, $28, $29, $30
       )
       ON CONFLICT (network_id, idempotency_key) DO NOTHING
       RETURNING id::text, global_id`,
      [
        input.networkId,
        input.reviewId,
        first.statement_id,
        first.statement_lineage_key,
        first.statement_version_number,
        first.match_executing_organization_id,
        first.shipment_id,
        first.shipment_order_id,
        first.shipper_party_id,
        first.quote_snapshot_id,
        first.account_authorization_id,
        first.carrier_account_id,
        first.contract_version_id,
        commerceOrderCandidateId,
        status,
        blockerCode,
        first.currency,
        checkoutChargeStatus,
        customerPaidCheckoutShippingMinor?.toString() || null,
        carrierBilledActualMinor.toString(),
        mudAdjustmentMinor?.toString() || null,
        contractBilledShippingMinor?.toString() || null,
        checkoutToCarrierActualVarianceMinor?.toString() || null,
        checkoutToContractBillVarianceMinor?.toString() || null,
        evidenceGroup.length,
        JSON.stringify(directiveSnapshot),
        JSON.stringify(calculationSnapshot),
        inputHash,
        idempotencyKey,
        input.actorEmail,
      ],
    )
    if (!calculation.rows[0]) continue

    for (const evidence of evidenceGroup) {
      const item = evidence.item
      await client.query(
        `INSERT INTO operations_carrier_billing_mud_calculation_charges (
           network_id, calculation_id, billing_statement_id,
           billing_charge_id, billing_match_id, shipper_assignment_id,
           gl_coding_review_item_id, source_charge_amount_minor, currency
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
           $6::uuid, $7::uuid, $8::bigint, $9
         )`,
        [
          input.networkId,
          calculation.rows[0].id,
          item.statement_id,
          item.charge_id,
          item.billing_match_id,
          item.shipper_assignment_id,
          evidence.reviewItemId,
          item.amount_minor,
          item.currency,
        ],
      )
    }
    if (status === 'calculated') {
      for (const row of directiveRows) {
        await client.query(
          `INSERT INTO
             operations_carrier_billing_mud_calculation_directives (
               network_id, calculation_id, account_authorization_id,
               grant_id, directive_id, directive_version,
               directive_priority, directive_type, amount_minor,
               basis_points
             ) VALUES (
               $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
               $6, $7, $8, $9::bigint, $10
             )`,
          [
            input.networkId,
            calculation.rows[0].id,
            first.account_authorization_id,
            row.grant_id,
            row.directive_id,
            row.directive_version,
            row.directive_priority,
            row.directive_type,
            row.amount_minor,
            row.basis_points,
          ],
        )
      }
    }
    calculationCount += 1
  }
  return calculationCount
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
      settlements: [],
      mudCalculations: [],
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
    review_global_id: string | null
    review_decision: 'approved' | 'rejected' | null
    review_reason: string | null
    reviewed_by: string | null
    reviewed_at: Date | null
  }>(
    `SELECT run.global_id, run.status, run.selected_batch_count,
            run.selected_charge_count, run.shipment_matched_count,
            run.shipper_assigned_count, run.orphan_count,
            run.excluded_count, run.error_count, run.requested_by,
            run.requested_at, run.completed_at,
            review.global_id AS review_global_id,
            review.decision AS review_decision,
            review.reason AS review_reason,
            review.reviewed_by, review.reviewed_at
       FROM operations_gl_coding_runs run
       LEFT JOIN operations_gl_coding_reviews review
         ON review.network_id = run.network_id
        AND review.run_id = run.id
      WHERE run.network_id = $1::uuid
      ORDER BY run.requested_at DESC, run.id DESC
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
  const settlements = await query<SettlementRow>(
    `SELECT settlement.id::text, settlement.global_id,
            settlement.settlement_type, settlement.amount_minor::text,
            settlement.source_charge_amount_minor::text,
            settlement.currency,
            COALESCE(latest.event_type, settlement.initial_status) AS current_status,
            CASE
              WHEN settlement.payer_type = 'carrier'
                THEN settlement.payer_external_ref
              ELSE payer.display_name
            END AS payer_name,
            payer.global_id AS payer_global_id,
            CASE
              WHEN settlement.payee_type = 'carrier'
                THEN settlement.payee_external_ref
              ELSE payee.display_name
            END AS payee_name,
            payee.global_id AS payee_global_id,
            review_link.role AS review_role,
            charge.global_id AS charge_global_id,
            settlement.source_global_id,
            settlement.actor_email, settlement.occurred_at,
            settlement.calculation_snapshot,
            latest.global_id AS latest_event_global_id,
            latest.details AS latest_event_details,
            latest.actor_email AS latest_event_actor,
            latest.occurred_at AS latest_event_at
       FROM operations_settlement_entries settlement
       LEFT JOIN operations_carrier_rate_parties payer
         ON payer.network_id = settlement.network_id
        AND payer.id = settlement.payer_party_id
       LEFT JOIN operations_carrier_rate_parties payee
         ON payee.network_id = settlement.network_id
        AND payee.id = settlement.payee_party_id
       LEFT JOIN operations_carrier_billing_charges charge
         ON charge.network_id = settlement.network_id
        AND charge.id = settlement.billing_charge_id
       LEFT JOIN operations_gl_coding_review_settlements review_link
         ON review_link.network_id = settlement.network_id
        AND review_link.settlement_entry_id = settlement.id
       LEFT JOIN LATERAL (
         SELECT event.global_id, event.event_type, event.details,
                event.actor_email, event.occurred_at
           FROM operations_settlement_events event
          WHERE event.network_id = settlement.network_id
            AND event.settlement_entry_id = settlement.id
          ORDER BY event.occurred_at DESC, event.created_at DESC, event.id DESC
          LIMIT 1
       ) latest ON true
      WHERE settlement.network_id = $1::uuid
      ORDER BY settlement.occurred_at DESC, settlement.id DESC
      LIMIT 200`,
    [network.id],
  )
  const mudCalculations = await query<BillingMudWorkspaceRow>(
    `SELECT calculation.global_id, calculation.status,
            calculation.blocker_code, statement.global_id
              AS statement_global_id,
            calculation.billing_statement_version,
            shipment.global_id AS shipment_global_id,
            canonical_order.global_id AS order_global_id,
            shipper.global_id AS shipper_global_id,
            shipper.display_name AS shipper_name,
            quote.global_id AS quote_snapshot_global_id,
            contract_version.global_id AS contract_version_global_id,
            contract_version.version_number AS contract_version_number,
            commerce_candidate.global_id
              AS commerce_order_candidate_global_id,
            calculation.currency, calculation.checkout_charge_status,
            calculation.customer_paid_checkout_shipping_minor::text,
            calculation.carrier_billed_actual_minor::text,
            calculation.mud_adjustment_minor::text,
            calculation.contract_billed_shipping_minor::text,
            calculation.checkout_to_carrier_actual_variance_minor::text,
            calculation.checkout_to_contract_bill_variance_minor::text,
            calculation.charge_count, calculation.directive_snapshot,
            calculation.calculation_snapshot, calculation.created_at
       FROM operations_carrier_billing_mud_calculations calculation
       JOIN operations_carrier_billing_statements statement
         ON statement.network_id = calculation.network_id
        AND statement.id = calculation.billing_statement_id
       JOIN operations_shipments shipment
         ON shipment.organization_id
              = calculation.executing_organization_id
        AND shipment.id = calculation.shipment_id
       JOIN operations_orders canonical_order
         ON canonical_order.organization_id
              = calculation.executing_organization_id
        AND canonical_order.id = calculation.order_id
       JOIN operations_carrier_rate_parties shipper
         ON shipper.network_id = calculation.network_id
        AND shipper.id = calculation.shipper_party_id
       JOIN operations_carrier_quote_snapshots quote
         ON quote.network_id = calculation.network_id
        AND quote.executing_organization_id
              = calculation.executing_organization_id
        AND quote.account_authorization_id
              = calculation.account_authorization_id
        AND quote.carrier_account_id = calculation.carrier_account_id
        AND quote.id = calculation.quote_snapshot_id
       LEFT JOIN operations_contract_versions contract_version
         ON contract_version.organization_id
              = calculation.executing_organization_id
        AND contract_version.id = calculation.contract_version_id
       LEFT JOIN operations_commerce_order_candidates commerce_candidate
         ON commerce_candidate.id
              = calculation.commerce_order_candidate_id
      WHERE calculation.network_id = $1::uuid
      ORDER BY calculation.created_at DESC, calculation.id DESC
      LIMIT 200`,
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
      review: row.review_global_id ? {
        globalId: row.review_global_id,
        decision: row.review_decision,
        reason: row.review_reason,
        reviewedBy: row.reviewed_by,
        reviewedAt: iso(row.reviewed_at),
      } : null,
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
    settlements: settlements.rows.map((row) => ({
      globalId: row.global_id,
      settlementType: row.settlement_type,
      role: row.review_role || row.settlement_type,
      amountMinor: safeMinorUnits(row.amount_minor),
      sourceChargeAmountMinor: row.source_charge_amount_minor === null
        ? null
        : safeMinorUnits(row.source_charge_amount_minor),
      currency: row.currency,
      currentStatus: row.current_status,
      payerName: row.payer_name,
      payerGlobalId: row.payer_global_id,
      payeeName: row.payee_name,
      payeeGlobalId: row.payee_global_id,
      chargeGlobalId: row.charge_global_id,
      sourceGlobalId: row.source_global_id,
      actorEmail: row.actor_email,
      occurredAt: iso(row.occurred_at),
      codingOutputs: objectValue(
        objectValue(row.calculation_snapshot).codingOutputs,
      ),
      latestEvent: row.latest_event_global_id ? {
        globalId: row.latest_event_global_id,
        details: objectValue(row.latest_event_details),
        actorEmail: row.latest_event_actor,
        occurredAt: iso(row.latest_event_at),
      } : null,
    })),
    mudCalculations: mudCalculations.rows.map((row) => ({
      globalId: row.global_id,
      status: row.status,
      blockerCode: row.blocker_code,
      statementGlobalId: row.statement_global_id,
      statementVersion: Number(row.billing_statement_version),
      shipmentGlobalId: row.shipment_global_id,
      orderGlobalId: row.order_global_id,
      shipperGlobalId: row.shipper_global_id,
      shipperName: row.shipper_name,
      quoteSnapshotGlobalId: row.quote_snapshot_global_id,
      contractVersionGlobalId: row.contract_version_global_id,
      contractVersionNumber: row.contract_version_number === null
        ? null
        : Number(row.contract_version_number),
      commerceOrderCandidateGlobalId:
        row.commerce_order_candidate_global_id,
      currency: row.currency,
      checkoutChargeStatus: row.checkout_charge_status,
      customerPaidCheckoutShippingMinor:
        row.customer_paid_checkout_shipping_minor === null
          ? null
          : safeMinorUnits(row.customer_paid_checkout_shipping_minor),
      carrierBilledActualMinor:
        safeMinorUnits(row.carrier_billed_actual_minor),
      mudAdjustmentMinor: row.mud_adjustment_minor === null
        ? null
        : safeMinorUnits(row.mud_adjustment_minor),
      contractBilledShippingMinor:
        row.contract_billed_shipping_minor === null
          ? null
          : safeMinorUnits(row.contract_billed_shipping_minor),
      checkoutToCarrierActualVarianceMinor:
        row.checkout_to_carrier_actual_variance_minor === null
          ? null
          : safeMinorUnits(
            row.checkout_to_carrier_actual_variance_minor,
          ),
      checkoutToContractBillVarianceMinor:
        row.checkout_to_contract_bill_variance_minor === null
          ? null
          : safeMinorUnits(
            row.checkout_to_contract_bill_variance_minor,
          ),
      chargeCount: Number(row.charge_count),
      directiveSnapshot: Array.isArray(row.directive_snapshot)
        ? row.directive_snapshot
        : [],
      calculationSnapshot: objectValue(row.calculation_snapshot),
      createdAt: iso(row.created_at),
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

export async function reviewGlCodingRunInPostgres(input: {
  organizationId: string
  actorEmail: string
  runGlobalId: string
  decision: 'approved' | 'rejected'
  reason: string
  idempotencyKey: string
}) {
  return withTransaction(async (client) => {
    const network = await requireNetwork(client, input.organizationId)
    await acquireTransactionAdvisoryLock(client, `gl-coding-review:${network.id}`)

    const existingByKey = await client.query<ExistingReviewRow>(
      `SELECT review.id::text, review.global_id, review.run_id::text,
              run.global_id AS run_global_id, review.decision, review.reason,
              review.idempotency_key, review.reviewed_by, review.reviewed_at
         FROM operations_gl_coding_reviews review
         JOIN operations_gl_coding_runs run
           ON run.network_id = review.network_id
          AND run.id = review.run_id
        WHERE review.network_id = $1::uuid
          AND review.idempotency_key = $2
        LIMIT 1`,
      [network.id, input.idempotencyKey],
    )
    if (existingByKey.rows[0]) {
      const prior = existingByKey.rows[0]
      if (
        prior.run_global_id !== input.runGlobalId
        || prior.decision !== input.decision
        || prior.reason !== input.reason
      ) {
        requestError(
          'GL_CODING_IDEMPOTENCY_CONFLICT',
          'This idempotency key was already used for a different GL Coding review',
          409,
        )
      }
      const counts = await client.query<QueryResultRow & {
        item_count: string
        settlement_count: string
      }>(
        `SELECT count(DISTINCT item.id)::text AS item_count,
                count(link.settlement_entry_id)::text AS settlement_count
           FROM operations_gl_coding_review_items item
           LEFT JOIN operations_gl_coding_review_settlements link
             ON link.network_id = item.network_id
            AND link.review_item_id = item.id
          WHERE item.network_id = $1::uuid
            AND item.review_id = $2::uuid`,
        [network.id, prior.id],
      )
      return reviewResult(
        prior,
        Number(counts.rows[0]?.item_count || 0),
        Number(counts.rows[0]?.settlement_count || 0),
        true,
      )
    }

    const runResultRow = await client.query<ExistingRunRow>(
      `SELECT id::text, global_id, input_checksum, selection_snapshot, status,
              selected_batch_count, selected_charge_count,
              shipment_matched_count, shipper_assigned_count,
              orphan_count, excluded_count, error_count, summary
         FROM operations_gl_coding_runs
        WHERE network_id = $1::uuid
          AND global_id = $2
        LIMIT 1
        FOR UPDATE`,
      [network.id, input.runGlobalId],
    )
    const run = runResultRow.rows[0]
    if (!run) {
      requestError('GL_CODING_RUN_NOT_FOUND', 'GL Coding run was not found', 404)
    }

    const existingByRun = await client.query<ExistingReviewRow>(
      `SELECT review.id::text, review.global_id, review.run_id::text,
              run.global_id AS run_global_id, review.decision, review.reason,
              review.idempotency_key, review.reviewed_by, review.reviewed_at
         FROM operations_gl_coding_reviews review
         JOIN operations_gl_coding_runs run
           ON run.network_id = review.network_id
          AND run.id = review.run_id
        WHERE review.network_id = $1::uuid
          AND review.run_id = $2::uuid
        LIMIT 1`,
      [network.id, run.id],
    )
    if (existingByRun.rows[0]) {
      const prior = existingByRun.rows[0]
      if (prior.decision !== input.decision || prior.reason !== input.reason) {
        requestError(
          'GL_CODING_REVIEW_ALREADY_RECORDED',
          'This GL Coding run already has a different review decision',
          409,
        )
      }
      const counts = await client.query<QueryResultRow & {
        item_count: string
        settlement_count: string
      }>(
        `SELECT count(DISTINCT item.id)::text AS item_count,
                count(link.settlement_entry_id)::text AS settlement_count
           FROM operations_gl_coding_review_items item
           LEFT JOIN operations_gl_coding_review_settlements link
             ON link.network_id = item.network_id
            AND link.review_item_id = item.id
          WHERE item.network_id = $1::uuid
            AND item.review_id = $2::uuid`,
        [network.id, prior.id],
      )
      return reviewResult(
        prior,
        Number(counts.rows[0]?.item_count || 0),
        Number(counts.rows[0]?.settlement_count || 0),
        true,
      )
    }

    const createdReview = await client.query<ExistingReviewRow>(
      `INSERT INTO operations_gl_coding_reviews (
         network_id, run_id, decision, reason, idempotency_key,
         evidence, reviewed_by
       ) VALUES (
         $1::uuid, $2::uuid, $3, $4, $5, $6::jsonb, $7
       )
       RETURNING id::text, global_id, run_id::text,
                 $8::text AS run_global_id, decision, reason,
                 idempotency_key, reviewed_by, reviewed_at`,
      [
        network.id,
        run.id,
        input.decision,
        input.reason,
        input.idempotencyKey,
        JSON.stringify({
          runGlobalId: run.global_id,
          selectedChargeCount: Number(run.selected_charge_count),
          shipperAssignedCount: Number(run.shipper_assigned_count),
          excludedCount: Number(run.excluded_count),
          orphanCount: Number(run.orphan_count),
          errorCount: Number(run.error_count),
        }),
        input.actorEmail,
        run.global_id,
      ],
    )
    const review = createdReview.rows[0]

    if (input.decision === 'rejected') {
      await recordAuditEvent({
        actor: input.actorEmail,
        eventType: 'operations.gl_coding.run_rejected',
        aggregateType: 'operations.gl_coding_review',
        aggregateId: review.global_id,
        eventKey: `gl-coding-review:${network.global_id}:${input.idempotencyKey}`,
        organizationId: input.organizationId,
        payload: {
          networkGlobalId: network.global_id,
          runGlobalId: run.global_id,
          reason: input.reason,
        },
      }, client)
      return reviewResult(review, 0, 0)
    }

    const reviewableItems = await client.query<ReviewableRunItemRow>(
      `SELECT item.id::text AS run_item_id,
              item.global_id AS run_item_global_id,
              charge.id::text AS charge_id,
              charge.global_id AS charge_global_id,
              statement.id::text AS statement_id,
              statement.global_id AS statement_global_id,
              statement.version_number AS statement_version_number,
              encode(
                digest(
                  statement.billed_account_fingerprint
                    || ':' || statement.external_statement_id,
                  'sha256'
                ),
                'hex'
              ) AS statement_lineage_key,
              batch.provider AS batch_provider,
              batch.source_filename,
              charge.amount_minor::text, charge.currency,
              resolution.id::text AS account_resolution_id,
              resolution.global_id AS account_resolution_global_id,
              resolution.account_authorization_id::text,
              authorization.global_id AS account_authorization_global_id,
              resolution.carrier_account_id::text,
              carrier_account.global_id AS carrier_account_global_id,
              assignment.id::text AS shipper_assignment_id,
              assignment.global_id AS shipper_assignment_global_id,
              shipper.id::text AS shipper_party_id,
              shipper.global_id AS shipper_party_global_id,
              shipper.display_name AS shipper_party_name,
              account_owner.id::text AS account_owner_party_id,
              account_owner.global_id AS account_owner_party_global_id,
              account_owner.display_name AS account_owner_party_name,
              assignment.coding_outputs,
              COALESCE(
                shipper.workspace_organization_id,
                shipper_pipeline.workspace_organization_id
              )::text AS executing_organization_id,
              billing_match.id::text AS billing_match_id,
              billing_match.global_id AS billing_match_global_id,
              billing_match.executing_organization_id::text
                AS match_executing_organization_id,
              shipment.id::text AS shipment_id,
              shipment.global_id AS shipment_global_id,
              shipment.order_id::text AS shipment_order_id,
              shipment.shipped_at AS shipment_shipped_at,
              billing_match.quote_snapshot_id::text AS quote_snapshot_id,
              quote_snapshot.global_id AS quote_snapshot_global_id,
              canonical_order.global_id AS order_global_id,
              canonical_order.contract_version_id::text
                AS contract_version_id,
              contract_version.global_id AS contract_version_global_id,
              contract_version.version_number AS contract_version_number,
              commerce_candidate.id::text AS commerce_order_candidate_id,
              commerce_candidate.global_id
                AS commerce_order_candidate_global_id,
              commerce_candidate.provider AS candidate_provider,
              commerce_candidate.currency_code AS candidate_currency,
              commerce_candidate.shipping_minor::text
                AS candidate_shipping_minor,
              commerce_candidate.normalized_payment_status
                AS candidate_payment_status,
              commerce_candidate.header_money_state
                AS candidate_header_money_state,
              shipment_count.active_shipment_count::text
                AS active_shipment_count
         FROM operations_gl_coding_run_items item
         JOIN operations_carrier_billing_charges charge
           ON charge.network_id = item.network_id
          AND charge.id = item.charge_id
         JOIN operations_carrier_billing_statements statement
           ON statement.network_id = charge.network_id
          AND statement.id = charge.statement_id
         JOIN operations_carrier_billing_batches batch
           ON batch.network_id = statement.network_id
          AND batch.id = statement.batch_id
         JOIN operations_carrier_billing_current_account_resolutions resolution
           ON resolution.network_id = statement.network_id
          AND resolution.statement_id = statement.id
          AND resolution.decision = 'matched'
         JOIN operations_carrier_account_authorizations authorization
           ON authorization.network_id = resolution.network_id
          AND authorization.id = resolution.account_authorization_id
         JOIN operations_integration_accounts carrier_account
           ON carrier_account.organization_id = authorization.account_owner_organization_id
          AND carrier_account.id = resolution.carrier_account_id
         JOIN operations_carrier_billing_current_shipper_assignments assignment
           ON assignment.network_id = charge.network_id
          AND assignment.charge_id = charge.id
          AND assignment.id = item.shipper_assignment_id
          AND assignment.decision = 'assigned'
         JOIN operations_carrier_rate_parties shipper
           ON shipper.network_id = assignment.network_id
          AND shipper.id = assignment.shipper_party_id
          AND shipper.role = 'shipper'
         LEFT JOIN pipeline_spaces shipper_pipeline
           ON shipper.entity_type = 'crm_customer'
          AND shipper_pipeline.id = shipper.crm_pipeline_id
         JOIN operations_carrier_rate_parties account_owner
           ON account_owner.network_id = resolution.network_id
          AND account_owner.workspace_organization_id
            = resolution.account_owner_organization_id
          AND account_owner.role IN ('platform_operator', 'reseller')
         LEFT JOIN operations_carrier_billing_matches billing_match
           ON billing_match.network_id = item.network_id
          AND billing_match.charge_id = item.charge_id
          AND billing_match.id = item.billing_match_id
          AND billing_match.decision = 'matched'
          AND NOT EXISTS (
            SELECT 1
              FROM operations_carrier_billing_matches child
             WHERE child.network_id = billing_match.network_id
               AND child.charge_id = billing_match.charge_id
               AND child.supersedes_match_id = billing_match.id
          )
         LEFT JOIN operations_shipments shipment
           ON shipment.organization_id
                = billing_match.executing_organization_id
          AND shipment.id = billing_match.shipment_id
         LEFT JOIN operations_carrier_quote_snapshots quote_snapshot
           ON quote_snapshot.network_id = billing_match.network_id
          AND quote_snapshot.executing_organization_id
                = billing_match.executing_organization_id
          AND quote_snapshot.account_authorization_id
                = billing_match.account_authorization_id
          AND quote_snapshot.carrier_account_id
                = billing_match.carrier_account_id
          AND quote_snapshot.id = billing_match.quote_snapshot_id
         LEFT JOIN operations_orders canonical_order
           ON canonical_order.organization_id = shipment.organization_id
          AND canonical_order.id = shipment.order_id
         LEFT JOIN operations_contract_versions contract_version
           ON contract_version.organization_id
                = canonical_order.organization_id
          AND contract_version.id = canonical_order.contract_version_id
         LEFT JOIN operations_commerce_order_candidates commerce_candidate
           ON commerce_candidate.organization_id
                = canonical_order.organization_id
          AND commerce_candidate.canonical_order_id = canonical_order.id
         LEFT JOIN LATERAL (
           SELECT count(*) AS active_shipment_count
             FROM operations_shipments sibling
            WHERE sibling.organization_id = shipment.organization_id
              AND sibling.order_id = shipment.order_id
              AND sibling.status <> 'voided'
         ) shipment_count ON true
        WHERE item.network_id = $1::uuid
          AND item.run_id = $2::uuid
          AND item.result = 'assigned'
        ORDER BY item.created_at, item.id
        FOR UPDATE OF item, charge`,
      [network.id, run.id],
    )
    if (reviewableItems.rows.length !== Number(run.shipper_assigned_count)) {
      requestError(
        'GL_CODING_REVIEW_EVIDENCE_STALE',
        'One or more GL Coding assignments changed; run GL Coding again before approval',
        409,
      )
    }

    let settlementCount = 0
    const approvedBillingMudEvidence: ApprovedBillingMudEvidence[] = []
    for (const item of reviewableItems.rows) {
      const reviewItem = await client.query<DecisionRow>(
        `INSERT INTO operations_gl_coding_review_items (
           network_id, run_id, review_id, run_item_id,
           billing_statement_id, billing_charge_id,
           billing_account_resolution_id, account_authorization_id,
           carrier_account_id, shipper_assignment_id,
           source_charge_amount_minor, currency, evidence
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, $4::uuid,
           $5::uuid, $6::uuid, $7::uuid, $8::uuid,
           $9::uuid, $10::uuid, $11::bigint, $12, $13::jsonb
         )
         RETURNING id::text, global_id`,
        [
          network.id,
          run.id,
          review.id,
          item.run_item_id,
          item.statement_id,
          item.charge_id,
          item.account_resolution_id,
          item.account_authorization_id,
          item.carrier_account_id,
          item.shipper_assignment_id,
          item.amount_minor,
          item.currency,
          JSON.stringify({
            runItemGlobalId: item.run_item_global_id,
            statementGlobalId: item.statement_global_id,
            chargeGlobalId: item.charge_global_id,
            accountResolutionGlobalId: item.account_resolution_global_id,
            accountAuthorizationGlobalId: item.account_authorization_global_id,
            carrierAccountGlobalId: item.carrier_account_global_id,
            shipperAssignmentGlobalId: item.shipper_assignment_global_id,
            sourceFilename: item.source_filename,
            codingOutputs: objectValue(item.coding_outputs),
          }),
        ],
      )
      const sourceAmount = BigInt(item.amount_minor)
      approvedBillingMudEvidence.push({
        reviewItemId: reviewItem.rows[0].id,
        item,
      })
      const absoluteAmount = sourceAmount < BigInt(0) ? -sourceAmount : sourceAmount
      const providerIdentity = item.batch_provider
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '')
        .replace(/^upsrest$/, 'ups')
        .replace(/^fedexrest$/, 'fedex')
        .replace(/^uspsrest$/, 'usps')
      const settlementsToCreate: Array<{
        role: 'carrier_payable' | 'carrier_cost_reimbursement' | 'credit'
        payerType: 'rate_party' | 'carrier'
        payerPartyId: string | null
        payerExternalRef: string | null
        payeeType: 'rate_party' | 'carrier'
        payeePartyId: string | null
        payeeExternalRef: string | null
      }> = []
      if (sourceAmount > BigInt(0)) {
        settlementsToCreate.push({
          role: 'carrier_payable',
          payerType: 'rate_party',
          payerPartyId: item.account_owner_party_id,
          payerExternalRef: null,
          payeeType: 'carrier',
          payeePartyId: null,
          payeeExternalRef: providerIdentity,
        })
        if (item.shipper_party_id !== item.account_owner_party_id) {
          settlementsToCreate.push({
            role: 'carrier_cost_reimbursement',
            payerType: 'rate_party',
            payerPartyId: item.shipper_party_id,
            payerExternalRef: null,
            payeeType: 'rate_party',
            payeePartyId: item.account_owner_party_id,
            payeeExternalRef: null,
          })
        }
      } else if (sourceAmount < BigInt(0)) {
        settlementsToCreate.push({
          role: 'credit',
          payerType: 'carrier',
          payerPartyId: null,
          payerExternalRef: providerIdentity,
          payeeType: 'rate_party',
          payeePartyId: item.account_owner_party_id,
          payeeExternalRef: null,
        })
      }

      for (const settlementPlan of settlementsToCreate) {
        const settlementKey = [
          'gl-review',
          review.global_id,
          reviewItem.rows[0].global_id,
          settlementPlan.role,
        ].join(':')
        const settlement = await client.query<DecisionRow>(
          `INSERT INTO operations_settlement_entries (
             network_id, quote_snapshot_id, executing_organization_id,
             shipment_id, settlement_type,
             payer_type, payer_party_id, payer_external_ref,
             payee_type, payee_party_id, payee_external_ref,
             amount_minor, currency, initial_status,
             source_type, source_global_id, directive_snapshot,
             calculation_snapshot, idempotency_key, actor_email,
             account_authorization_id, carrier_account_id,
             billing_statement_id, billing_charge_id,
             billing_account_resolution_id, shipper_assignment_id,
             cost_basis, source_charge_amount_minor
           ) VALUES (
             $1::uuid, NULL, $2::uuid, NULL, $3,
             $4, $5::uuid, $6, $7, $8::uuid, $9,
             $10::bigint, $11, 'accrued',
             'shipper_assignment', $12, '[]'::jsonb,
             $13::jsonb, $14, $15,
             $16::uuid, $17::uuid, $18::uuid, $19::uuid,
             $20::uuid, $21::uuid, 'billed_actual', $22::bigint
           )
           RETURNING id::text, global_id`,
          [
            network.id,
            item.executing_organization_id,
            settlementPlan.role,
            settlementPlan.payerType,
            settlementPlan.payerPartyId,
            settlementPlan.payerExternalRef,
            settlementPlan.payeeType,
            settlementPlan.payeePartyId,
            settlementPlan.payeeExternalRef,
            absoluteAmount.toString(),
            item.currency,
            item.shipper_assignment_global_id,
            JSON.stringify({
              model: 'triangle_square_circle_billed_actual',
              role: settlementPlan.role,
              reviewGlobalId: review.global_id,
              chargeGlobalId: item.charge_global_id,
              sourceChargeAmountMinor: item.amount_minor,
              accountOwnerParty: {
                globalId: item.account_owner_party_global_id,
                name: item.account_owner_party_name,
              },
              shipperParty: {
                globalId: item.shipper_party_global_id,
                name: item.shipper_party_name,
              },
              codingOutputs: objectValue(item.coding_outputs),
              quoteTimePlatformAndResellerFeesExcluded: true,
            }),
            settlementKey,
            input.actorEmail,
            item.account_authorization_id,
            item.carrier_account_id,
            item.statement_id,
            item.charge_id,
            item.account_resolution_id,
            item.shipper_assignment_id,
            item.amount_minor,
          ],
        )
        await client.query(
          `INSERT INTO operations_gl_coding_review_settlements (
             network_id, review_item_id, settlement_entry_id, role
           ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4)`,
          [
            network.id,
            reviewItem.rows[0].id,
            settlement.rows[0].id,
            settlementPlan.role,
          ],
        )
        await client.query(
          `INSERT INTO operations_settlement_events (
             network_id, settlement_entry_id, event_type, details,
             idempotency_key, actor_email
           ) VALUES (
             $1::uuid, $2::uuid, 'approved', $3::jsonb, $4, $5
           )`,
          [
            network.id,
            settlement.rows[0].id,
            JSON.stringify({
              reason: input.reason,
              reviewGlobalId: review.global_id,
              chargeGlobalId: item.charge_global_id,
            }),
            `${settlementKey}:approved`,
            input.actorEmail,
          ],
        )
        settlementCount += 1
      }
    }
    const billingMudCalculationCount =
      await persistApprovedBillingMudCalculations(client, {
        networkId: network.id,
        reviewId: review.id,
        reviewGlobalId: review.global_id,
        actorEmail: input.actorEmail,
        evidence: approvedBillingMudEvidence,
      })

    await recordAuditEvent({
      actor: input.actorEmail,
      eventType: 'operations.gl_coding.run_approved',
      aggregateType: 'operations.gl_coding_review',
      aggregateId: review.global_id,
      eventKey: `gl-coding-review:${network.global_id}:${input.idempotencyKey}`,
      organizationId: input.organizationId,
      payload: {
        networkGlobalId: network.global_id,
        runGlobalId: run.global_id,
        itemCount: reviewableItems.rows.length,
        settlementCount,
        billingMudCalculationCount,
        reason: input.reason,
        quoteTimePlatformAndResellerFeesExcluded: true,
        billingTimeMudOnly: true,
      },
    }, client)
    return reviewResult(
      review,
      reviewableItems.rows.length,
      settlementCount,
    )
  })
}

export async function recordGlCodingSettlementEventInPostgres(input: {
  organizationId: string
  actorEmail: string
  settlementGlobalId: string
  eventType:
    | 'approved'
    | 'billed'
    | 'paid'
    | 'disputed'
    | 'resolved'
    | 'reversed'
    | 'voided'
  reason: string
  reference?: string | null
  idempotencyKey: string
}) {
  return withTransaction(async (client) => {
    const network = await requireNetwork(client, input.organizationId)
    await acquireTransactionAdvisoryLock(client, `settlement:${network.id}`)

    const details = {
      reason: input.reason,
      ...(input.reference ? { reference: input.reference } : {}),
    }
    const existing = await client.query<QueryResultRow & {
      global_id: string
      settlement_global_id: string
      event_type: string
      details: unknown
      occurred_at: Date
    }>(
      `SELECT event.global_id, settlement.global_id AS settlement_global_id,
              event.event_type, event.details, event.occurred_at
         FROM operations_settlement_events event
         JOIN operations_settlement_entries settlement
           ON settlement.network_id = event.network_id
          AND settlement.id = event.settlement_entry_id
        WHERE event.network_id = $1::uuid
          AND event.idempotency_key = $2
        LIMIT 1`,
      [network.id, input.idempotencyKey],
    )
    if (existing.rows[0]) {
      const prior = existing.rows[0]
      const priorDetails = objectValue(prior.details)
      if (
        prior.settlement_global_id !== input.settlementGlobalId
        || prior.event_type !== input.eventType
        || priorDetails.reason !== input.reason
        || (priorDetails.reference || null) !== (input.reference || null)
      ) {
        requestError(
          'GL_CODING_IDEMPOTENCY_CONFLICT',
          'This idempotency key was already used for a different settlement event',
          409,
        )
      }
      return {
        globalId: prior.global_id,
        settlementGlobalId: prior.settlement_global_id,
        currentStatus: prior.event_type,
        occurredAt: iso(prior.occurred_at),
        duplicate: true,
      }
    }

    const settlementResult = await client.query<QueryResultRow & {
      id: string
      global_id: string
      initial_status: string
      current_status: string
    }>(
      `SELECT settlement.id::text, settlement.global_id,
              settlement.initial_status,
              COALESCE(latest.event_type, settlement.initial_status) AS current_status
         FROM operations_settlement_entries settlement
         LEFT JOIN LATERAL (
           SELECT event.event_type
             FROM operations_settlement_events event
            WHERE event.network_id = settlement.network_id
              AND event.settlement_entry_id = settlement.id
            ORDER BY event.occurred_at DESC, event.created_at DESC, event.id DESC
            LIMIT 1
         ) latest ON true
        WHERE settlement.network_id = $1::uuid
          AND settlement.global_id = $2
        LIMIT 1
        FOR UPDATE OF settlement`,
      [network.id, input.settlementGlobalId],
    )
    const settlement = settlementResult.rows[0]
    if (!settlement) {
      requestError('SETTLEMENT_NOT_FOUND', 'Settlement entry was not found', 404)
    }
    if (!settlementEventTransitionAllowed(settlement.current_status, input.eventType)) {
      requestError(
        'SETTLEMENT_TRANSITION_INVALID',
        `Settlement cannot move from ${settlement.current_status} to ${input.eventType}`,
        409,
      )
    }
    const created = await client.query<QueryResultRow & {
      global_id: string
      occurred_at: Date
    }>(
      `INSERT INTO operations_settlement_events (
         network_id, settlement_entry_id, event_type, details,
         idempotency_key, actor_email
       ) VALUES (
         $1::uuid, $2::uuid, $3, $4::jsonb, $5, $6
       )
       RETURNING global_id, occurred_at`,
      [
        network.id,
        settlement.id,
        input.eventType,
        JSON.stringify({
          ...details,
          previousStatus: settlement.current_status,
        }),
        input.idempotencyKey,
        input.actorEmail,
      ],
    )
    await recordAuditEvent({
      actor: input.actorEmail,
      eventType: `operations.settlement.${input.eventType}`,
      aggregateType: 'operations.settlement_entry',
      aggregateId: settlement.global_id,
      eventKey: `settlement:${network.global_id}:${input.idempotencyKey}`,
      organizationId: input.organizationId,
      payload: {
        previousStatus: settlement.current_status,
        currentStatus: input.eventType,
        reason: input.reason,
        reference: input.reference || null,
      },
    }, client)
    return {
      globalId: created.rows[0].global_id,
      settlementGlobalId: settlement.global_id,
      currentStatus: input.eventType,
      occurredAt: iso(created.rows[0].occurred_at),
      duplicate: false,
    }
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
