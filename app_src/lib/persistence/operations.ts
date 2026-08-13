import { createHash, randomUUID } from 'node:crypto'
import type { PoolClient, QueryResultRow } from 'pg'
import { recordAuditEvent } from '@/lib/auditWriter'
import { normalizedCrmIdentityText } from '@/lib/crm/stableId'
import {
  executeShopifyFulfillmentWriteback,
  prepareShopifyFulfillmentWriteback,
  reconcileShopifyFulfillmentWriteback,
} from '@/lib/integrations/shopifyFulfillmentWriteback'
import {
  assertShopifyOrderPlanningAuthorityHash,
  inspectShopifyOrderPlanningAuthority,
  normalizeShopifyOrderPlanningAuthoritySnapshot,
  shopifyOrderPlanningAuthorityHash,
  ShopifyOrderPlanningAuthorityError,
  type ShopifyOrderPlanningAuthorityEvidence,
  type ShopifyOrderPlanningAuthoritySnapshot,
} from '@/lib/integrations/shopifyOrderPlanningAuthority'
import {
  inspectShopifyExternalFulfillment,
  ShopifyExternalFulfillmentReconciliationError,
} from '@/lib/integrations/shopifyExternalFulfillmentReconciliation'
import type {
  ShopifyExternalFulfillmentEvidence,
  ShopifyExternalFulfillmentTarget,
} from '@/lib/integrations/shopifyExternalFulfillmentEvidence'
import {
  executeCurrentFaireFulfillmentWriteback,
  prepareCurrentFaireFulfillmentAuthority,
} from '@/lib/integrations/faireFulfillmentRuntime'
import {
  commerceFulfillmentRecoveryMode,
  faireFulfillmentErrorAllowsAutomaticReconciliation,
} from '@/lib/commerceFulfillmentRecoveryPolicy'
import {
  consumeSandboxCommerceE2eAuthorization,
  readActiveSandboxCommerceE2eAuthorizationForOrderInPostgres,
  requireActiveSandboxCommerceE2eAuthorization,
} from '@/lib/persistence/sandboxCommerceE2eAuthorization'
import {
  assertCommerceOrderRevisionExecutionCurrent,
  CommerceOrderRevisionGateError,
} from '@/lib/persistence/commerceOrderRevisions'
import {
  MockCarrierAdapter,
  MockCommerceAdapter,
  MockPrintAdapter,
} from '@/lib/operations/adapters'
import {
  applyFreightPricing,
  assertCurrency,
  assertPositiveQuantity,
  availableOperationsOrderActions,
  cartonizeSinglePackage,
  DeterministicFulfillmentOptimizer,
  priceContract,
  selectPromiseRate,
} from '@/lib/operations/domain'
import {
  PACKAGE_PACK_WORK_INSTRUCTION_TEMPLATE_VERSION,
  PACKING_SLIP_TEMPLATE_VERSION,
  renderPackagePackWorkInstruction,
  renderPackingSlip,
} from '@/lib/operations/packingSlip'
import {
  locationBarcode,
  providerBarcodeIdentity,
} from '@/lib/operations/barcodeLabels'
import type {
  WearablePickTaskCountEvidenceInput,
  WearablePickTaskScanEvidenceInput,
} from '@/lib/operations/wearablePicking'
import {
  authorizedCheckoutShippingChargeMinor,
  CANONICAL_FULFILLMENT_RATE_POLICY_VERSION,
  CanonicalFulfillmentPlanningError,
  selectCanonicalFulfillmentRate,
  type CanonicalWholeShipmentRateOffer,
} from '@/lib/operations/canonicalFulfillmentPlanning'
import {
  rateCheckoutShipment,
  type CheckoutRateCarrierProvider,
  type CheckoutShipmentRateResult,
} from '@/lib/integrations/carrierCheckoutRate'
import {
  carrierSandboxRateDestinationFingerprint,
  testCarrierSandboxShipmentRate,
} from '@/lib/integrations/carrierIntegrations'
import type { OperationsCapabilities } from '@/lib/operations/authorization'
import {
  pickAssignmentFingerprint,
  type OperationsManagePickAssignmentResult,
} from '@/lib/operations/pickManagement'
import type {
  Address,
  CommerceCustomerIdentity,
  CommerceCustomerResolution,
  CommerceOrderInput,
  MockOperationsProofInput,
  MockOperationsProofLineInput,
  MockOperationsProofResult,
  OperationsActivationState,
  OperationsActivationUpdateResult,
  OperationsCommerceFulfillmentRetryResult,
  OperationsCustomerNotificationDecision,
  OperationsExceptionListItem,
  OperationsExceptionStatus,
  OperationsExceptionUpdateResult,
  OperationsExternalFulfillmentReconciliationResult,
  OperationsInboundReceiptCommandResult,
  OperationsInboundReceiptCompletionInput,
  OperationsInboundReceiptCreationResult,
  OperationsInboundReceiptInput,
  OperationsOrderDetail,
  OperationsOrderCommandResult,
  OperationsPlanCommandResult,
  OperationsOrderListItem,
  OperationsPackingSlipCommandResult,
  OperationsPickHandoffResult,
  OperationsOrderStatus,
  OperationsPutawayPlacement,
  OperationsReplenishmentExecutionInput,
  OperationsReplenishmentExecutionResult,
  OperationsShipmentCommandResult,
  OperationsShadowFulfillmentExecutionResult,
  OperationsWorkspace,
  PricingDirective,
} from '@/lib/operations/types'
import { stageCrmRecordWithClient } from '@/lib/persistence/crm'
import {
  readCartonizationRateEvidenceByGlobalId,
  type CartonizationRateEvidence,
} from '@/lib/persistence/cartonizationRateEvidence'
import { enqueueOperationsPrintJobInPostgres } from '@/lib/persistence/operationPrintDelivery'
import { readShadowFulfillmentPreparation } from '@/lib/persistence/operationShadowFulfillmentPreparation'
import { readDefaultProductPackagingWithClient } from '@/lib/persistence/productPackaging'
import {
  acquireTransactionAdvisoryLock,
  query,
  withTransaction,
} from '@/lib/persistence/postgres'
import {
  lockShopifyCarrierServiceConfigWritersForActivationWithClient,
  rebindRegisteredShopifyCarrierServicesForShadowActivationWithClient,
  ShopifyCheckoutRatingPersistenceError,
  shopifyCheckoutRateLineageIsRequired,
  shopifyCheckoutRateOutcomeAllowsFulfillment,
  type ShopifyCheckoutRateReconciliationOutcome,
} from '@/lib/persistence/shopifyCheckoutRating'

type PipelineRow = QueryResultRow & { id: string; name: string; owner_email: string }
type CustomerRow = QueryResultRow & { id: string; reference_code: string; name: string }
type CustomerIdentityRow = CustomerRow & {
  email: string | null
  phone: string | null
  website: string | null
}
type ProductRow = QueryResultRow & {
  id: string
  reference_code: string
  name: string
  sku: string | null
  price: string
}
type IdRow = QueryResultRow & { id: string; global_id: string }
type OrderLineIdentityRow = IdRow & { external_line_id: string }
type WarehouseRow = QueryResultRow & {
  id: string
  global_id: string
  code: string
  name: string
  facility_type: OperationsWorkspace['warehouses'][number]['facilityType']
  timezone: string
  address: Record<string, unknown>
  status: 'active' | 'inactive'
  cutoff_time: string | null
  carrier_cutoffs: Record<string, string>
  operating_days: number[]
  opens_at: string
  closes_at: string
  standard_processing_minutes: number
  daily_order_capacity: number | null
  row_version: string
}
type WarehouseLocationRow = QueryResultRow & {
  id: string
  global_id: string
  warehouse_id: string
  code: string
  zone: string
  location_type: OperationsWorkspace['warehouses'][number]['locations'][number]['locationType']
  topology_level: OperationsWorkspace['warehouses'][number]['locations'][number]['topologyLevel']
  parent_location_global_id: string | null
  pick_sequence: number
  active: boolean
  storage_function: OperationsWorkspace['warehouses'][number]['locations'][number]['storageFunction']
  max_volume_cubic_meters: string | null
  max_weight_kg: string | null
  used_volume_cubic_meters: string
  used_weight_kg: string
  allow_mixed_products: boolean
  notes: string | null
  row_version: string
}
type LocationProductRuleRow = QueryResultRow & {
  global_id: string
  location_id: string
  product_global_id: string
  product_name: string
  product_sku: string | null
  rule_type: OperationsWorkspace['warehouses'][number]['locations'][number]['productRules'][number]['ruleType']
  max_quantity: string | null
  replenishment_mode: OperationsWorkspace['warehouses'][number]['locations'][number]['productRules'][number]['replenishmentMode']
  replenishment_source_location_global_id: string | null
  replenishment_source_location_code: string | null
  min_quantity: string | null
  target_quantity: string | null
  active: boolean
}
type ReplenishmentRecommendationRow = QueryResultRow & {
  warehouse_global_id: string
  warehouse_name: string
  product_global_id: string
  product_name: string
  product_sku: string | null
  pool_global_id: string
  pool_name: string
  source_location_global_id: string
  source_location_code: string
  destination_location_global_id: string
  destination_location_code: string
  replenishment_mode: 'min_max' | 'order_demand'
  available_at_source: string
  available_at_destination: string
  released_demand: string
  min_quantity: string | null
  target_quantity: string
  recommended_quantity: string
}
type InventoryPoolRow = QueryResultRow & {
  id: string
  global_id: string
  name: string
  pool_type: OperationsWorkspace['inventoryPools'][number]['poolType']
  allocation_policy: OperationsWorkspace['inventoryPools'][number]['allocationPolicy']
  owner_customer_global_id: string | null
  owner_customer_name: string | null
  active: boolean
}
type InventoryPoolCustomerRow = QueryResultRow & {
  pool_id: string
  global_id: string
  name: string
  priority: number
}
type InboundReceiptRow = QueryResultRow & {
  id: string
  global_id: string
  reference_number: string
  status: OperationsWorkspace['inboundReceipts'][number]['status']
  warehouse_global_id: string
  warehouse_name: string
  pool_global_id: string
  pool_name: string
  expected_at: Date | null
  completed_at: Date | null
  row_version: string
}
type InboundReceiptLineRow = QueryResultRow & {
  id: string
  global_id: string
  receipt_id: string
  line_number: number
  product_global_id: string
  product_name: string
  product_sku: string | null
  location_global_id: string
  location_code: string
  expected_quantity: string
  accepted_quantity: string
  damaged_quantity: string
  lot_code: string
  unit_of_measure: string
}
type PositionRow = QueryResultRow & {
  id: string
  global_id: string
  warehouse_id: string
  warehouse_global_id: string
  warehouse_name: string
  location_id: string
  on_hand_quantity: string
  reserved_quantity: string
  source_authority: 'clawpilot' | 'shopify'
}
type OrderIdentityRow = QueryResultRow & {
  id: string
  global_id: string
  status: OperationsOrderStatus
  row_version?: string
  tracking_number?: string | null
}

type ActivationRow = QueryResultRow & {
  data_pipeline_id: string
  pipeline_name: string
  pipeline_owner_email: string
  state: OperationsActivationState
  revision: number
  reason: string | null
  updated_at: Date
}

type CommandReceiptRow = QueryResultRow & {
  id: string
  request_hash: string
  target_global_id: string | null
  status: 'processing' | 'succeeded' | 'failed'
  correlation_id: string
  result_global_id: string | null
  result_payload: Record<string, unknown> | null
  attempts: number
  updated_at: Date
}

type PutawayCandidateRow = QueryResultRow & {
  id: string
  global_id: string
  code: string
  location_type: 'storage' | 'pick'
  pick_sequence: number
  max_volume_cubic_meters: string | null
  max_weight_kg: string | null
  allow_mixed_products: boolean
  rule_type: 'allowed' | 'preferred' | 'restricted' | null
  rule_max_quantity: string | null
  used_volume_cubic_meters: string
  used_weight_kg: string
  product_quantity: string
  other_product_count: string
  unknown_profile_count: string
}

type ReceiptCommandRow = QueryResultRow & {
  id: string
  global_id: string
  pipeline_id: string
  warehouse_id: string
  inventory_pool_id: string
  status: OperationsWorkspace['inboundReceipts'][number]['status']
  row_version: string
}

type ReceiptCommandLineRow = QueryResultRow & {
  id: string
  global_id: string
  product_id: string
  product_global_id: string
  target_location_id: string
  expected_quantity: string
  lot_code: string
}

type InventoryBalanceRow = QueryResultRow & {
  id: string
  global_id: string
  on_hand_quantity: string
  reserved_quantity: string
  damaged_quantity: string
}

type ReplenishmentExecutionRuleRow = QueryResultRow & {
  rule_id: string
  rule_global_id: string
  replenishment_mode: 'min_max' | 'order_demand'
  min_quantity: string | null
  target_quantity: string
  warehouse_id: string
  warehouse_global_id: string
  product_id: string
  product_name: string
  product_sku: string | null
  source_location_id: string
  source_location_global_id: string
  source_location_code: string
  destination_location_id: string
  destination_location_global_id: string
  destination_location_code: string
}

type ExceptionRow = QueryResultRow & {
  id: string
  global_id: string
  exception_type: string
  severity: OperationsExceptionListItem['severity']
  status: OperationsExceptionStatus
  title: string
  details: Record<string, unknown>
  assigned_to: string | null
  order_global_id: string | null
  order_number: string | null
  customer_name: string | null
  customer_global_id: string | null
  created_at: Date
  updated_at: Date
  resolved_at: Date | null
}

type ProofConfiguration = {
  integration: IdRow
  warehouse: IdRow & { name: string; address: Record<string, unknown> }
  location: IdRow
  pool: IdRow
  positions: Map<string, PositionRow>
  contractVersion: IdRow
  directives: PricingDirective[]
  printer: IdRow
}

const MOCK_PROOF_STEPS = [
  'Imported the mocked commerce order',
  'Resolved the CRM customer and product mapping',
  'Validated tenant, contract, and inventory-pool ownership',
  'Locked the inventory position',
  'Reserved inventory without overselling',
  'Selected a complete single-warehouse fulfillment candidate',
  'Created a deterministic carton plan',
  'Retrieved deterministic mock carrier rates',
  'Selected the lowest-cost service that meets the promise',
  'Applied exact contract and freight pricing',
  'Created the fulfillment plan and allocation',
  'Released a warehouse wave',
  'Completed the pick task',
  'Packed the package',
  'Created a mock carrier label',
  'Routed and completed the mock print job',
  'Confirmed the shipment',
  'Consumed reserved inventory in the immutable ledger',
  'Accrued immutable billable events',
  'Recorded the channel fulfillment result through the outbox boundary',
] as const

const MOCK_PROOF_PLANNED_STEP_COUNT = 11

function proofSteps(status: OperationsOrderStatus): string[] {
  return status === 'planned'
    ? [...MOCK_PROOF_STEPS.slice(0, MOCK_PROOF_PLANNED_STEP_COUNT)]
    : [...MOCK_PROOF_STEPS]
}

export class OperationsRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message)
  }
}

async function requireCurrentCommerceOrderRevision(
  client: PoolClient,
  input: Parameters<typeof assertCommerceOrderRevisionExecutionCurrent>[1],
) {
  try {
    await assertCommerceOrderRevisionExecutionCurrent(client, input)
  } catch (error) {
    if (error instanceof CommerceOrderRevisionGateError) {
      throw new OperationsRequestError(error.code, error.message, error.status)
    }
    throw error
  }
}

function numberValue(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function integerMinor(value: unknown): bigint {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new OperationsRequestError('OPERATIONS_PRICE_INVALID', 'Price must use non-negative integer minor units')
  return BigInt(parsed)
}

function json(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function customerNotificationDecision(
  value: unknown,
): OperationsCustomerNotificationDecision {
  const source = json(value)
  if (
    source.mode === 'provider_managed'
    && source.source === 'provider_managed'
  ) {
    return {
      mode: 'provider_managed',
      notifyCustomer: null,
      source: 'provider_managed',
      accountPolicyRevision: null,
      overrideReason: null,
      decidedBy: typeof source.decidedBy === 'string'
        ? source.decidedBy
        : null,
    }
  }
  const explicitSources = [
    'account_default',
    'order_override',
    'sandbox_e2e_suppression',
    'legacy_safe_default',
  ] as const
  const sourceName = String(source.source || '')
  const explicitDecision = (
    source.mode === 'clawpilot_explicit'
    && explicitSources.includes(
      sourceName as typeof explicitSources[number],
    )
    && typeof source.notifyCustomer === 'boolean'
    && !(
      sourceName === 'sandbox_e2e_suppression'
      && source.notifyCustomer === true
    )
    && !(
      sourceName === 'legacy_safe_default'
      && source.notifyCustomer === true
    )
  )
  if (!explicitDecision) {
    return {
      mode: 'clawpilot_explicit',
      notifyCustomer: false,
      source: 'legacy_safe_default',
      accountPolicyRevision: null,
      overrideReason: null,
      decidedBy: null,
    }
  }
  return {
    mode: 'clawpilot_explicit',
    notifyCustomer: source.notifyCustomer as boolean,
    source: sourceName as OperationsCustomerNotificationDecision['source'],
    accountPolicyRevision: source.accountPolicyRevision !== null
      && source.accountPolicyRevision !== undefined
      && Number.isSafeInteger(Number(source.accountPolicyRevision))
      ? Number(source.accountPolicyRevision)
      : null,
    overrideReason: typeof source.overrideReason === 'string'
      ? source.overrideReason
      : null,
    decidedBy: typeof source.decidedBy === 'string'
      ? source.decidedBy
      : null,
  }
}

function hasRetainedShopifySandboxAuthorization(
  payloadValue: unknown,
  provider: unknown,
): boolean {
  const payload = json(payloadValue)
  const retainedSandboxAuthorizationGlobalId = String(
    payload.sandboxE2eAuthorizationGlobalId || '',
  ).trim()
  return (
    provider === 'shopify'
    && /^gsea(?:[0-9]{7}|[0-9a-v]{12})$/.test(
      retainedSandboxAuthorizationGlobalId,
    )
  )
}

function commerceExportCustomerNotificationDecision(
  payloadValue: unknown,
  provider: unknown,
): OperationsCustomerNotificationDecision {
  const payload = json(payloadValue)
  const decision = customerNotificationDecision(payload.customerNotification)
  if (
    decision.source === 'legacy_safe_default'
    && hasRetainedShopifySandboxAuthorization(payload, provider)
  ) {
    return {
      mode: 'clawpilot_explicit',
      notifyCustomer: false,
      source: 'sandbox_e2e_suppression',
      accountPolicyRevision: null,
      overrideReason: null,
      decidedBy: null,
    }
  }
  return decision
}

function address(value: unknown): Address {
  const source = json(value)
  return {
    name: String(source.name || ''),
    line1: String(source.line1 || ''),
    line2: source.line2 ? String(source.line2) : undefined,
    city: String(source.city || ''),
    region: String(source.region || ''),
    postalCode: String(source.postalCode || ''),
    country: String(source.country || ''),
  }
}

function exceptionListItem(row: ExceptionRow): OperationsExceptionListItem {
  return {
    id: row.id,
    globalId: row.global_id,
    exceptionType: row.exception_type,
    severity: row.severity,
    status: row.status,
    title: row.title,
    details: json(row.details),
    assignedTo: row.assigned_to,
    orderGlobalId: row.order_global_id,
    orderNumber: row.order_number,
    customerName: row.customer_name,
    customerGlobalId: row.customer_global_id,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    resolvedAt: row.resolved_at?.toISOString() || null,
  }
}

function moneyMinorFromDecimal(value: unknown): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) return 0
  const minor = Math.round(parsed * 100)
  if (!Number.isSafeInteger(minor)) throw new OperationsRequestError('OPERATIONS_PRICE_INVALID', 'Product price is outside the supported range')
  return minor
}

function carrierDecimalAmountMinor(value: unknown): number {
  const amount = String(value ?? '').trim()
  const match = /^([0-9]+)(?:\.([0-9]{1,2}))?$/.exec(amount)
  if (!match) {
    throw new OperationsRequestError(
      'OPERATIONS_CARRIER_RATE_MONEY_INVALID',
      'Carrier rate evidence does not use exact decimal currency',
      409,
    )
  }
  const minor = (
    BigInt(match[1]) * BigInt(100)
    + BigInt((match[2] || '').padEnd(2, '0') || '0')
  )
  if (minor > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new OperationsRequestError(
      'OPERATIONS_CARRIER_RATE_MONEY_INVALID',
      'Carrier rate evidence is outside the supported range',
      409,
    )
  }
  return Number(minor)
}

function estimatedDeliveryAt(
  evidenceCompletedAt: string,
  deliveryDate: string | null,
  transitDays: number | null,
): { deliveryAt: string; transitDays: number } | null {
  if (deliveryDate) {
    const delivery = /^\d{4}-\d{2}-\d{2}$/.test(deliveryDate)
      ? new Date(`${deliveryDate}T23:59:59.000Z`)
      : new Date(deliveryDate)
    if (!Number.isNaN(delivery.getTime())) {
      const completed = new Date(evidenceCompletedAt)
      const derivedTransit = Number.isNaN(completed.getTime())
        ? 0
        : Math.max(
            0,
            Math.ceil(
              (delivery.getTime() - completed.getTime())
              / 86_400_000,
            ),
          )
      return {
        deliveryAt: delivery.toISOString(),
        transitDays: Number.isSafeInteger(transitDays)
          && Number(transitDays) >= 0
          ? Number(transitDays)
          : derivedTransit,
      }
    }
  }
  if (!Number.isSafeInteger(transitDays) || Number(transitDays) < 0) {
    return null
  }
  const completed = new Date(evidenceCompletedAt)
  if (Number.isNaN(completed.getTime())) return null
  completed.setUTCDate(completed.getUTCDate() + Number(transitDays))
  return {
    deliveryAt: completed.toISOString(),
    transitDays: Number(transitDays),
  }
}

function canonicalRateOffers(
  evidence: CartonizationRateEvidence,
): CanonicalWholeShipmentRateOffer[] {
  const packageKeys = evidence.packages.map((item) => item.packageKey)
  return evidence.shipmentRates.flatMap((shipmentRate) => (
    shipmentRate.status !== 'succeeded'
    || shipmentRate.packageCount !== packageKeys.length
    || shipmentRate.packageKeys.some(
      (packageKey, index) => packageKey !== packageKeys[index],
    )
      ? []
      : shipmentRate.rates.flatMap((rate) => {
          const delivery = estimatedDeliveryAt(
            shipmentRate.completedAt,
            rate.deliveryDate,
            rate.transitDays,
          )
          if (!delivery) return []
          return [{
            evidenceState: 'sealed' as const,
            rateScope: 'multi_package_shipment' as const,
            rateEvidenceGlobalId: shipmentRate.rateEvidenceGlobalId,
            packagePlanHash: evidence.planResultHash,
            packageCount: packageKeys.length,
            packageKeys,
            provider: shipmentRate.provider,
            serviceCode: rate.serviceCode,
            serviceName: rate.serviceName,
            carrierCostMinor: carrierDecimalAmountMinor(rate.amount),
            currency: rate.currency,
            transitDays: delivery.transitDays,
            estimatedDeliveryAt: delivery.deliveryAt,
          }]
        })
  ))
}

function uniqueReferenceRows<T extends { reference_code: string }>(rows: T[]): T[] {
  return [...new Map(rows.map((row) => [row.reference_code, row])).values()]
}

function requireOrganizationId(value: string) {
  const organizationId = String(value || '').trim()
  if (!organizationId) throw new OperationsRequestError('ACTIVE_ORGANIZATION_REQUIRED', 'Select an active organization first', 409)
  return organizationId
}

async function requireEligibleOperationsPicker(
  client: PoolClient,
  organizationId: string,
  pickerEmail: string,
) {
  const result = await client.query<{ eligible: boolean }>(
    `SELECT (
       membership.role = 'owner'
       OR (
         COALESCE((membership.permissions->>'viewOperations')::boolean, false)
         AND COALESCE((membership.permissions->>'executeWarehouse')::boolean, false)
       )
     ) AS eligible
     FROM app_user_organization_memberships membership
     JOIN app_users app_user ON app_user.email = membership.user_email
     WHERE membership.organization_id = $1::uuid
       AND membership.user_email = $2
       AND membership.status = 'active'
       AND app_user.status = 'active'
     LIMIT 1`,
    [organizationId, pickerEmail],
  )
  const membership = result.rows[0]
  if (!membership) {
    throw new OperationsRequestError(
      'OPERATIONS_PICKER_NOT_FOUND',
      'The selected picker is not an active member of this workspace',
      409,
    )
  }
  if (!membership.eligible) {
    throw new OperationsRequestError(
      'OPERATIONS_PICKER_ACCESS_REQUIRED',
      'The selected worker needs Operations view and warehouse execution permission',
      409,
    )
  }
}

type ManageablePickTaskRow = QueryResultRow & {
  id: string
  global_id: string
  wave_id: string
  status: string
  quantity: string
  picked_quantity: string | null
  picked_at: string | Date | null
  assigned_to: string | null
}

type ManageablePickAssignmentContext = {
  plan: IdRow & { status: string }
  wave: IdRow & { status: string }
  tasks: ManageablePickTaskRow[]
  previousAssignedTo: string | null | 'mixed'
  assignmentFingerprint: string
  openHandoffExceptionGlobalId: string | null
  openManagerInterventionExceptionGlobalId: string | null
}

async function lockManageablePickAssignment(
  client: PoolClient,
  input: {
    organizationId: string
    orderId: string
    orderRowVersion: number
    expectedTaskCount?: number
    expectedAssignmentFingerprint?: string
  },
): Promise<ManageablePickAssignmentContext> {
  const planResult = await client.query<IdRow & { status: string }>(
    `SELECT id::text, global_id, status
     FROM operations_fulfillment_plans
     WHERE organization_id = $1::uuid AND order_id = $2::uuid
     ORDER BY version_number DESC, id DESC
     LIMIT 1
     FOR UPDATE`,
    [input.organizationId, input.orderId],
  )
  const plan = planResult.rows[0]
  if (!plan || plan.status !== 'released') {
    throw new OperationsRequestError(
      'OPERATIONS_PICK_ASSIGNMENT_INVALID',
      'The released fulfillment plan is unavailable for assignment',
      409,
    )
  }

  const waveResult = await client.query<IdRow & { status: string }>(
    `SELECT wave.id::text, wave.global_id, wave.status
     FROM operations_waves wave
     WHERE wave.organization_id = $1::uuid
       AND wave.id IN (
         SELECT DISTINCT pick.wave_id
         FROM operations_pick_tasks pick
         WHERE pick.organization_id = $1::uuid
           AND pick.plan_id = $2::uuid
       )
     ORDER BY wave.id
     FOR UPDATE`,
    [input.organizationId, plan.id],
  )
  if (waveResult.rows.length !== 1 || waveResult.rows[0].status !== 'released') {
    throw new OperationsRequestError(
      'OPERATIONS_PICK_ASSIGNMENT_INVALID',
      'Exactly one released warehouse wave is required for assignment',
      409,
    )
  }
  const wave = waveResult.rows[0]

  const taskResult = await client.query<ManageablePickTaskRow>(
    `SELECT pick.id::text, pick.global_id, pick.wave_id::text,
            pick.status, pick.quantity::text,
            pick.picked_quantity::text, pick.picked_at,
            lower(pick.assigned_to) AS assigned_to
     FROM operations_pick_tasks pick
     WHERE pick.organization_id = $1::uuid
       AND pick.plan_id = $2::uuid
     ORDER BY pick.sequence_number, pick.id
     FOR UPDATE`,
    [input.organizationId, plan.id],
  )
  const tasks = taskResult.rows
  if (tasks.length < 1) {
    throw new OperationsRequestError(
      'OPERATIONS_PICK_ASSIGNMENT_INVALID',
      'No pick tasks are available for assignment',
      409,
    )
  }
  if (
    input.expectedTaskCount !== undefined
    && tasks.length !== input.expectedTaskCount
  ) {
    throw new OperationsRequestError(
      'OPERATIONS_PICK_ASSIGNMENT_TASKS_CHANGED',
      'Pick tasks changed before the manager intervention could be saved',
      409,
    )
  }
  if (tasks.some((task) => (
    task.wave_id !== wave.id
    || task.status !== 'ready'
    || Number(task.picked_quantity || 0) !== 0
    || task.picked_at !== null
  ))) {
    throw new OperationsRequestError(
      'OPERATIONS_PICK_ASSIGNMENT_ALREADY_STARTED',
      'Assignment changes stop after any pick task has started or recorded a picked quantity',
      409,
    )
  }

  const assignmentFingerprint = pickAssignmentFingerprint(tasks.map((task) => ({
    pickTaskGlobalId: task.global_id,
    assignedTo: task.assigned_to,
  })))
  if (
    input.expectedAssignmentFingerprint
    && assignmentFingerprint !== input.expectedAssignmentFingerprint
  ) {
    throw new OperationsRequestError(
      'OPERATIONS_PICK_ASSIGNMENT_CHANGED',
      'The picker assignment changed before the manager intervention was saved. Refresh and try again.',
      409,
    )
  }

  const evidenceResult = await client.query<{
    scan_count: string
    count_count: string
  }>(
    `SELECT
       (SELECT count(*)::text
        FROM operations_wearable_pick_scan_evidence scan
        WHERE scan.organization_id = $1::uuid
          AND scan.order_id = $2::uuid
          AND scan.order_row_version = $3::bigint
          AND scan.pick_task_id = ANY($4::uuid[])) AS scan_count,
       (SELECT count(*)::text
        FROM operations_wearable_pick_count_evidence count_evidence
        WHERE count_evidence.organization_id = $1::uuid
          AND count_evidence.order_id = $2::uuid
          AND count_evidence.order_row_version = $3::bigint
          AND count_evidence.pick_task_id = ANY($4::uuid[])) AS count_count`,
    [
      input.organizationId,
      input.orderId,
      input.orderRowVersion,
      tasks.map((task) => task.id),
    ],
  )
  if (Number(evidenceResult.rows[0]?.scan_count || 0) > 0) {
    throw new OperationsRequestError(
      'OPERATIONS_PICK_ASSIGNMENT_SCAN_EVIDENCE_EXISTS',
      'Current-version scan evidence exists. Use picker handoff or resolve the physical work before changing assignment.',
      409,
    )
  }
  if (Number(evidenceResult.rows[0]?.count_count || 0) > 0) {
    throw new OperationsRequestError(
      'OPERATIONS_PICK_ASSIGNMENT_COUNT_EVIDENCE_EXISTS',
      'Current-version count evidence exists. Resolve the physical work before changing assignment.',
      409,
    )
  }

  const physicalWorkResult = await client.query<{
    package_started: string
    label_started: string
    shipment_started: string
  }>(
    `SELECT
       (SELECT count(*)::text
        FROM operations_packages package
        WHERE package.organization_id = $1::uuid
          AND package.plan_id = $2::uuid
          AND (package.status <> 'planned' OR package.packed_at IS NOT NULL))
         AS package_started,
       ((SELECT count(*)
         FROM operations_labels label
         JOIN operations_packages package
           ON package.organization_id = label.organization_id
          AND package.id = label.package_id
         WHERE label.organization_id = $1::uuid
           AND package.plan_id = $2::uuid)
        +
        (SELECT count(*)
         FROM operations_label_attempts attempt
         WHERE attempt.organization_id = $1::uuid
           AND attempt.order_id = $3::uuid))::text AS label_started,
       (SELECT count(*)::text
        FROM operations_shipments shipment
        WHERE shipment.organization_id = $1::uuid
          AND shipment.order_id = $3::uuid) AS shipment_started`,
    [input.organizationId, plan.id, input.orderId],
  )
  const physicalWork = physicalWorkResult.rows[0]
  if (Number(physicalWork?.package_started || 0) > 0) {
    throw new OperationsRequestError(
      'OPERATIONS_PICK_ASSIGNMENT_PACKING_STARTED',
      'Assignment changes stop after packing has started',
      409,
    )
  }
  if (Number(physicalWork?.label_started || 0) > 0) {
    throw new OperationsRequestError(
      'OPERATIONS_PICK_ASSIGNMENT_LABEL_STARTED',
      'Assignment changes stop after label preparation has started',
      409,
    )
  }
  if (Number(physicalWork?.shipment_started || 0) > 0) {
    throw new OperationsRequestError(
      'OPERATIONS_PICK_ASSIGNMENT_SHIPMENT_STARTED',
      'Assignment changes stop after shipment evidence exists',
      409,
    )
  }

  const assignments = new Set(tasks.map((task) => task.assigned_to || null))
  const previousAssignedTo = assignments.size === 1
    ? [...assignments][0]
    : 'mixed' as const
  const handoffResult = await client.query<{ global_id: string }>(
    `SELECT global_id
     FROM operations_exceptions
     WHERE organization_id = $1::uuid
       AND order_id = $2::uuid
       AND exception_type = 'picker_handoff_requested'
       AND status IN ('open', 'acknowledged')
     ORDER BY created_at DESC, id DESC
     LIMIT 1
     FOR SHARE`,
    [input.organizationId, input.orderId],
  )
  const managerInterventionResult = await client.query<{ global_id: string }>(
    `SELECT global_id
     FROM operations_exceptions
     WHERE organization_id = $1::uuid
       AND order_id = $2::uuid
       AND exception_type = 'manager_pick_intervention'
       AND status IN ('open', 'acknowledged')
     ORDER BY created_at DESC, id DESC
     LIMIT 1
     FOR SHARE`,
    [input.organizationId, input.orderId],
  )
  return {
    plan,
    wave,
    tasks,
    previousAssignedTo,
    assignmentFingerprint,
    openHandoffExceptionGlobalId: handoffResult.rows[0]?.global_id || null,
    openManagerInterventionExceptionGlobalId:
      managerInterventionResult.rows[0]?.global_id || null,
  }
}

const ACTIVATION_STATES = new Set<OperationsActivationState>([
  'disabled', 'shadow', 'read_only', 'active', 'frozen',
])

async function fallbackPipeline(client: PoolClient, organizationId: string): Promise<PipelineRow> {
  const result = await client.query<PipelineRow>(
    `SELECT pipeline.id::text, pipeline.name, pipeline.owner_email
     FROM pipeline_spaces pipeline
     LEFT JOIN app_user_organization_memberships membership
       ON membership.user_email = pipeline.owner_email
      AND membership.organization_id = pipeline.workspace_organization_id
     WHERE pipeline.workspace_organization_id = $1::uuid
     ORDER BY
       CASE
         WHEN membership.status = 'active' AND membership.role = 'owner' THEN 0
         WHEN membership.status = 'active' AND membership.role = 'admin' THEN 1
         WHEN membership.status = 'active' AND membership.role = 'member' THEN 2
         ELSE 3
       END,
       pipeline.is_default DESC,
       pipeline.updated_at DESC,
       pipeline.id
     LIMIT 1`,
    [organizationId],
  )
  if (!result.rows[0]) {
    throw new OperationsRequestError(
      'OPERATIONS_PIPELINE_REQUIRED',
      'Create a pipeline for this organization before configuring operations',
      409,
    )
  }
  return result.rows[0]
}

async function resolveActivation(
  client: PoolClient,
  organizationId: string,
  lock = false,
): Promise<ActivationRow> {
  const read = () => client.query<ActivationRow>(
    `SELECT activation.data_pipeline_id::text, pipeline.name AS pipeline_name,
            pipeline.owner_email AS pipeline_owner_email,
            activation.state, activation.revision, activation.reason,
            activation.updated_at
     FROM operations_activation_scopes activation
     JOIN pipeline_spaces pipeline
       ON pipeline.workspace_organization_id = activation.organization_id
      AND pipeline.id = activation.data_pipeline_id
     WHERE activation.organization_id = $1::uuid
     ${lock ? 'FOR UPDATE OF activation' : ''}`,
    [organizationId],
  )
  const existing = await read()
  if (existing.rows[0]) return existing.rows[0]

  const pipeline = await fallbackPipeline(client, organizationId)
  await client.query(
    `INSERT INTO operations_activation_scopes (
       organization_id, data_pipeline_id, state, reason
     ) VALUES ($1::uuid, $2::uuid, 'shadow', $3)
     ON CONFLICT (organization_id) DO NOTHING`,
    [organizationId, pipeline.id, 'Initial authoritative CRM projection selected by Operations'],
  )
  const created = await read()
  if (!created.rows[0]) {
    throw new OperationsRequestError('OPERATIONS_ACTIVATION_UNAVAILABLE', 'Operations activation could not be initialized', 409)
  }
  return created.rows[0]
}

async function resolvePipeline(client: PoolClient, organizationId: string): Promise<PipelineRow> {
  const activation = await resolveActivation(client, organizationId)
  return {
    id: activation.data_pipeline_id,
    name: activation.pipeline_name,
    owner_email: activation.pipeline_owner_email,
  }
}

function activationPayload(row: ActivationRow): OperationsActivationUpdateResult {
  return {
    state: row.state,
    revision: row.revision,
    reason: row.reason,
    updatedAt: row.updated_at.toISOString(),
    dataPipeline: { id: row.data_pipeline_id, name: row.pipeline_name },
  }
}

async function resolveCustomer(
  client: PoolClient,
  pipelineId: string,
  globalId: string,
): Promise<CustomerRow> {
  const result = await client.query<CustomerRow>(
    `SELECT id::text, reference_code, name
     FROM crm_organizations
     WHERE pipeline_id = $1::uuid AND reference_code = $2
     LIMIT 1`,
    [pipelineId, globalId],
  )
  if (!result.rows[0]) {
    throw new OperationsRequestError('OPERATIONS_CUSTOMER_NOT_FOUND', 'Select a CRM organization from the active workspace', 404)
  }
  return result.rows[0]
}

async function resolveProduct(
  client: PoolClient,
  pipelineId: string,
  globalId: string,
): Promise<ProductRow> {
  const result = await client.query<ProductRow>(
    `SELECT id::text, reference_code, name, NULLIF(btrim(sku), '') AS sku, price::text
     FROM crm_products
     WHERE pipeline_id = $1::uuid AND reference_code = $2 AND active = true
     LIMIT 1`,
    [pipelineId, globalId],
  )
  if (!result.rows[0]) {
    throw new OperationsRequestError('OPERATIONS_PRODUCT_NOT_FOUND', 'Select an active CRM product from the active workspace', 404)
  }
  return result.rows[0]
}

const GENERIC_EMAIL_DOMAINS = new Set([
  'aol.com', 'gmail.com', 'hotmail.com', 'icloud.com', 'live.com', 'me.com',
  'msn.com', 'outlook.com', 'proton.me', 'protonmail.com', 'yahoo.com',
])

function trimmed(value: unknown, maximum = 500): string {
  const result = String(value ?? '').trim()
  if (result.length > maximum || /[\u0000-\u001f\u007f]/.test(result)) {
    throw new OperationsRequestError('OPERATIONS_CUSTOMER_IDENTITY_INVALID', 'Commerce customer identity is invalid')
  }
  return result
}

function normalizedPhone(value: unknown): string {
  const digits = trimmed(value, 50).replace(/\D/g, '')
  return digits.length >= 7 ? digits : ''
}

function emailDomain(value: unknown): string {
  const email = normalizedCrmIdentityText(value)
  const domain = email.includes('@') ? email.split('@').at(-1) || '' : ''
  return domain && !GENERIC_EMAIL_DOMAINS.has(domain) ? domain : ''
}

function websiteDomain(value: unknown): string {
  const website = trimmed(value, 300).toLowerCase()
  if (!website) return ''
  try {
    const parsed = new URL(website.includes('://') ? website : `https://${website}`)
    return parsed.hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

function customerDomains(customer: CustomerIdentityRow): Set<string> {
  return new Set([
    websiteDomain(customer.website),
    emailDomain(customer.email),
  ].filter(Boolean))
}

function customerResolution(
  method: CommerceCustomerResolution['method'],
  candidates: CustomerIdentityRow[],
): CommerceCustomerResolution | null {
  const unique = [...new Map(candidates.map((candidate) => [candidate.reference_code, candidate])).values()]
  if (unique.length === 0) return null
  if (unique.length > 1) {
    return {
      status: 'ambiguous',
      method: 'ambiguous',
      customer: null,
      candidateGlobalIds: unique.map((candidate) => candidate.reference_code).sort(),
    }
  }
  const customer = unique[0]
  return {
    status: 'matched',
    method,
    customer: { id: customer.id, globalId: customer.reference_code, name: customer.name },
    candidateGlobalIds: [],
  }
}

function customerIdentityLockKey(identity: CommerceCustomerIdentity, companyName: string): string {
  const identityFingerprint = JSON.stringify({
    name: normalizedCrmIdentityText(companyName),
    email: normalizedCrmIdentityText(identity.email),
    phone: normalizedPhone(identity.phone),
    domain: websiteDomain(identity.website) || emailDomain(identity.email),
    postalCode: normalizedCrmIdentityText(identity.postalCode),
  })
  return createHash('sha256').update(identityFingerprint).digest('hex')
}

async function resolveCrmMutationActor(
  client: PoolClient,
  pipeline: PipelineRow,
  requestedActor: string,
): Promise<string> {
  const result = await client.query<QueryResultRow & { email: string }>(
    `SELECT email
     FROM app_users
     WHERE lower(email) IN (lower($1), lower($2))
       AND status = 'active'
     ORDER BY CASE WHEN lower(email) = lower($1) THEN 0 ELSE 1 END
     LIMIT 1`,
    [requestedActor, pipeline.owner_email],
  )
  if (!result.rows[0]?.email) {
    throw new OperationsRequestError(
      'OPERATIONS_CUSTOMER_ACTOR_UNAVAILABLE',
      'The authoritative CRM projection has no active application owner for customer creation',
      409,
    )
  }
  return result.rows[0].email
}

async function bindCommerceCustomerExternalId(
  client: PoolClient,
  input: {
    organizationId: string
    integrationAccountId: string
    externalCustomerId: string
    customer: { globalId: string }
    method: CommerceCustomerResolution['method']
    evidence: Record<string, unknown>
  },
) {
  const result = await client.query<{ entity_global_id: string }>(
    `INSERT INTO operations_external_identifiers (
       organization_id, integration_account_id, entity_type, entity_global_id,
       external_id, status, match_method, match_evidence, last_verified_at
     ) VALUES ($1::uuid, $2::uuid, 'crm.organization', $3, $4,
       'active', $5, $6::jsonb, now())
     ON CONFLICT (organization_id, integration_account_id, entity_type, external_id)
     DO UPDATE SET status = 'active',
                   last_verified_at = now()
     RETURNING entity_global_id`,
    [
      input.organizationId,
      input.integrationAccountId,
      input.customer.globalId,
      input.externalCustomerId,
      input.method,
      JSON.stringify(input.evidence),
    ],
  )
  if (result.rows[0]?.entity_global_id !== input.customer.globalId) {
    throw new OperationsRequestError(
      'OPERATIONS_CUSTOMER_IDENTITY_CONFLICT',
      'This provider customer is already bound to a different CRM customer',
      409,
    )
  }
}

export async function resolveCommerceCustomerInPostgres(input: {
  organizationId: string
  integrationAccountGlobalId: string
  actorEmail: string
  identity: CommerceCustomerIdentity
}): Promise<CommerceCustomerResolution> {
  const organizationId = requireOrganizationId(input.organizationId)
  const actorEmail = trimmed(input.actorEmail, 320).toLowerCase()
  const integrationAccountGlobalId = trimmed(input.integrationAccountGlobalId, 20)
  const provider = trimmed(input.identity.provider, 100).toLowerCase()
  const externalCustomerId = trimmed(input.identity.externalCustomerId, 512)
  const companyName = trimmed(input.identity.companyName, 200)
  if (!actorEmail || !integrationAccountGlobalId || !provider || !externalCustomerId || !companyName) {
    throw new OperationsRequestError('OPERATIONS_CUSTOMER_IDENTITY_INVALID', 'Commerce customer identity is incomplete')
  }

  return withTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(
      client,
      `operations:commerce-customer:${organizationId}:${integrationAccountGlobalId}:${externalCustomerId}`,
    )
    await acquireTransactionAdvisoryLock(
      client,
      `operations:commerce-customer-identity:${organizationId}:${customerIdentityLockKey(input.identity, companyName)}`,
    )
    const integrationResult = await client.query<IdRow & { provider: string }>(
      `SELECT id::text, global_id, provider
       FROM operations_integration_accounts
       WHERE organization_id = $1::uuid AND global_id = $2
         AND integration_type = 'commerce' AND status = 'active'
       LIMIT 1`,
      [organizationId, integrationAccountGlobalId],
    )
    const integration = integrationResult.rows[0]
    if (!integration || integration.provider.toLowerCase() !== provider) {
      throw new OperationsRequestError(
        'OPERATIONS_COMMERCE_INTEGRATION_NOT_FOUND',
        'Select an active commerce integration for this provider',
        404,
      )
    }
    const pipeline = await resolvePipeline(client, organizationId)
    const mapped = await client.query<CustomerIdentityRow>(
      `SELECT customer.id::text, customer.reference_code, customer.name,
              customer.email, customer.phone, customer.website
       FROM operations_external_identifiers external_id
       JOIN crm_organizations customer
         ON customer.pipeline_id = $3::uuid
        AND customer.reference_code = external_id.entity_global_id
       WHERE external_id.organization_id = $1::uuid
         AND external_id.integration_account_id = $2::uuid
         AND external_id.entity_type = 'crm.organization'
         AND external_id.external_id = $4
         AND external_id.status = 'active'
       LIMIT 1`,
      [organizationId, integration.id, pipeline.id, externalCustomerId],
    )
    if (mapped.rows[0]) {
      const customer = mapped.rows[0]
      await bindCommerceCustomerExternalId(client, {
        organizationId,
        integrationAccountId: integration.id,
        externalCustomerId,
        customer: { globalId: customer.reference_code },
        method: 'external_id',
        evidence: { provider, externalCustomerId },
      })
      return {
        status: 'matched',
        method: 'external_id',
        customer: { id: customer.id, globalId: customer.reference_code, name: customer.name },
        candidateGlobalIds: [],
      }
    }

    const candidates = await client.query<CustomerIdentityRow>(
      `SELECT id::text, reference_code, name, email, phone, website
       FROM crm_organizations
       WHERE pipeline_id = $1::uuid
         AND COALESCE(lower(source_payload->>'archived'), 'false') NOT IN ('true', '1', 'yes')
       ORDER BY updated_at DESC, id
       LIMIT 1000`,
      [pipeline.id],
    )
    const normalizedEmail = normalizedCrmIdentityText(input.identity.email)
    const normalizedName = normalizedCrmIdentityText(companyName)
    const phone = normalizedPhone(input.identity.phone)
    const contactCandidates = normalizedEmail
      ? await client.query<CustomerIdentityRow>(
        `SELECT organization.id::text, organization.reference_code, organization.name,
                organization.email, organization.phone, organization.website
         FROM crm_contacts contact
         JOIN crm_organizations organization
           ON organization.pipeline_id = contact.pipeline_id
          AND organization.id = contact.organization_id
         WHERE contact.pipeline_id = $1::uuid
           AND lower(btrim(contact.email)) = $2
           AND COALESCE(lower(contact.source_payload->>'archived'), 'false') NOT IN ('true', '1', 'yes')
           AND COALESCE(lower(organization.source_payload->>'archived'), 'false') NOT IN ('true', '1', 'yes')
         ORDER BY organization.updated_at DESC, organization.id`,
        [pipeline.id, normalizedEmail],
      )
      : { rows: [] as CustomerIdentityRow[] }
    const domains = new Set([
      websiteDomain(input.identity.website),
      emailDomain(input.identity.email),
    ].filter(Boolean))
    const matchTiers: Array<{
      method: CommerceCustomerResolution['method']
      candidates: CustomerIdentityRow[]
    }> = [
      {
        method: 'email',
        candidates: normalizedEmail
          ? candidates.rows.filter((candidate) => normalizedCrmIdentityText(candidate.email) === normalizedEmail)
          : [],
      },
      {
        method: 'contact_email',
        candidates: contactCandidates.rows,
      },
      {
        method: 'website_domain',
        candidates: domains.size
          ? candidates.rows.filter((candidate) => [...customerDomains(candidate)].some((domain) => domains.has(domain)))
          : [],
      },
      {
        method: 'name_phone',
        candidates: phone
          ? candidates.rows.filter((candidate) => (
            normalizedCrmIdentityText(candidate.name) === normalizedName
            && normalizedPhone(candidate.phone) === phone
          ))
          : [],
      },
      {
        method: 'exact_name',
        candidates: candidates.rows.filter((candidate) => normalizedCrmIdentityText(candidate.name) === normalizedName),
      },
    ]

    for (const tier of matchTiers) {
      const resolution = customerResolution(tier.method, tier.candidates)
      if (!resolution) continue
      if (resolution.status === 'ambiguous') {
        await recordAuditEvent({
          actor: actorEmail,
          eventType: 'operations.customer_resolution.review_required',
          aggregateType: 'operations.integration_account',
          aggregateId: integration.global_id,
          subject: companyName,
          organizationId,
          eventKey: `operations:customer-resolution:${integration.global_id}:${externalCustomerId}:ambiguous`,
          payload: {
            provider,
            externalCustomerId,
            attemptedMethod: tier.method,
            candidateGlobalIds: resolution.candidateGlobalIds,
          },
        }, client)
        return resolution
      }
      await bindCommerceCustomerExternalId(client, {
        organizationId,
        integrationAccountId: integration.id,
        externalCustomerId,
        customer: { globalId: resolution.customer!.globalId },
        method: resolution.method,
        evidence: { provider, externalCustomerId, matchedBy: resolution.method },
      })
      return resolution
    }

    const workspaceRoot = await client.query<QueryResultRow & { id: string; suitecrm_id: string | null }>(
      `SELECT id::text, suitecrm_id
       FROM crm_organizations
       WHERE pipeline_id = $1::uuid AND workspace_organization_id = $2::uuid
       ORDER BY CASE relationship_type WHEN 'workspace_root' THEN 0 ELSE 1 END, updated_at DESC
       LIMIT 1`,
      [pipeline.id, organizationId],
    )
    const root = workspaceRoot.rows[0]
    const crmMutationActor = await resolveCrmMutationActor(client, pipeline, actorEmail)
    const staged = await stageCrmRecordWithClient(client, {
      entity: 'organizations',
      pipelineId: pipeline.id,
      sourceKey: `commerce:${provider}:${externalCustomerId}`,
      sourcePayload: {
        source: 'commerce_provider',
        provider,
        externalCustomerId,
        requestedActor: actorEmail,
      },
      actorEmail: crmMutationActor,
      fields: {
        parentOrganizationId: root?.id || null,
        parentOrganizationSuiteCrmId: root?.suitecrm_id || null,
        relationshipType: 'customer',
        name: companyName,
        website: trimmed(input.identity.website, 300) || undefined,
        phone: trimmed(input.identity.phone, 50) || undefined,
        email: trimmed(input.identity.email, 320) || undefined,
        address: trimmed(input.identity.address, 300) || undefined,
        city: trimmed(input.identity.city, 100) || undefined,
        state: trimmed(input.identity.region, 100) || undefined,
        postalCode: trimmed(input.identity.postalCode, 30) || undefined,
        country: trimmed(input.identity.country, 100) || undefined,
        description: `Created from ${provider} customer ${externalCustomerId}.`,
      },
    })
    const created: CommerceCustomerResolution = {
      status: 'created',
      method: 'created',
      customer: { id: staged.id, globalId: staged.referenceCode, name: companyName },
      candidateGlobalIds: [],
    }
    await bindCommerceCustomerExternalId(client, {
      organizationId,
      integrationAccountId: integration.id,
      externalCustomerId,
      customer: { globalId: staged.referenceCode },
      method: 'created',
      evidence: { provider, externalCustomerId, created: true },
    })
    return created
  })
}

async function appendDomainEvent(client: PoolClient, input: {
  organizationId: string
  aggregateType: string
  aggregateId: string
  aggregateGlobalId: string
  eventType: string
  actorEmail: string
  correlationId: string
  idempotencyKey: string
  payload?: Record<string, unknown>
}) {
  await client.query(
    `INSERT INTO operations_domain_events (
       organization_id, aggregate_type, aggregate_id, aggregate_global_id,
       event_type, payload, actor_email, correlation_id, idempotency_key
     ) VALUES ($1::uuid, $2, $3::uuid, $4, $5, $6::jsonb, $7, $8::uuid, $9)
     ON CONFLICT (organization_id, idempotency_key) DO NOTHING`,
    [
      input.organizationId,
      input.aggregateType,
      input.aggregateId,
      input.aggregateGlobalId,
      input.eventType,
      JSON.stringify(input.payload || {}),
      input.actorEmail,
      input.correlationId,
      input.idempotencyKey,
    ],
  )
}

async function ensureProofConfiguration(
  client: PoolClient,
  input: {
    organizationId: string
    pipeline: PipelineRow
    customer: CustomerRow
    products: ProductRow[]
    actorEmail: string
    currency: string
  },
): Promise<ProofConfiguration> {
  await acquireTransactionAdvisoryLock(client, `operations:proof-config:${input.organizationId}`)

  const integrationResult = await client.query<IdRow>(
    `INSERT INTO operations_integration_accounts (
       organization_id, provider, integration_type, environment, display_name,
       status, configuration, created_by, updated_by
     ) VALUES ($1::uuid, 'mock-commerce', 'commerce', 'mock', 'Mock commerce proof',
       'active', '{"mock":true}'::jsonb, $2, $2)
     ON CONFLICT (organization_id, integration_type, provider, environment)
     DO UPDATE SET status = 'active', display_name = EXCLUDED.display_name,
       configuration = EXCLUDED.configuration, updated_by = EXCLUDED.updated_by, updated_at = now()
     RETURNING id::text, global_id`,
    [input.organizationId, input.actorEmail],
  )
  const integration = integrationResult.rows[0]

  const warehouseResult = await client.query<IdRow & { name: string; address: Record<string, unknown> }>(
    `INSERT INTO operations_warehouses (
       organization_id, code, name, timezone, address, status, created_by, updated_by
     ) VALUES ($1::uuid, 'MOCK-01', 'Mock proof warehouse', 'America/New_York',
       $2::jsonb, 'active', $3, $3)
     ON CONFLICT (organization_id, code)
     DO UPDATE SET name = EXCLUDED.name, address = EXCLUDED.address, status = 'active',
       updated_by = EXCLUDED.updated_by, updated_at = now()
     RETURNING id::text, global_id, name, address`,
    [
      input.organizationId,
      JSON.stringify({
        name: 'Mock proof warehouse',
        line1: '100 Proof Way',
        city: 'Fairfield',
        region: 'CT',
        postalCode: '06824',
        country: 'US',
      }),
      input.actorEmail,
    ],
  )
  const warehouse = warehouseResult.rows[0]

  const locationResult = await client.query<IdRow>(
    `INSERT INTO operations_locations (
       organization_id, warehouse_id, code, zone, location_type, pick_sequence, active, created_by
     ) VALUES ($1::uuid, $2::uuid, 'PICK-01', 'PRIMARY', 'pick', 10, true, $3)
     ON CONFLICT (organization_id, warehouse_id, code)
     DO UPDATE SET active = true, zone = EXCLUDED.zone, location_type = EXCLUDED.location_type,
       pick_sequence = EXCLUDED.pick_sequence, updated_at = now()
     RETURNING id::text, global_id`,
    [input.organizationId, warehouse.id, input.actorEmail],
  )
  const location = locationResult.rows[0]

  const poolName = `Proof pool ${input.customer.reference_code}`
  const poolResult = await client.query<IdRow>(
    `INSERT INTO operations_inventory_pools (
       organization_id, pipeline_id, owner_customer_id, name, pool_type,
       allocation_policy, active, created_by
     ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'customer_dedicated', 'fifo', true, $5)
     ON CONFLICT (organization_id, name)
     DO UPDATE SET active = true, updated_at = now()
     WHERE operations_inventory_pools.pipeline_id = EXCLUDED.pipeline_id
       AND operations_inventory_pools.owner_customer_id = EXCLUDED.owner_customer_id
       AND operations_inventory_pools.pool_type = 'customer_dedicated'
     RETURNING id::text, global_id`,
    [input.organizationId, input.pipeline.id, input.customer.id, poolName, input.actorEmail],
  )
  const pool = poolResult.rows[0]
  if (!pool) {
    throw new OperationsRequestError(
      'OPERATIONS_POOL_OWNERSHIP_CONFLICT',
      'The proof inventory pool is already owned by another customer',
      409,
    )
  }
  await client.query(
    `INSERT INTO operations_inventory_pool_customers (
       organization_id, pool_id, pipeline_id, customer_id, priority, approved_by
     ) SELECT $1::uuid, $2::uuid, $3::uuid, $4::uuid, 1, $5
     WHERE NOT EXISTS (
       SELECT 1 FROM operations_inventory_pool_customers
       WHERE organization_id = $1::uuid AND pool_id = $2::uuid
         AND customer_id = $4::uuid AND effective_to IS NULL
     )`,
    [input.organizationId, pool.id, input.pipeline.id, input.customer.id, input.actorEmail],
  )

  const positions = new Map<string, PositionRow>()
  for (const product of [...input.products].sort((left, right) => left.id.localeCompare(right.id))) {
    await client.query(
      `INSERT INTO operations_product_mappings (
         organization_id, integration_account_id, pipeline_id, product_id,
       channel_sku, external_product_id, active, created_by
       ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, true, $7)
       ON CONFLICT (organization_id, integration_account_id, channel_sku)
       WHERE channel_sku IS NOT NULL
         AND mapping_method = 'legacy_sku'
       DO UPDATE SET pipeline_id = EXCLUDED.pipeline_id, product_id = EXCLUDED.product_id,
         external_product_id = EXCLUDED.external_product_id, active = true, updated_at = now()`,
      [
        input.organizationId,
        integration.id,
        input.pipeline.id,
        product.id,
        product.sku || product.reference_code,
        product.reference_code,
        input.actorEmail,
      ],
    )

    const positionInsert = await client.query<IdRow>(
      `INSERT INTO operations_inventory_positions (
         organization_id, pipeline_id, warehouse_id, location_id, pool_id, product_id
       ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid)
       ON CONFLICT (organization_id, warehouse_id, location_id, pool_id, product_id, lot_code)
       DO UPDATE SET updated_at = operations_inventory_positions.updated_at
       RETURNING id::text, global_id`,
      [input.organizationId, input.pipeline.id, warehouse.id, location.id, pool.id, product.id],
    )
    const positionResult = await client.query<PositionRow>(
      `SELECT position.id::text, position.global_id,
              position.warehouse_id::text, warehouse.global_id AS warehouse_global_id,
              warehouse.name AS warehouse_name, position.location_id::text,
              position.on_hand_quantity::text,
              position.reserved_quantity::text,
              position.source_authority
       FROM operations_inventory_positions position
       JOIN operations_warehouses warehouse
         ON warehouse.organization_id = position.organization_id AND warehouse.id = position.warehouse_id
       WHERE position.organization_id = $1::uuid AND position.id = $2::uuid
       FOR UPDATE OF position`,
      [input.organizationId, positionInsert.rows[0].id],
    )
    positions.set(product.id, positionResult.rows[0])
  }

  const contractName = `Mock proof fulfillment ${input.currency}`
  const contractResult = await client.query<IdRow>(
    `INSERT INTO operations_contracts (
       organization_id, pipeline_id, customer_id, name, status, created_by
     ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'active', $5)
     ON CONFLICT (organization_id, customer_id, name)
     DO UPDATE SET status = 'active', updated_at = now()
     RETURNING id::text, global_id`,
    [input.organizationId, input.pipeline.id, input.customer.id, contractName, input.actorEmail],
  )
  const contract = contractResult.rows[0]
  await client.query(
    `INSERT INTO operations_contract_versions (
       organization_id, contract_id, version_number, effective_from, currency,
       status, terms_snapshot, published_by
     ) SELECT $1::uuid, $2::uuid, 1, '2000-01-01T00:00:00Z'::timestamptz,
       $3, 'published', '{"proof":true}'::jsonb, $4
     WHERE NOT EXISTS (
       SELECT 1 FROM operations_contract_versions WHERE contract_id = $2::uuid AND version_number = 1
     )`,
    [input.organizationId, contract.id, input.currency, input.actorEmail],
  )
  const contractVersionResult = await client.query<IdRow>(
    `SELECT id::text, global_id FROM operations_contract_versions
     WHERE organization_id = $1::uuid AND contract_id = $2::uuid AND version_number = 1`,
    [input.organizationId, contract.id],
  )
  const contractVersion = contractVersionResult.rows[0]

  const defaultDirectives: Array<Pick<PricingDirective, 'type' | 'priority' | 'configuration'>> = [
    { type: 'fixed_order_fee', priority: 10, configuration: { amountMinor: 250 } },
    { type: 'pick_fee', priority: 20, configuration: { amountMinor: 35 } },
    { type: 'pack_fee', priority: 30, configuration: { amountMinor: 125 } },
    { type: 'freight_markup_percent', priority: 40, configuration: { basisPoints: 1_500 } },
  ]
  for (const directive of defaultDirectives) {
    await client.query(
      `INSERT INTO operations_pricing_directives (
         organization_id, contract_version_id, directive_type, priority, configuration
       ) SELECT $1::uuid, $2::uuid, $3, $4, $5::jsonb
       WHERE NOT EXISTS (
         SELECT 1 FROM operations_pricing_directives
         WHERE organization_id = $1::uuid AND contract_version_id = $2::uuid
           AND directive_type = $3 AND priority = $4
       )`,
      [input.organizationId, contractVersion.id, directive.type, directive.priority, JSON.stringify(directive.configuration)],
    )
  }
  const directiveResult = await client.query<QueryResultRow & {
    id: string
    global_id: string
    directive_type: PricingDirective['type']
    priority: number
    configuration: Record<string, unknown>
  }>(
    `SELECT id::text, global_id, directive_type, priority, configuration
     FROM operations_pricing_directives
     WHERE organization_id = $1::uuid AND contract_version_id = $2::uuid
     ORDER BY priority, global_id`,
    [input.organizationId, contractVersion.id],
  )
  const directives: PricingDirective[] = directiveResult.rows.map((directive) => ({
    id: directive.id,
    globalId: directive.global_id,
    type: directive.directive_type,
    priority: directive.priority,
    configuration: json(directive.configuration),
  }))

  const printerResult = await client.query<IdRow>(
    `INSERT INTO operations_printers (
       organization_id, warehouse_id, code, name, station_type,
       supports_zpl, priority, status, created_by
     ) VALUES ($1::uuid, $2::uuid, 'MOCK-ZPL-01', 'Mock ZPL printer',
       'pack', true, 1, 'online', $3)
     ON CONFLICT (organization_id, warehouse_id, code)
     DO UPDATE SET status = 'online', priority = 1, updated_at = now()
     RETURNING id::text, global_id`,
    [input.organizationId, warehouse.id, input.actorEmail],
  )
  const printer = printerResult.rows[0]
  await client.query(
    `INSERT INTO operations_rules (
       organization_id, rule_type, name, priority, conditions, actions, active, created_by
     ) VALUES ($1::uuid, 'printer_route', 'Mock proof ZPL route', 1,
       '{"labelFormat":"ZPL"}'::jsonb, $2::jsonb, true, $3)
     ON CONFLICT (organization_id, rule_type, name)
     DO UPDATE SET priority = 1, conditions = EXCLUDED.conditions,
       actions = EXCLUDED.actions, active = true, updated_at = now()`,
    [input.organizationId, JSON.stringify({ printerGlobalId: printer.global_id }), input.actorEmail],
  )

  return { integration, warehouse, location, pool, positions, contractVersion, directives, printer }
}

async function transitionOrder(
  client: PoolClient,
  input: {
    organizationId: string
    order: OrderIdentityRow
    status: OperationsOrderStatus
    eventType: string
    actorEmail: string
    correlationId: string
    eventKey: string
    payload?: Record<string, unknown>
    promisedDeliveryAt?: string
  },
) {
  await client.query(
    `UPDATE operations_orders SET status = $3,
       promised_delivery_at = COALESCE($4::timestamptz, promised_delivery_at),
       updated_by = $5, updated_at = now(), row_version = row_version + 1
     WHERE organization_id = $1::uuid AND id = $2::uuid`,
    [input.organizationId, input.order.id, input.status, input.promisedDeliveryAt || null, input.actorEmail],
  )
  await appendDomainEvent(client, {
    organizationId: input.organizationId,
    aggregateType: 'operations.order',
    aggregateId: input.order.id,
    aggregateGlobalId: input.order.global_id,
    eventType: input.eventType,
    actorEmail: input.actorEmail,
    correlationId: input.correlationId,
    idempotencyKey: `${input.order.global_id}:${input.eventKey}`,
    payload: { status: input.status, ...(input.payload || {}) },
  })
}

async function prepareAndReserveInventory(
  client: PoolClient,
  input: {
    organizationId: string
    order: OrderIdentityRow
    orderLine: IdRow
    position: PositionRow
    quantity: number
    openingQuantity: number
    actorEmail: string
  },
): Promise<IdRow> {
  if (input.position.source_authority !== 'clawpilot') {
    throw new OperationsRequestError(
      'OPERATIONS_INVENTORY_SOURCE_AUTHORITY_CONFLICT',
      'Shopify-authoritative inventory is already reserved in Shopify and cannot be reserved a second time by this workflow',
      409,
    )
  }
  let onHand = numberValue(input.position.on_hand_quantity)
  let reserved = numberValue(input.position.reserved_quantity)
  const requestedOpening = Math.max(0, input.openingQuantity)
  const topUp = Math.max(0, requestedOpening - onHand)
  if (topUp > 0) {
    onHand += topUp
    await client.query(
      `UPDATE operations_inventory_positions
       SET on_hand_quantity = $3, version = version + 1, updated_at = now()
       WHERE organization_id = $1::uuid AND id = $2::uuid`,
      [input.organizationId, input.position.id, onHand],
    )
    await client.query(
      `INSERT INTO operations_inventory_ledger (
         organization_id, position_id, event_type, on_hand_delta, reserved_delta,
         on_hand_after, reserved_after, source_global_id, reason, idempotency_key, actor_email
       ) VALUES ($1::uuid, $2::uuid, 'opening_balance', $3, 0, $4, $5,
         $6, 'Mock proof inventory setup', $7, $8)
       ON CONFLICT (organization_id, idempotency_key) DO NOTHING`,
      [
        input.organizationId,
        input.position.id,
        topUp,
        onHand,
        reserved,
        input.order.global_id,
        `${input.order.global_id}:${input.orderLine.global_id}:opening-balance`,
        input.actorEmail,
      ],
    )
  }

  const available = onHand - reserved
  if (available < input.quantity) {
    throw new OperationsRequestError(
      'OPERATIONS_INVENTORY_INSUFFICIENT',
      `Only ${available} units are available in the selected customer inventory pool`,
      409,
    )
  }

  reserved += input.quantity
  await client.query(
    `UPDATE operations_inventory_positions
     SET reserved_quantity = $3, version = version + 1, updated_at = now()
     WHERE organization_id = $1::uuid AND id = $2::uuid`,
    [input.organizationId, input.position.id, reserved],
  )
  const reservationResult = await client.query<IdRow>(
    `INSERT INTO operations_reservations (
       organization_id, order_id, order_line_id, position_id, quantity,
       status, idempotency_key, created_by
     ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5,
       'active', $6, $7)
     RETURNING id::text, global_id`,
    [
      input.organizationId,
      input.order.id,
      input.orderLine.id,
      input.position.id,
      input.quantity,
      `${input.order.global_id}:${input.orderLine.global_id}:reservation`,
      input.actorEmail,
    ],
  )
  await client.query(
    `INSERT INTO operations_inventory_ledger (
       organization_id, position_id, event_type, on_hand_delta, reserved_delta,
       on_hand_after, reserved_after, source_global_id, reason, idempotency_key, actor_email
     ) VALUES ($1::uuid, $2::uuid, 'reservation', 0, $3, $4, $5,
       $6, 'Reserved for mock proof order', $7, $8)`,
    [
      input.organizationId,
      input.position.id,
      input.quantity,
      onHand,
      reserved,
      input.order.global_id,
      `${input.order.global_id}:${input.orderLine.global_id}:reservation-ledger`,
      input.actorEmail,
    ],
  )
  return reservationResult.rows[0]
}

async function consumeReservedInventory(
  client: PoolClient,
  input: {
    organizationId: string
    order: OrderIdentityRow
    position: PositionRow
    reservation: IdRow
    quantity: number
    actorEmail: string
  },
) {
  if (input.position.source_authority !== 'clawpilot') {
    throw new OperationsRequestError(
      'OPERATIONS_INVENTORY_SOURCE_AUTHORITY_CONFLICT',
      'Shopify-authoritative inventory cannot be consumed by the local reservation workflow',
      409,
    )
  }
  const lockedResult = await client.query<QueryResultRow & {
    on_hand_quantity: string
    reserved_quantity: string
  }>(
    `SELECT on_hand_quantity::text, reserved_quantity::text
     FROM operations_inventory_positions
     WHERE organization_id = $1::uuid AND id = $2::uuid
     FOR UPDATE`,
    [input.organizationId, input.position.id],
  )
  const onHand = numberValue(lockedResult.rows[0]?.on_hand_quantity) - input.quantity
  const reserved = numberValue(lockedResult.rows[0]?.reserved_quantity) - input.quantity
  if (onHand < 0 || reserved < 0) {
    throw new OperationsRequestError(
      'OPERATIONS_INVENTORY_CONCURRENCY_CONFLICT',
      'Reserved inventory changed before shipment confirmation',
      409,
    )
  }
  await client.query(
    `UPDATE operations_inventory_positions
     SET on_hand_quantity = $3, reserved_quantity = $4,
       version = version + 1, updated_at = now()
     WHERE organization_id = $1::uuid AND id = $2::uuid`,
    [input.organizationId, input.position.id, onHand, reserved],
  )
  const consumedReservation = await client.query(
    `UPDATE operations_reservations SET status = 'consumed', released_at = now()
     WHERE organization_id = $1::uuid
       AND id = $2::uuid
       AND status = 'active'
       AND reservation_authority = 'local_balance'
     RETURNING id`,
    [input.organizationId, input.reservation.id],
  )
  if (consumedReservation.rowCount !== 1) {
    throw new OperationsRequestError(
      'OPERATIONS_RESERVATION_CHANGED',
      'The local inventory reservation changed before shipment confirmation. Refresh and replan the order.',
      409,
    )
  }
  await client.query(
    `INSERT INTO operations_inventory_ledger (
       organization_id, position_id, event_type, on_hand_delta, reserved_delta,
       on_hand_after, reserved_after, source_global_id, reason, idempotency_key, actor_email
     ) VALUES ($1::uuid, $2::uuid, 'ship', $3, $4, $5, $6,
       $7, 'Shipment confirmed', $8, $9)`,
    [
      input.organizationId,
      input.position.id,
      -input.quantity,
      -input.quantity,
      onHand,
      reserved,
      input.order.global_id,
      `${input.order.global_id}:${input.reservation.global_id}:shipment-ledger`,
      input.actorEmail,
    ],
  )
}

async function consumeProviderCommitment(
  client: PoolClient,
  input: {
    organizationId: string
    reservation: IdRow
  },
) {
  const consumed = await client.query(
    `UPDATE operations_reservations
     SET status = 'consumed', released_at = now()
     WHERE organization_id = $1::uuid
       AND id = $2::uuid
       AND status = 'active'
       AND reservation_authority = 'provider_commitment'
     RETURNING id`,
    [input.organizationId, input.reservation.id],
  )
  if (consumed.rowCount !== 1) {
    throw new OperationsRequestError(
      'OPERATIONS_PROVIDER_COMMITMENT_CHANGED',
      'The Shopify inventory commitment changed before shipment confirmation. Refresh the order before retrying.',
      409,
    )
  }
}

async function consumePackagingMaterialClaimsForPlan(
  client: PoolClient,
  input: {
    organizationId: string
    planId: string
    cartonizationEvidenceId: string | null
    actorEmail: string
  },
) {
  const claimResult = await client.query<QueryResultRow & {
    id: string
    global_id: string
    packaging_material_stock_id: string
    quantity: string
    status: 'active' | 'consumed' | 'released'
    stock_on_hand_quantity: string | null
    stock_is_available: boolean
  }>(
    `SELECT claim.id::text, claim.global_id,
            claim.packaging_material_stock_id::text,
            claim.quantity::text, claim.status,
            stock.on_hand_quantity::text AS stock_on_hand_quantity,
            stock.is_available AS stock_is_available
     FROM operations_packaging_material_claims claim
     JOIN operations_packaging_material_stock stock
       ON stock.organization_id = claim.organization_id
      AND stock.id = claim.packaging_material_stock_id
     WHERE claim.organization_id = $1::uuid
       AND claim.plan_id = $2::uuid
     ORDER BY claim.packaging_material_stock_id, claim.id
     FOR UPDATE OF claim, stock`,
    [input.organizationId, input.planId],
  )
  const claims = claimResult.rows
  if (input.cartonizationEvidenceId && claims.length < 1) {
    throw new OperationsRequestError(
      'OPERATIONS_PACKAGING_MATERIAL_CLAIMS_REQUIRED',
      'The sealed cartonization plan has no active packaging-material claims. Replan the order before confirming shipment.',
      409,
    )
  }
  if (claims.some((claim) => claim.status !== 'active')) {
    throw new OperationsRequestError(
      'OPERATIONS_PACKAGING_MATERIAL_CLAIMS_CHANGED',
      'Packaging-material claims changed before shipment confirmation. Refresh and replan the order.',
      409,
    )
  }

  const quantityByStock = new Map<string, number>()
  for (const claim of claims) {
    const quantity = Number(claim.quantity)
    const onHandQuantity = claim.stock_on_hand_quantity === null
      ? null
      : Number(claim.stock_on_hand_quantity)
    if (
      !claim.stock_is_available
      || onHandQuantity === null
      || onHandQuantity < quantity
    ) {
      throw new OperationsRequestError(
        'OPERATIONS_PACKAGING_MATERIAL_STOCK_CHANGED',
        'Physical packaging stock no longer covers the accepted plan. Replenish stock or replan the order.',
        409,
      )
    }
    quantityByStock.set(
      claim.packaging_material_stock_id,
      (quantityByStock.get(claim.packaging_material_stock_id) || 0)
        + quantity,
    )
  }
  for (const claim of claims) {
    const available = claim.stock_on_hand_quantity === null
      ? 0
      : Number(claim.stock_on_hand_quantity)
    const claimed = quantityByStock.get(
      claim.packaging_material_stock_id,
    ) || 0
    if (available < claimed) {
      throw new OperationsRequestError(
        'OPERATIONS_PACKAGING_MATERIAL_STOCK_CHANGED',
        'Physical packaging stock no longer covers the accepted plan. Replenish stock or replan the order.',
        409,
      )
    }
  }

  const consumedClaims = await client.query(
    `UPDATE operations_packaging_material_claims
     SET status = 'consumed', consumed_at = now(),
         updated_by = $3, updated_at = now()
     WHERE organization_id = $1::uuid
       AND plan_id = $2::uuid
       AND status = 'active'
     RETURNING id`,
    [input.organizationId, input.planId, input.actorEmail],
  )
  if (Number(consumedClaims.rowCount || 0) !== claims.length) {
    throw new OperationsRequestError(
      'OPERATIONS_PACKAGING_MATERIAL_CLAIMS_CHANGED',
      'Packaging-material claims changed before shipment confirmation. Refresh and replan the order.',
      409,
    )
  }

  for (const [stockId, quantity] of quantityByStock) {
    const consumedStock = await client.query(
      `UPDATE operations_packaging_material_stock
       SET on_hand_quantity = on_hand_quantity - $3,
           row_version = row_version + 1,
           updated_by = $4, updated_at = now()
       WHERE organization_id = $1::uuid
         AND id = $2::uuid
         AND is_available = true
         AND on_hand_quantity IS NOT NULL
         AND on_hand_quantity >= $3
       RETURNING id`,
      [input.organizationId, stockId, quantity, input.actorEmail],
    )
    if (consumedStock.rowCount !== 1) {
      throw new OperationsRequestError(
        'OPERATIONS_PACKAGING_MATERIAL_STOCK_CHANGED',
        'Physical packaging stock changed before shipment confirmation. Refresh and replan the order.',
        409,
      )
    }
  }

  return {
    claimCount: claims.length,
    quantity: claims.reduce(
      (total, claim) => total + Number(claim.quantity),
      0,
    ),
  }
}

function providerCommitmentValidationFailed(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || '')
  return [
    'Provider commitment',
    'Shopify-authoritative balances changed',
    'Active provider commitment claims exceed',
  ].some((fragment) => message.includes(fragment))
}

async function revalidateProviderCommitmentsForPlan(
  client: PoolClient,
  input: {
    organizationId: string
    planId: string
  },
): Promise<{
  count: number
  latestInventorySyncRunGlobalIds: string[]
}> {
  const positionResult = await client.query<QueryResultRow & {
    position_id: string
  }>(
    `SELECT DISTINCT allocation.position_id::text AS position_id
     FROM operations_fulfillment_allocations allocation
     WHERE allocation.organization_id = $1::uuid
       AND allocation.plan_id = $2::uuid
     ORDER BY allocation.position_id::text`,
    [input.organizationId, input.planId],
  )
  for (const position of positionResult.rows) {
    await acquireTransactionAdvisoryLock(
      client,
      [
        'operations:inventory-reservation',
        input.organizationId,
        position.position_id,
      ].join(':'),
    )
  }

  const authorityResult = await client.query<QueryResultRow & {
    source_authority: 'clawpilot' | 'shopify'
    reservation_authority: 'local_balance' | 'provider_commitment'
    reservation_status: 'active' | 'released' | 'consumed'
    reservation_id: string
  }>(
    `SELECT position.source_authority,
            reservation.reservation_authority,
            reservation.status AS reservation_status,
            reservation.id::text AS reservation_id
     FROM operations_fulfillment_allocations allocation
     JOIN operations_inventory_positions position
       ON position.organization_id = allocation.organization_id
      AND position.id = allocation.position_id
     JOIN operations_reservations reservation
       ON reservation.organization_id = allocation.organization_id
      AND reservation.id = allocation.reservation_id
     WHERE allocation.organization_id = $1::uuid
       AND allocation.plan_id = $2::uuid
     ORDER BY allocation.id
     FOR UPDATE OF position, reservation`,
    [input.organizationId, input.planId],
  )
  const providerAllocations = authorityResult.rows.filter(
    (row) => row.source_authority === 'shopify',
  )
  if (providerAllocations.length < 1) {
    return {
      count: 0,
      latestInventorySyncRunGlobalIds: [],
    }
  }
  if (providerAllocations.some((row) => (
    row.reservation_authority !== 'provider_commitment'
    || row.reservation_status !== 'active'
  ))) {
    throw new OperationsRequestError(
      'OPERATIONS_PROVIDER_COMMITMENT_INVALID',
      'Shopify inventory allocations no longer have active provider commitments. Refresh inventory and replan the order.',
      409,
    )
  }

  const reservationIds = [
    ...new Set(providerAllocations.map((row) => row.reservation_id)),
  ]
  try {
    const revalidated = await client.query(
      `UPDATE operations_reservations
       SET status = status
       WHERE organization_id = $1::uuid
         AND id = ANY($2::uuid[])
         AND status = 'active'
         AND reservation_authority = 'provider_commitment'
       RETURNING id`,
      [input.organizationId, reservationIds],
    )
    if (Number(revalidated.rowCount || 0) !== reservationIds.length) {
      throw new OperationsRequestError(
        'OPERATIONS_PROVIDER_COMMITMENT_CHANGED',
        'Shopify inventory commitments changed before warehouse release. Refresh inventory and replan the order.',
        409,
      )
    }
  } catch (error) {
    if (error instanceof OperationsRequestError) throw error
    if (providerCommitmentValidationFailed(error)) {
      throw new OperationsRequestError(
        'OPERATIONS_PROVIDER_COMMITMENT_CHANGED',
        'Shopify inventory no longer supports this fulfillment plan. Refresh inventory and replan the order.',
        409,
      )
    }
    throw error
  }

  const supportResult = await client.query<QueryResultRow & {
    reservation_id: string
    supported: boolean
    reason_code: string
    latest_sync_run_global_id: string | null
  }>(
    `WITH target_reservations AS (
       SELECT unnest($2::uuid[]) AS reservation_id
     )
     SELECT support.reservation_id::text,
            support.supported,
            support.reason_code,
            support.latest_inventory_sync_run_global_id
              AS latest_sync_run_global_id
     FROM target_reservations target
     CROSS JOIN LATERAL operations_provider_commitment_current_support(
       $1::uuid,
       target.reservation_id
     ) support
     ORDER BY support.reservation_id`,
    [input.organizationId, reservationIds],
  )
  if (
    supportResult.rows.length !== reservationIds.length
    || supportResult.rows.some((row) => (
      !row.supported || !row.latest_sync_run_global_id
    ))
  ) {
    throw new OperationsRequestError(
      'OPERATIONS_PROVIDER_COMMITMENT_CHANGED',
      'Shopify inventory no longer supports this fulfillment plan. Refresh inventory and replan the order.',
      409,
    )
  }

  return {
    count: reservationIds.length,
    latestInventorySyncRunGlobalIds: [
      ...new Set(supportResult.rows.map(
        (row) => row.latest_sync_run_global_id as string,
      )),
    ].sort(),
  }
}

type NativeOneOffShipmentAvailability = {
  ready: boolean
  blockedReason: string | null
}

async function readNativeOneOffShipmentAvailability(input: {
  organizationId: string
  orderId: string
  planId: string | null
  executionMode: 'test' | 'live' | null
  activationState: OperationsActivationState
}): Promise<NativeOneOffShipmentAvailability> {
  if (!input.planId || !input.executionMode) {
    return {
      ready: false,
      blockedReason: 'Select TEST or LIVE and purchase the exact packed shipment first.',
    }
  }
  const result = await query<QueryResultRow & {
    state: 'prepared' | 'succeeded' | 'failed' | 'unknown'
    environment: 'sandbox' | 'production'
    package_count: string
    authority_exact: boolean
    canonical_package_count: string
    canonical_labeled_package_count: string
    member_count: string
    result_count: string
    active_group_label_count: string
    active_plan_label_count: string
    invalid_member_result_count: string
    close_blocker_count: string
    allocated_total_matches: boolean
  }>(
    `WITH latest_create AS (
       SELECT attempt.*
       FROM operations_one_off_carrier_group_attempts attempt
       WHERE attempt.organization_id = $1::uuid
         AND attempt.order_id = $2::uuid
         AND attempt.plan_id = $3::uuid
         AND attempt.action = 'create'
       ORDER BY attempt.requested_at DESC, attempt.id DESC
       LIMIT 1
     )
     SELECT attempt.state, attempt.environment,
            attempt.package_count::text,
            operations_one_off_plan_execution_is_exact(
              attempt.organization_id,
              attempt.plan_id,
              CASE WHEN attempt.environment = 'sandbox' THEN 'test' ELSE 'live' END
            ) AS authority_exact,
            (SELECT count(*)::text
             FROM operations_packages package
             WHERE package.organization_id = attempt.organization_id
               AND package.plan_id = attempt.plan_id) AS canonical_package_count,
            (SELECT count(*)::text
             FROM operations_packages package
             WHERE package.organization_id = attempt.organization_id
               AND package.plan_id = attempt.plan_id
               AND package.status = 'labeled') AS canonical_labeled_package_count,
            (SELECT count(*)::text
             FROM operations_one_off_carrier_group_members member
             WHERE member.organization_id = attempt.organization_id
               AND member.carrier_group_attempt_id = attempt.id) AS member_count,
            (SELECT count(*)::text
             FROM operations_one_off_carrier_group_results package_result
             WHERE package_result.organization_id = attempt.organization_id
               AND package_result.carrier_group_attempt_id = attempt.id) AS result_count,
            (SELECT count(*)::text
             FROM operations_labels label
             WHERE label.organization_id = attempt.organization_id
               AND label.one_off_carrier_group_attempt_id = attempt.id
               AND label.status = 'created'
               AND label.one_off_void_group_attempt_id IS NULL)
              AS active_group_label_count,
            (SELECT count(*)::text
             FROM operations_labels label
             JOIN operations_packages package
               ON package.organization_id = label.organization_id
              AND package.id = label.package_id
             WHERE label.organization_id = attempt.organization_id
               AND package.plan_id = attempt.plan_id
               AND label.status = 'created') AS active_plan_label_count,
            (SELECT count(*)::text
             FROM operations_one_off_carrier_group_members member
             LEFT JOIN operations_packages package
               ON package.organization_id = member.organization_id
              AND package.id = member.package_id
              AND package.plan_id = member.plan_id
             LEFT JOIN operations_one_off_carrier_group_results package_result
               ON package_result.organization_id = member.organization_id
              AND package_result.carrier_group_attempt_id = member.carrier_group_attempt_id
              AND package_result.package_id = member.package_id
             LEFT JOIN operations_labels label
               ON label.organization_id = package_result.organization_id
              AND label.id = package_result.label_id
             WHERE member.organization_id = attempt.organization_id
               AND member.carrier_group_attempt_id = attempt.id
               AND (
                 package.id IS NULL
                 OR package.status <> 'labeled'
                 OR package.package_number <> member.package_number
                 OR package_result.id IS NULL
                 OR package_result.package_number <> member.package_number
                 OR label.id IS NULL
                 OR label.package_id <> member.package_id
                 OR label.one_off_carrier_group_attempt_id <> attempt.id
                 OR label.one_off_void_group_attempt_id IS NOT NULL
                 OR label.status <> 'created'
                 OR label.environment <> attempt.environment
                 OR label.tracking_number <> package_result.tracking_number
               )) AS invalid_member_result_count,
            (SELECT count(*)::text
             FROM operations_one_off_carrier_group_attempts closed
             WHERE closed.organization_id = attempt.organization_id
               AND closed.create_attempt_id = attempt.id
               AND closed.action IN ('void', 'close_sample')
               AND closed.state IN ('prepared', 'succeeded', 'unknown'))
              AS close_blocker_count,
            COALESCE((
              SELECT sum(member.allocated_selected_cost_minor)
              FROM operations_one_off_carrier_group_members member
              WHERE member.organization_id = attempt.organization_id
                AND member.carrier_group_attempt_id = attempt.id
            ), 0) = attempt.selected_amount_minor AS allocated_total_matches
     FROM latest_create attempt`,
    [input.organizationId, input.orderId, input.planId],
  )
  const row = result.rows[0]
  if (!row) {
    return {
      ready: false,
      blockedReason: 'Purchase one complete one-off carrier shipment group first.',
    }
  }
  if (row.state === 'prepared' || row.state === 'unknown') {
    return {
      ready: false,
      blockedReason: 'Resolve the pending one-off carrier group before confirming shipment.',
    }
  }
  if (row.state !== 'succeeded') {
    return {
      ready: false,
      blockedReason: 'The latest one-off carrier group did not succeed. Re-rate and retry the group.',
    }
  }
  const expectedEnvironment = input.executionMode === 'test'
    ? 'sandbox'
    : 'production'
  const expectedActivation = input.executionMode === 'test'
    ? 'shadow'
    : 'active'
  if (
    row.environment !== expectedEnvironment
    || input.activationState !== expectedActivation
    || !row.authority_exact
  ) {
    return {
      ready: false,
      blockedReason: input.executionMode === 'test'
        ? 'TEST confirmation requires exact sandbox authority in Operations Shadow.'
        : 'LIVE confirmation requires exact production authority in Operations Active.',
    }
  }
  const packageCount = Number(row.package_count)
  if (
    packageCount < 1
    || Number(row.canonical_package_count) !== packageCount
    || Number(row.canonical_labeled_package_count) !== packageCount
    || Number(row.member_count) !== packageCount
    || Number(row.result_count) !== packageCount
    || Number(row.active_group_label_count) !== packageCount
    || Number(row.active_plan_label_count) !== packageCount
    || Number(row.invalid_member_result_count) !== 0
    || Number(row.close_blocker_count) !== 0
    || !row.allocated_total_matches
  ) {
    return {
      ready: false,
      blockedReason: 'The one-off carrier group is partial, closed, or no longer matches every packed package.',
    }
  }
  return { ready: true, blockedReason: null }
}

async function readOrderDetail(
  organizationId: string,
  orderGlobalId: string,
  context: {
    activationState: OperationsActivationState
    canExecute: boolean
    canManage: boolean
    canActivate: boolean
    actorEmail: string | null
    canAuthorizeSandboxCommerceE2e: boolean
  },
): Promise<OperationsOrderDetail | null> {
  const orderResult = await query<QueryResultRow & {
    id: string
    global_id: string
    order_number: string
    external_order_id: string
    customer_name: string
    customer_global_id: string
    source_provider: string
    order_type: string
    integration_account_id: string
    integration_account_global_id: string | null
    planning_candidate_global_id: string | null
    planning_candidate_row_version: string | null
    notify_customer_default: boolean | null
    notification_policy_revision: string | number | null
    status: OperationsOrderStatus
    currency: string
    row_version: string
    plan_id: string | null
    warehouse_id: string | null
    plan_status: string | null
    wave_status: string | null
    warehouse_name: string | null
    promised_delivery_at: Date | null
    line_count: string
    fully_reserved_line_count: string
    allocated_line_count: string
    pick_task_count: string
    ready_pick_task_count: string
    picked_pick_task_count: string
    package_count: string
    planned_package_count: string
    packed_package_count: string
    active_label_count: string
    shippable_label_count: string
    sandbox_label_count: string
    unresolved_label_attempt_count: string
    existing_shipment_count: string
    exception_count: string
    blocking_exception_count: string
    expected_cost_minor: string | null
    expected_revenue_minor: string | null
    expected_margin_minor: string | null
    tracking_number: string | null
    ship_to: Record<string, unknown>
    updated_at: Date
    one_off_shipping_mode: 'test' | 'live' | null
    shopify_external_fulfillment_reconciliation_required: boolean
  }>(
    `SELECT
       orders.id::text, orders.global_id, orders.order_number, orders.external_order_id,
       customer.name AS customer_name, customer.reference_code AS customer_global_id,
       orders.source_provider, orders.order_type,
       orders.integration_account_id::text,
       source_account.global_id AS integration_account_global_id,
       planning_candidate.global_id AS planning_candidate_global_id,
       planning_candidate.row_version::text
         AS planning_candidate_row_version,
       notification_policy.notify_customer_default,
       notification_policy.revision::text AS notification_policy_revision,
       orders.status, orders.currency, orders.ship_to,
       orders.row_version::text, plan.id::text AS plan_id,
       plan.warehouse_id::text AS warehouse_id,
       one_off_quote.execution_mode AS one_off_shipping_mode,
       plan.status AS plan_status, wave.status AS wave_status,
       operations_shopify_external_fulfillment_reconciliation_required(
         orders.organization_id,
         plan.id
       ) AS shopify_external_fulfillment_reconciliation_required,
       plan_warehouse.name AS warehouse_name, orders.promised_delivery_at,
       (SELECT count(*) FROM operations_current_order_lines line WHERE line.order_id = orders.id)::text AS line_count,
       (SELECT count(*) FROM operations_current_order_lines line
        WHERE line.organization_id = orders.organization_id
          AND line.order_id = orders.id
          AND COALESCE((
            SELECT sum(reservation.quantity)
            FROM operations_fulfillment_allocations allocation
            JOIN operations_reservations reservation
              ON reservation.organization_id =
                   allocation.organization_id
             AND reservation.id = allocation.reservation_id
            WHERE allocation.organization_id = line.organization_id
              AND allocation.plan_id = plan.id
              AND allocation.order_line_id = line.id
              AND reservation.order_line_id = allocation.order_line_id
              AND reservation.position_id = allocation.position_id
              AND reservation.quantity = allocation.quantity
              AND reservation.status = 'active'
          ), 0) = line.quantity)::text AS fully_reserved_line_count,
       (SELECT count(*) FROM operations_current_order_lines line
        WHERE line.organization_id = orders.organization_id AND line.order_id = orders.id
          AND COALESCE((
            SELECT sum(allocation.quantity)
            FROM operations_fulfillment_allocations allocation
            WHERE allocation.organization_id = line.organization_id
              AND allocation.order_line_id = line.id AND allocation.plan_id = plan.id
          ), 0) = line.quantity)::text AS allocated_line_count,
       (SELECT count(*) FROM operations_pick_tasks pick
        WHERE pick.organization_id = orders.organization_id AND pick.plan_id = plan.id)::text AS pick_task_count,
       (SELECT count(*) FROM operations_pick_tasks pick
        WHERE pick.organization_id = orders.organization_id AND pick.plan_id = plan.id
          AND pick.status = 'ready')::text AS ready_pick_task_count,
       (SELECT count(*) FROM operations_pick_tasks pick
        WHERE pick.organization_id = orders.organization_id AND pick.plan_id = plan.id
          AND pick.status = 'picked' AND pick.picked_quantity = pick.quantity)::text AS picked_pick_task_count,
       (SELECT count(*) FROM operations_packages package
        WHERE package.organization_id = orders.organization_id AND package.plan_id = plan.id)::text AS package_count,
       (SELECT count(*) FROM operations_packages package
        WHERE package.organization_id = orders.organization_id AND package.plan_id = plan.id
          AND package.status = 'planned')::text AS planned_package_count,
       (SELECT count(*) FROM operations_packages package
        WHERE package.organization_id = orders.organization_id AND package.plan_id = plan.id
          AND package.status IN ('packed', 'labeled', 'shipped'))::text AS packed_package_count,
       (SELECT count(*) FROM operations_labels label
        JOIN operations_packages package
          ON package.organization_id = label.organization_id
         AND package.id = label.package_id
        WHERE label.organization_id = orders.organization_id
          AND package.plan_id = plan.id
          AND label.status = 'created')::text AS active_label_count,
       (SELECT count(*) FROM operations_labels label
        JOIN operations_packages package
          ON package.organization_id = label.organization_id
         AND package.id = label.package_id
        WHERE label.organization_id = orders.organization_id
          AND package.plan_id = plan.id
          AND label.status = 'created'
          AND label.environment IN ('mock', 'production'))::text AS shippable_label_count,
       (SELECT count(*) FROM operations_labels label
        JOIN operations_packages package
          ON package.organization_id = label.organization_id
         AND package.id = label.package_id
        WHERE label.organization_id = orders.organization_id
          AND package.plan_id = plan.id
          AND label.status = 'created'
          AND label.environment = 'sandbox')::text AS sandbox_label_count,
       (SELECT count(*) FROM operations_label_attempts attempt
        WHERE attempt.organization_id = orders.organization_id
          AND attempt.order_id = orders.id
          AND attempt.state IN ('prepared', 'unknown'))::text AS unresolved_label_attempt_count,
       (SELECT count(*) FROM operations_shipments existing_shipment
        WHERE existing_shipment.organization_id = orders.organization_id
          AND existing_shipment.order_id = orders.id)::text AS existing_shipment_count,
       (SELECT count(*) FROM operations_exceptions exception
        WHERE exception.order_id = orders.id AND exception.status IN ('open', 'acknowledged'))::text AS exception_count,
       (SELECT count(*) FROM operations_exceptions exception
        WHERE exception.order_id = orders.id AND exception.status IN ('open', 'acknowledged')
          AND exception.severity IN ('high', 'critical'))::text AS blocking_exception_count,
       plan.estimated_cost_minor::text, plan.estimated_revenue_minor::text, plan.estimated_margin_minor::text,
       shipment.tracking_number, orders.updated_at
     FROM operations_orders orders
     JOIN crm_organizations customer ON customer.id = orders.customer_id AND customer.pipeline_id = orders.pipeline_id
     LEFT JOIN operations_integration_accounts source_account
       ON source_account.organization_id = orders.organization_id
      AND source_account.id = orders.integration_account_id
     LEFT JOIN LATERAL (
       SELECT candidate.global_id, candidate.row_version
       FROM operations_commerce_order_candidates candidate
       WHERE candidate.organization_id = orders.organization_id
         AND candidate.integration_account_id = orders.integration_account_id
         AND candidate.canonical_order_id = orders.id
         AND candidate.workflow_state = 'promoted'
       ORDER BY candidate.promoted_at DESC, candidate.id DESC
       LIMIT 1
     ) planning_candidate ON true
     LEFT JOIN operations_shopify_fulfillment_notification_policies notification_policy
       ON notification_policy.organization_id = orders.organization_id
      AND notification_policy.integration_account_id = orders.integration_account_id
     LEFT JOIN LATERAL (
       SELECT candidate.* FROM operations_fulfillment_plans candidate
       WHERE candidate.order_id = orders.id ORDER BY candidate.version_number DESC LIMIT 1
     ) plan ON true
     LEFT JOIN operations_warehouses plan_warehouse ON plan_warehouse.id = plan.warehouse_id
     LEFT JOIN operations_one_off_shipment_quotes one_off_quote
       ON one_off_quote.organization_id = plan.organization_id
      AND one_off_quote.id = plan.one_off_quote_id
     LEFT JOIN LATERAL (
       SELECT candidate.status FROM operations_pick_tasks pick
       JOIN operations_waves candidate
         ON candidate.organization_id = pick.organization_id AND candidate.id = pick.wave_id
       WHERE pick.organization_id = orders.organization_id AND pick.plan_id = plan.id
       ORDER BY candidate.created_at DESC, candidate.id DESC LIMIT 1
     ) wave ON true
     LEFT JOIN LATERAL (
       SELECT candidate.tracking_number FROM operations_shipments candidate
       WHERE candidate.order_id = orders.id ORDER BY candidate.shipped_at DESC LIMIT 1
     ) shipment ON true
     WHERE orders.organization_id = $1::uuid AND orders.global_id = $2
       AND orders.archived_at IS NULL
     LIMIT 1`,
    [organizationId, orderGlobalId],
  )
  const row = orderResult.rows[0]
  if (!row) return null

  const [
    lineResult,
    packageResult,
    packageContentResult,
    rateResult,
    billableResult,
    labelAttemptResult,
    shipmentResult,
    trackingResult,
    artifactResult,
    commerceExportResult,
    eventResult,
    fulfillmentPreparation,
    sandboxCommerceE2eAuthorization,
    nativeOneOffShipmentAvailability,
  ] = await Promise.all([
    query<QueryResultRow & {
      global_id: string
      product_global_id: string
      product_name: string
      channel_sku: string
      quantity: string
      reserved_quantity: string
      pick_status: string | null
    }>(
      `SELECT line.global_id, product.reference_code AS product_global_id, product.name AS product_name,
              line.channel_sku, line.quantity::text,
              reservation.reserved_quantity,
              pick.status AS pick_status
       FROM operations_current_order_lines line
       JOIN crm_products product ON product.id = line.product_id AND product.pipeline_id = line.pipeline_id
       LEFT JOIN LATERAL (
         SELECT COALESCE(sum(candidate.quantity), 0)::text
                  AS reserved_quantity
         FROM operations_fulfillment_allocations allocation
         JOIN operations_reservations candidate
           ON candidate.organization_id = allocation.organization_id
          AND candidate.id = allocation.reservation_id
         WHERE allocation.organization_id = line.organization_id
           AND allocation.order_line_id = line.id
           AND allocation.plan_id = $3::uuid
           AND candidate.order_line_id = allocation.order_line_id
           AND candidate.position_id = allocation.position_id
           AND candidate.quantity = allocation.quantity
           AND candidate.status = 'active'
       ) reservation ON true
       LEFT JOIN LATERAL (
         SELECT CASE
           WHEN count(task.id) = 0 THEN NULL
           WHEN bool_and(task.status = 'picked') THEN 'picked'
           WHEN bool_and(task.status = 'ready') THEN 'ready'
           WHEN bool_or(task.status = 'short') THEN 'short'
           WHEN bool_or(task.status = 'in_progress') THEN 'in_progress'
           WHEN bool_or(task.status = 'cancelled') THEN 'cancelled'
           ELSE 'mixed'
         END AS status
         FROM operations_fulfillment_allocations allocation
         LEFT JOIN operations_pick_tasks task
           ON task.organization_id = allocation.organization_id
          AND task.allocation_id = allocation.id
         WHERE allocation.organization_id = line.organization_id
           AND allocation.order_line_id = line.id
           AND allocation.plan_id = $3::uuid
       ) pick ON true
       WHERE line.organization_id = $1::uuid AND line.order_id = $2::uuid
       ORDER BY line.created_at, line.id`,
      [organizationId, row.id, row.plan_id],
    ),
    query<QueryResultRow & {
      global_id: string
      package_number: number
      weight_grams: number
      length_mm: number
      width_mm: number
      height_mm: number
      status: string
      label_global_id: string | null
      label_status: 'created' | 'voided' | 'failed' | null
      label_carrier: string | null
      label_service_code: string | null
      label_tracking_number: string | null
      label_environment: 'mock' | 'sandbox' | 'production' | null
      create_attempt_global_id: string | null
      void_attempt_global_id: string | null
      label_created_at: Date | null
      label_voided_at: Date | null
    }>(
      `SELECT package.global_id, package.package_number, package.weight_grams,
              package.length_mm, package.width_mm, package.height_mm, package.status,
              latest_label.global_id AS label_global_id,
              latest_label.status AS label_status,
              latest_label.carrier AS label_carrier,
              latest_label.service_code AS label_service_code,
              latest_label.tracking_number AS label_tracking_number,
              latest_label.environment AS label_environment,
              latest_label.create_attempt_global_id,
              latest_label.void_attempt_global_id,
              latest_label.created_at AS label_created_at,
              latest_label.voided_at AS label_voided_at
       FROM operations_packages package
       LEFT JOIN LATERAL (
         SELECT label.global_id, label.status, label.carrier, label.service_code,
                label.tracking_number, label.environment, label.created_at, label.voided_at,
                create_attempt.global_id AS create_attempt_global_id,
                void_attempt.global_id AS void_attempt_global_id
         FROM operations_labels label
         LEFT JOIN operations_label_attempts create_attempt
           ON create_attempt.organization_id = label.organization_id
          AND create_attempt.id = label.create_attempt_id
         LEFT JOIN operations_label_attempts void_attempt
           ON void_attempt.organization_id = label.organization_id
          AND void_attempt.id = label.void_attempt_id
         WHERE label.organization_id = package.organization_id
           AND label.package_id = package.id
         ORDER BY label.created_at DESC, label.id DESC
         LIMIT 1
       ) latest_label ON true
       WHERE package.organization_id = $1::uuid AND package.plan_id = $2::uuid
       ORDER BY package.package_number`,
      [organizationId, row.plan_id],
    ),
    query<QueryResultRow & {
      global_id: string
      package_global_id: string
      order_line_global_id: string
      product_global_id: string
      product_name: string
      channel_sku: string
      quantity: string
    }>(
      `SELECT content.global_id,
              package.global_id AS package_global_id,
              source_line.global_id AS order_line_global_id,
              product.reference_code AS product_global_id,
              product.name AS product_name,
              source_line.channel_sku,
              content.quantity::text
       FROM operations_package_contents content
       JOIN operations_packages package
         ON package.organization_id = content.organization_id
        AND package.id = content.package_id
       JOIN operations_current_order_lines source_line
         ON source_line.organization_id = content.organization_id
        AND source_line.id = content.order_line_id
       JOIN crm_products product
         ON product.pipeline_id = source_line.pipeline_id
        AND product.id = source_line.product_id
       WHERE content.organization_id = $1::uuid
         AND content.plan_id = $2::uuid
       ORDER BY package.package_number, source_line.created_at, source_line.id`,
      [organizationId, row.plan_id],
    ),
    query<QueryResultRow & {
      global_id: string
      carrier: string
      service_code: string
      service_name: string
      internal_cost_minor: string
      customer_charge_minor: string | null
      estimated_delivery_at: Date
      meets_promise: boolean
      selected: boolean
    }>(
      `SELECT rate.global_id, rate.carrier, rate.service_code, rate.service_name, rate.internal_cost_minor::text,
              rate.customer_charge_minor::text, rate.estimated_delivery_at,
              rate.meets_promise, rate.selected
       FROM operations_carrier_rates rate
       WHERE rate.organization_id = $1::uuid AND rate.plan_id = $2::uuid
       ORDER BY rate.internal_cost_minor, rate.carrier, rate.service_code`,
      [organizationId, row.plan_id],
    ),
    query<QueryResultRow & { global_id: string; event_type: string; amount_minor: string; status: string }>(
      `SELECT global_id, event_type, amount_minor::text, status
       FROM operations_billable_events
       WHERE organization_id = $1::uuid AND order_id = $2::uuid
       ORDER BY occurred_at, id`,
      [organizationId, row.id],
    ),
    query<QueryResultRow & {
      global_id: string
      action: 'create' | 'void' | 'reconcile'
      state: 'prepared' | 'succeeded' | 'failed' | 'unknown'
      provider: 'ups_rest' | 'fedex_rest'
      environment: 'sandbox' | 'production'
      error_code: string | null
      label_global_id: string | null
      requested_at: Date
      completed_at: Date | null
    }>(
      `SELECT attempt.global_id, attempt.action, attempt.state, attempt.provider,
              attempt.environment, attempt.error_code,
              label.global_id AS label_global_id,
              attempt.requested_at, attempt.completed_at
       FROM operations_label_attempts attempt
       LEFT JOIN operations_labels label
         ON label.organization_id = attempt.organization_id
        AND label.id = attempt.label_id
       WHERE attempt.organization_id = $1::uuid
         AND attempt.order_id = $2::uuid
       ORDER BY attempt.requested_at DESC, attempt.id DESC`,
      [organizationId, row.id],
    ),
    query<QueryResultRow & {
      global_id: string
      status: 'confirmed' | 'in_transit' | 'delivered' | 'exception' | 'voided'
      carrier: string
      service_code: string
      tracking_number: string
      quoted_carrier_cost_minor: string
      one_off_carrier_group_global_id: string | null
      shipped_at: Date
    }>(
      `SELECT shipment.global_id, shipment.status, label.carrier,
              label.service_code, shipment.tracking_number,
              shipment.quoted_carrier_cost_minor::text,
              carrier_group.global_id AS one_off_carrier_group_global_id,
              shipment.shipped_at
       FROM operations_shipments shipment
       JOIN operations_labels label
         ON label.organization_id = shipment.organization_id
        AND label.id = shipment.label_id
       LEFT JOIN operations_one_off_carrier_group_attempts carrier_group
         ON carrier_group.organization_id = shipment.organization_id
        AND carrier_group.id = shipment.one_off_carrier_group_attempt_id
       WHERE shipment.organization_id = $1::uuid
         AND shipment.order_id = $2::uuid
       ORDER BY shipment.shipped_at DESC, shipment.id DESC`,
      [organizationId, row.id],
    ),
    query<QueryResultRow & {
      global_id: string
      shipment_global_id: string
      status: 'confirmed' | 'in_transit' | 'out_for_delivery' | 'delivered' | 'exception' | 'voided'
      provider: string
      source: 'shipment_confirmation' | 'carrier_webhook' | 'carrier_poll' | 'manual'
      location: string | null
      observed_at: Date
    }>(
      `SELECT observation.global_id,
              shipment.global_id AS shipment_global_id,
              observation.status, observation.provider, observation.source,
              observation.location, observation.observed_at
       FROM operations_tracking_observations observation
       JOIN operations_shipments shipment
         ON shipment.organization_id = observation.organization_id
        AND shipment.id = observation.shipment_id
       WHERE shipment.organization_id = $1::uuid
         AND shipment.order_id = $2::uuid
       ORDER BY observation.observed_at DESC, observation.id DESC`,
      [organizationId, row.id],
    ),
    query<QueryResultRow & {
      global_id: string
      package_global_id: string | null
      shipment_global_id: string | null
      document_type: 'shipping_label' | 'packing_slip'
      format: 'ZPL' | 'PDF' | 'PNG'
      media_size: 'label_4x6' | 'label_4x8' | 'letter' | 'a4'
      filename: string | null
      template_version: string | null
      has_payload: boolean
      created_at: Date
    }>(
      `SELECT artifact.global_id,
              COALESCE(
                artifact_package.global_id,
                shipment_package.global_id
              ) AS package_global_id,
              shipment.global_id AS shipment_global_id,
              artifact.document_type, artifact.format, artifact.media_size,
              payload.filename, payload.template_version,
              (payload.artifact_id IS NOT NULL) AS has_payload,
              artifact.created_at
       FROM operations_print_artifacts artifact
       LEFT JOIN operations_shipments shipment
         ON shipment.organization_id = artifact.organization_id
        AND shipment.id = artifact.source_shipment_id
       LEFT JOIN operations_packages artifact_package
         ON artifact_package.organization_id = artifact.organization_id
        AND artifact_package.id = artifact.source_package_id
       LEFT JOIN operations_packages shipment_package
         ON shipment_package.organization_id = shipment.organization_id
        AND shipment_package.id = shipment.package_id
       LEFT JOIN operations_print_artifact_payloads payload
         ON payload.organization_id = artifact.organization_id
        AND payload.artifact_id = artifact.id
       WHERE artifact.organization_id = $1::uuid
         AND artifact.source_order_id = $2::uuid
       ORDER BY artifact.created_at DESC, artifact.id DESC`,
      [organizationId, row.id],
    ),
    query<QueryResultRow & {
      global_id: string
      shipment_global_id: string
      provider: string
      state: 'queued' | 'processing' | 'succeeded' | 'failed' | 'unsupported'
      attempts: number
      payload_snapshot: Record<string, unknown>
      provider_reference: string | null
      error_code: string | null
      error_message: string | null
      requested_at: Date
      completed_at: Date | null
    }>(
      `SELECT export.global_id,
              shipment.global_id AS shipment_global_id,
              export.provider, export.state, export.attempts,
              export.payload_snapshot, export.provider_reference,
              export.error_code, export.error_message,
              export.requested_at, export.completed_at
       FROM operations_commerce_fulfillment_exports export
       JOIN operations_shipments shipment
         ON shipment.organization_id = export.organization_id
        AND shipment.id = export.shipment_id
       WHERE export.organization_id = $1::uuid
         AND export.order_id = $2::uuid
       ORDER BY export.requested_at DESC, export.id DESC`,
      [organizationId, row.id],
    ),
    query<QueryResultRow & { global_id: string; event_type: string; occurred_at: Date; payload: Record<string, unknown> }>(
      `SELECT global_id, event_type, occurred_at, payload
       FROM operations_domain_events
       WHERE organization_id = $1::uuid AND aggregate_type = 'operations.order' AND aggregate_id = $2::uuid
       ORDER BY occurred_at, id`,
      [organizationId, row.id],
    ),
    readShadowFulfillmentPreparation(organizationId, row.id),
    context.actorEmail && context.canAuthorizeSandboxCommerceE2e
      ? readActiveSandboxCommerceE2eAuthorizationForOrderInPostgres({
          organizationId,
          orderGlobalId,
          actorEmail: context.actorEmail,
        })
      : Promise.resolve(null),
    row.source_provider === 'clawpilot_native' && row.order_type === 'one_off'
      ? readNativeOneOffShipmentAvailability({
          organizationId,
          orderId: row.id,
          planId: row.plan_id,
          executionMode: row.one_off_shipping_mode,
          activationState: context.activationState,
        })
      : Promise.resolve<NativeOneOffShipmentAvailability>({
          ready: false,
          blockedReason: null,
        }),
  ])

  let shadowPreparationReady = false
  let shadowPreparationBlockedReason: string | null = null
  if (fulfillmentPreparation) {
    shadowPreparationBlockedReason =
      `Shadow preparation ${fulfillmentPreparation.executionGlobalId} is already durable.`
  } else if (
    context.activationState === 'shadow'
    && row.source_provider === 'shopify'
    && row.status === 'packed'
    && Number(row.exception_count) === 0
  ) {
    try {
      await withTransaction((client) => readShadowExecutionContext(client, {
        organizationId,
        orderGlobalId: row.global_id,
        expectedRowVersion: Number(row.row_version),
      }))
      shadowPreparationReady = true
    } catch (caught) {
      shadowPreparationBlockedReason = caught instanceof Error
        ? caught.message
        : 'Checkout, sealed carton, and carrier evidence is incomplete.'
    }
  }

  return {
    id: row.id,
    globalId: row.global_id,
    orderNumber: row.order_number,
    externalOrderId: row.external_order_id,
    customerName: row.customer_name,
    customerGlobalId: row.customer_global_id,
    sourceProvider: row.source_provider,
    status: row.status,
    currency: row.currency,
    rowVersion: Number(row.row_version),
    oneOffShippingMode: row.one_off_shipping_mode,
    warehouseId: row.warehouse_id,
    planStatus: row.plan_status,
    waveStatus: row.wave_status,
    pickTaskCount: Number(row.pick_task_count),
    readyPickTaskCount: Number(row.ready_pick_task_count),
    pickedPickTaskCount: Number(row.picked_pick_task_count),
    packageCount: Number(row.package_count),
    plannedPackageCount: Number(row.planned_package_count),
    packedPackageCount: Number(row.packed_package_count),
    shopifyExternalFulfillmentReconciliationRequired:
      row.shopify_external_fulfillment_reconciliation_required,
    availableActions: availableOperationsOrderActions({
      status: row.status,
      activationState: context.activationState,
      canExecute: context.canExecute,
      canManage: context.canManage,
      canActivate: context.canActivate,
      planStatus: row.plan_status,
      waveStatus: row.wave_status,
      lineCount: Number(row.line_count),
      fullyReservedLineCount: Number(row.fully_reserved_line_count),
      allocatedLineCount: Number(row.allocated_line_count),
      pickTaskCount: Number(row.pick_task_count),
      readyPickTaskCount: Number(row.ready_pick_task_count),
      pickedPickTaskCount: Number(row.picked_pick_task_count),
      packageCount: Number(row.package_count),
      plannedPackageCount: Number(row.planned_package_count),
      packedPackageCount: Number(row.packed_package_count),
      blockingExceptionCount: Number(row.blocking_exception_count),
      openExceptionCount: Number(row.exception_count),
      sourceProvider: row.source_provider,
      orderType: row.order_type,
      oneOffShippingMode: row.one_off_shipping_mode,
      shadowPreparationReady,
      shadowPreparationBlockedReason,
      activeLabelCount: Number(row.active_label_count),
      shippableLabelCount: Number(row.shippable_label_count),
      sandboxLabelCount: Number(row.sandbox_label_count),
      unresolvedLabelAttemptCount: Number(row.unresolved_label_attempt_count),
      existingShipmentCount: Number(row.existing_shipment_count),
      sandboxE2eAuthorized: Boolean(sandboxCommerceE2eAuthorization),
      nativeOneOffGroupReady: nativeOneOffShipmentAvailability.ready,
      nativeOneOffGroupBlockedReason:
        nativeOneOffShipmentAvailability.blockedReason,
      shopifyExternalFulfillmentReconciliationRequired:
        row.shopify_external_fulfillment_reconciliation_required,
    }),
    sandboxCommerceE2eAuthorization: sandboxCommerceE2eAuthorization
      ? {
          authorizationGlobalId:
            sandboxCommerceE2eAuthorization.authorizationGlobalId,
          authorizedAt: sandboxCommerceE2eAuthorization.authorizedAt,
          expiresAt: sandboxCommerceE2eAuthorization.expiresAt,
        }
      : null,
    fulfillmentPreparation,
    planningPreparation:
      row.integration_account_global_id
      && row.planning_candidate_global_id
      && row.planning_candidate_row_version !== null
        ? {
            accountGlobalId: row.integration_account_global_id,
            candidateGlobalId: row.planning_candidate_global_id,
            candidateRowVersion: Number(row.planning_candidate_row_version),
          }
        : null,
    fulfillmentNotificationPolicy: row.source_provider === 'shopify'
      ? {
          mode: 'clawpilot_explicit',
          notifyCustomerDefault: row.notify_customer_default === true,
          revision: numberValue(row.notification_policy_revision),
        }
      : row.source_provider === 'faire'
        ? {
            mode: 'provider_managed',
            notifyCustomerDefault: null,
            revision: 0,
          }
        : {
            mode: 'unavailable',
            notifyCustomerDefault: null,
            revision: 0,
          },
    warehouseName: row.warehouse_name,
    promisedDeliveryAt: row.promised_delivery_at?.toISOString() || null,
    lineCount: Number(row.line_count),
    exceptionCount: Number(row.exception_count),
    expectedCostMinor: row.expected_cost_minor,
    expectedRevenueMinor: row.expected_revenue_minor,
    expectedMarginMinor: row.expected_margin_minor,
    trackingNumber: row.tracking_number,
    shipTo: address(row.ship_to),
    updatedAt: row.updated_at.toISOString(),
    lines: lineResult.rows.map((item) => ({
      globalId: item.global_id,
      productGlobalId: item.product_global_id,
      productName: item.product_name,
      channelSku: item.channel_sku,
      quantity: Number(item.quantity),
      reservedQuantity: Number(item.reserved_quantity),
      pickStatus: item.pick_status,
    })),
    packages: packageResult.rows.map((item) => ({
      globalId: item.global_id,
      packageNumber: item.package_number,
      weightGrams: item.weight_grams,
      dimensionsMm: { length: item.length_mm, width: item.width_mm, height: item.height_mm },
      status: item.status,
      contents: packageContentResult.rows
        .filter((content) => content.package_global_id === item.global_id)
        .map((content) => ({
          globalId: content.global_id,
          orderLineGlobalId: content.order_line_global_id,
          productGlobalId: content.product_global_id,
          productName: content.product_name,
          channelSku: content.channel_sku,
          quantity: Number(content.quantity),
        })),
      latestLabel: item.label_global_id && item.label_status && item.label_carrier
        && item.label_service_code && item.label_tracking_number && item.label_environment
        && item.label_created_at
        ? {
            globalId: item.label_global_id,
            status: item.label_status,
            carrier: item.label_carrier,
            serviceCode: item.label_service_code,
            trackingNumber: item.label_tracking_number,
            environment: item.label_environment,
            createAttemptGlobalId: item.create_attempt_global_id,
            voidAttemptGlobalId: item.void_attempt_global_id,
            createdAt: item.label_created_at.toISOString(),
            voidedAt: item.label_voided_at?.toISOString() || null,
          }
        : null,
    })),
    rates: rateResult.rows.map((item) => ({
      globalId: item.global_id,
      carrier: item.carrier,
      serviceCode: item.service_code,
      serviceName: item.service_name,
      internalCostMinor: item.internal_cost_minor,
      customerChargeMinor: item.customer_charge_minor,
      estimatedDeliveryAt: item.estimated_delivery_at.toISOString(),
      meetsPromise: item.meets_promise,
      selected: item.selected,
    })),
    billableEvents: billableResult.rows.map((item) => ({
      globalId: item.global_id,
      type: item.event_type,
      amountMinor: item.amount_minor,
      status: item.status,
    })),
    labelAttempts: labelAttemptResult.rows.map((item) => ({
      globalId: item.global_id,
      action: item.action,
      state: item.state,
      provider: item.provider,
      environment: item.environment,
      errorCode: item.error_code,
      labelGlobalId: item.label_global_id,
      requestedAt: item.requested_at.toISOString(),
      completedAt: item.completed_at?.toISOString() || null,
    })),
    shipments: shipmentResult.rows.map((item) => ({
      globalId: item.global_id,
      status: item.status,
      carrier: item.carrier,
      serviceCode: item.service_code,
      trackingNumber: item.tracking_number,
      quotedCarrierCostMinor: item.quoted_carrier_cost_minor,
      oneOffCarrierGroupGlobalId: item.one_off_carrier_group_global_id,
      shippedAt: item.shipped_at.toISOString(),
    })),
    trackingObservations: trackingResult.rows.map((item) => ({
      globalId: item.global_id,
      shipmentGlobalId: item.shipment_global_id,
      status: item.status,
      provider: item.provider,
      source: item.source,
      location: item.location,
      observedAt: item.observed_at.toISOString(),
    })),
    printArtifacts: artifactResult.rows.map((item) => ({
      globalId: item.global_id,
      packageGlobalId: item.package_global_id,
      shipmentGlobalId: item.shipment_global_id,
      documentType: item.document_type,
      documentKind: item.document_type === 'shipping_label'
        ? 'shipping_label' as const
        : item.shipment_global_id
          ? 'final_packing_slip' as const
          : item.template_version
              === PACKAGE_PACK_WORK_INSTRUCTION_TEMPLATE_VERSION
            ? 'pack_work_instruction' as const
            : 'legacy_prelabel_packing_list' as const,
      format: item.format,
      media: item.media_size,
      filename: item.filename,
      contentUrl: item.has_payload
        ? `/api/operations/artifacts/${encodeURIComponent(item.global_id)}`
        : null,
      createdAt: item.created_at.toISOString(),
    })),
    commerceExports: commerceExportResult.rows.map((item) => ({
      globalId: item.global_id,
      shipmentGlobalId: item.shipment_global_id,
      provider: item.provider,
      state: item.state,
      attempts: item.attempts,
      providerReference: item.provider_reference,
      errorCode: item.error_code,
      errorMessage: item.error_message,
      requestedAt: item.requested_at.toISOString(),
      completedAt: item.completed_at?.toISOString() || null,
      customerNotification: commerceExportCustomerNotificationDecision(
        item.payload_snapshot,
        item.provider,
      ),
    })),
    events: eventResult.rows.map((item) => ({
      globalId: item.global_id,
      type: item.event_type,
      occurredAt: item.occurred_at.toISOString(),
      payload: json(item.payload),
    })),
  }
}

export async function readOperationsWorkspaceFromPostgres(input: {
  organizationId: string
  actorEmail?: string | null
  capabilities: OperationsCapabilities
  search?: string
  status?: string | null
  exceptionStatus?: OperationsExceptionStatus | null
  selectedOrderGlobalId?: string | null
}): Promise<OperationsWorkspace> {
  const organizationId = requireOrganizationId(input.organizationId)
  const activation = await withTransaction((client) => resolveActivation(client, organizationId))
  const values: unknown[] = [organizationId]
  const where = ['orders.organization_id = $1::uuid', 'orders.archived_at IS NULL']
  const exceptionValues: unknown[] = [organizationId]
  const exceptionWhere = [
    'exception.organization_id = $1::uuid',
    '(orders.id IS NULL OR orders.archived_at IS NULL)',
  ]
  if (input.search) {
    values.push(`%${input.search.toLowerCase()}%`)
    where.push(`(lower(orders.order_number) LIKE $${values.length} OR lower(orders.global_id) LIKE $${values.length} OR lower(customer.name) LIKE $${values.length})`)
    exceptionValues.push(`%${input.search.toLowerCase()}%`)
    exceptionWhere.push(`(lower(exception.title) LIKE $${exceptionValues.length} OR lower(exception.global_id) LIKE $${exceptionValues.length} OR lower(COALESCE(orders.order_number, '')) LIKE $${exceptionValues.length} OR lower(COALESCE(customer.name, '')) LIKE $${exceptionValues.length})`)
  }
  if (input.status) {
    values.push(input.status)
    where.push(`orders.status = $${values.length}`)
  }
  if (input.exceptionStatus) {
    exceptionValues.push(input.exceptionStatus)
    exceptionWhere.push(`exception.status = $${exceptionValues.length}`)
  }

  const [
    configuredResult,
    summaryResult,
    orderResult,
    exceptionResult,
    warehouseResult,
    warehouseLocationResult,
    locationProductRuleResult,
    replenishmentRecommendationResult,
    inventoryPoolResult,
    inventoryPoolCustomerResult,
    inboundReceiptResult,
    inboundReceiptLineResult,
    customerResult,
    productResult,
    sandboxCarrierAccountResult,
  ] = await Promise.all([
    query<QueryResultRow & { configured: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM operations_warehouses warehouse
         WHERE warehouse.organization_id = $1::uuid
           AND warehouse.status = 'active'
           AND warehouse.code <> 'MOCK-01'
       ) AS configured`,
      [organizationId],
    ),
    query<QueryResultRow & {
      open_orders: string
      exceptions: string
      due_soon: string
      shipped_today: string
      reserved_units: string
      available_units: string
      unbilled_minor: string
    }>(
      `SELECT
         (SELECT count(*) FROM operations_orders WHERE organization_id = $1::uuid AND archived_at IS NULL AND status NOT IN ('shipped', 'cancelled'))::text AS open_orders,
         (SELECT count(*)
          FROM operations_exceptions exception
          LEFT JOIN operations_orders exception_order
            ON exception_order.organization_id = exception.organization_id AND exception_order.id = exception.order_id
          WHERE exception.organization_id = $1::uuid
            AND exception.status IN ('open', 'acknowledged')
            AND (exception_order.id IS NULL OR exception_order.archived_at IS NULL))::text AS exceptions,
         (SELECT count(*) FROM operations_orders WHERE organization_id = $1::uuid AND archived_at IS NULL AND status NOT IN ('shipped', 'cancelled') AND promised_delivery_at <= now() + interval '2 days')::text AS due_soon,
         (SELECT count(*) FROM operations_orders WHERE organization_id = $1::uuid AND archived_at IS NULL AND status = 'shipped' AND updated_at >= date_trunc('day', now()))::text AS shipped_today,
         COALESCE((SELECT sum(position.reserved_quantity)
                   FROM operations_inventory_positions position
                   JOIN operations_warehouses warehouse
                     ON warehouse.organization_id = position.organization_id AND warehouse.id = position.warehouse_id
                   JOIN operations_locations location
                     ON location.organization_id = position.organization_id AND location.id = position.location_id
                   JOIN operations_inventory_pools pool
                     ON pool.organization_id = position.organization_id AND pool.id = position.pool_id
                   WHERE position.organization_id = $1::uuid
                     AND warehouse.status = 'active' AND warehouse.code <> 'MOCK-01'
                     AND location.active = true AND pool.active = true), 0)::text AS reserved_units,
         COALESCE((SELECT sum(position.on_hand_quantity - position.reserved_quantity - position.damaged_quantity)
                   FROM operations_inventory_positions position
                   JOIN operations_warehouses warehouse
                     ON warehouse.organization_id = position.organization_id AND warehouse.id = position.warehouse_id
                   JOIN operations_locations location
                     ON location.organization_id = position.organization_id AND location.id = position.location_id
                   JOIN operations_inventory_pools pool
                     ON pool.organization_id = position.organization_id AND pool.id = position.pool_id
                   WHERE position.organization_id = $1::uuid
                     AND warehouse.status = 'active' AND warehouse.code <> 'MOCK-01'
                     AND location.active = true AND pool.active = true), 0)::text AS available_units,
         COALESCE((SELECT sum(event.amount_minor)
                   FROM operations_billable_events event
                   JOIN operations_orders billable_order
                     ON billable_order.organization_id = event.organization_id AND billable_order.id = event.order_id
                   WHERE event.organization_id = $1::uuid AND event.status = 'unbilled'
                     AND billable_order.archived_at IS NULL), 0)::text AS unbilled_minor`,
      [organizationId],
    ),
    query<QueryResultRow & {
      id: string
      global_id: string
      order_number: string
      customer_name: string
      customer_global_id: string
      source_provider: string
      status: OperationsOrderStatus
      warehouse_name: string | null
      promised_delivery_at: Date | null
      line_count: string
      exception_count: string
      expected_cost_minor: string | null
      expected_revenue_minor: string | null
      expected_margin_minor: string | null
      tracking_number: string | null
      updated_at: Date
    }>(
      `SELECT orders.id::text, orders.global_id, orders.order_number,
              customer.name AS customer_name, customer.reference_code AS customer_global_id,
              orders.source_provider, orders.status, warehouse.name AS warehouse_name,
              orders.promised_delivery_at,
              (SELECT count(*) FROM operations_current_order_lines line WHERE line.order_id = orders.id)::text AS line_count,
              (SELECT count(*) FROM operations_exceptions exception WHERE exception.order_id = orders.id AND exception.status IN ('open', 'acknowledged'))::text AS exception_count,
              plan.estimated_cost_minor::text, plan.estimated_revenue_minor::text,
              plan.estimated_margin_minor::text, shipment.tracking_number, orders.updated_at
       FROM operations_orders orders
       JOIN crm_organizations customer ON customer.id = orders.customer_id AND customer.pipeline_id = orders.pipeline_id
       LEFT JOIN LATERAL (
         SELECT candidate.* FROM operations_fulfillment_plans candidate
         WHERE candidate.order_id = orders.id ORDER BY candidate.version_number DESC LIMIT 1
       ) plan ON true
       LEFT JOIN operations_warehouses warehouse ON warehouse.id = plan.warehouse_id
       LEFT JOIN LATERAL (
         SELECT candidate.tracking_number FROM operations_shipments candidate
         WHERE candidate.order_id = orders.id ORDER BY candidate.shipped_at DESC LIMIT 1
       ) shipment ON true
       WHERE ${where.join(' AND ')}
       ORDER BY orders.updated_at DESC, orders.id DESC
       LIMIT 100`,
      values,
    ),
    query<ExceptionRow>(
      `SELECT exception.id::text, exception.global_id, exception.exception_type,
              exception.severity, exception.status, exception.title, exception.details,
              exception.assigned_to, exception.created_at, exception.updated_at,
              exception.resolved_at, orders.global_id AS order_global_id,
              orders.order_number, customer.name AS customer_name,
              customer.reference_code AS customer_global_id
       FROM operations_exceptions exception
       LEFT JOIN operations_orders orders
         ON orders.organization_id = exception.organization_id AND orders.id = exception.order_id
       LEFT JOIN crm_organizations customer
         ON customer.id = orders.customer_id AND customer.pipeline_id = orders.pipeline_id
       WHERE ${exceptionWhere.join(' AND ')}
       ORDER BY
         CASE exception.status WHEN 'open' THEN 0 WHEN 'acknowledged' THEN 1 ELSE 2 END,
         CASE exception.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
         exception.updated_at DESC, exception.id DESC
       LIMIT 100`,
      exceptionValues,
    ),
    query<WarehouseRow>(
      `SELECT id::text, global_id, code, name, facility_type, timezone, address, status,
              cutoff_time::text, carrier_cutoffs, operating_days, opens_at::text, closes_at::text,
              standard_processing_minutes, daily_order_capacity, row_version::text
       FROM operations_warehouses
       WHERE organization_id = $1::uuid
         AND code <> 'MOCK-01'
         AND NOT COALESCE((
           status = 'inactive'
           AND address->>'scenarioKey' = 'clawpilot-wms-development-v1'
           AND address->>'state' = 'retired'
         ), false)
       ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, lower(name), id`,
      [organizationId],
    ),
    query<WarehouseLocationRow>(
      `SELECT location.id::text, location.global_id,
              location.warehouse_id::text, location.code, location.zone,
              location.location_type, location.topology_level,
              parent.global_id AS parent_location_global_id,
              location.pick_sequence, location.active, location.storage_function,
              location.max_volume_cubic_meters::text,
              location.max_weight_kg::text,
              COALESCE(usage.used_volume_cubic_meters, 0)::text AS used_volume_cubic_meters,
              COALESCE(usage.used_weight_kg, 0)::text AS used_weight_kg,
              location.allow_mixed_products, location.notes, location.row_version::text
       FROM operations_locations location
       JOIN operations_warehouses warehouse
         ON warehouse.organization_id = location.organization_id
        AND warehouse.id = location.warehouse_id
       LEFT JOIN operations_locations parent
         ON parent.organization_id = location.organization_id
        AND parent.id = location.parent_location_id
       LEFT JOIN LATERAL (
         SELECT
           COALESCE(sum(
             position.on_hand_quantity
             / NULLIF(profile.units_per_package, 0)
             * profile.length_mm * profile.width_mm * profile.height_mm
             / 1000000000.0
           ), 0) AS used_volume_cubic_meters,
           COALESCE(sum(
             position.on_hand_quantity
             / NULLIF(profile.units_per_package, 0)
             * profile.weight_grams
             / 1000.0
           ), 0) AS used_weight_kg
         FROM operations_inventory_positions position
         LEFT JOIN operations_product_package_profiles profile
           ON profile.organization_id = position.organization_id
          AND profile.product_id = position.product_id
          AND profile.active = true
          AND profile.is_default = true
         WHERE position.organization_id = location.organization_id
           AND position.location_id = location.id
       ) usage ON true
       WHERE location.organization_id = $1::uuid
         AND warehouse.code <> 'MOCK-01'
         AND NOT COALESCE((
           warehouse.status = 'inactive'
           AND warehouse.address->>'scenarioKey' = 'clawpilot-wms-development-v1'
           AND warehouse.address->>'state' = 'retired'
         ), false)
       ORDER BY lower(warehouse.name), location.pick_sequence, lower(location.code), location.id`,
      [organizationId],
    ),
    query<LocationProductRuleRow>(
      `SELECT rule.global_id, rule.location_id::text,
              product.reference_code AS product_global_id, product.name AS product_name,
              product.sku AS product_sku,
              rule.rule_type, rule.max_quantity::text, rule.replenishment_mode,
              source.global_id AS replenishment_source_location_global_id,
              source.code AS replenishment_source_location_code,
              rule.min_quantity::text, rule.target_quantity::text, rule.active
       FROM operations_location_product_rules rule
       JOIN crm_products product
         ON product.pipeline_id = rule.pipeline_id AND product.id = rule.product_id
       LEFT JOIN operations_locations source
         ON source.organization_id = rule.organization_id
        AND source.id = rule.replenishment_source_location_id
       WHERE rule.organization_id = $1::uuid
       ORDER BY rule.location_id, lower(product.name), rule.id`,
      [organizationId],
    ),
    query<ReplenishmentRecommendationRow>(
      `SELECT warehouse.global_id AS warehouse_global_id,
              warehouse.name AS warehouse_name,
              product.reference_code AS product_global_id,
              product.name AS product_name,
              product.sku AS product_sku,
              pool.global_id AS pool_global_id,
              pool.name AS pool_name,
              source.global_id AS source_location_global_id,
              source.code AS source_location_code,
              destination.global_id AS destination_location_global_id,
              destination.code AS destination_location_code,
              rule.replenishment_mode,
              source_balance.available_quantity::text AS available_at_source,
              COALESCE(destination_balance.available_quantity, 0)::text
                AS available_at_destination,
              COALESCE(demand.released_demand, 0)::text AS released_demand,
              rule.min_quantity::text,
              rule.target_quantity::text,
              LEAST(
                source_balance.available_quantity,
                GREATEST(
                  CASE
                    WHEN rule.replenishment_mode = 'order_demand'
                      THEN GREATEST(rule.target_quantity, COALESCE(demand.released_demand, 0))
                    ELSE rule.target_quantity
                  END
                    - COALESCE(destination_balance.available_quantity, 0),
                  0
                )
              )::text AS recommended_quantity
       FROM operations_location_product_rules rule
       JOIN operations_locations destination
         ON destination.organization_id = rule.organization_id
        AND destination.id = rule.location_id
        AND destination.active = true
       JOIN operations_locations source
         ON source.organization_id = rule.organization_id
        AND source.id = rule.replenishment_source_location_id
        AND source.active = true
       JOIN operations_warehouses warehouse
         ON warehouse.organization_id = rule.organization_id
        AND warehouse.id = destination.warehouse_id
        AND warehouse.id = source.warehouse_id
        AND warehouse.status = 'active'
        AND warehouse.code <> 'MOCK-01'
       JOIN crm_products product
         ON product.pipeline_id = rule.pipeline_id
        AND product.id = rule.product_id
       JOIN LATERAL (
         SELECT position.pool_id,
                SUM(GREATEST(
                  position.on_hand_quantity
                    - position.reserved_quantity
                    - position.damaged_quantity,
                  0
                )) AS available_quantity
         FROM operations_inventory_positions position
         WHERE position.organization_id = rule.organization_id
           AND position.location_id = source.id
           AND position.product_id = rule.product_id
         GROUP BY position.pool_id
         HAVING SUM(GREATEST(
           position.on_hand_quantity
             - position.reserved_quantity
             - position.damaged_quantity,
           0
         )) > 0
       ) source_balance ON true
       JOIN operations_inventory_pools pool
         ON pool.organization_id = rule.organization_id
        AND pool.id = source_balance.pool_id
        AND pool.active = true
       LEFT JOIN LATERAL (
         SELECT SUM(GREATEST(
                  position.on_hand_quantity
                    - position.reserved_quantity
                    - position.damaged_quantity,
                  0
                )) AS available_quantity
         FROM operations_inventory_positions position
         WHERE position.organization_id = rule.organization_id
           AND position.location_id = destination.id
           AND position.product_id = rule.product_id
           AND position.pool_id = source_balance.pool_id
       ) destination_balance ON true
       LEFT JOIN LATERAL (
         SELECT COALESCE(SUM(allocation.quantity), 0) AS released_demand
         FROM operations_fulfillment_allocations allocation
         JOIN operations_fulfillment_plans plan
           ON plan.organization_id = allocation.organization_id
          AND plan.id = allocation.plan_id
          AND plan.warehouse_id = warehouse.id
         JOIN operations_orders demand_order
           ON demand_order.organization_id = plan.organization_id
          AND demand_order.id = plan.order_id
          AND demand_order.status IN ('planned', 'released', 'picking')
         JOIN operations_current_order_lines demand_line
           ON demand_line.organization_id = allocation.organization_id
          AND demand_line.id = allocation.order_line_id
          AND demand_line.product_id = rule.product_id
         JOIN operations_inventory_positions allocation_position
           ON allocation_position.organization_id = allocation.organization_id
          AND allocation_position.id = allocation.position_id
          AND allocation_position.pool_id = source_balance.pool_id
       ) demand ON true
       WHERE rule.organization_id = $1::uuid
         AND rule.active = true
         AND rule.replenishment_mode IN ('min_max', 'order_demand')
         AND rule.target_quantity IS NOT NULL
         AND (
           (
             rule.replenishment_mode = 'min_max'
             AND COALESCE(destination_balance.available_quantity, 0) <= rule.min_quantity
           )
           OR (
             rule.replenishment_mode = 'order_demand'
             AND COALESCE(destination_balance.available_quantity, 0)
               < GREATEST(rule.target_quantity, COALESCE(demand.released_demand, 0))
           )
         )
       ORDER BY warehouse.name, destination.pick_sequence, product.name, pool.name`,
      [organizationId],
    ),
    query<InventoryPoolRow>(
      `SELECT pool.id::text, pool.global_id, pool.name, pool.pool_type,
              pool.allocation_policy, pool.active,
              owner.reference_code AS owner_customer_global_id,
              owner.name AS owner_customer_name
       FROM operations_inventory_pools pool
       LEFT JOIN crm_organizations owner
         ON owner.pipeline_id = pool.pipeline_id AND owner.id = pool.owner_customer_id
       WHERE pool.organization_id = $1::uuid
         AND NOT (
           pool.active = false
           AND pool.name = '[DEV WMS] Shared Simulation Pool'
         )
       ORDER BY pool.active DESC, lower(pool.name), pool.id`,
      [organizationId],
    ),
    query<InventoryPoolCustomerRow>(
      `SELECT eligible.pool_id::text, customer.reference_code AS global_id,
              customer.name, eligible.priority
       FROM operations_inventory_pool_customers eligible
       JOIN crm_organizations customer
         ON customer.pipeline_id = eligible.pipeline_id AND customer.id = eligible.customer_id
       WHERE eligible.organization_id = $1::uuid
         AND eligible.effective_from <= now()
         AND (eligible.effective_to IS NULL OR eligible.effective_to > now())
       ORDER BY eligible.pool_id, eligible.priority, lower(customer.name), customer.id`,
      [organizationId],
    ),
    query<InboundReceiptRow>(
      `SELECT receipt.id::text, receipt.global_id, receipt.reference_number,
              receipt.status, warehouse.global_id AS warehouse_global_id,
              warehouse.name AS warehouse_name, pool.global_id AS pool_global_id,
              pool.name AS pool_name, receipt.expected_at, receipt.completed_at,
              receipt.row_version::text
       FROM operations_receipts receipt
       JOIN operations_warehouses warehouse
         ON warehouse.organization_id = receipt.organization_id AND warehouse.id = receipt.warehouse_id
       JOIN operations_inventory_pools pool
         ON pool.organization_id = receipt.organization_id AND pool.id = receipt.inventory_pool_id
       WHERE receipt.organization_id = $1::uuid
       ORDER BY
         CASE receipt.status WHEN 'receiving' THEN 0 WHEN 'expected' THEN 1 ELSE 2 END,
         receipt.expected_at NULLS LAST, receipt.updated_at DESC, receipt.id DESC
       LIMIT 200`,
      [organizationId],
    ),
    query<InboundReceiptLineRow>(
      `SELECT line.id::text, line.global_id, line.receipt_id::text, line.line_number,
              product.reference_code AS product_global_id, product.name AS product_name,
              NULLIF(btrim(product.sku), '') AS product_sku,
              location.global_id AS location_global_id, location.code AS location_code,
              line.expected_quantity::text, line.accepted_quantity::text,
              line.damaged_quantity::text, line.lot_code, line.unit_of_measure
       FROM operations_receipt_lines line
       JOIN crm_products product
         ON product.pipeline_id = line.pipeline_id AND product.id = line.product_id
       JOIN operations_locations location
         ON location.organization_id = line.organization_id AND location.id = line.target_location_id
       WHERE line.organization_id = $1::uuid
       ORDER BY line.receipt_id, line.line_number`,
      [organizationId],
    ),
    query<CustomerRow>(
      `SELECT customer.id::text, customer.reference_code, customer.name
       FROM crm_organizations customer
       WHERE customer.pipeline_id = $1::uuid
         AND NOT COALESCE((
           customer.source_payload->>'scenarioKey'
             = 'clawpilot-wms-development-v1'
           AND customer.source_payload->>'state' = 'retired'
         ), false)
       ORDER BY lower(customer.name), customer.id LIMIT 500`,
      [activation.data_pipeline_id],
    ),
    query<ProductRow>(
      `SELECT product.id::text, product.reference_code, product.name, NULLIF(btrim(product.sku), '') AS sku, product.price::text
       FROM crm_products product
       WHERE product.pipeline_id = $1::uuid AND product.active = true
       ORDER BY lower(product.name), product.id LIMIT 500`,
      [activation.data_pipeline_id],
    ),
    query<QueryResultRow & {
      global_id: string
      provider: 'ups_rest' | 'fedex_rest'
      display_name: string
      account_number_last_four: string
      allow_sender_billing: boolean
      allow_recipient_billing: boolean
      allow_third_party_billing: boolean
    }>(
      `SELECT account.global_id, integration.provider, account.display_name,
              account.account_number_last_four,
              account.allow_sender_billing, account.allow_recipient_billing,
              account.allow_third_party_billing
       FROM operations_carrier_accounts account
       JOIN operations_integration_accounts integration
         ON integration.organization_id = account.organization_id
        AND integration.id = account.integration_account_id
       WHERE account.organization_id = $1::uuid
         AND account.status = 'active'
         AND integration.status = 'active'
         AND integration.environment = 'sandbox'
         AND integration.integration_type = 'carrier'
         AND integration.provider IN ('ups_rest', 'fedex_rest')
         AND EXISTS (
           SELECT 1
           FROM operations_carrier_credentials credential
           WHERE credential.organization_id = integration.organization_id
             AND credential.integration_account_id = integration.id
             AND credential.verification_status = 'verified'
         )
       ORDER BY integration.provider, lower(account.display_name), account.id`,
      [organizationId],
    ),
  ])

  const orders: OperationsOrderListItem[] = orderResult.rows.map((row) => ({
    id: row.id,
    globalId: row.global_id,
    orderNumber: row.order_number,
    customerName: row.customer_name,
    customerGlobalId: row.customer_global_id,
    sourceProvider: row.source_provider,
    status: row.status,
    warehouseName: row.warehouse_name,
    promisedDeliveryAt: row.promised_delivery_at?.toISOString() || null,
    lineCount: Number(row.line_count),
    exceptionCount: Number(row.exception_count),
    expectedCostMinor: row.expected_cost_minor,
    expectedRevenueMinor: row.expected_revenue_minor,
    expectedMarginMinor: row.expected_margin_minor,
    trackingNumber: row.tracking_number,
    updatedAt: row.updated_at.toISOString(),
  }))
  const selectedGlobalId = input.selectedOrderGlobalId || null
  const summary = summaryResult.rows[0]
  return {
    organizationId,
    configured: configuredResult.rows[0]?.configured === true,
    capabilities: input.capabilities,
    dataPipeline: {
      id: activation.data_pipeline_id,
      name: activation.pipeline_name,
    },
    activation: {
      state: activation.state,
      revision: activation.revision,
      reason: activation.reason,
      updatedAt: activation.updated_at.toISOString(),
    },
    summary: {
      openOrders: Number(summary?.open_orders || 0),
      exceptions: Number(summary?.exceptions || 0),
      dueSoon: Number(summary?.due_soon || 0),
      shippedToday: Number(summary?.shipped_today || 0),
      reservedUnits: Number(summary?.reserved_units || 0),
      availableUnits: Number(summary?.available_units || 0),
      unbilledMinor: summary?.unbilled_minor || '0',
    },
    orders,
    exceptions: exceptionResult.rows.map(exceptionListItem),
    selectedOrder: selectedGlobalId ? await readOrderDetail(organizationId, selectedGlobalId, {
      activationState: activation.state,
      canExecute: input.capabilities.canExecute,
      canManage: input.capabilities.canManage,
      canActivate: input.capabilities.canActivate,
      actorEmail: input.actorEmail || null,
      canAuthorizeSandboxCommerceE2e: Boolean(
        input.capabilities.canActivate
        && input.capabilities.canManage
        && input.capabilities.canExecute
      ),
    }) : null,
    warehouses: warehouseResult.rows.map((row) => ({
      id: row.id,
      globalId: row.global_id,
      code: row.code,
      name: row.name,
      facilityType: row.facility_type,
      timezone: row.timezone,
      address: json(row.address) as Address,
      status: row.status,
      cutoffTime: row.cutoff_time,
      carrierCutoffs: json(row.carrier_cutoffs) as Record<string, string>,
      operatingDays: row.operating_days.map(Number),
      opensAt: row.opens_at,
      closesAt: row.closes_at,
      standardProcessingMinutes: Number(row.standard_processing_minutes),
      dailyOrderCapacity: row.daily_order_capacity === null ? null : Number(row.daily_order_capacity),
      rowVersion: Number(row.row_version),
      locations: warehouseLocationResult.rows
        .filter((location) => location.warehouse_id === row.id)
        .map((location) => ({
          id: location.id,
          globalId: location.global_id,
          code: location.code,
          zone: location.zone,
          locationType: location.location_type,
          topologyLevel: location.topology_level,
          parentLocationGlobalId: location.parent_location_global_id,
          pickSequence: location.pick_sequence,
          active: location.active,
          storageFunction: location.storage_function,
          maxVolumeCubicMeters: location.max_volume_cubic_meters === null ? null : Number(location.max_volume_cubic_meters),
          maxWeightKg: location.max_weight_kg === null ? null : Number(location.max_weight_kg),
          usedVolumeCubicMeters: Number(location.used_volume_cubic_meters),
          usedWeightKg: Number(location.used_weight_kg),
          allowMixedProducts: location.allow_mixed_products,
          notes: location.notes,
          rowVersion: Number(location.row_version),
          productRules: locationProductRuleResult.rows
            .filter((rule) => rule.location_id === location.id)
            .map((rule) => ({
              globalId: rule.global_id,
              productGlobalId: rule.product_global_id,
              productName: rule.product_name,
              ruleType: rule.rule_type,
              maxQuantity: rule.max_quantity === null ? null : Number(rule.max_quantity),
              replenishmentMode: rule.replenishment_mode,
              replenishmentSourceLocationGlobalId: rule.replenishment_source_location_global_id,
              replenishmentSourceLocationCode: rule.replenishment_source_location_code,
              minQuantity: rule.min_quantity === null ? null : Number(rule.min_quantity),
              targetQuantity: rule.target_quantity === null ? null : Number(rule.target_quantity),
              active: rule.active,
            })),
        })),
    })),
    replenishmentRecommendations: replenishmentRecommendationResult.rows.map((row) => ({
      warehouseGlobalId: row.warehouse_global_id,
      warehouseName: row.warehouse_name,
      productGlobalId: row.product_global_id,
      productName: row.product_name,
      productSku: row.product_sku,
      inventoryPoolGlobalId: row.pool_global_id,
      inventoryPoolName: row.pool_name,
      sourceLocationGlobalId: row.source_location_global_id,
      sourceLocationCode: row.source_location_code,
      destinationLocationGlobalId: row.destination_location_global_id,
      destinationLocationCode: row.destination_location_code,
      replenishmentMode: row.replenishment_mode,
      availableAtSource: Number(row.available_at_source),
      availableAtDestination: Number(row.available_at_destination),
      releasedDemand: Number(row.released_demand),
      minQuantity: row.min_quantity === null ? null : Number(row.min_quantity),
      targetQuantity: Number(row.target_quantity),
      recommendedQuantity: Number(row.recommended_quantity),
      explanation: row.replenishment_mode === 'min_max'
        ? `${row.destination_location_code} is at or below its minimum; move available reserve inventory toward its target.`
        : `${row.destination_location_code} is below ${Number(row.released_demand).toLocaleString()} units of released allocation demand; stage reserve inventory before wave release.`,
    })),
    inventoryPools: inventoryPoolResult.rows.map((row) => ({
      id: row.id,
      globalId: row.global_id,
      name: row.name,
      poolType: row.pool_type,
      allocationPolicy: row.allocation_policy,
      ownerCustomerGlobalId: row.owner_customer_global_id,
      ownerCustomerName: row.owner_customer_name,
      eligibleCustomers: inventoryPoolCustomerResult.rows
        .filter((customer) => customer.pool_id === row.id)
        .map((customer) => ({
          globalId: customer.global_id,
          name: customer.name,
          priority: customer.priority,
        })),
      active: row.active,
    })),
    inboundReceipts: inboundReceiptResult.rows.map((row) => {
      const lines = inboundReceiptLineResult.rows
        .filter((line) => line.receipt_id === row.id)
        .map((line) => ({
          id: line.id,
          globalId: line.global_id,
          lineNumber: line.line_number,
          productGlobalId: line.product_global_id,
          productName: line.product_name,
          productSku: line.product_sku,
          targetLocationGlobalId: line.location_global_id,
          targetLocationCode: line.location_code,
          expectedQuantity: Number(line.expected_quantity),
          acceptedQuantity: Number(line.accepted_quantity),
          damagedQuantity: Number(line.damaged_quantity),
          lotCode: line.lot_code,
          unitOfMeasure: line.unit_of_measure,
        }))
      return {
        id: row.id,
        globalId: row.global_id,
        referenceNumber: row.reference_number,
        status: row.status,
        warehouseGlobalId: row.warehouse_global_id,
        warehouseName: row.warehouse_name,
        inventoryPoolGlobalId: row.pool_global_id,
        inventoryPoolName: row.pool_name,
        expectedAt: row.expected_at?.toISOString() || null,
        completedAt: row.completed_at?.toISOString() || null,
        rowVersion: Number(row.row_version),
        expectedQuantity: lines.reduce((sum, line) => sum + line.expectedQuantity, 0),
        receivedQuantity: lines.reduce((sum, line) => sum + line.acceptedQuantity, 0),
        damagedQuantity: lines.reduce((sum, line) => sum + line.damagedQuantity, 0),
        lines,
      }
    }),
    catalog: {
      customers: uniqueReferenceRows(customerResult.rows).map((row) => ({ id: row.id, globalId: row.reference_code, name: row.name })),
      products: uniqueReferenceRows(productResult.rows).map((row) => ({ id: row.id, globalId: row.reference_code, name: row.name, sku: row.sku })),
    },
    shipping: {
      sandboxCarrierAccounts: sandboxCarrierAccountResult.rows.map((row) => ({
        globalId: row.global_id,
        provider: row.provider,
        displayName: row.display_name,
        accountNumberLastFour: row.account_number_last_four,
        billingRelationships: [
          ...(row.allow_sender_billing ? ['sender' as const] : []),
          ...(row.allow_recipient_billing ? ['recipient' as const] : []),
          ...(row.allow_third_party_billing ? ['third_party' as const] : []),
        ],
      })),
    },
    generatedAt: new Date().toISOString(),
  }
}

const WAREHOUSE_LOCATION_TYPES = new Set([
  'receiving', 'storage', 'pick', 'pack', 'staging', 'shipping', 'returns',
])
const WAREHOUSE_FACILITY_TYPES = new Set([
  'distribution_center', 'store', 'dark_store', 'micro_fulfillment',
  'cross_dock', 'supplier', 'drop_ship', 'third_party',
])
const WAREHOUSE_TOPOLOGY_LEVELS = new Set([
  'building', 'zone', 'aisle', 'row', 'bay', 'level', 'shelf', 'bin',
  'staging', 'dock', 'station',
])
const LOCATION_PRODUCT_RULE_TYPES = new Set(['allowed', 'preferred', 'restricted'])
const LOCATION_STORAGE_FUNCTIONS = new Set([
  'work_area', 'reserve', 'bulk', 'forward_pick', 'mezzanine_pick', 'flow_rack', 'staging',
])
const LOCATION_REPLENISHMENT_MODES = new Set(['disabled', 'min_max', 'order_demand'])

type OperationsWarehouseOperatingProfileInput = {
  operatingDays?: number[]
  opensAt?: string
  closesAt?: string
  standardProcessingMinutes?: number
  dailyOrderCapacity?: number | null
  carrierCutoffs?: Record<string, string>
}

type LocationProductRuleInput = {
  productGlobalId: string
  ruleType: 'allowed' | 'preferred' | 'restricted'
  maxQuantity?: number | null
  replenishmentMode?: 'disabled' | 'min_max' | 'order_demand'
  replenishmentSourceLocationGlobalId?: string | null
  minQuantity?: number | null
  targetQuantity?: number | null
}

type OperationsLocationMutationInput = {
  organizationId: string
  actorEmail: string
  warehouseGlobalId: string
  code: string
  zone: string
  locationType: OperationsWorkspace['warehouses'][number]['locations'][number]['locationType']
  topologyLevel: OperationsWorkspace['warehouses'][number]['locations'][number]['topologyLevel']
  parentLocationGlobalId?: string | null
  pickSequence: number
  active?: boolean
  storageFunction?: OperationsWorkspace['warehouses'][number]['locations'][number]['storageFunction']
  maxVolumeCubicMeters?: number | null
  maxWeightKg?: number | null
  allowMixedProducts?: boolean
  notes?: string | null
  productRules?: LocationProductRuleInput[]
}

function defaultStorageFunction(
  locationType: OperationsLocationMutationInput['locationType'],
): NonNullable<OperationsLocationMutationInput['storageFunction']> {
  if (locationType === 'pick') return 'forward_pick'
  if (locationType === 'storage') return 'reserve'
  if (locationType === 'staging') return 'staging'
  return 'work_area'
}

function validateWarehouseOperatingProfile(input: OperationsWarehouseOperatingProfileInput) {
  const operatingDays = Array.from(new Set(input.operatingDays || [1, 2, 3, 4, 5])).sort((a, b) => a - b)
  if (
    operatingDays.length < 1
    || operatingDays.length > 7
    || operatingDays.some((day) => !Number.isSafeInteger(day) || day < 0 || day > 6)
  ) {
    throw new OperationsRequestError(
      'OPERATIONS_WAREHOUSE_OPERATING_DAYS_INVALID',
      'Select at least one valid operating day',
    )
  }
  const opensAt = trimmed(input.opensAt ?? '08:00', 8)
  const closesAt = trimmed(input.closesAt ?? '17:00', 8)
  if (
    !/^([01]\d|2[0-3]):[0-5]\d$/.test(opensAt)
    || !/^([01]\d|2[0-3]):[0-5]\d$/.test(closesAt)
    || opensAt === closesAt
  ) {
    throw new OperationsRequestError(
      'OPERATIONS_WAREHOUSE_OPERATING_HOURS_INVALID',
      'Local opening and closing times must be different valid 24-hour times',
    )
  }
  const standardProcessingMinutes = input.standardProcessingMinutes ?? 120
  if (
    !Number.isSafeInteger(standardProcessingMinutes)
    || standardProcessingMinutes < 0
    || standardProcessingMinutes > 10_080
  ) {
    throw new OperationsRequestError(
      'OPERATIONS_WAREHOUSE_PROCESSING_TIME_INVALID',
      'Standard processing time must be from 0 to 10,080 minutes',
    )
  }
  const dailyOrderCapacity = input.dailyOrderCapacity === null || input.dailyOrderCapacity === undefined
    ? null
    : Number(input.dailyOrderCapacity)
  if (
    dailyOrderCapacity !== null
    && (!Number.isSafeInteger(dailyOrderCapacity) || dailyOrderCapacity < 1 || dailyOrderCapacity > 1_000_000_000)
  ) {
    throw new OperationsRequestError(
      'OPERATIONS_WAREHOUSE_DAILY_CAPACITY_INVALID',
      'Daily order capacity must be a positive whole number',
    )
  }
  const carrierCutoffs: Record<string, string> = {}
  const inputCarrierCutoffs = input.carrierCutoffs || {}
  if (
    !inputCarrierCutoffs
    || typeof inputCarrierCutoffs !== 'object'
    || Array.isArray(inputCarrierCutoffs)
    || Object.keys(inputCarrierCutoffs).length > 25
  ) {
    throw new OperationsRequestError(
      'OPERATIONS_WAREHOUSE_CARRIER_CUTOFFS_INVALID',
      'Carrier cutoffs are invalid',
    )
  }
  for (const [providerValue, cutoffValue] of Object.entries(inputCarrierCutoffs)) {
    const provider = trimmed(providerValue, 40).toUpperCase()
    const cutoff = trimmed(cutoffValue, 8)
    if (!/^[A-Z0-9_-]+$/.test(provider) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(cutoff)) {
      throw new OperationsRequestError(
        'OPERATIONS_WAREHOUSE_CARRIER_CUTOFFS_INVALID',
        'Each carrier cutoff must use a valid carrier code and local 24-hour HH:MM time',
      )
    }
    carrierCutoffs[provider] = cutoff
  }
  return {
    operatingDays,
    opensAt,
    closesAt,
    standardProcessingMinutes,
    dailyOrderCapacity,
    carrierCutoffs,
  }
}

function optionalPositiveCapacity(value: unknown, label: string): number | null {
  if (value === null || value === undefined || value === '') return null
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0 || numeric > 1_000_000_000) {
    throw new OperationsRequestError('OPERATIONS_LOCATION_CAPACITY_INVALID', `${label} must be greater than zero`)
  }
  return numeric
}

function optionalNonNegativeQuantity(value: unknown, label: string): number | null {
  if (value === null || value === undefined || value === '') return null
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric < 0 || numeric > 1_000_000_000) {
    throw new OperationsRequestError('OPERATIONS_LOCATION_REPLENISHMENT_INVALID', `${label} cannot be negative`)
  }
  return numeric
}

function validateLocationMutation(input: OperationsLocationMutationInput) {
  const actorEmail = trimmed(input.actorEmail, 320).toLowerCase()
  const code = trimmed(input.code, 40).toUpperCase()
  const zone = trimmed(input.zone, 80).toUpperCase()
  if (!actorEmail) throw new OperationsRequestError('OPERATIONS_ACTOR_REQUIRED', 'A signed-in user is required', 401)
  if (!/^gwh(?:[0-9]{7}|[0-9a-v]{12})$/.test(input.warehouseGlobalId)) {
    throw new OperationsRequestError('OPERATIONS_WAREHOUSE_INVALID', 'Warehouse is invalid')
  }
  if (!code || !/^[A-Z0-9][A-Z0-9_-]*$/.test(code)) {
    throw new OperationsRequestError('OPERATIONS_LOCATION_CODE_INVALID', 'Location code may use letters, numbers, hyphens, and underscores')
  }
  if (!zone) throw new OperationsRequestError('OPERATIONS_LOCATION_ZONE_REQUIRED', 'Location zone is required')
  if (!WAREHOUSE_LOCATION_TYPES.has(input.locationType)) {
    throw new OperationsRequestError('OPERATIONS_LOCATION_TYPE_INVALID', 'Location type is invalid')
  }
  if (!WAREHOUSE_TOPOLOGY_LEVELS.has(input.topologyLevel)) {
    throw new OperationsRequestError('OPERATIONS_TOPOLOGY_LEVEL_INVALID', 'Topology level is invalid')
  }
  const storageFunction = input.storageFunction || defaultStorageFunction(input.locationType)
  if (!LOCATION_STORAGE_FUNCTIONS.has(storageFunction)) {
    throw new OperationsRequestError('OPERATIONS_LOCATION_STORAGE_FUNCTION_INVALID', 'Storage function is invalid')
  }
  if (!Number.isSafeInteger(input.pickSequence) || input.pickSequence < 0 || input.pickSequence > 1_000_000) {
    throw new OperationsRequestError('OPERATIONS_PICK_SEQUENCE_INVALID', 'Pick sequence is invalid')
  }
  const rules = input.productRules || []
  if (rules.length > 250) {
    throw new OperationsRequestError('OPERATIONS_LOCATION_RULE_LIMIT', 'A location may have up to 250 product rules')
  }
  const uniqueProducts = new Set<string>()
  for (const rule of rules) {
    if (!/^gp(?:[0-9]{7}|[0-9a-v]{12})$/.test(rule.productGlobalId) || !LOCATION_PRODUCT_RULE_TYPES.has(rule.ruleType)) {
      throw new OperationsRequestError('OPERATIONS_LOCATION_RULE_INVALID', 'A location product rule is invalid')
    }
    if (uniqueProducts.has(rule.productGlobalId)) {
      throw new OperationsRequestError('OPERATIONS_LOCATION_RULE_DUPLICATE', 'A product may only have one rule per location')
    }
    uniqueProducts.add(rule.productGlobalId)
    const replenishmentMode = rule.replenishmentMode || 'disabled'
    if (!LOCATION_REPLENISHMENT_MODES.has(replenishmentMode)) {
      throw new OperationsRequestError('OPERATIONS_LOCATION_REPLENISHMENT_INVALID', 'Replenishment mode is invalid')
    }
    const maxQuantity = optionalPositiveCapacity(rule.maxQuantity, 'Product quantity limit')
    const minQuantity = optionalNonNegativeQuantity(rule.minQuantity, 'Replenishment minimum')
    const targetQuantity = optionalPositiveCapacity(rule.targetQuantity, 'Replenishment target')
    const sourceGlobalId = rule.replenishmentSourceLocationGlobalId || null
    if (
      replenishmentMode !== 'disabled'
      && (
        !sourceGlobalId
        || !/^gwl(?:[0-9]{7}|[0-9a-v]{12})$/.test(sourceGlobalId)
        || targetQuantity === null
        || (replenishmentMode === 'min_max' && minQuantity === null)
      )
    ) {
      throw new OperationsRequestError(
        'OPERATIONS_LOCATION_REPLENISHMENT_INVALID',
        'Active replenishment requires a reserve source, target quantity, and a minimum for min/max mode',
      )
    }
    if (
      (minQuantity !== null && targetQuantity !== null && minQuantity > targetQuantity)
      || (targetQuantity !== null && maxQuantity !== null && targetQuantity > maxQuantity)
    ) {
      throw new OperationsRequestError(
        'OPERATIONS_LOCATION_REPLENISHMENT_INVALID',
        'Replenishment quantities must follow minimum, target, and maximum order',
      )
    }
  }
  return {
    actorEmail,
    code,
    zone,
    notes: trimmed(input.notes, 2_000) || null,
    maxVolumeCubicMeters: optionalPositiveCapacity(input.maxVolumeCubicMeters, 'Maximum cubic storage'),
    maxWeightKg: optionalPositiveCapacity(input.maxWeightKg, 'Maximum weight'),
    storageFunction,
    rules: rules.map((rule) => ({
      ...rule,
      maxQuantity: optionalPositiveCapacity(rule.maxQuantity, 'Product quantity limit'),
      replenishmentMode: rule.replenishmentMode || 'disabled',
      replenishmentSourceLocationGlobalId: rule.replenishmentMode && rule.replenishmentMode !== 'disabled'
        ? rule.replenishmentSourceLocationGlobalId || null
        : null,
      minQuantity: rule.replenishmentMode && rule.replenishmentMode !== 'disabled'
        ? optionalNonNegativeQuantity(rule.minQuantity, 'Replenishment minimum')
        : null,
      targetQuantity: rule.replenishmentMode && rule.replenishmentMode !== 'disabled'
        ? optionalPositiveCapacity(rule.targetQuantity, 'Replenishment target')
        : null,
    })),
  }
}

async function resolveLocationParent(
  client: PoolClient,
  organizationId: string,
  warehouseId: string,
  parentGlobalId: string | null | undefined,
  currentLocationId?: string,
): Promise<string | null> {
  if (!parentGlobalId) return null
  if (!/^gwl(?:[0-9]{7}|[0-9a-v]{12})$/.test(parentGlobalId)) {
    throw new OperationsRequestError('OPERATIONS_LOCATION_PARENT_INVALID', 'Parent location is invalid')
  }
  const parentResult = await client.query<IdRow>(
    `SELECT id::text, global_id
     FROM operations_locations
     WHERE organization_id = $1::uuid AND warehouse_id = $2::uuid
       AND global_id = $3 AND active = true
     LIMIT 1 FOR UPDATE`,
    [organizationId, warehouseId, parentGlobalId],
  )
  const parent = parentResult.rows[0]
  if (!parent) {
    throw new OperationsRequestError('OPERATIONS_LOCATION_PARENT_NOT_FOUND', 'Parent location was not found in this warehouse', 404)
  }
  if (currentLocationId) {
    if (parent.id === currentLocationId) {
      throw new OperationsRequestError('OPERATIONS_LOCATION_PARENT_CYCLE', 'A location cannot be its own parent')
    }
    const descendantResult = await client.query<QueryResultRow & { found: boolean }>(
      `WITH RECURSIVE descendants AS (
         SELECT id FROM operations_locations
         WHERE organization_id = $1::uuid AND parent_location_id = $2::uuid
         UNION ALL
         SELECT child.id
         FROM operations_locations child
         JOIN descendants parent ON child.parent_location_id = parent.id
         WHERE child.organization_id = $1::uuid
       )
       SELECT EXISTS (SELECT 1 FROM descendants WHERE id = $3::uuid) AS found`,
      [organizationId, currentLocationId, parent.id],
    )
    if (descendantResult.rows[0]?.found) {
      throw new OperationsRequestError('OPERATIONS_LOCATION_PARENT_CYCLE', 'A location cannot be moved beneath one of its descendants')
    }
  }
  return parent.id
}

async function replaceLocationProductRules(
  client: PoolClient,
  organizationId: string,
  pipelineId: string,
  locationId: string,
  warehouseId: string,
  actorEmail: string,
  rules: LocationProductRuleInput[],
) {
  const productIds: string[] = []
  for (const rule of rules) {
    const product = await resolveProduct(client, pipelineId, rule.productGlobalId)
    let replenishmentSourceLocationId: string | null = null
    if (rule.replenishmentMode && rule.replenishmentMode !== 'disabled') {
      const sourceResult = await client.query<IdRow & { warehouse_id: string; storage_function: string }>(
        `SELECT id::text, global_id, warehouse_id::text, storage_function
         FROM operations_locations
         WHERE organization_id = $1::uuid AND global_id = $2 AND active = true
         LIMIT 1 FOR UPDATE`,
        [organizationId, rule.replenishmentSourceLocationGlobalId],
      )
      const source = sourceResult.rows[0]
      if (
        !source
        || source.warehouse_id !== warehouseId
        || !['reserve', 'bulk'].includes(source.storage_function)
        || source.id === locationId
      ) {
        throw new OperationsRequestError(
          'OPERATIONS_LOCATION_REPLENISHMENT_SOURCE_INVALID',
          'Replenishment must come from an active reserve or bulk location in the same warehouse',
        )
      }
      replenishmentSourceLocationId = source.id
    }
    productIds.push(product.id)
    await client.query(
      `INSERT INTO operations_location_product_rules (
         organization_id, pipeline_id, location_id, product_id, rule_type,
         max_quantity, replenishment_mode, replenishment_source_location_id,
         min_quantity, target_quantity, active, created_by, updated_by
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6::numeric, $7,
         $8::uuid, $9::numeric, $10::numeric, true, $11, $11
       )
       ON CONFLICT (organization_id, location_id, product_id) DO UPDATE SET
         rule_type = EXCLUDED.rule_type,
         max_quantity = EXCLUDED.max_quantity,
         replenishment_mode = EXCLUDED.replenishment_mode,
         replenishment_source_location_id = EXCLUDED.replenishment_source_location_id,
         min_quantity = EXCLUDED.min_quantity,
         target_quantity = EXCLUDED.target_quantity,
         active = true,
         updated_by = EXCLUDED.updated_by,
         updated_at = now()`,
      [
        organizationId,
        pipelineId,
        locationId,
        product.id,
        rule.ruleType,
        rule.maxQuantity ?? null,
        rule.replenishmentMode || 'disabled',
        replenishmentSourceLocationId,
        rule.minQuantity ?? null,
        rule.targetQuantity ?? null,
        actorEmail,
      ],
    )
  }
  await client.query(
    `UPDATE operations_location_product_rules
     SET active = false, updated_by = $4, updated_at = now()
     WHERE organization_id = $1::uuid AND location_id = $2::uuid
       AND (cardinality($3::uuid[]) = 0 OR product_id <> ALL($3::uuid[]))`,
    [organizationId, locationId, productIds, actorEmail],
  )
}

export async function createOperationsWarehouseInPostgres(input: {
  organizationId: string
  actorEmail: string
  code: string
  name: string
  timezone: string
  address: Address
  facilityType?: OperationsWorkspace['warehouses'][number]['facilityType']
  cutoffTime?: string | null
  operatingDays?: number[]
  opensAt?: string
  closesAt?: string
  standardProcessingMinutes?: number
  dailyOrderCapacity?: number | null
  carrierCutoffs?: Record<string, string>
  createStarterLocations?: boolean
}): Promise<{ warehouseGlobalId: string; locationGlobalIds: string[] }> {
  const organizationId = requireOrganizationId(input.organizationId)
  const actorEmail = trimmed(input.actorEmail, 320).toLowerCase()
  if (!actorEmail) throw new OperationsRequestError('OPERATIONS_ACTOR_REQUIRED', 'A signed-in user is required', 401)
  const code = trimmed(input.code, 32).toUpperCase()
  const name = trimmed(input.name, 160)
  const timezone = trimmed(input.timezone, 80)
  const cutoffTime = trimmed(input.cutoffTime, 8) || null
  const facilityType = input.facilityType || 'distribution_center'
  const operatingProfile = validateWarehouseOperatingProfile(input)
  if (!code || !/^[A-Z0-9][A-Z0-9_-]*$/.test(code)) {
    throw new OperationsRequestError('OPERATIONS_WAREHOUSE_CODE_INVALID', 'Warehouse code may use letters, numbers, hyphens, and underscores')
  }
  if (!name) throw new OperationsRequestError('OPERATIONS_WAREHOUSE_NAME_REQUIRED', 'Warehouse name is required')
  if (!WAREHOUSE_FACILITY_TYPES.has(facilityType)) {
    throw new OperationsRequestError('OPERATIONS_WAREHOUSE_FACILITY_INVALID', 'Warehouse facility type is invalid')
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format()
  } catch {
    throw new OperationsRequestError('OPERATIONS_WAREHOUSE_TIMEZONE_INVALID', 'Warehouse timezone is invalid')
  }
  if (cutoffTime && !/^([01]\d|2[0-3]):[0-5]\d$/.test(cutoffTime)) {
    throw new OperationsRequestError('OPERATIONS_WAREHOUSE_CUTOFF_INVALID', 'Warehouse cutoff must use 24-hour HH:MM time')
  }

  return withTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(client, `operations:warehouse:${organizationId}:${code}`)
    let warehouse: IdRow
    try {
      const result = await client.query<IdRow>(
        `INSERT INTO operations_warehouses (
           organization_id, code, name, facility_type, timezone, address, status,
           cutoff_time, carrier_cutoffs, operating_days, opens_at, closes_at,
           standard_processing_minutes, daily_order_capacity, created_by, updated_by
         ) VALUES (
           $1::uuid, $2, $3, $4, $5, $6::jsonb, 'active', $7::time,
           $8::jsonb, $9::smallint[], $10::time, $11::time, $12, $13, $14, $14
         )
         RETURNING id::text, global_id`,
        [
          organizationId,
          code,
          name,
          facilityType,
          timezone,
          JSON.stringify(input.address),
          cutoffTime,
          JSON.stringify(operatingProfile.carrierCutoffs),
          operatingProfile.operatingDays,
          operatingProfile.opensAt,
          operatingProfile.closesAt,
          operatingProfile.standardProcessingMinutes,
          operatingProfile.dailyOrderCapacity,
          actorEmail,
        ],
      )
      warehouse = result.rows[0]
    } catch (error) {
      if ((error as { code?: string }).code === '23505') {
        throw new OperationsRequestError('OPERATIONS_WAREHOUSE_CODE_EXISTS', 'A warehouse already uses this code', 409)
      }
      throw error
    }

    const starterLocations = input.createStarterLocations === false ? [] : [
      { code: 'INBOUND', zone: 'INBOUND', type: 'receiving', level: 'zone', storage: 'work_area', sequence: 1, parent: null },
      { code: 'RECEIVE-01', zone: 'INBOUND', type: 'receiving', level: 'dock', storage: 'work_area', sequence: 10, parent: 'INBOUND' },
      { code: 'STAGE-IN-01', zone: 'INBOUND', type: 'staging', level: 'staging', storage: 'staging', sequence: 20, parent: 'INBOUND' },
      { code: 'STORAGE', zone: 'STORAGE', type: 'storage', level: 'zone', storage: 'reserve', sequence: 90, parent: null },
      { code: 'RESERVE-01', zone: 'STORAGE', type: 'storage', level: 'bin', storage: 'reserve', sequence: 100, parent: 'STORAGE' },
      { code: 'FULFILLMENT', zone: 'FULFILLMENT', type: 'pick', level: 'zone', storage: 'work_area', sequence: 190, parent: null },
      { code: 'PICKFACE-01', zone: 'FULFILLMENT', type: 'pick', level: 'bin', storage: 'forward_pick', sequence: 200, parent: 'FULFILLMENT' },
      { code: 'PACK-01', zone: 'FULFILLMENT', type: 'pack', level: 'station', storage: 'work_area', sequence: 300, parent: 'FULFILLMENT' },
      { code: 'OUTBOUND', zone: 'OUTBOUND', type: 'shipping', level: 'zone', storage: 'work_area', sequence: 390, parent: null },
      { code: 'STAGE-OUT-01', zone: 'OUTBOUND', type: 'staging', level: 'staging', storage: 'staging', sequence: 400, parent: 'OUTBOUND' },
      { code: 'SHIP-01', zone: 'OUTBOUND', type: 'shipping', level: 'dock', storage: 'work_area', sequence: 500, parent: 'OUTBOUND' },
      { code: 'RETURNS', zone: 'RETURNS', type: 'returns', level: 'zone', storage: 'work_area', sequence: 590, parent: null },
      { code: 'RETURNS-01', zone: 'RETURNS', type: 'returns', level: 'station', storage: 'work_area', sequence: 600, parent: 'RETURNS' },
    ] as const
    const locationGlobalIds: string[] = []
    const locationIdsByCode = new Map<string, string>()
    for (const starter of starterLocations) {
      const result = await client.query<IdRow>(
        `INSERT INTO operations_locations (
           organization_id, warehouse_id, code, zone, location_type,
           topology_level, parent_location_id, pick_sequence, active, storage_function,
           created_by, updated_by
         ) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::uuid, $8, true, $9, $10, $10)
         RETURNING id::text, global_id`,
        [
          organizationId,
          warehouse.id,
          starter.code,
          starter.zone,
          starter.type,
          starter.level,
          starter.parent ? locationIdsByCode.get(starter.parent) : null,
          starter.sequence,
          starter.storage,
          actorEmail,
        ],
      )
      locationIdsByCode.set(starter.code, result.rows[0].id)
      locationGlobalIds.push(result.rows[0].global_id)
    }
    await recordAuditEvent({
      actor: actorEmail,
      eventType: 'operations.warehouse.created',
      aggregateType: 'operations.warehouse',
      aggregateId: warehouse.global_id,
      subject: name,
      organizationId,
      eventKey: `operations:warehouse:${warehouse.global_id}:created`,
      payload: {
        code,
        facilityType,
        timezone,
        cutoffTime,
        ...operatingProfile,
        starterLocationCount: locationGlobalIds.length,
      },
    }, client)
    return { warehouseGlobalId: warehouse.global_id, locationGlobalIds }
  })
}

export async function createOperationsLocationInPostgres(input: OperationsLocationMutationInput): Promise<{ locationGlobalId: string }> {
  const organizationId = requireOrganizationId(input.organizationId)
  const normalized = validateLocationMutation(input)
  return withTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(client, `operations:location:${organizationId}:${input.warehouseGlobalId}:${normalized.code}`)
    const warehouseResult = await client.query<IdRow>(
      `SELECT id::text, global_id FROM operations_warehouses
       WHERE organization_id = $1::uuid AND global_id = $2 LIMIT 1 FOR UPDATE`,
      [organizationId, input.warehouseGlobalId],
    )
    const warehouse = warehouseResult.rows[0]
    if (!warehouse) throw new OperationsRequestError('OPERATIONS_WAREHOUSE_NOT_FOUND', 'Warehouse was not found', 404)
    const parentLocationId = await resolveLocationParent(
      client,
      organizationId,
      warehouse.id,
      input.parentLocationGlobalId,
    )
    const pipeline = await resolvePipeline(client, organizationId)
    try {
      const result = await client.query<IdRow>(
        `INSERT INTO operations_locations (
           organization_id, warehouse_id, code, zone, location_type,
           topology_level, parent_location_id, pick_sequence, active,
           storage_function,
           max_volume_cubic_meters, max_weight_kg, allow_mixed_products,
           notes, created_by, updated_by
         ) VALUES (
           $1::uuid, $2::uuid, $3, $4, $5, $6, $7::uuid, $8, $9, $10,
           $11::numeric, $12::numeric, $13, $14, $15, $15
         )
         RETURNING id::text, global_id`,
        [
          organizationId,
          warehouse.id,
          normalized.code,
          normalized.zone,
          input.locationType,
          input.topologyLevel,
          parentLocationId,
          input.pickSequence,
          input.active !== false,
          normalized.storageFunction,
          normalized.maxVolumeCubicMeters,
          normalized.maxWeightKg,
          input.allowMixedProducts !== false,
          normalized.notes,
          normalized.actorEmail,
        ],
      )
      const location = result.rows[0]
      await replaceLocationProductRules(
        client,
        organizationId,
        pipeline.id,
        location.id,
        warehouse.id,
        normalized.actorEmail,
        normalized.rules,
      )
      await recordAuditEvent({
        actor: normalized.actorEmail,
        eventType: 'operations.location.created',
        aggregateType: 'operations.location',
        aggregateId: location.global_id,
        subject: normalized.code,
        organizationId,
        eventKey: `operations:location:${location.global_id}:created`,
        payload: {
          warehouseGlobalId: warehouse.global_id,
          zone: normalized.zone,
          locationType: input.locationType,
          topologyLevel: input.topologyLevel,
          parentLocationGlobalId: input.parentLocationGlobalId || null,
          pickSequence: input.pickSequence,
          storageFunction: normalized.storageFunction,
          maxVolumeCubicMeters: normalized.maxVolumeCubicMeters,
          maxWeightKg: normalized.maxWeightKg,
          productRuleCount: normalized.rules.length,
        },
      }, client)
      return { locationGlobalId: location.global_id }
    } catch (error) {
      if ((error as { code?: string }).code === '23505') {
        throw new OperationsRequestError('OPERATIONS_LOCATION_CODE_EXISTS', 'This warehouse already uses that location code', 409)
      }
      throw error
    }
  })
}

export async function updateOperationsWarehouseInPostgres(input: {
  organizationId: string
  actorEmail: string
  warehouseGlobalId: string
  expectedRowVersion: number
  name: string
  facilityType: OperationsWorkspace['warehouses'][number]['facilityType']
  timezone: string
  address: Address
  cutoffTime?: string | null
  operatingDays?: number[]
  opensAt?: string
  closesAt?: string
  standardProcessingMinutes?: number
  dailyOrderCapacity?: number | null
  carrierCutoffs?: Record<string, string>
  status: 'active' | 'inactive'
}): Promise<{ warehouseGlobalId: string; rowVersion: number }> {
  const organizationId = requireOrganizationId(input.organizationId)
  const actorEmail = trimmed(input.actorEmail, 320).toLowerCase()
  const name = trimmed(input.name, 160)
  const cutoffTime = trimmed(input.cutoffTime, 8) || null
  const operatingProfile = validateWarehouseOperatingProfile(input)
  if (!actorEmail) throw new OperationsRequestError('OPERATIONS_ACTOR_REQUIRED', 'A signed-in user is required', 401)
  if (!/^gwh(?:[0-9]{7}|[0-9a-v]{12})$/.test(input.warehouseGlobalId) || !name) {
    throw new OperationsRequestError('OPERATIONS_WAREHOUSE_INVALID', 'Warehouse is invalid')
  }
  if (!WAREHOUSE_FACILITY_TYPES.has(input.facilityType) || !['active', 'inactive'].includes(input.status)) {
    throw new OperationsRequestError('OPERATIONS_WAREHOUSE_FACILITY_INVALID', 'Warehouse configuration is invalid')
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: input.timezone }).format()
  } catch {
    throw new OperationsRequestError('OPERATIONS_WAREHOUSE_TIMEZONE_INVALID', 'Warehouse timezone is invalid')
  }
  if (cutoffTime && !/^([01]\d|2[0-3]):[0-5]\d$/.test(cutoffTime)) {
    throw new OperationsRequestError('OPERATIONS_WAREHOUSE_CUTOFF_INVALID', 'Warehouse cutoff must use 24-hour HH:MM time')
  }
  return withTransaction(async (client) => {
    const result = await client.query<QueryResultRow & { global_id: string; row_version: string }>(
      `UPDATE operations_warehouses
       SET name = $4, facility_type = $5, timezone = $6, address = $7::jsonb,
           cutoff_time = $8::time, operating_days = $9::smallint[],
           carrier_cutoffs = $10::jsonb, opens_at = $11::time, closes_at = $12::time,
           standard_processing_minutes = $13, daily_order_capacity = $14,
           status = $15, row_version = row_version + 1,
           updated_by = $16, updated_at = now()
       WHERE organization_id = $1::uuid AND global_id = $2 AND row_version = $3
       RETURNING global_id, row_version::text`,
      [
        organizationId,
        input.warehouseGlobalId,
        input.expectedRowVersion,
        name,
        input.facilityType,
        input.timezone,
        JSON.stringify(input.address),
        cutoffTime,
        operatingProfile.operatingDays,
        JSON.stringify(operatingProfile.carrierCutoffs),
        operatingProfile.opensAt,
        operatingProfile.closesAt,
        operatingProfile.standardProcessingMinutes,
        operatingProfile.dailyOrderCapacity,
        input.status,
        actorEmail,
      ],
    )
    const row = result.rows[0]
    if (!row) {
      throw new OperationsRequestError('OPERATIONS_WAREHOUSE_VERSION_CONFLICT', 'Warehouse changed since it was opened. Refresh and try again.', 409)
    }
    await recordAuditEvent({
      actor: actorEmail,
      eventType: 'operations.warehouse.updated',
      aggregateType: 'operations.warehouse',
      aggregateId: row.global_id,
      subject: name,
      organizationId,
      eventKey: `operations:warehouse:${row.global_id}:version:${row.row_version}`,
      payload: {
        facilityType: input.facilityType,
        timezone: input.timezone,
        status: input.status,
        cutoffTime,
        ...operatingProfile,
      },
    }, client)
    return { warehouseGlobalId: row.global_id, rowVersion: Number(row.row_version) }
  })
}

export async function updateOperationsLocationInPostgres(
  input: OperationsLocationMutationInput & { locationGlobalId: string; expectedRowVersion: number },
): Promise<{ locationGlobalId: string; rowVersion: number }> {
  const organizationId = requireOrganizationId(input.organizationId)
  const normalized = validateLocationMutation(input)
  if (!/^gwl(?:[0-9]{7}|[0-9a-v]{12})$/.test(input.locationGlobalId)) {
    throw new OperationsRequestError('OPERATIONS_LOCATION_INVALID', 'Location is invalid')
  }
  return withTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(client, `operations:location:${organizationId}:${input.locationGlobalId}`)
    const currentResult = await client.query<IdRow & { warehouse_id: string }>(
      `SELECT location.id::text, location.global_id, location.warehouse_id::text
       FROM operations_locations location
       JOIN operations_warehouses warehouse
         ON warehouse.organization_id = location.organization_id
        AND warehouse.id = location.warehouse_id
       WHERE location.organization_id = $1::uuid
         AND location.global_id = $2
         AND warehouse.global_id = $3
       LIMIT 1 FOR UPDATE OF location`,
      [organizationId, input.locationGlobalId, input.warehouseGlobalId],
    )
    const current = currentResult.rows[0]
    if (!current) throw new OperationsRequestError('OPERATIONS_LOCATION_NOT_FOUND', 'Location was not found', 404)
    const parentLocationId = await resolveLocationParent(
      client,
      organizationId,
      current.warehouse_id,
      input.parentLocationGlobalId,
      current.id,
    )
    const result = await client.query<QueryResultRow & { global_id: string; row_version: string }>(
      `UPDATE operations_locations
       SET code = $4, zone = $5, location_type = $6, topology_level = $7,
           parent_location_id = $8::uuid, pick_sequence = $9, active = $10,
           storage_function = $11, max_volume_cubic_meters = $12::numeric,
           max_weight_kg = $13::numeric, allow_mixed_products = $14,
           notes = $15, row_version = row_version + 1,
           updated_by = $16, updated_at = now()
       WHERE organization_id = $1::uuid AND id = $2::uuid AND row_version = $3
       RETURNING global_id, row_version::text`,
      [
        organizationId,
        current.id,
        input.expectedRowVersion,
        normalized.code,
        normalized.zone,
        input.locationType,
        input.topologyLevel,
        parentLocationId,
        input.pickSequence,
        input.active !== false,
        normalized.storageFunction,
        normalized.maxVolumeCubicMeters,
        normalized.maxWeightKg,
        input.allowMixedProducts !== false,
        normalized.notes,
        normalized.actorEmail,
      ],
    )
    const row = result.rows[0]
    if (!row) {
      throw new OperationsRequestError('OPERATIONS_LOCATION_VERSION_CONFLICT', 'Location changed since it was opened. Refresh and try again.', 409)
    }
    const pipeline = await resolvePipeline(client, organizationId)
    await replaceLocationProductRules(
      client,
      organizationId,
      pipeline.id,
      current.id,
      current.warehouse_id,
      normalized.actorEmail,
      normalized.rules,
    )
    await recordAuditEvent({
      actor: normalized.actorEmail,
      eventType: 'operations.location.updated',
      aggregateType: 'operations.location',
      aggregateId: row.global_id,
      subject: normalized.code,
      organizationId,
      eventKey: `operations:location:${row.global_id}:version:${row.row_version}`,
      payload: {
        zone: normalized.zone,
        locationType: input.locationType,
        topologyLevel: input.topologyLevel,
        parentLocationGlobalId: input.parentLocationGlobalId || null,
        active: input.active !== false,
        storageFunction: normalized.storageFunction,
        productRuleCount: normalized.rules.length,
      },
    }, client)
    return { locationGlobalId: row.global_id, rowVersion: Number(row.row_version) }
  })
}

export async function deleteOperationsLocationInPostgres(input: {
  organizationId: string
  actorEmail: string
  locationGlobalId: string
  expectedRowVersion: number
}): Promise<{ locationGlobalId: string; outcome: 'deleted' | 'retired' }> {
  const organizationId = requireOrganizationId(input.organizationId)
  const actorEmail = trimmed(input.actorEmail, 320).toLowerCase()
  if (!actorEmail) throw new OperationsRequestError('OPERATIONS_ACTOR_REQUIRED', 'A signed-in user is required', 401)
  if (!/^gwl(?:[0-9]{7}|[0-9a-v]{12})$/.test(input.locationGlobalId)) {
    throw new OperationsRequestError('OPERATIONS_LOCATION_INVALID', 'Location is invalid')
  }
  return withTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(client, `operations:location:${organizationId}:${input.locationGlobalId}`)
    const currentResult = await client.query<IdRow & { code: string; row_version: string }>(
      `SELECT id::text, global_id, code, row_version::text
       FROM operations_locations
       WHERE organization_id = $1::uuid AND global_id = $2
       LIMIT 1 FOR UPDATE`,
      [organizationId, input.locationGlobalId],
    )
    const current = currentResult.rows[0]
    if (!current) throw new OperationsRequestError('OPERATIONS_LOCATION_NOT_FOUND', 'Location was not found', 404)
    if (Number(current.row_version) !== input.expectedRowVersion) {
      throw new OperationsRequestError('OPERATIONS_LOCATION_VERSION_CONFLICT', 'Location changed since it was opened. Refresh and try again.', 409)
    }
    const childResult = await client.query<QueryResultRow & { count: string }>(
      `SELECT count(*)::text AS count
       FROM operations_locations
       WHERE organization_id = $1::uuid AND parent_location_id = $2::uuid AND active = true`,
      [organizationId, current.id],
    )
    if (Number(childResult.rows[0]?.count || 0) > 0) {
      throw new OperationsRequestError('OPERATIONS_LOCATION_HAS_CHILDREN', 'Move or retire child locations before removing this topology node', 409)
    }
    let outcome: 'deleted' | 'retired' = 'deleted'
    await client.query('SAVEPOINT delete_operations_location')
    try {
      await client.query(
        `DELETE FROM operations_location_product_rules
         WHERE organization_id = $1::uuid AND location_id = $2::uuid`,
        [organizationId, current.id],
      )
      await client.query(
        `DELETE FROM operations_locations
         WHERE organization_id = $1::uuid AND id = $2::uuid`,
        [organizationId, current.id],
      )
      await client.query('RELEASE SAVEPOINT delete_operations_location')
    } catch (error) {
      await client.query('ROLLBACK TO SAVEPOINT delete_operations_location')
      if ((error as { code?: string }).code !== '23503') {
        await client.query('RELEASE SAVEPOINT delete_operations_location')
        throw error
      }
      await client.query('RELEASE SAVEPOINT delete_operations_location')
      outcome = 'retired'
      await client.query(
        `UPDATE operations_locations
         SET active = false, row_version = row_version + 1,
             updated_by = $3, updated_at = now()
         WHERE organization_id = $1::uuid AND id = $2::uuid`,
        [organizationId, current.id, actorEmail],
      )
      await client.query(
        `UPDATE operations_location_product_rules
         SET active = false, updated_by = $3, updated_at = now()
         WHERE organization_id = $1::uuid AND location_id = $2::uuid`,
        [organizationId, current.id, actorEmail],
      )
    }
    await recordAuditEvent({
      actor: actorEmail,
      eventType: outcome === 'deleted' ? 'operations.location.deleted' : 'operations.location.retired',
      aggregateType: 'operations.location',
      aggregateId: current.global_id,
      subject: current.code,
      organizationId,
      eventKey: `operations:location:${current.global_id}:${outcome}:${Date.now()}`,
      payload: { outcome },
    }, client)
    return { locationGlobalId: current.global_id, outcome }
  })
}

export async function updateOperationsActivationInPostgres(input: {
  organizationId: string
  actorEmail: string
  state: OperationsActivationState
  reason?: string | null
  expectedCurrentState?: OperationsActivationState | 'missing'
  expectedCurrentRevision?: number | null
}): Promise<OperationsActivationUpdateResult> {
  const organizationId = requireOrganizationId(input.organizationId)
  const actorEmail = trimmed(input.actorEmail, 320).toLowerCase()
  if (!actorEmail) throw new OperationsRequestError('OPERATIONS_ACTOR_REQUIRED', 'A signed-in user is required', 401)
  if (!ACTIVATION_STATES.has(input.state)) {
    throw new OperationsRequestError('OPERATIONS_ACTIVATION_STATE_INVALID', 'Operations activation state is invalid')
  }
  const reason = trimmed(input.reason, 500) || null

  return withTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(client, `operations:activation:${organizationId}`)
    if (input.state === 'shadow') {
      await acquireTransactionAdvisoryLock(
        client,
        `commerce-active-transition:${organizationId}`,
      )
      await lockShopifyCarrierServiceConfigWritersForActivationWithClient(
        client,
        organizationId,
      )
    }
    if (input.expectedCurrentState !== undefined) {
      const observed = await client.query<{
        state: OperationsActivationState
        revision: number
      }>(
        `SELECT state, revision
         FROM operations_activation_scopes
         WHERE organization_id = $1::uuid
         FOR UPDATE`,
        [organizationId],
      )
      const row = observed.rows[0] || null
      const exactMatch = input.expectedCurrentState === 'missing'
        ? row === null && input.expectedCurrentRevision === null
        : row?.state === input.expectedCurrentState
          && row.revision === input.expectedCurrentRevision
      if (!exactMatch) {
        throw new OperationsRequestError(
          'OPERATIONS_ACTIVATION_STATE_CONFLICT',
          'Operations activation changed after this workflow loaded; review its current mode before continuing',
          409,
        )
      }
    }
    const current = await resolveActivation(client, organizationId, true)
    if (input.state === 'active') {
      const sandboxPlan = await client.query<{ global_id: string }>(
        `SELECT plan.global_id
         FROM operations_fulfillment_plans plan
         JOIN operations_orders source_order
           ON source_order.organization_id = plan.organization_id
          AND source_order.id = plan.order_id
         LEFT JOIN operations_cartonization_rate_evidence evidence
           ON evidence.organization_id = plan.organization_id
          AND evidence.id = plan.cartonization_evidence_id
         WHERE plan.organization_id = $1::uuid
           AND plan.status IN ('planned', 'released')
           AND source_order.status NOT IN ('shipped', 'cancelled')
           AND (
             plan.cartonization_evidence_id IS NULL
             OR evidence.plan_snapshot->>'carrierReadEnvironment'
                  IS DISTINCT FROM 'production'
           )
           AND NOT operations_one_off_plan_authority_is_valid(
             plan.organization_id, plan.order_id, plan.warehouse_id,
             plan.one_off_quote_id, plan.one_off_offer_id, 'live'
           )
           AND NOT EXISTS (
             SELECT 1
             FROM operations_sandbox_commerce_e2e_authorizations sandbox_auth
             WHERE sandbox_auth.organization_id = plan.organization_id
               AND sandbox_auth.order_id = plan.order_id
               AND sandbox_auth.state = 'active'
               AND sandbox_auth.expires_at > statement_timestamp()
               AND source_order.status = 'packed'
               AND source_order.source_provider = 'shopify'
               AND sandbox_auth.external_order_id = source_order.external_order_id
           )
         ORDER BY plan.created_at, plan.id
         LIMIT 1`,
        [organizationId],
      )
      if (sandboxPlan.rows[0]) {
        throw new OperationsRequestError(
          'OPERATIONS_ACTIVE_SANDBOX_PLANS_EXIST',
          `Live activation is blocked while fulfillment plan ${sandboxPlan.rows[0].global_id} is missing production carrier-rate evidence`,
          409,
        )
      }
      const providers = await client.query<QueryResultRow & { integration_type: string }>(
        `SELECT DISTINCT integration_type
         FROM operations_integration_accounts
         WHERE organization_id = $1::uuid AND environment = 'production'
           AND status = 'active'
           AND integration_type IN ('commerce', 'carrier', 'printing')
           AND (
             integration_type <> 'carrier'
             OR EXISTS (
               SELECT 1
               FROM operations_carrier_credentials credential
               WHERE credential.organization_id = operations_integration_accounts.organization_id
                 AND credential.integration_account_id = operations_integration_accounts.id
                 AND credential.verification_status = 'verified'
             )
           )`,
        [organizationId],
      )
      const available = new Set(providers.rows.map((row) => row.integration_type))
      const missing = ['commerce', 'carrier', 'printing'].filter((type) => !available.has(type))
      if (missing.length) {
        throw new OperationsRequestError(
          'OPERATIONS_LIVE_PROVIDER_REQUIRED',
          `Live activation requires production ${missing.join(', ')} integration${missing.length === 1 ? '' : 's'}`,
          409,
        )
      }
    }
    if (current.state === input.state && current.reason === reason) return activationPayload(current)

    await client.query(
      `UPDATE operations_activation_scopes
       SET state = $2, reason = $3, revision = revision + 1,
           updated_by = $4, updated_at = now()
       WHERE organization_id = $1::uuid`,
      [organizationId, input.state, reason, actorEmail],
    )
    const updated = await resolveActivation(client, organizationId)
    let shadowCarrierServiceRebindings: Awaited<ReturnType<
      typeof rebindRegisteredShopifyCarrierServicesForShadowActivationWithClient
    >> = []
    if (input.state === 'shadow') {
      try {
        shadowCarrierServiceRebindings =
          await rebindRegisteredShopifyCarrierServicesForShadowActivationWithClient(
            client,
            {
              organizationId,
              targetActivationRevision: updated.revision,
              actorEmail,
            },
          )
      } catch (error) {
        if (error instanceof ShopifyCheckoutRatingPersistenceError) {
          throw new OperationsRequestError(
            error.code,
            error.message,
            error.status,
          )
        }
        throw error
      }
    }
    await recordAuditEvent({
      actor: actorEmail,
      eventType: 'operations.activation.updated',
      aggregateType: 'operations.activation',
      aggregateId: organizationId,
      subject: updated.pipeline_name,
      organizationId,
      eventKey: `operations:activation:${organizationId}:revision:${updated.revision}`,
      payload: {
        previousState: current.state,
        state: updated.state,
        revision: updated.revision,
        reason: updated.reason,
        dataPipelineId: updated.data_pipeline_id,
        carrierServiceRebindings: shadowCarrierServiceRebindings.map(
          (rebound) => ({
            configGlobalId: rebound.configGlobalId,
            accountGlobalId: rebound.accountGlobalId,
            serviceGid: rebound.serviceGid,
            fromActivationRevision: rebound.fromActivationRevision,
            activationRevision: rebound.activationRevision,
            fromRowVersion: rebound.fromRowVersion,
            rowVersion: rebound.rowVersion,
            callbackTokenVersionRetained:
              rebound.callbackTokenVersion,
            providerWrites: 0,
            callbackTokenRotations: 0,
          }),
        ),
      },
    }, client)
    return activationPayload(updated)
  })
}

async function readException(
  client: PoolClient,
  organizationId: string,
  globalId: string,
  lock = false,
): Promise<ExceptionRow | null> {
  const result = await client.query<ExceptionRow>(
    `SELECT exception.id::text, exception.global_id, exception.exception_type,
            exception.severity, exception.status, exception.title, exception.details,
            exception.assigned_to, exception.created_at, exception.updated_at,
            exception.resolved_at, orders.global_id AS order_global_id,
            orders.order_number, customer.name AS customer_name,
            customer.reference_code AS customer_global_id
     FROM operations_exceptions exception
     LEFT JOIN operations_orders orders
       ON orders.organization_id = exception.organization_id AND orders.id = exception.order_id
     LEFT JOIN crm_organizations customer
       ON customer.id = orders.customer_id AND customer.pipeline_id = orders.pipeline_id
     WHERE exception.organization_id = $1::uuid AND exception.global_id = $2
     LIMIT 1
     ${lock ? 'FOR UPDATE OF exception' : ''}`,
    [organizationId, globalId],
  )
  return result.rows[0] || null
}

const EXCEPTION_TRANSITIONS: Record<OperationsExceptionStatus, Set<OperationsExceptionStatus>> = {
  open: new Set(['acknowledged', 'resolved', 'dismissed']),
  acknowledged: new Set(['open', 'resolved', 'dismissed']),
  resolved: new Set(['open']),
  dismissed: new Set(['open']),
}

export async function updateOperationsExceptionInPostgres(input: {
  organizationId: string
  actorEmail: string
  exceptionGlobalId: string
  status: OperationsExceptionStatus
}): Promise<OperationsExceptionUpdateResult> {
  const organizationId = requireOrganizationId(input.organizationId)
  const actorEmail = String(input.actorEmail || '').trim().toLowerCase()
  if (!actorEmail) throw new OperationsRequestError('OPERATIONS_ACTOR_REQUIRED', 'A signed-in user is required', 401)
  if (!Object.prototype.hasOwnProperty.call(EXCEPTION_TRANSITIONS, input.status)) {
    throw new OperationsRequestError('OPERATIONS_EXCEPTION_STATUS_INVALID', 'Exception status is invalid')
  }

  return withTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(
      client,
      `operations:exception:${organizationId}:${input.exceptionGlobalId}`,
    )
    const current = await readException(client, organizationId, input.exceptionGlobalId, true)
    if (!current) {
      throw new OperationsRequestError('OPERATIONS_EXCEPTION_NOT_FOUND', 'Operations exception was not found', 404)
    }
    if (
      current.exception_type === 'commerce_order_revision_required'
      && !['open', 'acknowledged'].includes(input.status)
    ) {
      throw new OperationsRequestError(
        'COMMERCE_ORDER_REVISION_DISPOSITION_REQUIRED',
        'Provider order revisions can be resolved only by an immutable authorized disposition',
        409,
      )
    }
    if (current.status === input.status) {
      return { exception: exceptionListItem(current), changed: false }
    }
    if (!EXCEPTION_TRANSITIONS[current.status].has(input.status)) {
      throw new OperationsRequestError(
        'OPERATIONS_EXCEPTION_TRANSITION_INVALID',
        `Exception cannot move from ${current.status} to ${input.status}`,
        409,
      )
    }

    const correlationId = randomUUID()
    await client.query(
      `UPDATE operations_exceptions
       SET status = $3,
           resolved_by = CASE WHEN $3 = 'resolved' THEN $4 ELSE NULL END,
           resolved_at = CASE WHEN $3 = 'resolved' THEN now() ELSE NULL END,
           updated_at = now()
       WHERE organization_id = $1::uuid AND global_id = $2`,
      [organizationId, input.exceptionGlobalId, input.status, actorEmail],
    )
    const updated = await readException(client, organizationId, input.exceptionGlobalId)
    if (!updated) throw new OperationsRequestError('OPERATIONS_EXCEPTION_NOT_FOUND', 'Operations exception was not found', 404)

    await appendDomainEvent(client, {
      organizationId,
      aggregateType: 'operations.exception',
      aggregateId: updated.id,
      aggregateGlobalId: updated.global_id,
      eventType: `operations.exception.${input.status}`,
      actorEmail,
      correlationId,
      idempotencyKey: `${updated.global_id}:status:${current.status}:${input.status}:${correlationId}`,
      payload: {
        previousStatus: current.status,
        status: input.status,
        orderGlobalId: updated.order_global_id,
      },
    })
    await recordAuditEvent({
      actor: actorEmail,
      eventType: `operations.exception.${input.status}`,
      aggregateType: 'operations.exception',
      aggregateId: updated.global_id,
      subject: updated.title,
      organizationId,
      eventKey: `operations:exception:${updated.global_id}:${correlationId}`,
      payload: {
        previousStatus: current.status,
        status: input.status,
        orderGlobalId: updated.order_global_id,
      },
    }, client)

    return { exception: exceptionListItem(updated), changed: true }
  })
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>
    return `{${Object.keys(source).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(source[key])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function commandRequestHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

async function prepareCommandReceipt(input: {
  organizationId: string
  commandType: string
  idempotencyKey: string
  requestHash: string
  actorEmail: string
  targetGlobalId?: string
}): Promise<{ receipt: CommandReceiptRow; completed: boolean }> {
  return withTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(
      client,
      `operations:command-receipt:${input.organizationId}:${input.commandType}:${input.idempotencyKey}`,
    )
    const existing = await client.query<CommandReceiptRow>(
      `SELECT id::text, request_hash, target_global_id,
              status, correlation_id::text,
              result_global_id, result_payload, attempts, updated_at
       FROM operations_command_receipts
       WHERE organization_id = $1::uuid AND command_type = $2 AND idempotency_key = $3
       FOR UPDATE`,
      [input.organizationId, input.commandType, input.idempotencyKey],
    )
    let receipt = existing.rows[0]
    if (receipt) {
      if (receipt.request_hash !== input.requestHash) {
        throw new OperationsRequestError(
          'OPERATIONS_IDEMPOTENCY_CONFLICT',
          'This idempotency key was already used with different command data',
          409,
        )
      }
      if (
        input.targetGlobalId
        && receipt.target_global_id
        && receipt.target_global_id !== input.targetGlobalId
      ) {
        throw new OperationsRequestError(
          'OPERATIONS_IDEMPOTENCY_CONFLICT',
          'This idempotency key was already used for a different command target',
          409,
        )
      }
      if (input.targetGlobalId && !receipt.target_global_id) {
        const targeted = await client.query<CommandReceiptRow>(
          `UPDATE operations_command_receipts
           SET target_global_id = $2
           WHERE id = $1::uuid AND target_global_id IS NULL
           RETURNING id::text, request_hash, target_global_id,
                     status, correlation_id::text,
                     result_global_id, result_payload, attempts, updated_at`,
          [receipt.id, input.targetGlobalId],
        )
        receipt = targeted.rows[0]
      }
      if (receipt.status === 'succeeded') return { receipt, completed: true }
      if (receipt.status === 'processing' && Date.now() - receipt.updated_at.getTime() < 5 * 60_000) {
        throw new OperationsRequestError(
          'OPERATIONS_COMMAND_IN_PROGRESS',
          'This order command is already being processed',
          409,
        )
      }
      const retried = await client.query<CommandReceiptRow>(
        `UPDATE operations_command_receipts
         SET status = 'processing', actor_email = $2, attempts = attempts + 1,
             error_code = NULL, error_message = NULL, completed_at = NULL,
             started_at = now(), updated_at = now()
         WHERE id = $1::uuid
         RETURNING id::text, request_hash, target_global_id,
                   status, correlation_id::text,
                   result_global_id, result_payload, attempts, updated_at`,
        [receipt.id, input.actorEmail],
      )
      return { receipt: retried.rows[0], completed: false }
    }
    const created = await client.query<CommandReceiptRow>(
      `INSERT INTO operations_command_receipts (
         organization_id, command_type, idempotency_key, request_hash,
         actor_email, status, correlation_id, target_global_id
       ) VALUES (
         $1::uuid, $2, $3, $4, $5, 'processing', $6::uuid, $7
       )
       RETURNING id::text, request_hash, target_global_id,
                 status, correlation_id::text,
                 result_global_id, result_payload, attempts, updated_at`,
      [
        input.organizationId,
        input.commandType,
        input.idempotencyKey,
        input.requestHash,
        input.actorEmail,
        randomUUID(),
        input.targetGlobalId || null,
      ],
    )
    return { receipt: created.rows[0], completed: false }
  })
}

async function completeCommandReceipt(
  client: PoolClient,
  receiptId: string,
  resultGlobalId: string,
  resultPayload: Record<string, unknown>,
) {
  await client.query(
    `UPDATE operations_command_receipts
     SET status = 'succeeded', result_global_id = $2, result_payload = $3::jsonb,
         error_code = NULL, error_message = NULL,
         completed_at = now(), updated_at = now()
     WHERE id = $1::uuid`,
    [receiptId, resultGlobalId, JSON.stringify(resultPayload)],
  )
}

async function failCommandReceipt(receiptId: string, error: unknown) {
  const code = error instanceof OperationsRequestError
    ? error.code
    : 'OPERATIONS_REQUEST_FAILED'
  const message = error instanceof Error
    ? error.message.slice(0, 500)
    : 'Operations request failed'
  try {
    await query(
      `UPDATE operations_command_receipts
       SET status = 'failed', error_code = $2, error_message = $3,
           completed_at = now(), updated_at = now()
       WHERE id = $1::uuid AND status = 'processing'`,
      [receiptId, code, message],
    )
  } catch {
    // Preserve the command failure even if receipt persistence is unavailable.
  }
}

type ShadowExecutionCarrier = {
  provider: CheckoutRateCarrierProvider
  carrierAccountId: string
  carrierAccountGlobalId: string
}

type ShadowExecutionLine = {
  id: string
  globalId: string
  productGlobalId: string
  providerVariantId: string
  title: string
  quantity: number
  unitWeightGrams: number
}

type ShadowExecutionAllocation = {
  orderLineId: string
  lineGlobalId: string
  productGlobalId: string
  providerVariantId: string
  title: string
  quantity: number
}

type ShadowExecutionPackage = {
  id: string
  globalId: string
  packageKey: string
  packageSequence: number
  materialCode: string
  materialName: string
  lengthMm: number
  widthMm: number
  heightMm: number
  contentWeightGrams: number
  tareWeightGrams: number
  grossWeightGrams: number
  allocations: ShadowExecutionAllocation[]
}

type ShadowExecutionContext = {
  activationRevision: number
  orderId: string
  orderGlobalId: string
  orderRowVersion: number
  pipelineId: string
  customerId: string
  integrationAccountId: string
  externalOrderId: string
  currency: string
  requestedDeliveryAt: string | null
  shipTo: Record<string, unknown>
  planId: string
  planGlobalId: string
  warehouseId: string
  reconciliationId: string
  reconciliationGlobalId: string
  receiptId: string
  receiptGlobalId: string
  receiptConfigId: string
  receiptCreatedAt: string
  receiptExpiresAt: string
  receiptRequestEvidenceHash: string
  receiptResultHash: string
  receiptPackagePlanHash: string
  receiptPolicyHash: string
  receiptAlgorithmVersion: string
  receiptCarrierDestinationFingerprint: string
  fulfillmentCarrierDestinationFingerprint: string
  checkoutProvider: CheckoutRateCarrierProvider
  checkoutServiceCode: string
  checkoutServiceName: string
  checkoutCarrierCostMinor: number
  checkoutShippingChargeMinor: number
  checkoutCurrency: string
  checkoutPackageCount: number
  lines: ShadowExecutionLine[]
  packages: ShadowExecutionPackage[]
  carriers: ShadowExecutionCarrier[]
  packagePlanHash: string
  driftHash: string
}

function exactWholeQuantity(value: unknown, label: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new OperationsRequestError(
      'OPERATIONS_FULFILLMENT_EXECUTION_INVALID',
      `${label} must be an exact positive whole-unit quantity`,
      409,
    )
  }
  return parsed
}

function exactMinor(value: unknown, label: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new OperationsRequestError(
      'OPERATIONS_FULFILLMENT_EXECUTION_INVALID',
      `${label} must be an exact nonnegative minor-unit amount`,
      409,
    )
  }
  return parsed
}

function shadowExecutionDriftHash(input: Omit<
  ShadowExecutionContext,
  'driftHash'
>): string {
  return commandRequestHash({
    activationRevision: input.activationRevision,
    orderId: input.orderId,
    orderRowVersion: input.orderRowVersion,
    planId: input.planId,
    warehouseId: input.warehouseId,
    reconciliationId: input.reconciliationId,
    receiptId: input.receiptId,
    receiptResultHash: input.receiptResultHash,
    fulfillmentCarrierDestinationFingerprint:
      input.fulfillmentCarrierDestinationFingerprint,
    carriers: input.carriers,
    lines: input.lines,
    packages: input.packages,
  })
}

async function readShadowExecutionContext(
  client: PoolClient,
  input: {
    organizationId: string
    orderGlobalId: string
    expectedRowVersion: number
  },
): Promise<ShadowExecutionContext> {
  const activation = await resolveActivation(client, input.organizationId)
  if (activation.state !== 'shadow') {
    throw new OperationsRequestError(
      'OPERATIONS_SHADOW_EXECUTION_REQUIRED',
      'Shipment execution preparation is limited to Shadow mode',
      409,
    )
  }

  const orderResult = await client.query<QueryResultRow & {
    id: string
    global_id: string
    status: OperationsOrderStatus
    row_version: string
    pipeline_id: string
    customer_id: string
    integration_account_id: string | null
    source_provider: string
    external_order_id: string
    currency: string
    requested_delivery_at: Date | null
    ship_to: Record<string, unknown>
  }>(
    `SELECT
       source_order.id::text,
       source_order.global_id,
       source_order.status,
       source_order.row_version::text,
       source_order.pipeline_id::text,
       source_order.customer_id::text,
       source_order.integration_account_id::text,
       source_order.source_provider,
       source_order.external_order_id,
       source_order.currency,
       source_order.requested_delivery_at,
       source_order.ship_to
     FROM operations_orders source_order
     WHERE source_order.organization_id = $1::uuid
       AND source_order.global_id = $2
     FOR UPDATE`,
    [input.organizationId, input.orderGlobalId],
  )
  const order = orderResult.rows[0]
  if (!order) {
    throw new OperationsRequestError(
      'OPERATIONS_ORDER_NOT_FOUND',
      'Operations order was not found',
      404,
    )
  }
  if (Number(order.row_version) !== input.expectedRowVersion) {
    throw new OperationsRequestError(
      'OPERATIONS_ORDER_VERSION_CONFLICT',
      'This order changed after it was opened. Refresh before preparing shipment execution.',
      409,
    )
  }
  await requireCurrentCommerceOrderRevision(client, {
    organizationId: input.organizationId,
    orderId: order.id,
    operation: 'prepare_fulfillment',
  })
  if (
    order.status !== 'packed'
    || order.source_provider !== 'shopify'
    || !order.integration_account_id
  ) {
    throw new OperationsRequestError(
      'OPERATIONS_FULFILLMENT_EXECUTION_NOT_READY',
      'Shadow shipment execution requires one packed Shopify order with an integration account',
      409,
    )
  }

  const existingExecutionResult = await client.query<{ global_id: string }>(
    `SELECT execution.global_id
     FROM operations_fulfillment_executions execution
     WHERE execution.organization_id = $1::uuid
       AND execution.order_id = $2::uuid
     LIMIT 1
     FOR SHARE`,
    [input.organizationId, order.id],
  )
  const existingExecution = existingExecutionResult.rows[0]
  if (existingExecution) {
    throw new OperationsRequestError(
      'OPERATIONS_FULFILLMENT_EXECUTION_ALREADY_PREPARED',
      `Shadow preparation ${existingExecution.global_id} is already durable for this order`,
      409,
    )
  }

  const blockerResult = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count
     FROM operations_exceptions exception
     WHERE exception.organization_id = $1::uuid
       AND exception.order_id = $2::uuid
       AND exception.status IN ('open', 'acknowledged')`,
    [input.organizationId, order.id],
  )
  if (Number(blockerResult.rows[0]?.count || 0) !== 0) {
    throw new OperationsRequestError(
      'OPERATIONS_FULFILLMENT_EXECUTION_BLOCKED',
      'Resolve all order exceptions before preparing shipment execution',
      409,
    )
  }

  const planResult = await client.query<QueryResultRow & {
    id: string
    global_id: string
    status: string
    warehouse_id: string
  }>(
    `SELECT plan.id::text, plan.global_id, plan.status,
            plan.warehouse_id::text
     FROM operations_fulfillment_plans plan
     WHERE plan.organization_id = $1::uuid
       AND plan.order_id = $2::uuid
     ORDER BY plan.version_number DESC
     LIMIT 1
     FOR UPDATE`,
    [input.organizationId, order.id],
  )
  const plan = planResult.rows[0]
  if (!plan || plan.status !== 'released') {
    throw new OperationsRequestError(
      'OPERATIONS_FULFILLMENT_PLAN_INVALID',
      'The latest single-warehouse fulfillment plan must be released',
      409,
    )
  }

  const lineRows = await client.query<QueryResultRow & {
    id: string
    global_id: string
    product_global_id: string
    provider_variant_id: string
    description: string
    quantity: string
    weight_grams: number
  }>(
    `SELECT
       line.id::text,
       line.global_id,
       product.reference_code AS product_global_id,
       candidate_line.external_variant_id AS provider_variant_id,
       line.description,
       line.quantity::text,
       line.weight_grams
     FROM operations_current_order_lines line
     JOIN crm_products product
       ON product.pipeline_id = line.pipeline_id
      AND product.id = line.product_id
     JOIN operations_commerce_order_candidates candidate
       ON candidate.organization_id = line.organization_id
      AND candidate.canonical_order_id = line.order_id
      AND candidate.integration_account_id = $3::uuid
      AND candidate.provider = 'shopify'
      AND candidate.workflow_state = 'promoted'
     JOIN operations_commerce_current_planning_lines candidate_line
       ON candidate_line.organization_id = line.organization_id
      AND candidate_line.order_candidate_id = candidate.id
      AND candidate_line.canonical_order_line_id = line.id
      AND candidate_line.provider = 'shopify'
      AND candidate_line.workflow_state = 'promoted'
      AND candidate_line.external_variant_id IS NOT NULL
     WHERE line.organization_id = $1::uuid
       AND line.order_id = $2::uuid
     ORDER BY line.global_id
     FOR UPDATE OF line`,
    [input.organizationId, order.id, order.integration_account_id],
  )
  const lines: ShadowExecutionLine[] = lineRows.rows.map((line) => ({
    id: line.id,
    globalId: line.global_id,
    productGlobalId: line.product_global_id,
    providerVariantId: line.provider_variant_id,
    title: line.description,
    quantity: exactWholeQuantity(line.quantity, `Order line ${line.global_id}`),
    unitWeightGrams: exactWholeQuantity(
      line.weight_grams,
      `Order line ${line.global_id} weight`,
    ),
  }))
  if (!lines.length) {
    throw new OperationsRequestError(
      'OPERATIONS_ORDER_LINES_INVALID',
      'The packed order has no canonical lines',
      409,
    )
  }
  const lineById = new Map(lines.map((line) => [line.id, line]))

  const packageRows = await client.query<QueryResultRow & {
    id: string
    global_id: string
    package_number: number
    status: string
    evidence_package_key: string | null
    length_mm: number
    width_mm: number
    height_mm: number
    weight_grams: number
    material_code: string | null
    material_name: string | null
    content_weight_grams: number | null
    tare_weight_grams: number | null
  }>(
    `SELECT
       package.id::text,
       package.global_id,
       package.package_number,
       package.status,
       package.evidence_package_key,
       package.length_mm,
       package.width_mm,
       package.height_mm,
       package.weight_grams,
       material.code AS material_code,
       material.name AS material_name,
       evidence_package.content_weight_grams,
       evidence_package.tare_weight_grams
     FROM operations_packages package
     LEFT JOIN operations_cartonization_rate_evidence_packages
       evidence_package
       ON evidence_package.organization_id = package.organization_id
      AND evidence_package.evidence_id = package.cartonization_evidence_id
      AND evidence_package.package_key = package.evidence_package_key
     LEFT JOIN operations_packaging_materials material
       ON material.organization_id = evidence_package.organization_id
      AND material.id = evidence_package.packaging_material_id
     WHERE package.organization_id = $1::uuid
       AND package.plan_id = $2::uuid
     ORDER BY package.package_number
     FOR UPDATE OF package`,
    [input.organizationId, plan.id],
  )
  if (
    !packageRows.rows.length
    || packageRows.rows.some((item) => (
      item.status !== 'packed'
      || !item.evidence_package_key
      || !item.material_code
      || !item.material_name
      || !item.content_weight_grams
      || !item.tare_weight_grams
      || item.weight_grams !== (
        item.content_weight_grams + item.tare_weight_grams
      )
    ))
  ) {
    throw new OperationsRequestError(
      'OPERATIONS_CANONICAL_PACKAGES_REQUIRED',
      'Every physical package must be packed and bound to sealed cartonization evidence',
      409,
    )
  }

  const allocationRows = await client.query<QueryResultRow & {
    package_id: string
    order_line_id: string
    line_global_id: string
    product_global_id: string
    title: string
    quantity: string
  }>(
    `SELECT
       content.package_id::text,
       content.order_line_id::text,
       line.global_id AS line_global_id,
       product.reference_code AS product_global_id,
       line.description AS title,
       content.quantity::text
     FROM operations_package_contents content
     JOIN operations_current_order_lines line
       ON line.organization_id = content.organization_id
      AND line.id = content.order_line_id
     JOIN crm_products product
       ON product.pipeline_id = line.pipeline_id
      AND product.id = line.product_id
     WHERE content.organization_id = $1::uuid
       AND content.plan_id = $2::uuid
       AND content.order_id = $3::uuid
     ORDER BY content.package_id, line.global_id
     FOR UPDATE OF content`,
    [input.organizationId, plan.id, order.id],
  )
  const allocationByPackage = new Map<string, ShadowExecutionAllocation[]>()
  const allocatedByLine = new Map<string, number>()
  for (const allocation of allocationRows.rows) {
    const executionLine = lineById.get(allocation.order_line_id)
    if (!executionLine) {
      throw new OperationsRequestError(
        'OPERATIONS_PACKAGE_CONTENTS_INCOMPLETE',
        'Physical package allocations must resolve one promoted provider variant identity',
        409,
      )
    }
    const quantity = exactWholeQuantity(
      allocation.quantity,
      `Package allocation ${allocation.line_global_id}`,
    )
    const values = allocationByPackage.get(allocation.package_id) || []
    values.push({
      orderLineId: allocation.order_line_id,
      lineGlobalId: allocation.line_global_id,
      productGlobalId: allocation.product_global_id,
      providerVariantId: executionLine.providerVariantId,
      title: allocation.title,
      quantity,
    })
    allocationByPackage.set(allocation.package_id, values)
    allocatedByLine.set(
      allocation.order_line_id,
      (allocatedByLine.get(allocation.order_line_id) || 0) + quantity,
    )
  }
  if (
    lines.some((line) => allocatedByLine.get(line.id) !== line.quantity)
    || packageRows.rows.some(
      (packageRow) => !allocationByPackage.get(packageRow.id)?.length,
    )
  ) {
    throw new OperationsRequestError(
      'OPERATIONS_PACKAGE_CONTENTS_INCOMPLETE',
      'Physical package allocations must exactly cover every canonical order line',
      409,
    )
  }
  const packages: ShadowExecutionPackage[] = packageRows.rows.map((item) => ({
    id: item.id,
    globalId: item.global_id,
    packageKey: item.evidence_package_key as string,
    packageSequence: item.package_number,
    materialCode: item.material_code as string,
    materialName: item.material_name as string,
    lengthMm: item.length_mm,
    widthMm: item.width_mm,
    heightMm: item.height_mm,
    contentWeightGrams: item.content_weight_grams as number,
    tareWeightGrams: item.tare_weight_grams as number,
    grossWeightGrams: item.weight_grams,
    allocations: allocationByPackage.get(item.id) || [],
  }))

  const reconciliationResult = await client.query<QueryResultRow & {
    id: string
    global_id: string
    receipt_id: string
    receipt_global_id: string
    receipt_config_id: string
    outcome: ShopifyCheckoutRateReconciliationOutcome
    source_shipping_charge_minor: string | null
    source_shopify_service_code: string | null
    selected_carrier_provider: CheckoutRateCarrierProvider | null
    selected_service_code: string | null
    selected_currency: string | null
    selected_customer_charge_minor: string | null
    receipt_created_at: Date
    receipt_expires_at: Date | null
    request_evidence_hash: string
    receipt_result_hash: string
    receipt_package_plan_hash: string
    receipt_policy_hash: string
    receipt_algorithm_version: string
    receipt_carrier_destination_fingerprint: string
    checkout_service_name: string | null
    checkout_carrier_cost_minor: string | null
    checkout_package_count: number
  }>(
    `SELECT
       reconciliation.id::text,
       reconciliation.global_id,
       reconciliation.receipt_id::text,
       receipt.global_id AS receipt_global_id,
       receipt.config_id::text AS receipt_config_id,
       reconciliation.outcome,
       reconciliation.source_shipping_charge_minor::text,
       reconciliation.source_shopify_service_code,
       reconciliation.selected_carrier_provider,
       reconciliation.selected_service_code,
       reconciliation.selected_currency,
       reconciliation.selected_customer_charge_minor::text,
       receipt.created_at AS receipt_created_at,
       receipt.expires_at AS receipt_expires_at,
       receipt.request_evidence_hash,
       receipt.result_hash AS receipt_result_hash,
       receipt.package_plan_hash AS receipt_package_plan_hash,
       receipt.policy_hash AS receipt_policy_hash,
       receipt.algorithm_version AS receipt_algorithm_version,
       receipt.carrier_destination_fingerprint
         AS receipt_carrier_destination_fingerprint,
       selected_offer.service_name AS checkout_service_name,
       selected_offer.carrier_cost_minor::text
         AS checkout_carrier_cost_minor,
       receipt.package_count AS checkout_package_count
     FROM operations_shopify_checkout_rate_current_reconciliations
       reconciliation
     JOIN operations_shopify_checkout_rate_receipts receipt
       ON receipt.organization_id = reconciliation.organization_id
      AND receipt.id = reconciliation.receipt_id
     LEFT JOIN operations_shopify_checkout_rate_receipt_offers
       selected_offer
       ON selected_offer.organization_id = receipt.organization_id
      AND selected_offer.receipt_id = receipt.id
      AND selected_offer.shopify_service_code
        = reconciliation.source_shopify_service_code
     WHERE reconciliation.organization_id = $1::uuid
       AND reconciliation.order_id = $2::uuid
     ORDER BY reconciliation.created_at DESC`,
    [input.organizationId, order.id],
  )
  if (reconciliationResult.rows.length !== 1) {
    throw new OperationsRequestError(
      'OPERATIONS_SHOPIFY_CHECKOUT_RATE_RECONCILIATION_REQUIRED',
      'Exactly one current Shopify checkout-rate reconciliation is required',
      409,
    )
  }
  const reconciliation = reconciliationResult.rows[0]
  if (
    reconciliation.outcome !== 'matched'
    || !reconciliation.receipt_expires_at
    || !reconciliation.source_shopify_service_code
    || !reconciliation.selected_carrier_provider
    || !reconciliation.selected_service_code
    || !reconciliation.selected_currency
    || !reconciliation.checkout_service_name
    || reconciliation.checkout_carrier_cost_minor === null
    || reconciliation.selected_customer_charge_minor === null
    || reconciliation.source_shipping_charge_minor === null
    || reconciliation.selected_customer_charge_minor
      !== reconciliation.source_shipping_charge_minor
  ) {
    throw new OperationsRequestError(
      'OPERATIONS_SHOPIFY_CHECKOUT_RATE_RECONCILIATION_REQUIRED',
      'The current Shopify reconciliation must be an exact matched checkout offer',
      409,
    )
  }
  const invalidReceiptFacts = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count
     FROM operations_shopify_checkout_rate_receipt_lines line
     WHERE line.organization_id = $1::uuid
       AND line.receipt_id = $2::uuid
       AND line.unit_weight_grams <= 0`,
    [input.organizationId, reconciliation.receipt_id],
  )
  if (Number(invalidReceiptFacts.rows[0]?.count || 0) !== 0) {
    throw new OperationsRequestError(
      'OPERATIONS_CHECKOUT_PACK_RATE_INCOMPLETE',
      'The matched checkout receipt lacks positive unit-weight evidence',
      409,
    )
  }

  const carrierRows = await client.query<QueryResultRow & {
    carrier_provider: CheckoutRateCarrierProvider
    carrier_account_id: string
    carrier_account_global_id: string
    environment: string
  }>(
    `SELECT
       binding.carrier_provider,
       carrier_account.id::text AS carrier_account_id,
       carrier_account.global_id AS carrier_account_global_id,
       carrier_connection.environment
     FROM operations_shopify_carrier_service_configs config
     JOIN operations_shopify_carrier_service_config_carriers binding
       ON binding.organization_id = config.organization_id
      AND binding.config_id = config.id
     JOIN operations_carrier_accounts carrier_account
       ON carrier_account.organization_id = binding.organization_id
      AND carrier_account.id = binding.carrier_account_id
     JOIN operations_integration_accounts carrier_connection
       ON carrier_connection.organization_id = carrier_account.organization_id
      AND carrier_connection.id = carrier_account.integration_account_id
     WHERE config.organization_id = $1::uuid
       AND config.integration_account_id = $2::uuid
       AND config.warehouse_id = $3::uuid
       AND config.id = $4::uuid
       AND operations_shopify_carrier_service_config_is_ready(
         config.organization_id, config.id
       )
     ORDER BY binding.carrier_provider
     FOR UPDATE OF config, binding, carrier_account, carrier_connection`,
    [
      input.organizationId,
      order.integration_account_id,
      plan.warehouse_id,
      reconciliation.receipt_config_id,
    ],
  )
  if (
    carrierRows.rows.length !== 2
    || carrierRows.rows.some((row) => row.environment !== 'sandbox')
    || new Set(carrierRows.rows.map((row) => row.carrier_provider)).size !== 2
  ) {
    throw new OperationsRequestError(
      'OPERATIONS_SHADOW_CARRIERS_NOT_READY',
      'Shadow execution requires the configured UPS and FedEx sandbox accounts',
      409,
    )
  }
  const carriers: ShadowExecutionCarrier[] = carrierRows.rows.map((row) => ({
    provider: row.carrier_provider,
    carrierAccountId: row.carrier_account_id,
    carrierAccountGlobalId: row.carrier_account_global_id,
  }))
  const packagePlanHash = commandRequestHash(packages.map((item) => ({
    packageKey: item.packageKey,
    packageSequence: item.packageSequence,
    lengthMm: item.lengthMm,
    widthMm: item.widthMm,
    heightMm: item.heightMm,
    grossWeightGrams: item.grossWeightGrams,
    allocations: item.allocations,
  })))
  const contextWithoutDrift: Omit<ShadowExecutionContext, 'driftHash'> = {
    activationRevision: activation.revision,
    orderId: order.id,
    orderGlobalId: order.global_id,
    orderRowVersion: Number(order.row_version),
    pipelineId: order.pipeline_id,
    customerId: order.customer_id,
    integrationAccountId: order.integration_account_id,
    externalOrderId: order.external_order_id,
    currency: order.currency.toUpperCase(),
    requestedDeliveryAt:
      order.requested_delivery_at?.toISOString() || null,
    shipTo: order.ship_to,
    planId: plan.id,
    planGlobalId: plan.global_id,
    warehouseId: plan.warehouse_id,
    reconciliationId: reconciliation.id,
    reconciliationGlobalId: reconciliation.global_id,
    receiptId: reconciliation.receipt_id,
    receiptGlobalId: reconciliation.receipt_global_id,
    receiptConfigId: reconciliation.receipt_config_id,
    receiptCreatedAt: reconciliation.receipt_created_at.toISOString(),
    receiptExpiresAt: reconciliation.receipt_expires_at.toISOString(),
    receiptRequestEvidenceHash:
      reconciliation.request_evidence_hash,
    receiptResultHash: reconciliation.receipt_result_hash,
    receiptPackagePlanHash:
      reconciliation.receipt_package_plan_hash,
    receiptPolicyHash: reconciliation.receipt_policy_hash,
    receiptAlgorithmVersion:
      reconciliation.receipt_algorithm_version,
    receiptCarrierDestinationFingerprint:
      reconciliation.receipt_carrier_destination_fingerprint,
    fulfillmentCarrierDestinationFingerprint:
      carrierSandboxRateDestinationFingerprint(
        shadowExecutionDestination(order.ship_to),
      ),
    checkoutProvider:
      reconciliation.selected_carrier_provider,
    checkoutServiceCode: reconciliation.selected_service_code,
    checkoutServiceName: reconciliation.checkout_service_name,
    checkoutCarrierCostMinor: exactMinor(
      reconciliation.checkout_carrier_cost_minor,
      'Checkout carrier cost',
    ),
    checkoutShippingChargeMinor: exactMinor(
      reconciliation.selected_customer_charge_minor,
      'Checkout shipping charge',
    ),
    checkoutCurrency: reconciliation.selected_currency.toUpperCase(),
    checkoutPackageCount: reconciliation.checkout_package_count,
    lines,
    packages,
    carriers,
    packagePlanHash,
  }
  if (contextWithoutDrift.checkoutCurrency !== contextWithoutDrift.currency) {
    throw new OperationsRequestError(
      'OPERATIONS_CHECKOUT_CURRENCY_MISMATCH',
      'Checkout and order currencies do not match',
      409,
    )
  }
  return {
    ...contextWithoutDrift,
    driftHash: shadowExecutionDriftHash(contextWithoutDrift),
  }
}

function completedShadowFulfillmentExecutionResult(
  receipt: Pick<CommandReceiptRow, 'result_payload'>,
): OperationsShadowFulfillmentExecutionResult {
  const payload = receipt.result_payload
  if (
    !payload
    || typeof payload.orderGlobalId !== 'string'
    || payload.orderStatus !== 'packed'
    || typeof payload.fulfillmentExecutionGlobalId !== 'string'
    || typeof payload.shipmentGroupGlobalId !== 'string'
    || !Array.isArray(payload.providerAttempts)
  ) {
    throw new OperationsRequestError(
      'OPERATIONS_COMMAND_RECEIPT_INVALID',
      'Completed command receipt has no Shadow fulfillment execution result',
      409,
    )
  }
  return {
    ...(payload as unknown as OperationsShadowFulfillmentExecutionResult),
    replayed: true,
  }
}

function shadowExecutionDestination(
  shipTo: Record<string, unknown>,
) {
  const value = (key: string): string | null => {
    const normalized = String(shipTo[key] ?? '').trim()
    return normalized || null
  }
  const postalCode = value('postalCode')
  const country = String(shipTo.country ?? '').trim().toUpperCase()
  if (
    !postalCode
    || !['US', 'USA', 'UNITED STATES', 'UNITED STATES OF AMERICA'].includes(
      country,
    )
  ) {
    throw new OperationsRequestError(
      'OPERATIONS_SHADOW_DESTINATION_INVALID',
      'Shadow shipment preparation currently requires one complete US destination',
      409,
    )
  }
  return {
    name: value('name'),
    line1: value('line1'),
    line2: value('line2'),
    city: value('city'),
    region: value('region'),
    postalCode,
    countryCode: 'US' as const,
  }
}

function shadowExecutionParcels(context: ShadowExecutionContext) {
  return context.packages.map((item) => ({
    packageKey: item.packageKey,
    description: `ClawPilot carton ${item.packageSequence}`,
    exteriorInches: {
      length: Math.ceil(item.lengthMm / 25.4),
      width: Math.ceil(item.widthMm / 25.4),
      height: Math.ceil(item.heightMm / 25.4),
    },
    grossPounds: Math.max(
      0.1,
      Math.ceil((item.grossWeightGrams / 453.59237) * 10) / 10,
    ),
  }))
}

function selectShadowExecutionRate(
  context: ShadowExecutionContext,
  rated: CheckoutShipmentRateResult,
) {
  const packageKeys = context.packages.map((item) => item.packageKey)
  const offers: CanonicalWholeShipmentRateOffer[] = rated.offers.flatMap(
    (offer) => {
      const delivery = estimatedDeliveryAt(
        rated.completedAt,
        offer.deliveryDate,
        offer.transitDays,
      )
      if (!delivery) return []
      return [{
        evidenceState: 'sealed' as const,
        rateScope: 'multi_package_shipment' as const,
        rateEvidenceGlobalId: offer.evidenceGlobalId,
        packagePlanHash: context.packagePlanHash,
        packageCount: context.packages.length,
        packageKeys,
        provider: offer.provider,
        serviceCode: offer.serviceLevelCode,
        serviceName: offer.serviceName,
        carrierCostMinor: offer.amountMinor,
        currency: offer.currency,
        transitDays: delivery.transitDays,
        estimatedDeliveryAt: delivery.deliveryAt,
      }]
    },
  )
  try {
    return selectCanonicalFulfillmentRate({
      packagePlanHash: context.packagePlanHash,
      packageCount: context.packages.length,
      packageKeys,
      expectedCurrency: context.currency,
      requestedDeliveryAt: context.requestedDeliveryAt,
      actualCheckoutShippingChargeMinor:
        context.checkoutShippingChargeMinor,
      offers,
    })
  } catch (error) {
    if (error instanceof CanonicalFulfillmentPlanningError) {
      throw new OperationsRequestError(
        `OPERATIONS_${error.code}`,
        error.message,
        409,
      )
    }
    throw error
  }
}

type ShadowRateEvidenceRow = QueryResultRow & {
  id: string
  global_id: string
  provider: CheckoutRateCarrierProvider
  carrier_account_id: string
  request_hash: string
  environment: string
  purpose: string
  status: 'succeeded' | 'failed'
  error_code: string | null
  redacted_request: Record<string, unknown>
  redacted_response: Record<string, unknown>
}

function nestedRecord(
  value: unknown,
  key: string,
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const nested = (value as Record<string, unknown>)[key]
  return nested && typeof nested === 'object' && !Array.isArray(nested)
    ? nested as Record<string, unknown>
    : {}
}

export async function prepareOperationsShipmentExecutionFromPostgres(input: {
  organizationId: string
  actorEmail: string
  orderGlobalId: string
  expectedRowVersion: number
  reason: string
  idempotencyKey: string
}): Promise<OperationsShadowFulfillmentExecutionResult> {
  const organizationId = requireOrganizationId(input.organizationId)
  const actorEmail = String(input.actorEmail || '').trim().toLowerCase()
  const orderGlobalId = String(input.orderGlobalId || '').trim()
  const reason = String(input.reason || '').trim()
  const idempotencyKey = String(input.idempotencyKey || '').trim()
  if (!actorEmail) {
    throw new OperationsRequestError(
      'OPERATIONS_ACTOR_REQUIRED',
      'A signed-in user is required',
      401,
    )
  }
  if (!/^gor(?:[0-9]{7}|[0-9a-v]{12})$/.test(orderGlobalId)) {
    throw new OperationsRequestError(
      'OPERATIONS_ORDER_INVALID',
      'Order is invalid',
    )
  }
  if (
    !Number.isSafeInteger(input.expectedRowVersion)
    || input.expectedRowVersion < 0
  ) {
    throw new OperationsRequestError(
      'OPERATIONS_ORDER_VERSION_INVALID',
      'Order version is invalid',
    )
  }
  if (!reason || reason.length > 500) {
    throw new OperationsRequestError(
      'OPERATIONS_FULFILLMENT_EXECUTION_REASON_INVALID',
      'A Shadow shipment-preparation reason is required',
    )
  }
  if (!/^[A-Za-z0-9._:-]{8,200}$/.test(idempotencyKey)) {
    throw new OperationsRequestError(
      'OPERATIONS_IDEMPOTENCY_KEY_INVALID',
      'A valid idempotency key is required',
    )
  }

  const requestHash = commandRequestHash({
    orderGlobalId,
    expectedRowVersion: input.expectedRowVersion,
    reason,
  })
  const command = await prepareCommandReceipt({
    organizationId,
    commandType: 'prepare_operations_shipment_execution',
    idempotencyKey,
    requestHash,
    actorEmail,
  })
  if (command.completed) {
    return completedShadowFulfillmentExecutionResult(command.receipt)
  }

  try {
    const preflight = await withTransaction(async (client) => {
      await acquireTransactionAdvisoryLock(
        client,
        `operations:activation:${organizationId}`,
      )
      await acquireTransactionAdvisoryLock(
        client,
        `operations:order:${organizationId}:${orderGlobalId}`,
      )
      return readShadowExecutionContext(client, {
        organizationId,
        orderGlobalId,
        expectedRowVersion: input.expectedRowVersion,
      })
    })

    // This is deliberately outside either database transaction. The helper
    // calls every configured carrier once with the complete ordered package
    // array and permits at most one degraded provider with durable evidence.
    const rated = await rateCheckoutShipment({
      destination: shadowExecutionDestination(preflight.shipTo),
      parcels: shadowExecutionParcels(preflight),
      carriers: preflight.carriers.map((carrier) => ({
        provider: carrier.provider,
        carrierAccountGlobalId: carrier.carrierAccountGlobalId,
      })),
      currency: preflight.currency,
      deadlineAt: Date.now() + 25_000,
      invoke: async (selection, request) => {
        const result = await testCarrierSandboxShipmentRate({
          organizationId,
          provider: selection.provider,
          environment: 'sandbox',
          carrierAccountGlobalId: selection.carrierAccountGlobalId,
          destination: request.destination,
          parcels: request.parcels,
          actorEmail,
          timeoutMs: 20_000,
          signal: request.signal,
          requireFailureEvidence: true,
        })
        return {
          provider: selection.provider,
          carrierAccountGlobalId: selection.carrierAccountGlobalId,
          packageCount: request.parcels.length,
          rateScope: 'multi_package_shipment' as const,
          rates: result.rates.map((rate) => ({
            serviceCode: rate.serviceCode,
            serviceName: rate.serviceName,
            amount: rate.amount,
            currency: rate.currency,
            transitDays: rate.transitDays,
            deliveryDate: rate.deliveryDate,
            evidenceGlobalId: result.evidenceGlobalId,
          })),
        }
      },
    })
    const selected = selectShadowExecutionRate(preflight, rated)

    return await withTransaction(async (client) => {
      await acquireTransactionAdvisoryLock(
        client,
        `operations:activation:${organizationId}`,
      )
      await acquireTransactionAdvisoryLock(
        client,
        `operations:order:${organizationId}:${orderGlobalId}`,
      )
      const current = await readShadowExecutionContext(client, {
        organizationId,
        orderGlobalId,
        expectedRowVersion: input.expectedRowVersion,
      })
      if (current.driftHash !== preflight.driftHash) {
        throw new OperationsRequestError(
          'OPERATIONS_FULFILLMENT_EXECUTION_DRIFT',
          'Order, packages, checkout reconciliation, or carrier configuration changed during rating',
          409,
        )
      }

      const evidenceIds = rated.providerAttempts.map(
        (attempt) => attempt.rateEvidenceGlobalId,
      )
      const evidenceResult = await client.query<ShadowRateEvidenceRow>(
        `SELECT
           evidence.id::text,
           evidence.global_id,
           evidence.provider,
           evidence.carrier_account_id::text,
           evidence.request_hash,
           evidence.environment,
           evidence.purpose,
           evidence.status,
           evidence.error_code,
           evidence.redacted_request,
           evidence.redacted_response
         FROM operations_carrier_rate_requests evidence
         WHERE evidence.organization_id = $1::uuid
           AND evidence.global_id = ANY($2::text[])
         ORDER BY evidence.provider
         FOR SHARE`,
        [organizationId, evidenceIds],
      )
      if (evidenceResult.rows.length !== rated.providerAttempts.length) {
        throw new OperationsRequestError(
          'OPERATIONS_CARRIER_RATE_EVIDENCE_REQUIRED',
          'Every configured carrier attempt must retain durable evidence',
          409,
        )
      }
      const evidenceByGlobalId = new Map(
        evidenceResult.rows.map((row) => [row.global_id, row]),
      )
      for (const attempt of rated.providerAttempts) {
        const evidence = evidenceByGlobalId.get(
          attempt.rateEvidenceGlobalId,
        )
        const carrier = current.carriers.find(
          (item) => item.provider === attempt.provider,
        )
        const shipment = nestedRecord(evidence?.redacted_request, 'shipment')
        if (
          !evidence
          || !carrier
          || evidence.provider !== attempt.provider
          || evidence.carrier_account_id !== carrier.carrierAccountId
          || evidence.environment !== 'sandbox'
          || evidence.purpose !== 'cartonization_shipment_rate'
          || shipment.destinationFingerprint
            !== current.fulfillmentCarrierDestinationFingerprint
          || shipment.rateScope !== 'multi_package_shipment'
          || Number(shipment.packageCount) !== current.packages.length
          || (
            attempt.status === 'succeeded'
            && (
              evidence.status !== 'succeeded'
              || evidence.error_code !== null
              || attempt.failureCode !== null
            )
          )
          || (
            attempt.status === 'degraded'
            && (
              evidence.status !== 'failed'
              || evidence.error_code !== attempt.failureCode
            )
          )
        ) {
          throw new OperationsRequestError(
            'OPERATIONS_CARRIER_RATE_EVIDENCE_MISMATCH',
            'Carrier attempt evidence no longer matches this exact Shadow rerate',
            409,
          )
        }
      }

      const replayGroupKey =
        `shadow:${orderGlobalId}:${current.receiptGlobalId}:` +
        requestHash.slice(0, 16)
      const scenarioId = `shadow-${orderGlobalId}`
      const checkoutIdempotencyKey = `shadow-checkout:${requestHash}`
      const fulfillmentIdempotencyKey =
        `shadow-fulfillment:${requestHash}`

      const checkoutRunResult = await client.query<{
        id: string
        global_id: string
      }>(
        `INSERT INTO operations_pack_rate_runs (
           organization_id,
           replay_group_key,
           scenario_id,
           source_kind,
           source_reference,
           provider,
           checkout_source,
           purpose,
           prior_checkout_run_id,
           pipeline_id,
           customer_id,
           customer_resolution_outcome,
           status,
           blocker_code,
           policy_version,
           algorithm_version,
           input_hash,
           result_hash,
           input_snapshot,
           result_snapshot,
           stage_snapshot,
           line_count,
           package_count,
           rate_choice_count,
           currency,
           selected_provider,
           selected_service_code,
           selected_service_name,
           selected_carrier_cost_minor,
           customer_charge_minor,
           mud_markup_minor,
           margin_minor,
           idempotency_key,
           actor_email,
           provider_write_count,
           postage_purchase_count,
           label_write_count,
           expires_at,
           created_at,
           pricing_semantics_version
         )
         SELECT
           receipt.organization_id,
           $3,
           $4,
           'provider_checkout',
           receipt.global_id,
           'shopify',
           'live_callback_recorded',
           'checkout_quote',
           NULL,
           NULL,
           NULL,
           'not_attempted',
           'succeeded',
           NULL,
           receipt.policy_hash,
           receipt.algorithm_version,
           receipt.request_evidence_hash,
           receipt.result_hash,
           receipt.redacted_request_snapshot,
           receipt.result_snapshot,
           jsonb_build_object(
             'stage', 'checkout_quote',
             'receiptGlobalId', receipt.global_id,
             'reconciliationGlobalId', $5::text
           ),
           receipt.line_count,
           receipt.package_count,
           receipt.offer_count,
           receipt.currency,
           $6,
           $7,
           $8,
           $9::bigint,
           $10::bigint,
           NULL,
           $10::bigint - $9::bigint,
           $11,
           $12,
           0,
           0,
           0,
           receipt.expires_at,
           receipt.created_at,
           2
         FROM operations_shopify_checkout_rate_receipts receipt
         WHERE receipt.organization_id = $1::uuid
           AND receipt.id = $2::uuid
           AND receipt.status = 'succeeded'
         RETURNING id::text, global_id`,
        [
          organizationId,
          current.receiptId,
          replayGroupKey,
          scenarioId,
          current.reconciliationGlobalId,
          current.checkoutProvider,
          current.checkoutServiceCode,
          current.checkoutServiceName,
          current.checkoutCarrierCostMinor,
          current.checkoutShippingChargeMinor,
          checkoutIdempotencyKey,
          actorEmail,
        ],
      )
      const checkoutRun = checkoutRunResult.rows[0]
      if (!checkoutRun) {
        throw new OperationsRequestError(
          'OPERATIONS_CHECKOUT_PACK_RATE_REQUIRED',
          'The matched checkout receipt could not become immutable pack-and-rate evidence',
          409,
        )
      }

      await client.query(
        `INSERT INTO operations_pack_rate_run_lines (
           organization_id,
           run_id,
           line_key,
           product_key,
           title,
           required_quantity,
           unit_weight_grams,
           line_hash,
           line_snapshot
         )
         SELECT
           line.organization_id,
           $3::uuid,
           line.line_key,
           line.provider_variant_id,
           COALESCE(NULLIF(line.sku, ''), line.provider_variant_id),
           line.quantity,
           line.unit_weight_grams,
           line.line_hash,
           line.line_snapshot
         FROM operations_shopify_checkout_rate_receipt_lines line
         WHERE line.organization_id = $1::uuid
           AND line.receipt_id = $2::uuid`,
        [organizationId, current.receiptId, checkoutRun.id],
      )
      await client.query(
        `INSERT INTO operations_pack_rate_run_packages (
           organization_id,
           run_id,
           package_key,
           package_sequence,
           material_code,
           material_name,
           length_mm,
           width_mm,
           height_mm,
           content_weight_grams,
           tare_weight_grams,
           gross_weight_grams,
           allocation_count,
           package_hash,
           package_snapshot
         )
         SELECT
           package.organization_id,
           $3::uuid,
           package.package_key,
           package.package_sequence,
           material.code,
           material.name,
           package.rated_outer_length_mm,
           package.rated_outer_width_mm,
           package.rated_outer_height_mm,
           package.content_weight_grams,
           package.tare_weight_grams,
           package.gross_weight_grams,
           package.allocation_count,
           package.package_hash,
           package.package_snapshot
         FROM operations_shopify_checkout_rate_receipt_packages package
         JOIN operations_packaging_materials material
           ON material.organization_id = package.organization_id
          AND material.id = package.packaging_material_id
         WHERE package.organization_id = $1::uuid
           AND package.receipt_id = $2::uuid`,
        [organizationId, current.receiptId, checkoutRun.id],
      )
      await client.query(
        `INSERT INTO operations_pack_rate_run_allocations (
           organization_id,
           run_id,
           package_key,
           line_key,
           product_key,
           comparison_product_key,
           title,
           quantity,
           allocation_hash
         )
         SELECT
           allocation.organization_id,
           $3::uuid,
           allocation.package_key,
           allocation.line_key,
           line.provider_variant_id,
           line.provider_variant_id,
           COALESCE(NULLIF(line.sku, ''), line.provider_variant_id),
           allocation.quantity,
           allocation.allocation_hash
         FROM operations_shopify_checkout_rate_receipt_allocations allocation
         JOIN operations_shopify_checkout_rate_receipt_lines line
           ON line.organization_id = allocation.organization_id
          AND line.receipt_id = allocation.receipt_id
          AND line.line_key = allocation.line_key
         WHERE allocation.organization_id = $1::uuid
           AND allocation.receipt_id = $2::uuid`,
        [organizationId, current.receiptId, checkoutRun.id],
      )
      await client.query(
        `INSERT INTO operations_pack_rate_run_rate_choices (
           organization_id,
           run_id,
           provider,
           service_code,
           service_name,
           carrier_cost_minor,
           currency,
           selected,
           recorded_fact_version,
           normalized_response
         )
         SELECT
           offer.organization_id,
           $3::uuid,
           offer.carrier_provider,
           offer.service_code,
           offer.service_name,
           offer.carrier_cost_minor,
           offer.currency,
           (
             offer.carrier_provider = $4
             AND offer.service_code = $5
           ),
           'shopify-checkout-receipt-v1',
           offer.offer_snapshot
           || jsonb_build_object(
             'packagePlanHash', offer.package_plan_hash,
             'packageCount', offer.package_count
           )
         FROM operations_shopify_checkout_rate_receipt_offers offer
         WHERE offer.organization_id = $1::uuid
           AND offer.receipt_id = $2::uuid`,
        [
          organizationId,
          current.receiptId,
          checkoutRun.id,
          current.checkoutProvider,
          current.checkoutServiceCode,
        ],
      )

      const fulfillmentInputSnapshot = {
        checkoutCarrierDestinationFingerprint:
          current.receiptCarrierDestinationFingerprint,
        carrierDestinationFingerprint:
          current.fulfillmentCarrierDestinationFingerprint,
        configuredCarriers: current.carriers.map((carrier) => ({
          provider: carrier.provider,
          carrierAccountId: carrier.carrierAccountId,
          carrierAccountGlobalId: carrier.carrierAccountGlobalId,
        })),
        orderGlobalId,
        planGlobalId: current.planGlobalId,
        packagePlanHash: current.packagePlanHash,
        packages: current.packages.map((item) => ({
          packageKey: item.packageKey,
          packageSequence: item.packageSequence,
          lengthMm: item.lengthMm,
          widthMm: item.widthMm,
          heightMm: item.heightMm,
          grossWeightGrams: item.grossWeightGrams,
        })),
      }
      const fulfillmentResultSnapshot = {
        rateScope: rated.rateScope,
        packageCount: rated.packageCount,
        packagePlanHash: current.packagePlanHash,
        selectedProvider: selected.carrierProvider,
        selectedServiceCode: selected.serviceCode,
        selectedServiceName: selected.serviceName,
        selectedCarrierCostMinor: selected.carrierCostMinor,
        currency: selected.currency,
        providerAttempts: rated.providerAttempts,
        policy: selected.policy,
      }
      const fulfillmentStageSnapshot = {
        stage: 'pre_label_fulfillment_rerate',
        authorityMode: 'shadow',
        checkoutReceiptGlobalId: current.receiptGlobalId,
        checkoutReconciliationGlobalId: current.reconciliationGlobalId,
        providerWriteCount: 0,
        postagePurchaseCount: 0,
        labelWriteCount: 0,
        commerceWriteCount: 0,
      }
      const fulfillmentRunResult = await client.query<{
        id: string
        global_id: string
      }>(
        `INSERT INTO operations_pack_rate_runs (
           organization_id,
           replay_group_key,
           scenario_id,
           source_kind,
           source_reference,
           provider,
           checkout_source,
           purpose,
           prior_checkout_run_id,
           pipeline_id,
           customer_id,
           customer_resolution_outcome,
           status,
           blocker_code,
           policy_version,
           algorithm_version,
           input_hash,
           result_hash,
           input_snapshot,
           result_snapshot,
           stage_snapshot,
           line_count,
           package_count,
           rate_choice_count,
           currency,
           selected_provider,
           selected_service_code,
           selected_service_name,
           selected_carrier_cost_minor,
           customer_charge_minor,
           mud_markup_minor,
           margin_minor,
           idempotency_key,
           actor_email,
           provider_write_count,
           postage_purchase_count,
           label_write_count,
           expires_at,
           pricing_semantics_version
         ) VALUES (
           $1::uuid, $2, $3, 'provider_checkout', $4, 'shopify',
           'live_callback_recorded', 'fulfillment_execution',
           $5::uuid, $6::uuid, $7::uuid, 'reused', 'succeeded',
           NULL, $8, $9, $10, $11, $12::jsonb, $13::jsonb,
           $14::jsonb, $15, $16, $17, $18, $19, $20, $21,
           $22::bigint, $23::bigint, NULL,
           $23::bigint - $22::bigint, $24, $25, 0, 0, 0, NULL, 2
         )
         RETURNING id::text, global_id`,
        [
          organizationId,
          replayGroupKey,
          scenarioId,
          current.receiptGlobalId,
          checkoutRun.id,
          current.pipelineId,
          current.customerId,
          CANONICAL_FULFILLMENT_RATE_POLICY_VERSION,
          'shadow-fulfillment-preparation-v1',
          commandRequestHash(fulfillmentInputSnapshot),
          commandRequestHash(fulfillmentResultSnapshot),
          JSON.stringify(fulfillmentInputSnapshot),
          JSON.stringify(fulfillmentResultSnapshot),
          JSON.stringify(fulfillmentStageSnapshot),
          current.lines.length,
          current.packages.length,
          rated.offers.length,
          current.currency,
          selected.carrierProvider,
          selected.serviceCode,
          selected.serviceName,
          selected.carrierCostMinor,
          current.checkoutShippingChargeMinor,
          fulfillmentIdempotencyKey,
          actorEmail,
        ],
      )
      const fulfillmentRun = fulfillmentRunResult.rows[0]

      for (const line of current.lines) {
        const lineSnapshot = {
          lineKey: line.globalId,
          productKey: line.productGlobalId,
          providerVariantId: line.providerVariantId,
          title: line.title,
          requiredQuantity: line.quantity,
          unitWeightGrams: line.unitWeightGrams,
        }
        await client.query(
          `INSERT INTO operations_pack_rate_run_lines (
             organization_id, run_id, line_key, product_key, title,
             required_quantity, unit_weight_grams, line_hash, line_snapshot
           ) VALUES (
             $1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9::jsonb
           )`,
          [
            organizationId,
            fulfillmentRun.id,
            line.globalId,
            line.productGlobalId,
            line.title,
            line.quantity,
            line.unitWeightGrams,
            commandRequestHash(lineSnapshot),
            JSON.stringify(lineSnapshot),
          ],
        )
      }
      for (const packageItem of current.packages) {
        const packageSnapshot = {
          packageKey: packageItem.packageKey,
          packageSequence: packageItem.packageSequence,
          materialCode: packageItem.materialCode,
          materialName: packageItem.materialName,
          lengthMm: packageItem.lengthMm,
          widthMm: packageItem.widthMm,
          heightMm: packageItem.heightMm,
          contentWeightGrams: packageItem.contentWeightGrams,
          tareWeightGrams: packageItem.tareWeightGrams,
          grossWeightGrams: packageItem.grossWeightGrams,
        }
        await client.query(
          `INSERT INTO operations_pack_rate_run_packages (
             organization_id, run_id, package_key, package_sequence,
             material_code, material_name, length_mm, width_mm, height_mm,
             content_weight_grams, tare_weight_grams, gross_weight_grams,
             allocation_count, package_hash, package_snapshot
           ) VALUES (
             $1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9,
             $10, $11, $12, $13, $14, $15::jsonb
           )`,
          [
            organizationId,
            fulfillmentRun.id,
            packageItem.packageKey,
            packageItem.packageSequence,
            packageItem.materialCode,
            packageItem.materialName,
            packageItem.lengthMm,
            packageItem.widthMm,
            packageItem.heightMm,
            packageItem.contentWeightGrams,
            packageItem.tareWeightGrams,
            packageItem.grossWeightGrams,
            packageItem.allocations.length,
            commandRequestHash(packageSnapshot),
            JSON.stringify(packageSnapshot),
          ],
        )
        for (const allocation of packageItem.allocations) {
          const allocationSnapshot = {
            packageKey: packageItem.packageKey,
            lineKey: allocation.lineGlobalId,
            productKey: allocation.productGlobalId,
            providerVariantId: allocation.providerVariantId,
            quantity: allocation.quantity,
          }
          await client.query(
            `INSERT INTO operations_pack_rate_run_allocations (
               organization_id, run_id, package_key, line_key,
               product_key, comparison_product_key, title, quantity,
               allocation_hash
             ) VALUES (
               $1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9
             )`,
            [
              organizationId,
              fulfillmentRun.id,
              packageItem.packageKey,
              allocation.lineGlobalId,
              allocation.productGlobalId,
              allocation.providerVariantId,
              allocation.title,
              allocation.quantity,
              commandRequestHash(allocationSnapshot),
            ],
          )
        }
      }
      for (const offer of rated.offers) {
        const evidence = evidenceByGlobalId.get(offer.evidenceGlobalId)
        const responseRates = Array.isArray(evidence?.redacted_response.rates)
          ? evidence.redacted_response.rates.filter((candidate) => {
              if (
                !candidate
                || typeof candidate !== 'object'
                || Array.isArray(candidate)
              ) return false
              const rate = candidate as Record<string, unknown>
              try {
                return (
                  String(rate.serviceCode || '').trim().toLowerCase()
                    === offer.serviceLevelCode.toLowerCase()
                  && String(rate.serviceName || '').trim()
                    === offer.serviceName
                  && String(rate.currency || '').trim().toUpperCase()
                    === offer.currency
                  && carrierDecimalAmountMinor(rate.amount)
                    === offer.amountMinor
                )
              } catch {
                return false
              }
            })
          : []
        if (responseRates.length !== 1) {
          throw new OperationsRequestError(
            'OPERATIONS_CARRIER_RATE_EVIDENCE_MISMATCH',
            'Every fulfillment offer must match exactly one durable normalized carrier rate',
            409,
          )
        }
        const normalizedResponse = {
          ...responseRates[0] as Record<string, unknown>,
          packagePlanHash: current.packagePlanHash,
          packageCount: current.packages.length,
        }
        await client.query(
          `INSERT INTO operations_pack_rate_run_rate_choices (
             organization_id, run_id, provider, service_code,
             service_name, carrier_cost_minor, currency, selected,
             recorded_fact_version, normalized_response
           ) VALUES (
             $1::uuid, $2::uuid, $3, $4, $5, $6::bigint, $7, $8,
             'sandbox-carrier-rate-evidence-v1', $9::jsonb
           )`,
          [
            organizationId,
            fulfillmentRun.id,
            offer.provider,
            offer.serviceLevelCode,
            offer.serviceName,
            offer.amountMinor,
            offer.currency,
            offer.provider === selected.carrierProvider
              && offer.serviceLevelCode === selected.serviceCode,
            JSON.stringify(normalizedResponse),
          ],
        )
      }

      const changeResult = await client.query<{
        comparison_identity_missing: boolean
        allocation_changed: boolean
        material_changed: boolean
      }>(
        `SELECT
           EXISTS (
             SELECT 1
             FROM operations_pack_rate_run_allocations allocation
             WHERE allocation.organization_id = $1::uuid
               AND allocation.run_id IN ($2::uuid, $3::uuid)
               AND allocation.comparison_product_key IS NULL
           ) AS comparison_identity_missing,
           EXISTS (
             (
               SELECT package_key, comparison_product_key,
                      sum(quantity)::bigint AS quantity
               FROM operations_pack_rate_run_allocations
               WHERE organization_id = $1::uuid AND run_id = $2::uuid
               GROUP BY package_key, comparison_product_key
               EXCEPT
               SELECT package_key, comparison_product_key,
                      sum(quantity)::bigint AS quantity
               FROM operations_pack_rate_run_allocations
               WHERE organization_id = $1::uuid AND run_id = $3::uuid
               GROUP BY package_key, comparison_product_key
             )
             UNION ALL
             (
               SELECT package_key, comparison_product_key,
                      sum(quantity)::bigint AS quantity
               FROM operations_pack_rate_run_allocations
               WHERE organization_id = $1::uuid AND run_id = $3::uuid
               GROUP BY package_key, comparison_product_key
               EXCEPT
               SELECT package_key, comparison_product_key,
                      sum(quantity)::bigint AS quantity
               FROM operations_pack_rate_run_allocations
               WHERE organization_id = $1::uuid AND run_id = $2::uuid
               GROUP BY package_key, comparison_product_key
             )
           ) AS allocation_changed,
           EXISTS (
             (
               SELECT package_key, material_code, length_mm, width_mm,
                      height_mm, gross_weight_grams
               FROM operations_pack_rate_run_packages
               WHERE organization_id = $1::uuid AND run_id = $2::uuid
               EXCEPT
               SELECT package_key, material_code, length_mm, width_mm,
                      height_mm, gross_weight_grams
               FROM operations_pack_rate_run_packages
               WHERE organization_id = $1::uuid AND run_id = $3::uuid
             )
             UNION ALL
             (
               SELECT package_key, material_code, length_mm, width_mm,
                      height_mm, gross_weight_grams
               FROM operations_pack_rate_run_packages
               WHERE organization_id = $1::uuid AND run_id = $3::uuid
               EXCEPT
               SELECT package_key, material_code, length_mm, width_mm,
                      height_mm, gross_weight_grams
               FROM operations_pack_rate_run_packages
               WHERE organization_id = $1::uuid AND run_id = $2::uuid
             )
           ) AS material_changed`,
        [organizationId, checkoutRun.id, fulfillmentRun.id],
      )
      if (changeResult.rows[0]?.comparison_identity_missing !== false) {
        throw new OperationsRequestError(
          'OPERATIONS_FULFILLMENT_COMPARISON_IDENTITY_REQUIRED',
          'Checkout and fulfillment allocations require the same provider variant identity before variance can be recorded',
          409,
        )
      }
      const allocationChanged =
        changeResult.rows[0]?.allocation_changed === true
      const materialChanged = changeResult.rows[0]?.material_changed === true
      const serviceChanged = (
        current.checkoutProvider !== selected.carrierProvider
        || current.checkoutServiceCode !== selected.serviceCode
      )
      const causes = [
        ...(allocationChanged ? ['allocation_changed'] : []),
        ...(materialChanged ? ['material_changed'] : []),
        ...(serviceChanged ? ['service_changed'] : []),
        ...(current.checkoutCarrierCostMinor !== selected.carrierCostMinor
          ? ['recorded_rate_changed']
          : []),
      ]
      const comparisonSnapshot = {
        checkoutRunGlobalId: checkoutRun.global_id,
        fulfillmentRunGlobalId: fulfillmentRun.global_id,
        packageCountDelta:
          current.packages.length - current.checkoutPackageCount,
        checkoutCarrierCostMinor: current.checkoutCarrierCostMinor,
        checkoutCustomerChargeMinor: current.checkoutShippingChargeMinor,
        fulfillmentCarrierCostMinor: selected.carrierCostMinor,
        allocationChanged,
        materialChanged,
        serviceChanged,
        causes,
      }
      const varianceResult = await client.query<{
        id: string
        global_id: string
      }>(
        `INSERT INTO operations_pack_rate_variances (
           organization_id, checkout_run_id, fulfillment_run_id,
           package_count_delta, checkout_carrier_cost_minor,
           checkout_customer_charge_minor,
           fulfillment_carrier_cost_minor, carrier_cost_variance_minor,
           realized_margin_minor, currency, allocation_changed,
           material_changed, service_changed, causes, comparison_hash
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, $4, $5::bigint, $6::bigint,
           $7::bigint, $7::bigint - $5::bigint,
           $6::bigint - $7::bigint, $8, $9, $10, $11, $12::jsonb, $13
         )
         RETURNING id::text, global_id`,
        [
          organizationId,
          checkoutRun.id,
          fulfillmentRun.id,
          current.packages.length - current.checkoutPackageCount,
          current.checkoutCarrierCostMinor,
          current.checkoutShippingChargeMinor,
          selected.carrierCostMinor,
          current.currency,
          allocationChanged,
          materialChanged,
          serviceChanged,
          JSON.stringify(causes),
          commandRequestHash(comparisonSnapshot),
        ],
      )
      const variance = varianceResult.rows[0]

      const executionResult = await client.query<{
        id: string
        global_id: string
      }>(
        `INSERT INTO operations_fulfillment_executions (
           organization_id, order_id, plan_id, checkout_pack_rate_run_id,
           fulfillment_pack_rate_run_id,
           shopify_checkout_reconciliation_id,
           shopify_checkout_receipt_id, authority_mode, state,
           idempotency_key, request_hash, provider_write_count,
           postage_purchase_count, label_write_count,
           commerce_write_count, prepared_by
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
           $6::uuid, $7::uuid, 'shadow', 'shadow_prepared',
           $8, $9, 0, 0, 0, 0, $10
         )
         RETURNING id::text, global_id`,
        [
          organizationId,
          current.orderId,
          current.planId,
          checkoutRun.id,
          fulfillmentRun.id,
          current.reconciliationId,
          current.receiptId,
          idempotencyKey,
          requestHash,
          actorEmail,
        ],
      )
      const execution = executionResult.rows[0]
      const shipmentGroupResult = await client.query<{
        id: string
        global_id: string
      }>(
        `INSERT INTO operations_shipment_groups (
           organization_id, fulfillment_execution_id, order_id, plan_id,
           warehouse_id, fulfillment_pack_rate_run_id, selected_provider,
           selected_service_code, selected_service_name,
           selected_carrier_cost_minor, currency, state
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid,
           $7, $8, $9, $10::bigint, $11, 'shadow_prepared'
         )
         RETURNING id::text, global_id`,
        [
          organizationId,
          execution.id,
          current.orderId,
          current.planId,
          current.warehouseId,
          fulfillmentRun.id,
          selected.carrierProvider,
          selected.serviceCode,
          selected.serviceName,
          selected.carrierCostMinor,
          current.currency,
        ],
      )
      const shipmentGroup = shipmentGroupResult.rows[0]

      for (const line of current.lines) {
        await client.query(
          `INSERT INTO operations_fulfillment_execution_lines (
             organization_id, execution_id, fulfillment_pack_rate_run_id,
             order_line_id, line_key, product_key, required_quantity
           ) VALUES (
             $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7
           )`,
          [
            organizationId,
            execution.id,
            fulfillmentRun.id,
            line.id,
            line.globalId,
            line.productGlobalId,
            line.quantity,
          ],
        )
      }
      for (const packageItem of current.packages) {
        await client.query(
          `INSERT INTO operations_fulfillment_execution_packages (
             organization_id, execution_id, shipment_group_id,
             fulfillment_pack_rate_run_id, package_id, package_key
           ) VALUES (
             $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6
           )`,
          [
            organizationId,
            execution.id,
            shipmentGroup.id,
            fulfillmentRun.id,
            packageItem.id,
            packageItem.packageKey,
          ],
        )
      }
      for (const attempt of rated.providerAttempts) {
        const evidence = evidenceByGlobalId.get(attempt.rateEvidenceGlobalId)
        if (!evidence) {
          throw new OperationsRequestError(
            'OPERATIONS_CARRIER_RATE_EVIDENCE_REQUIRED',
            'Carrier rate evidence disappeared before commit',
            409,
          )
        }
        await client.query(
          `INSERT INTO operations_fulfillment_execution_rate_attempts (
             organization_id, execution_id, carrier_provider,
             fulfillment_pack_rate_run_id, carrier_account_id,
             carrier_rate_request_id, carrier_rate_purpose,
             carrier_request_hash, environment, attempt_status,
             failure_code, selected
           ) VALUES (
             $1::uuid, $2::uuid, $3, $4::uuid, $5::uuid, $6::uuid,
             'cartonization_shipment_rate', $7, 'sandbox', $8, $9, $10
           )`,
          [
            organizationId,
            execution.id,
            attempt.provider,
            fulfillmentRun.id,
            evidence.carrier_account_id,
            evidence.id,
            evidence.request_hash,
            attempt.status,
            attempt.failureCode,
            attempt.provider === selected.carrierProvider,
          ],
        )
      }

      const result: OperationsShadowFulfillmentExecutionResult = {
        orderGlobalId,
        orderStatus: 'packed',
        rowVersion: current.orderRowVersion,
        fulfillmentExecutionGlobalId: execution.global_id,
        shipmentGroupGlobalId: shipmentGroup.global_id,
        checkoutRateReceiptGlobalId: current.receiptGlobalId,
        checkoutPackRateRunGlobalId: checkoutRun.global_id,
        fulfillmentPackRateRunGlobalId: fulfillmentRun.global_id,
        varianceGlobalId: variance.global_id,
        packageCount: current.packages.length,
        carrier: selected.carrierName,
        provider: selected.carrierProvider,
        serviceCode: selected.serviceCode,
        serviceName: selected.serviceName,
        carrierCostMinor: selected.carrierCostMinor,
        checkoutShippingChargeMinor:
          current.checkoutShippingChargeMinor,
        carrierCostVarianceMinor:
          selected.carrierCostMinor - current.checkoutCarrierCostMinor,
        estimatedCheckoutVarianceMinor:
          current.checkoutShippingChargeMinor - selected.carrierCostMinor,
        currency: current.currency,
        providerAttempts: rated.providerAttempts,
        providerWriteCount: 0,
        postagePurchaseCount: 0,
        labelWriteCount: 0,
        commerceWriteCount: 0,
        replayed: false,
      }
      await appendDomainEvent(client, {
        organizationId,
        aggregateType: 'operations.fulfillment_execution',
        aggregateId: execution.id,
        aggregateGlobalId: execution.global_id,
        eventType: 'operations.fulfillment_execution.shadow_prepared',
        actorEmail,
        correlationId: command.receipt.correlation_id,
        idempotencyKey:
          `operations:shadow-fulfillment:${execution.global_id}`,
        payload: {
          orderGlobalId,
          planGlobalId: current.planGlobalId,
          shipmentGroupGlobalId: shipmentGroup.global_id,
          checkoutPackRateRunGlobalId: checkoutRun.global_id,
          fulfillmentPackRateRunGlobalId: fulfillmentRun.global_id,
          varianceGlobalId: variance.global_id,
          packageCount: current.packages.length,
          selectedProvider: selected.carrierProvider,
          selectedServiceCode: selected.serviceCode,
          providerWriteCount: 0,
          postagePurchaseCount: 0,
          labelWriteCount: 0,
          commerceWriteCount: 0,
          reason,
        },
      })
      await recordAuditEvent({
        actor: actorEmail,
        eventType: 'operations.fulfillment_execution.shadow_prepared',
        aggregateType: 'operations.fulfillment_execution',
        aggregateId: execution.global_id,
        subject: orderGlobalId,
        organizationId,
        eventKey:
          `operations:shadow-fulfillment:${execution.global_id}`,
        payload: {
          orderGlobalId,
          packageCount: current.packages.length,
          selectedProvider: selected.carrierProvider,
          selectedServiceCode: selected.serviceCode,
          checkoutShippingChargeMinor:
            current.checkoutShippingChargeMinor,
          carrierCostMinor: selected.carrierCostMinor,
          estimatedCheckoutVarianceMinor:
            current.checkoutShippingChargeMinor - selected.carrierCostMinor,
          writeCounters: {
            provider: 0,
            postage: 0,
            label: 0,
            commerce: 0,
          },
          reason,
        },
      }, client)
      await completeCommandReceipt(
        client,
        command.receipt.id,
        execution.global_id,
        result as unknown as Record<string, unknown>,
      )
      return result
    })
  } catch (error) {
    await failCommandReceipt(command.receipt.id, error)
    throw error
  }
}

type PutawayPendingUsage = {
  volumeCubicMeters: number
  weightKg: number
  quantityByProductId: Map<string, number>
}

function positiveReceiptQuantity(value: unknown, label: string): number {
  const quantity = Number(value)
  if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 1_000_000_000) {
    throw new OperationsRequestError('OPERATIONS_RECEIPT_INVALID', `${label} must be greater than zero`)
  }
  return quantity
}

function nonNegativeReceiptQuantity(value: unknown, label: string): number {
  const quantity = Number(value)
  if (!Number.isFinite(quantity) || quantity < 0 || quantity > 1_000_000_000) {
    throw new OperationsRequestError('OPERATIONS_RECEIPT_INVALID', `${label} must be zero or greater`)
  }
  return quantity
}

function receiptText(value: unknown, label: string, maximum: number, required = true): string {
  const result = String(value ?? '').trim()
  if ((required && !result) || result.length > maximum || /[\u0000-\u001f\u007f]/.test(result)) {
    throw new OperationsRequestError('OPERATIONS_RECEIPT_INVALID', `${label} is invalid`)
  }
  return result
}

function completedReceiptCreationResult(
  receipt: Pick<CommandReceiptRow, 'result_payload'>,
): OperationsInboundReceiptCreationResult {
  const payload = receipt.result_payload
  if (!payload
    || typeof payload.receiptGlobalId !== 'string'
    || payload.status !== 'expected'
    || typeof payload.rowVersion !== 'number'
    || typeof payload.expectedQuantity !== 'number'
    || !Array.isArray(payload.placements)) {
    throw new OperationsRequestError(
      'OPERATIONS_COMMAND_RECEIPT_INVALID',
      'Completed command receipt has no inbound receipt result',
      409,
    )
  }
  return {
    receiptGlobalId: payload.receiptGlobalId,
    status: 'expected',
    rowVersion: payload.rowVersion,
    expectedQuantity: payload.expectedQuantity,
    placements: payload.placements as OperationsPutawayPlacement[],
    replayed: true,
  }
}

function completedInboundReceiptResult(
  receipt: Pick<CommandReceiptRow, 'result_payload'>,
): OperationsInboundReceiptCommandResult {
  const payload = receipt.result_payload
  if (!payload
    || typeof payload.receiptGlobalId !== 'string'
    || payload.status !== 'completed'
    || typeof payload.rowVersion !== 'number'
    || typeof payload.receivedQuantity !== 'number'
    || typeof payload.damagedQuantity !== 'number'
    || !Array.isArray(payload.positionGlobalIds)
    || !payload.positionGlobalIds.every((value) => typeof value === 'string')) {
    throw new OperationsRequestError(
      'OPERATIONS_COMMAND_RECEIPT_INVALID',
      'Completed command receipt has no receiving result',
      409,
    )
  }
  return {
    receiptGlobalId: payload.receiptGlobalId,
    status: 'completed',
    rowVersion: payload.rowVersion,
    receivedQuantity: payload.receivedQuantity,
    damagedQuantity: payload.damagedQuantity,
    positionGlobalIds: payload.positionGlobalIds,
    replayed: true,
  }
}

function completedReplenishmentExecutionResult(
  receipt: Pick<CommandReceiptRow, 'result_payload'>,
): OperationsReplenishmentExecutionResult {
  const payload = receipt.result_payload
  if (!payload
    || typeof payload.replenishmentTaskGlobalId !== 'string'
    || payload.status !== 'completed'
    || typeof payload.warehouseGlobalId !== 'string'
    || typeof payload.productGlobalId !== 'string'
    || typeof payload.inventoryPoolGlobalId !== 'string'
    || typeof payload.sourceLocationGlobalId !== 'string'
    || typeof payload.sourceLocationCode !== 'string'
    || typeof payload.destinationLocationGlobalId !== 'string'
    || typeof payload.destinationLocationCode !== 'string'
    || typeof payload.movedQuantity !== 'number'
    || typeof payload.sourceAvailableAfter !== 'number'
    || typeof payload.destinationAvailableAfter !== 'number') {
    throw new OperationsRequestError(
      'OPERATIONS_COMMAND_RECEIPT_INVALID',
      'Completed command receipt has no replenishment result',
      409,
    )
  }
  return {
    replenishmentTaskGlobalId: payload.replenishmentTaskGlobalId,
    status: 'completed',
    warehouseGlobalId: payload.warehouseGlobalId,
    productGlobalId: payload.productGlobalId,
    inventoryPoolGlobalId: payload.inventoryPoolGlobalId,
    sourceLocationGlobalId: payload.sourceLocationGlobalId,
    sourceLocationCode: payload.sourceLocationCode,
    destinationLocationGlobalId: payload.destinationLocationGlobalId,
    destinationLocationCode: payload.destinationLocationCode,
    movedQuantity: payload.movedQuantity,
    sourceAvailableAfter: payload.sourceAvailableAfter,
    destinationAvailableAfter: payload.destinationAvailableAfter,
    replayed: true,
  }
}

async function readPutawayCandidates(
  client: PoolClient,
  input: {
    organizationId: string
    pipelineId: string
    warehouseId: string
    productId: string
    requestedLocationGlobalId?: string | null
  },
): Promise<PutawayCandidateRow[]> {
  const result = await client.query<PutawayCandidateRow>(
    `SELECT location.id::text, location.global_id, location.code,
            location.location_type, location.pick_sequence,
            location.max_volume_cubic_meters::text,
            location.max_weight_kg::text, location.allow_mixed_products,
            rule.rule_type, rule.max_quantity::text AS rule_max_quantity,
            COALESCE(usage.used_volume_cubic_meters, 0)::text AS used_volume_cubic_meters,
            COALESCE(usage.used_weight_kg, 0)::text AS used_weight_kg,
            COALESCE(usage.product_quantity, 0)::text AS product_quantity,
            COALESCE(usage.other_product_count, 0)::text AS other_product_count,
            COALESCE(usage.unknown_profile_count, 0)::text AS unknown_profile_count
     FROM operations_locations location
     LEFT JOIN operations_location_product_rules rule
       ON rule.organization_id = location.organization_id
      AND rule.location_id = location.id
      AND rule.pipeline_id = $2::uuid
      AND rule.product_id = $4::uuid
      AND rule.active = true
     LEFT JOIN LATERAL (
       SELECT
         COALESCE(sum(
           CASE WHEN profile.units_per_package IS NULL THEN 0 ELSE
             position.on_hand_quantity
             / NULLIF(profile.units_per_package, 0)
             * profile.length_mm * profile.width_mm * profile.height_mm
             / 1000000000.0
           END
         ), 0) AS used_volume_cubic_meters,
         COALESCE(sum(
           CASE WHEN profile.units_per_package IS NULL THEN 0 ELSE
             position.on_hand_quantity
             / NULLIF(profile.units_per_package, 0)
             * profile.weight_grams
             / 1000.0
           END
         ), 0) AS used_weight_kg,
         COALESCE(sum(position.on_hand_quantity)
           FILTER (WHERE position.product_id = $4::uuid), 0) AS product_quantity,
         count(DISTINCT position.product_id)
           FILTER (WHERE position.product_id <> $4::uuid AND position.on_hand_quantity > 0)
           AS other_product_count,
         count(*)
           FILTER (WHERE position.on_hand_quantity > 0 AND profile.units_per_package IS NULL)
           AS unknown_profile_count
       FROM operations_inventory_positions position
       LEFT JOIN LATERAL (
         SELECT package.units_per_package, package.length_mm, package.width_mm,
                package.height_mm, package.weight_grams
         FROM operations_product_package_profiles package
         WHERE package.organization_id = position.organization_id
           AND package.pipeline_id = position.pipeline_id
           AND package.product_id = position.product_id
           AND package.active = true
         ORDER BY package.is_default DESC, lower(package.profile_name), package.id
         LIMIT 1
       ) profile ON true
       WHERE position.organization_id = location.organization_id
         AND position.location_id = location.id
     ) usage ON true
     WHERE location.organization_id = $1::uuid
       AND location.warehouse_id = $3::uuid
       AND location.active = true
       AND location.location_type IN ('storage', 'pick')
       AND ($5::text IS NULL OR location.global_id = $5)
       AND NOT EXISTS (
         SELECT 1
         FROM operations_locations child
         WHERE child.organization_id = location.organization_id
           AND child.parent_location_id = location.id
           AND child.active = true
       )
     ORDER BY location.pick_sequence, lower(location.code), location.id`,
    [
      input.organizationId,
      input.pipelineId,
      input.warehouseId,
      input.productId,
      input.requestedLocationGlobalId || null,
    ],
  )
  return result.rows
}

async function selectPutawayPlacement(
  client: PoolClient,
  input: {
    organizationId: string
    pipelineId: string
    warehouseId: string
    product: ProductRow
    quantity: number
    requestedLocationGlobalId?: string | null
    pendingByLocationId?: Map<string, PutawayPendingUsage>
  },
): Promise<{
  locationId: string
  placement: Omit<OperationsPutawayPlacement, 'lineGlobalId'>
  volumeCubicMeters: number
  weightKg: number
}> {
  const candidates = await readPutawayCandidates(client, {
    organizationId: input.organizationId,
    pipelineId: input.pipelineId,
    warehouseId: input.warehouseId,
    productId: input.product.id,
    requestedLocationGlobalId: input.requestedLocationGlobalId,
  })
  if (input.requestedLocationGlobalId && !candidates.length) {
    throw new OperationsRequestError(
      'OPERATIONS_PUTAWAY_LOCATION_INVALID',
      'The selected putaway location is not an active leaf storage or pick location in this warehouse',
      409,
    )
  }

  const packaging = await readDefaultProductPackagingWithClient(client, {
    organizationId: input.organizationId,
    pipelineId: input.pipelineId,
    productIds: [input.product.id],
  })
  const profile = packaging.get(input.product.id)
  const packageCount = profile ? input.quantity / profile.unitsPerPackage : 0
  const incomingVolume = profile
    ? packageCount * profile.lengthMm * profile.widthMm * profile.heightMm / 1_000_000_000
    : 0
  const incomingWeight = profile ? packageCount * profile.weightGrams / 1_000 : 0
  const rejected = new Set<string>()
  const eligible = candidates.filter((candidate) => {
    const pending = input.pendingByLocationId?.get(candidate.id)
    const pendingOtherProducts = pending
      ? [...pending.quantityByProductId.entries()]
          .some(([productId, quantity]) => productId !== input.product.id && quantity > 0)
      : false
    const pendingProductQuantity = pending?.quantityByProductId.get(input.product.id) || 0
    if (candidate.rule_type === 'restricted') {
      rejected.add('product restriction')
      return false
    }
    if (!candidate.allow_mixed_products
      && (numberValue(candidate.other_product_count) > 0 || pendingOtherProducts)) {
      rejected.add('mixed-product restriction')
      return false
    }
    if (candidate.rule_max_quantity !== null
      && numberValue(candidate.product_quantity) + pendingProductQuantity + input.quantity
        > numberValue(candidate.rule_max_quantity) + 0.000001) {
      rejected.add('product quantity limit')
      return false
    }
    const hasCapacity = candidate.max_volume_cubic_meters !== null
      || candidate.max_weight_kg !== null
    if (hasCapacity && !profile) {
      rejected.add('missing package dimensions or weight')
      return false
    }
    if (hasCapacity && numberValue(candidate.unknown_profile_count) > 0) {
      rejected.add('existing inventory without package measurements')
      return false
    }
    const projectedVolume = numberValue(candidate.used_volume_cubic_meters)
      + (pending?.volumeCubicMeters || 0)
      + incomingVolume
    const projectedWeight = numberValue(candidate.used_weight_kg)
      + (pending?.weightKg || 0)
      + incomingWeight
    if (candidate.max_volume_cubic_meters !== null
      && projectedVolume > numberValue(candidate.max_volume_cubic_meters) + 0.000001) {
      rejected.add('cubic capacity')
      return false
    }
    if (candidate.max_weight_kg !== null
      && projectedWeight > numberValue(candidate.max_weight_kg) + 0.000001) {
      rejected.add('weight capacity')
      return false
    }
    return true
  })
  eligible.sort((left, right) => {
    const leftPending = input.pendingByLocationId?.get(left.id)
    const rightPending = input.pendingByLocationId?.get(right.id)
    const leftRank = left.rule_type === 'preferred'
      ? 0
      : numberValue(left.product_quantity) + (leftPending?.quantityByProductId.get(input.product.id) || 0) > 0
        ? 1
        : left.location_type === 'storage' ? 2 : 3
    const rightRank = right.rule_type === 'preferred'
      ? 0
      : numberValue(right.product_quantity) + (rightPending?.quantityByProductId.get(input.product.id) || 0) > 0
        ? 1
        : right.location_type === 'storage' ? 2 : 3
    return leftRank - rightRank
      || left.pick_sequence - right.pick_sequence
      || left.code.localeCompare(right.code)
  })
  const selected = eligible[0]
  if (!selected) {
    const suffix = rejected.size ? ` Blocked by: ${[...rejected].join(', ')}.` : ''
    throw new OperationsRequestError(
      'OPERATIONS_PUTAWAY_UNAVAILABLE',
      `No eligible putaway location has sufficient configured capacity for ${input.product.name}.${suffix}`,
      409,
    )
  }
  const pending = input.pendingByLocationId?.get(selected.id)
  const sameProduct = numberValue(selected.product_quantity)
    + (pending?.quantityByProductId.get(input.product.id) || 0) > 0
  const strategy: OperationsPutawayPlacement['strategy'] = input.requestedLocationGlobalId
    ? 'manual'
    : selected.rule_type === 'preferred'
      ? 'preferred_rule'
      : sameProduct
        ? 'same_product'
        : 'route_order'
  const explanation = strategy === 'manual'
    ? `Selected manually; product rules and capacity were revalidated for ${selected.code}.`
    : strategy === 'preferred_rule'
      ? `${selected.code} has the preferred-product rule and sufficient capacity.`
      : strategy === 'same_product'
        ? `${selected.code} already stores this product and has sufficient capacity.`
        : `${selected.code} is the first eligible location by pick route order (${selected.pick_sequence}).`
  return {
    locationId: selected.id,
    placement: {
      productGlobalId: input.product.reference_code,
      targetLocationGlobalId: selected.global_id,
      targetLocationCode: selected.code,
      strategy,
      explanation,
      projectedVolumeCubicMeters: profile
        ? numberValue(selected.used_volume_cubic_meters) + (pending?.volumeCubicMeters || 0) + incomingVolume
        : null,
      projectedWeightKg: profile
        ? numberValue(selected.used_weight_kg) + (pending?.weightKg || 0) + incomingWeight
        : null,
    },
    volumeCubicMeters: incomingVolume,
    weightKg: incomingWeight,
  }
}

export async function createOperationsInboundReceiptInPostgres(input: {
  organizationId: string
  actorEmail: string
  receipt: OperationsInboundReceiptInput
  idempotencyKey: string
}): Promise<OperationsInboundReceiptCreationResult> {
  const organizationId = requireOrganizationId(input.organizationId)
  const referenceNumber = receiptText(input.receipt.referenceNumber, 'Receipt reference', 120)
  if (!Array.isArray(input.receipt.lines) || input.receipt.lines.length < 1 || input.receipt.lines.length > 100) {
    throw new OperationsRequestError('OPERATIONS_RECEIPT_INVALID', 'Receipt must include from 1 to 100 lines')
  }
  const expectedAt = input.receipt.expectedAt ? new Date(input.receipt.expectedAt) : null
  if (expectedAt && Number.isNaN(expectedAt.getTime())) {
    throw new OperationsRequestError('OPERATIONS_RECEIPT_INVALID', 'Expected receipt date is invalid')
  }
  const normalized: OperationsInboundReceiptInput = {
    warehouseGlobalId: receiptText(input.receipt.warehouseGlobalId, 'Warehouse', 16),
    inventoryPoolGlobalId: receiptText(input.receipt.inventoryPoolGlobalId, 'Inventory pool', 16),
    referenceNumber,
    expectedAt: expectedAt?.toISOString() || null,
    lines: input.receipt.lines.map((line, index) => ({
      productGlobalId: receiptText(line.productGlobalId, `Product on line ${index + 1}`, 16),
      targetLocationGlobalId: line.targetLocationGlobalId
        ? receiptText(line.targetLocationGlobalId, `Putaway location on line ${index + 1}`, 16)
        : null,
      expectedQuantity: positiveReceiptQuantity(line.expectedQuantity, `Expected quantity on line ${index + 1}`),
      lotCode: receiptText(line.lotCode, `Lot on line ${index + 1}`, 120, false),
      unitOfMeasure: receiptText(line.unitOfMeasure || 'each', `Unit of measure on line ${index + 1}`, 50),
    })),
  }
  const prepared = await prepareCommandReceipt({
    organizationId,
    commandType: 'create_inbound_receipt',
    idempotencyKey: input.idempotencyKey,
    requestHash: commandRequestHash(normalized),
    actorEmail: input.actorEmail,
  })
  if (prepared.completed) return completedReceiptCreationResult(prepared.receipt)

  try {
    return await withTransaction(async (client) => {
      const pipeline = await resolvePipeline(client, organizationId)
      await acquireTransactionAdvisoryLock(
        client,
        `operations:receipt-reference:${organizationId}:${referenceNumber}`,
      )
      const warehouseResult = await client.query<WarehouseRow>(
        `SELECT id::text, global_id, code, name, facility_type, timezone, address, status,
                cutoff_time::text, operating_days, opens_at::text, closes_at::text,
                standard_processing_minutes, daily_order_capacity, row_version::text
         FROM operations_warehouses
         WHERE organization_id = $1::uuid AND global_id = $2
         LIMIT 1
         FOR UPDATE`,
        [organizationId, normalized.warehouseGlobalId],
      )
      const warehouse = warehouseResult.rows[0]
      if (!warehouse || warehouse.status !== 'active') {
        throw new OperationsRequestError(
          'OPERATIONS_WAREHOUSE_INACTIVE',
          'Select an active warehouse for this receipt',
          409,
        )
      }
      await acquireTransactionAdvisoryLock(client, `operations:receiving:${organizationId}:${warehouse.id}`)
      const poolResult = await client.query<InventoryPoolRow>(
        `SELECT pool.id::text, pool.global_id, pool.name, pool.pool_type,
                pool.allocation_policy, pool.active,
                owner.reference_code AS owner_customer_global_id,
                owner.name AS owner_customer_name
         FROM operations_inventory_pools pool
         LEFT JOIN crm_organizations owner
           ON owner.pipeline_id = pool.pipeline_id AND owner.id = pool.owner_customer_id
         WHERE pool.organization_id = $1::uuid AND pool.global_id = $2
         LIMIT 1`,
        [organizationId, normalized.inventoryPoolGlobalId],
      )
      const pool = poolResult.rows[0]
      if (!pool || !pool.active) {
        throw new OperationsRequestError(
          'OPERATIONS_INVENTORY_POOL_INACTIVE',
          'Select an active inventory pool for this receipt',
          409,
        )
      }
      const existing = await client.query<{ global_id: string }>(
        `SELECT global_id
         FROM operations_receipts
         WHERE organization_id = $1::uuid AND reference_number = $2
         LIMIT 1`,
        [organizationId, referenceNumber],
      )
      if (existing.rows[0]) {
        throw new OperationsRequestError(
          'OPERATIONS_RECEIPT_REFERENCE_EXISTS',
          'This receipt reference already exists',
          409,
        )
      }
      const receiptResult = await client.query<ReceiptCommandRow>(
        `INSERT INTO operations_receipts (
           organization_id, pipeline_id, warehouse_id, inventory_pool_id,
           reference_number, expected_at, created_by, updated_by
         ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6::timestamptz, $7, $7)
         RETURNING id::text, global_id, pipeline_id::text, warehouse_id::text,
                   inventory_pool_id::text, status, row_version::text`,
        [
          organizationId,
          pipeline.id,
          warehouse.id,
          pool.id,
          referenceNumber,
          normalized.expectedAt,
          input.actorEmail,
        ],
      )
      const receipt = receiptResult.rows[0]
      const placements: OperationsPutawayPlacement[] = []
      const pendingByLocationId = new Map<string, PutawayPendingUsage>()
      for (const [index, line] of normalized.lines.entries()) {
        const product = await resolveProduct(client, pipeline.id, line.productGlobalId)
        const selected = await selectPutawayPlacement(client, {
          organizationId,
          pipelineId: pipeline.id,
          warehouseId: warehouse.id,
          product,
          quantity: line.expectedQuantity,
          requestedLocationGlobalId: line.targetLocationGlobalId,
          pendingByLocationId,
        })
        const inserted = await client.query<{ global_id: string }>(
          `INSERT INTO operations_receipt_lines (
             organization_id, receipt_id, pipeline_id, product_id, target_location_id,
             line_number, expected_quantity, lot_code, unit_of_measure
           ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, $7, $8, $9)
           RETURNING global_id`,
          [
            organizationId,
            receipt.id,
            pipeline.id,
            product.id,
            selected.locationId,
            index + 1,
            line.expectedQuantity,
            line.lotCode,
            line.unitOfMeasure,
          ],
        )
        placements.push({ lineGlobalId: inserted.rows[0].global_id, ...selected.placement })
        const pending = pendingByLocationId.get(selected.locationId) || {
          volumeCubicMeters: 0,
          weightKg: 0,
          quantityByProductId: new Map<string, number>(),
        }
        pending.volumeCubicMeters += selected.volumeCubicMeters
        pending.weightKg += selected.weightKg
        pending.quantityByProductId.set(
          product.id,
          (pending.quantityByProductId.get(product.id) || 0) + line.expectedQuantity,
        )
        pendingByLocationId.set(selected.locationId, pending)
      }
      const expectedQuantity = normalized.lines.reduce((sum, line) => sum + line.expectedQuantity, 0)
      const result: OperationsInboundReceiptCreationResult = {
        receiptGlobalId: receipt.global_id,
        status: 'expected',
        rowVersion: Number(receipt.row_version),
        expectedQuantity,
        placements,
        replayed: false,
      }
      await appendDomainEvent(client, {
        organizationId,
        aggregateType: 'operations.receipt',
        aggregateId: receipt.id,
        aggregateGlobalId: receipt.global_id,
        eventType: 'operations.receipt.created',
        actorEmail: input.actorEmail,
        correlationId: prepared.receipt.correlation_id,
        idempotencyKey: `${receipt.global_id}:created`,
        payload: {
          referenceNumber,
          warehouseGlobalId: warehouse.global_id,
          inventoryPoolGlobalId: pool.global_id,
          expectedQuantity,
          placements,
        },
      })
      await recordAuditEvent({
        actor: input.actorEmail,
        eventType: 'operations.receipt.created',
        aggregateType: 'operations.receipt',
        aggregateId: receipt.global_id,
        subject: referenceNumber,
        organizationId,
        eventKey: `operations:receipt:${receipt.global_id}:created`,
        payload: {
          warehouseGlobalId: warehouse.global_id,
          inventoryPoolGlobalId: pool.global_id,
          expectedQuantity,
          placements,
        },
      }, client)
      await completeCommandReceipt(
        client,
        prepared.receipt.id,
        receipt.global_id,
        result as unknown as Record<string, unknown>,
      )
      return result
    })
  } catch (error) {
    await failCommandReceipt(prepared.receipt.id, error)
    throw error
  }
}

export async function completeOperationsInboundReceiptInPostgres(input: {
  organizationId: string
  actorEmail: string
  completion: OperationsInboundReceiptCompletionInput
  idempotencyKey: string
}): Promise<OperationsInboundReceiptCommandResult> {
  const organizationId = requireOrganizationId(input.organizationId)
  const reason = receiptText(input.completion.reason, 'Receiving reason', 500)
  if (!Number.isSafeInteger(input.completion.expectedRowVersion) || input.completion.expectedRowVersion < 0) {
    throw new OperationsRequestError('OPERATIONS_RECEIPT_INVALID', 'Receipt version is invalid')
  }
  if (!Array.isArray(input.completion.lines) || input.completion.lines.length < 1 || input.completion.lines.length > 100) {
    throw new OperationsRequestError('OPERATIONS_RECEIPT_INVALID', 'Receiving confirmation must include every receipt line')
  }
  const seen = new Set<string>()
  const normalized: OperationsInboundReceiptCompletionInput = {
    receiptGlobalId: receiptText(input.completion.receiptGlobalId, 'Receipt', 16),
    expectedRowVersion: input.completion.expectedRowVersion,
    reason,
    lines: input.completion.lines.map((line, index) => {
      const lineGlobalId = receiptText(line.lineGlobalId, `Receipt line ${index + 1}`, 20)
      if (seen.has(lineGlobalId)) {
        throw new OperationsRequestError('OPERATIONS_RECEIPT_INVALID', 'Receipt line confirmations must be unique')
      }
      seen.add(lineGlobalId)
      return {
        lineGlobalId,
        acceptedQuantity: nonNegativeReceiptQuantity(
          line.acceptedQuantity,
          `Accepted quantity on line ${index + 1}`,
        ),
        damagedQuantity: nonNegativeReceiptQuantity(
          line.damagedQuantity,
          `Damaged quantity on line ${index + 1}`,
        ),
      }
    }),
  }
  const prepared = await prepareCommandReceipt({
    organizationId,
    commandType: 'complete_inbound_receipt',
    idempotencyKey: input.idempotencyKey,
    requestHash: commandRequestHash(normalized),
    actorEmail: input.actorEmail,
  })
  if (prepared.completed) return completedInboundReceiptResult(prepared.receipt)

  try {
    return await withTransaction(async (client) => {
      const receiptResult = await client.query<ReceiptCommandRow>(
        `SELECT id::text, global_id, pipeline_id::text, warehouse_id::text,
                inventory_pool_id::text, status, row_version::text
         FROM operations_receipts
         WHERE organization_id = $1::uuid AND global_id = $2
         LIMIT 1
         FOR UPDATE`,
        [organizationId, normalized.receiptGlobalId],
      )
      const receipt = receiptResult.rows[0]
      if (!receipt) {
        throw new OperationsRequestError('OPERATIONS_RECEIPT_NOT_FOUND', 'Inbound receipt was not found', 404)
      }
      await acquireTransactionAdvisoryLock(client, `operations:receiving:${organizationId}:${receipt.warehouse_id}`)
      if (!['expected', 'receiving'].includes(receipt.status)) {
        throw new OperationsRequestError(
          'OPERATIONS_RECEIPT_STATUS_INVALID',
          `Receipt cannot be completed from ${receipt.status}`,
          409,
        )
      }
      if (Number(receipt.row_version) !== normalized.expectedRowVersion) {
        throw new OperationsRequestError(
          'OPERATIONS_RECEIPT_VERSION_CONFLICT',
          'Receipt changed after it was opened; refresh before confirming receiving',
          409,
        )
      }
      const lineResult = await client.query<ReceiptCommandLineRow>(
        `SELECT line.id::text, line.global_id, line.product_id::text,
                product.reference_code AS product_global_id,
                line.target_location_id::text, line.expected_quantity::text,
                line.lot_code
         FROM operations_receipt_lines line
         JOIN crm_products product
           ON product.pipeline_id = line.pipeline_id AND product.id = line.product_id
         WHERE line.organization_id = $1::uuid AND line.receipt_id = $2::uuid
         ORDER BY line.line_number, line.id
         FOR UPDATE OF line`,
        [organizationId, receipt.id],
      )
      if (lineResult.rows.length !== normalized.lines.length) {
        throw new OperationsRequestError(
          'OPERATIONS_RECEIPT_LINES_INCOMPLETE',
          'Confirm accepted and damaged quantities for every receipt line',
          409,
        )
      }
      const completionByLine = new Map(normalized.lines.map((line) => [line.lineGlobalId, line]))
      if (lineResult.rows.some((line) => !completionByLine.has(line.global_id))) {
        throw new OperationsRequestError(
          'OPERATIONS_RECEIPT_LINES_INCOMPLETE',
          'Receiving confirmation does not match this receipt',
          409,
        )
      }
      const positionGlobalIds = new Set<string>()
      let receivedQuantity = 0
      let damagedQuantity = 0
      for (const line of lineResult.rows) {
        const completion = completionByLine.get(line.global_id)!
        const total = completion.acceptedQuantity + completion.damagedQuantity
        if (total > numberValue(line.expected_quantity) + 0.000001) {
          throw new OperationsRequestError(
            'OPERATIONS_RECEIPT_QUANTITY_EXCEEDED',
            `Accepted and damaged quantity exceeds expected quantity on ${line.global_id}`,
            409,
          )
        }
        if (Math.abs(total - numberValue(line.expected_quantity)) > 0.000001) {
          throw new OperationsRequestError(
            'OPERATIONS_RECEIPT_QUANTITY_INCOMPLETE',
            `Classify every expected unit as accepted or damaged on ${line.global_id}`,
            409,
          )
        }
        if (total > 0) {
          const product = await resolveProduct(client, receipt.pipeline_id, line.product_global_id)
          const location = await client.query<{ global_id: string }>(
            `SELECT global_id
             FROM operations_locations
             WHERE organization_id = $1::uuid AND id = $2::uuid
             LIMIT 1`,
            [organizationId, line.target_location_id],
          )
          if (!location.rows[0]) {
            throw new OperationsRequestError(
              'OPERATIONS_PUTAWAY_LOCATION_INVALID',
              `The planned putaway location for ${line.global_id} is no longer available`,
              409,
            )
          }
          await selectPutawayPlacement(client, {
            organizationId,
            pipelineId: receipt.pipeline_id,
            warehouseId: receipt.warehouse_id,
            product,
            quantity: total,
            requestedLocationGlobalId: location.rows[0].global_id,
          })
          const positionInsert = await client.query<{ id: string; global_id: string }>(
            `INSERT INTO operations_inventory_positions (
               organization_id, pipeline_id, warehouse_id, location_id, pool_id,
               product_id, lot_code
             ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7)
             ON CONFLICT (
               organization_id, warehouse_id, location_id, pool_id, product_id, lot_code
             ) DO UPDATE SET updated_at = operations_inventory_positions.updated_at
             RETURNING id::text, global_id`,
            [
              organizationId,
              receipt.pipeline_id,
              receipt.warehouse_id,
              line.target_location_id,
              receipt.inventory_pool_id,
              line.product_id,
              line.lot_code,
            ],
          )
          const positionResult = await client.query<InventoryBalanceRow>(
            `SELECT id::text, global_id, on_hand_quantity::text,
                    reserved_quantity::text, damaged_quantity::text
             FROM operations_inventory_positions
             WHERE organization_id = $1::uuid AND id = $2::uuid
             FOR UPDATE`,
            [organizationId, positionInsert.rows[0].id],
          )
          const position = positionResult.rows[0]
          const onHandAfter = numberValue(position.on_hand_quantity) + total
          const damagedAfter = numberValue(position.damaged_quantity) + completion.damagedQuantity
          const reservedAfter = numberValue(position.reserved_quantity)
          await client.query(
            `UPDATE operations_inventory_positions
             SET on_hand_quantity = $3, damaged_quantity = $4,
                 version = version + 1, updated_at = now()
             WHERE organization_id = $1::uuid AND id = $2::uuid`,
            [organizationId, position.id, onHandAfter, damagedAfter],
          )
          await client.query(
            `INSERT INTO operations_inventory_ledger (
               organization_id, position_id, event_type,
               on_hand_delta, reserved_delta, damaged_delta,
               on_hand_after, reserved_after, damaged_after,
               source_global_id, reason, idempotency_key, actor_email
             ) VALUES (
               $1::uuid, $2::uuid, 'receipt', $3, 0, $4, $5, $6, $7, $8, $9, $10, $11
             )`,
            [
              organizationId,
              position.id,
              total,
              completion.damagedQuantity,
              onHandAfter,
              reservedAfter,
              damagedAfter,
              line.global_id,
              reason,
              `${receipt.global_id}:${line.global_id}:receipt:${prepared.receipt.id}`,
              input.actorEmail,
            ],
          )
          positionGlobalIds.add(position.global_id)
        }
        await client.query(
          `UPDATE operations_receipt_lines
           SET accepted_quantity = $3, damaged_quantity = $4, updated_at = now()
           WHERE organization_id = $1::uuid AND id = $2::uuid`,
          [
            organizationId,
            line.id,
            completion.acceptedQuantity,
            completion.damagedQuantity,
          ],
        )
        receivedQuantity += completion.acceptedQuantity
        damagedQuantity += completion.damagedQuantity
      }
      const updatedReceipt = await client.query<{ row_version: string }>(
        `UPDATE operations_receipts
         SET status = 'completed', started_at = COALESCE(started_at, now()),
             completed_at = now(), updated_by = $4,
             row_version = row_version + 1, updated_at = now()
         WHERE organization_id = $1::uuid AND id = $2::uuid AND row_version = $3
         RETURNING row_version::text`,
        [
          organizationId,
          receipt.id,
          normalized.expectedRowVersion,
          input.actorEmail,
        ],
      )
      if (!updatedReceipt.rows[0]) {
        throw new OperationsRequestError(
          'OPERATIONS_RECEIPT_VERSION_CONFLICT',
          'Receipt changed before receiving could be completed',
          409,
        )
      }
      const result: OperationsInboundReceiptCommandResult = {
        receiptGlobalId: receipt.global_id,
        status: 'completed',
        rowVersion: Number(updatedReceipt.rows[0].row_version),
        receivedQuantity,
        damagedQuantity,
        positionGlobalIds: [...positionGlobalIds],
        replayed: false,
      }
      await appendDomainEvent(client, {
        organizationId,
        aggregateType: 'operations.receipt',
        aggregateId: receipt.id,
        aggregateGlobalId: receipt.global_id,
        eventType: 'operations.receipt.completed',
        actorEmail: input.actorEmail,
        correlationId: prepared.receipt.correlation_id,
        idempotencyKey: `${receipt.global_id}:completed:${prepared.receipt.id}`,
        payload: {
          receivedQuantity,
          damagedQuantity,
          positionGlobalIds: result.positionGlobalIds,
          reason,
        },
      })
      await recordAuditEvent({
        actor: input.actorEmail,
        eventType: 'operations.receipt.completed',
        aggregateType: 'operations.receipt',
        aggregateId: receipt.global_id,
        subject: receipt.global_id,
        organizationId,
        eventKey: `operations:receipt:${receipt.global_id}:completed:${prepared.receipt.id}`,
        payload: {
          receivedQuantity,
          damagedQuantity,
          positionGlobalIds: result.positionGlobalIds,
          reason,
        },
      }, client)
      await completeCommandReceipt(
        client,
        prepared.receipt.id,
        receipt.global_id,
        result as unknown as Record<string, unknown>,
      )
      return result
    })
  } catch (error) {
    await failCommandReceipt(prepared.receipt.id, error)
    throw error
  }
}

export async function executeOperationsReplenishmentInPostgres(input: {
  organizationId: string
  actorEmail: string
  replenishment: OperationsReplenishmentExecutionInput
  idempotencyKey: string
}): Promise<OperationsReplenishmentExecutionResult> {
  const organizationId = requireOrganizationId(input.organizationId)
  const normalized: OperationsReplenishmentExecutionInput = {
    sourceLocationGlobalId: receiptText(
      input.replenishment.sourceLocationGlobalId,
      'Replenishment source location',
      20,
    ),
    destinationLocationGlobalId: receiptText(
      input.replenishment.destinationLocationGlobalId,
      'Replenishment destination location',
      20,
    ),
    inventoryPoolGlobalId: receiptText(
      input.replenishment.inventoryPoolGlobalId,
      'Replenishment inventory pool',
      20,
    ),
    productGlobalId: receiptText(
      input.replenishment.productGlobalId,
      'Replenishment product',
      20,
    ),
    quantity: positiveReceiptQuantity(
      input.replenishment.quantity,
      'Replenishment quantity',
    ),
  }
  if (normalized.sourceLocationGlobalId === normalized.destinationLocationGlobalId) {
    throw new OperationsRequestError(
      'OPERATIONS_REPLENISHMENT_INVALID',
      'Replenishment source and destination must be different locations',
    )
  }
  const prepared = await prepareCommandReceipt({
    organizationId,
    commandType: 'execute_replenishment',
    idempotencyKey: input.idempotencyKey,
    requestHash: commandRequestHash(normalized),
    actorEmail: input.actorEmail,
  })
  if (prepared.completed) {
    return completedReplenishmentExecutionResult(prepared.receipt)
  }

  try {
    return await withTransaction(async (client) => {
      const pipeline = await resolvePipeline(client, organizationId)
      const product = await resolveProduct(client, pipeline.id, normalized.productGlobalId)
      const ruleResult = await client.query<ReplenishmentExecutionRuleRow>(
        `SELECT rule.id::text AS rule_id, rule.global_id AS rule_global_id,
                rule.replenishment_mode, rule.min_quantity::text,
                rule.target_quantity::text,
                warehouse.id::text AS warehouse_id,
                warehouse.global_id AS warehouse_global_id,
                product.id::text AS product_id, product.name AS product_name,
                product.sku AS product_sku,
                source.id::text AS source_location_id,
                source.global_id AS source_location_global_id,
                source.code AS source_location_code,
                destination.id::text AS destination_location_id,
                destination.global_id AS destination_location_global_id,
                destination.code AS destination_location_code
         FROM operations_location_product_rules rule
         JOIN operations_locations destination
           ON destination.organization_id = rule.organization_id
          AND destination.id = rule.location_id
          AND destination.active = true
         JOIN operations_locations source
           ON source.organization_id = rule.organization_id
          AND source.id = rule.replenishment_source_location_id
          AND source.active = true
         JOIN operations_warehouses warehouse
           ON warehouse.organization_id = rule.organization_id
          AND warehouse.id = destination.warehouse_id
          AND warehouse.id = source.warehouse_id
          AND warehouse.status = 'active'
          AND warehouse.code <> 'MOCK-01'
         JOIN crm_products product
           ON product.pipeline_id = rule.pipeline_id
          AND product.id = rule.product_id
          AND product.active = true
         WHERE rule.organization_id = $1::uuid
           AND rule.pipeline_id = $2::uuid
           AND rule.active = true
           AND rule.replenishment_mode IN ('min_max', 'order_demand')
           AND rule.target_quantity IS NOT NULL
           AND source.global_id = $3
           AND destination.global_id = $4
           AND product.reference_code = $5
         LIMIT 1
         FOR UPDATE OF rule, source, destination, warehouse`,
        [
          organizationId,
          pipeline.id,
          normalized.sourceLocationGlobalId,
          normalized.destinationLocationGlobalId,
          normalized.productGlobalId,
        ],
      )
      const rule = ruleResult.rows[0]
      if (!rule) {
        throw new OperationsRequestError(
          'OPERATIONS_REPLENISHMENT_RULE_NOT_FOUND',
          'The active replenishment rule is no longer available; refresh warehouse setup',
          409,
        )
      }
      const poolResult = await client.query<InventoryPoolRow>(
        `SELECT pool.id::text, pool.global_id, pool.name, pool.pool_type,
                pool.allocation_policy, pool.active,
                owner.reference_code AS owner_customer_global_id,
                owner.name AS owner_customer_name
         FROM operations_inventory_pools pool
         LEFT JOIN crm_organizations owner
           ON owner.pipeline_id = pool.pipeline_id AND owner.id = pool.owner_customer_id
         WHERE pool.organization_id = $1::uuid
           AND pool.global_id = $2
           AND pool.active = true
         LIMIT 1`,
        [organizationId, normalized.inventoryPoolGlobalId],
      )
      const pool = poolResult.rows[0]
      if (!pool) {
        throw new OperationsRequestError(
          'OPERATIONS_INVENTORY_POOL_INACTIVE',
          'The replenishment inventory pool is no longer active',
          409,
        )
      }
      await acquireTransactionAdvisoryLock(
        client,
        `operations:replenishment:${organizationId}:${rule.warehouse_id}:${product.id}:${pool.id}`,
      )
      const sourceResult = await client.query<InventoryBalanceRow & { lot_code: string }>(
        `SELECT id::text, global_id, lot_code, on_hand_quantity::text,
                reserved_quantity::text, damaged_quantity::text
         FROM operations_inventory_positions
         WHERE organization_id = $1::uuid
           AND warehouse_id = $2::uuid
           AND location_id = $3::uuid
           AND pool_id = $4::uuid
           AND product_id = $5::uuid
         ORDER BY lot_code, id
         FOR UPDATE`,
        [
          organizationId,
          rule.warehouse_id,
          rule.source_location_id,
          pool.id,
          product.id,
        ],
      )
      const destinationResult = await client.query<InventoryBalanceRow & { lot_code: string }>(
        `SELECT id::text, global_id, lot_code, on_hand_quantity::text,
                reserved_quantity::text, damaged_quantity::text
         FROM operations_inventory_positions
         WHERE organization_id = $1::uuid
           AND warehouse_id = $2::uuid
           AND location_id = $3::uuid
           AND pool_id = $4::uuid
           AND product_id = $5::uuid
         ORDER BY lot_code, id
         FOR UPDATE`,
        [
          organizationId,
          rule.warehouse_id,
          rule.destination_location_id,
          pool.id,
          product.id,
        ],
      )
      const availableAtSource = sourceResult.rows.reduce(
        (sum, position) => sum + Math.max(
          numberValue(position.on_hand_quantity)
            - numberValue(position.reserved_quantity)
            - numberValue(position.damaged_quantity),
          0,
        ),
        0,
      )
      const availableAtDestination = destinationResult.rows.reduce(
        (sum, position) => sum + Math.max(
          numberValue(position.on_hand_quantity)
            - numberValue(position.reserved_quantity)
            - numberValue(position.damaged_quantity),
          0,
        ),
        0,
      )
      const demandResult = await client.query<{ released_demand: string }>(
        `SELECT COALESCE(SUM(allocation.quantity), 0)::text AS released_demand
         FROM operations_fulfillment_allocations allocation
         JOIN operations_fulfillment_plans plan
           ON plan.organization_id = allocation.organization_id
          AND plan.id = allocation.plan_id
          AND plan.warehouse_id = $2::uuid
         JOIN operations_orders demand_order
           ON demand_order.organization_id = plan.organization_id
          AND demand_order.id = plan.order_id
          AND demand_order.status IN ('planned', 'released', 'picking')
         JOIN operations_current_order_lines demand_line
           ON demand_line.organization_id = allocation.organization_id
          AND demand_line.id = allocation.order_line_id
          AND demand_line.product_id = $3::uuid
         JOIN operations_inventory_positions allocation_position
           ON allocation_position.organization_id = allocation.organization_id
          AND allocation_position.id = allocation.position_id
          AND allocation_position.pool_id = $4::uuid
         WHERE allocation.organization_id = $1::uuid`,
        [organizationId, rule.warehouse_id, product.id, pool.id],
      )
      const releasedDemand = numberValue(demandResult.rows[0]?.released_demand)
      const targetQuantity = rule.replenishment_mode === 'order_demand'
        ? Math.max(numberValue(rule.target_quantity), releasedDemand)
        : numberValue(rule.target_quantity)
      const triggerActive = rule.replenishment_mode === 'min_max'
        ? availableAtDestination <= numberValue(rule.min_quantity)
        : availableAtDestination < targetQuantity
      const recommendedQuantity = triggerActive
        ? Math.min(availableAtSource, Math.max(targetQuantity - availableAtDestination, 0))
        : 0
      if (normalized.quantity > recommendedQuantity + 0.000001) {
        throw new OperationsRequestError(
          'OPERATIONS_REPLENISHMENT_STALE',
          'Inventory or demand changed; refresh the recommendation before moving stock',
          409,
        )
      }
      await selectPutawayPlacement(client, {
        organizationId,
        pipelineId: pipeline.id,
        warehouseId: rule.warehouse_id,
        product,
        quantity: normalized.quantity,
        requestedLocationGlobalId: rule.destination_location_global_id,
      })
      const recommendationSnapshot = {
        ruleGlobalId: rule.rule_global_id,
        replenishmentMode: rule.replenishment_mode,
        availableAtSource,
        availableAtDestination,
        releasedDemand,
        minQuantity: rule.min_quantity === null ? null : numberValue(rule.min_quantity),
        targetQuantity: numberValue(rule.target_quantity),
        calculatedTargetQuantity: targetQuantity,
        recommendedQuantity,
      }
      const taskResult = await client.query<{ id: string; global_id: string }>(
        `INSERT INTO operations_replenishment_tasks (
           organization_id, pipeline_id, warehouse_id, inventory_pool_id,
           product_id, source_location_id, destination_location_id,
           quantity, replenishment_mode, recommendation_snapshot, status,
           idempotency_key, created_by, completed_by, completed_at
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7::uuid,
           $8, $9, $10::jsonb, 'completed', $11, $12, $12, now()
         )
         RETURNING id::text, global_id`,
        [
          organizationId,
          pipeline.id,
          rule.warehouse_id,
          pool.id,
          product.id,
          rule.source_location_id,
          rule.destination_location_id,
          normalized.quantity,
          rule.replenishment_mode,
          JSON.stringify(recommendationSnapshot),
          input.idempotencyKey,
          input.actorEmail,
        ],
      )
      const task = taskResult.rows[0]
      let remaining = normalized.quantity
      let movementIndex = 0
      for (const sourcePosition of sourceResult.rows) {
        if (remaining <= 0.000001) break
        const sourceAvailable = Math.max(
          numberValue(sourcePosition.on_hand_quantity)
            - numberValue(sourcePosition.reserved_quantity)
            - numberValue(sourcePosition.damaged_quantity),
          0,
        )
        const movedQuantity = Math.min(sourceAvailable, remaining)
        if (movedQuantity <= 0.000001) continue
        movementIndex += 1
        const sourceOnHandAfter = numberValue(sourcePosition.on_hand_quantity) - movedQuantity
        const sourceReservedAfter = numberValue(sourcePosition.reserved_quantity)
        const sourceDamagedAfter = numberValue(sourcePosition.damaged_quantity)
        await client.query(
          `UPDATE operations_inventory_positions
           SET on_hand_quantity = $3, version = version + 1, updated_at = now()
           WHERE organization_id = $1::uuid AND id = $2::uuid`,
          [organizationId, sourcePosition.id, sourceOnHandAfter],
        )
        await client.query(
          `INSERT INTO operations_inventory_ledger (
             organization_id, position_id, event_type,
             on_hand_delta, reserved_delta, damaged_delta,
             on_hand_after, reserved_after, damaged_after,
             source_global_id, reason, idempotency_key, actor_email
           ) VALUES (
             $1::uuid, $2::uuid, 'replenishment_out',
             $3, 0, 0, $4, $5, $6, $7, $8, $9, $10
           )`,
          [
            organizationId,
            sourcePosition.id,
            -movedQuantity,
            sourceOnHandAfter,
            sourceReservedAfter,
            sourceDamagedAfter,
            task.global_id,
            `Move to ${rule.destination_location_code}`,
            `${task.global_id}:${movementIndex}:out`,
            input.actorEmail,
          ],
        )
        const destinationInsert = await client.query<{ id: string; global_id: string }>(
          `INSERT INTO operations_inventory_positions (
             organization_id, pipeline_id, warehouse_id, location_id, pool_id,
             product_id, lot_code
           ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7)
           ON CONFLICT (
             organization_id, warehouse_id, location_id, pool_id, product_id, lot_code
           ) DO UPDATE SET updated_at = operations_inventory_positions.updated_at
           RETURNING id::text, global_id`,
          [
            organizationId,
            pipeline.id,
            rule.warehouse_id,
            rule.destination_location_id,
            pool.id,
            product.id,
            sourcePosition.lot_code,
          ],
        )
        const destinationPositionResult = await client.query<InventoryBalanceRow>(
          `SELECT id::text, global_id, on_hand_quantity::text,
                  reserved_quantity::text, damaged_quantity::text
           FROM operations_inventory_positions
           WHERE organization_id = $1::uuid AND id = $2::uuid
           FOR UPDATE`,
          [organizationId, destinationInsert.rows[0].id],
        )
        const destinationPosition = destinationPositionResult.rows[0]
        const destinationOnHandAfter = numberValue(destinationPosition.on_hand_quantity)
          + movedQuantity
        const destinationReservedAfter = numberValue(destinationPosition.reserved_quantity)
        const destinationDamagedAfter = numberValue(destinationPosition.damaged_quantity)
        await client.query(
          `UPDATE operations_inventory_positions
           SET on_hand_quantity = $3, version = version + 1, updated_at = now()
           WHERE organization_id = $1::uuid AND id = $2::uuid`,
          [organizationId, destinationPosition.id, destinationOnHandAfter],
        )
        await client.query(
          `INSERT INTO operations_inventory_ledger (
             organization_id, position_id, event_type,
             on_hand_delta, reserved_delta, damaged_delta,
             on_hand_after, reserved_after, damaged_after,
             source_global_id, reason, idempotency_key, actor_email
           ) VALUES (
             $1::uuid, $2::uuid, 'replenishment_in',
             $3, 0, 0, $4, $5, $6, $7, $8, $9, $10
           )`,
          [
            organizationId,
            destinationPosition.id,
            movedQuantity,
            destinationOnHandAfter,
            destinationReservedAfter,
            destinationDamagedAfter,
            task.global_id,
            `Move from ${rule.source_location_code}`,
            `${task.global_id}:${movementIndex}:in`,
            input.actorEmail,
          ],
        )
        remaining -= movedQuantity
      }
      if (remaining > 0.000001) {
        throw new OperationsRequestError(
          'OPERATIONS_REPLENISHMENT_INVENTORY_CONFLICT',
          'Available source inventory changed before the move completed',
          409,
        )
      }
      const result: OperationsReplenishmentExecutionResult = {
        replenishmentTaskGlobalId: task.global_id,
        status: 'completed',
        warehouseGlobalId: rule.warehouse_global_id,
        productGlobalId: product.reference_code,
        inventoryPoolGlobalId: pool.global_id,
        sourceLocationGlobalId: rule.source_location_global_id,
        sourceLocationCode: rule.source_location_code,
        destinationLocationGlobalId: rule.destination_location_global_id,
        destinationLocationCode: rule.destination_location_code,
        movedQuantity: normalized.quantity,
        sourceAvailableAfter: availableAtSource - normalized.quantity,
        destinationAvailableAfter: availableAtDestination + normalized.quantity,
        replayed: false,
      }
      await appendDomainEvent(client, {
        organizationId,
        aggregateType: 'operations.replenishment_task',
        aggregateId: task.id,
        aggregateGlobalId: task.global_id,
        eventType: 'operations.replenishment.completed',
        actorEmail: input.actorEmail,
        correlationId: prepared.receipt.correlation_id,
        idempotencyKey: `${task.global_id}:completed`,
        payload: {
          ...result,
          ruleGlobalId: rule.rule_global_id,
          recommendationSnapshot,
        },
      })
      await recordAuditEvent({
        actor: input.actorEmail,
        eventType: 'operations.replenishment.completed',
        aggregateType: 'operations.replenishment_task',
        aggregateId: task.global_id,
        subject: `${product.name}: ${rule.source_location_code} to ${rule.destination_location_code}`,
        organizationId,
        eventKey: `operations:replenishment:${task.global_id}:completed`,
        payload: {
          ...result,
          ruleGlobalId: rule.rule_global_id,
          recommendationSnapshot,
        },
      }, client)
      await completeCommandReceipt(
        client,
        prepared.receipt.id,
        task.global_id,
        result as unknown as Record<string, unknown>,
      )
      return result
    })
  } catch (error) {
    await failCommandReceipt(prepared.receipt.id, error)
    throw error
  }
}

async function completedProofResult(
  organizationId: string,
  receipt: Pick<CommandReceiptRow, 'result_global_id' | 'result_payload'>,
): Promise<MockOperationsProofResult> {
  const payload = receipt.result_payload
  if (payload
    && typeof payload.orderGlobalId === 'string'
    && typeof payload.orderStatus === 'string'
    && (typeof payload.trackingNumber === 'string' || payload.trackingNumber === null)
    && Array.isArray(payload.steps)
    && payload.steps.every((step) => typeof step === 'string')) {
    return {
      orderGlobalId: payload.orderGlobalId,
      orderStatus: payload.orderStatus as OperationsOrderStatus,
      duplicate: true,
      trackingNumber: payload.trackingNumber,
      steps: payload.steps,
    }
  }
  const orderGlobalId = receipt.result_global_id
  if (!orderGlobalId) {
    throw new OperationsRequestError('OPERATIONS_COMMAND_RECEIPT_INVALID', 'Completed command receipt has no order result', 409)
  }
  const result = await query<OrderIdentityRow>(
    `SELECT orders.id::text, orders.global_id, orders.status, shipment.tracking_number
     FROM operations_orders orders
     LEFT JOIN LATERAL (
       SELECT tracking_number FROM operations_shipments candidate
       WHERE candidate.organization_id = orders.organization_id
         AND candidate.order_id = orders.id
       ORDER BY candidate.shipped_at DESC LIMIT 1
     ) shipment ON true
     WHERE orders.organization_id = $1::uuid AND orders.global_id = $2
     LIMIT 1`,
    [organizationId, orderGlobalId],
  )
  const order = result.rows[0]
  if (!order) {
    throw new OperationsRequestError('OPERATIONS_COMMAND_RECEIPT_INVALID', 'Completed order result is unavailable', 409)
  }
  return {
    orderGlobalId: order.global_id,
    orderStatus: order.status,
    duplicate: true,
    trackingNumber: order.tracking_number || null,
    steps: proofSteps(order.status),
  }
}

async function completedOrderCommandResult(
  organizationId: string,
  receipt: Pick<CommandReceiptRow, 'result_global_id' | 'result_payload'>,
): Promise<OperationsOrderCommandResult> {
  const payload = receipt.result_payload
  if (payload
    && typeof payload.orderGlobalId === 'string'
    && typeof payload.orderStatus === 'string'
    && Number.isSafeInteger(Number(payload.rowVersion))) {
    return {
      orderGlobalId: payload.orderGlobalId,
      orderStatus: payload.orderStatus as OperationsOrderStatus,
      rowVersion: Number(payload.rowVersion),
      replayed: true,
    }
  }
  const orderGlobalId = receipt.result_global_id
  if (!orderGlobalId) {
    throw new OperationsRequestError('OPERATIONS_COMMAND_RECEIPT_INVALID', 'Completed command receipt has no order result', 409)
  }
  const result = await query<OrderIdentityRow>(
    `SELECT id::text, global_id, status, row_version::text
     FROM operations_orders
     WHERE organization_id = $1::uuid AND global_id = $2
     LIMIT 1`,
    [organizationId, orderGlobalId],
  )
  const order = result.rows[0]
  if (!order || order.row_version === undefined) {
    throw new OperationsRequestError('OPERATIONS_COMMAND_RECEIPT_INVALID', 'Completed order result is unavailable', 409)
  }
  return {
    orderGlobalId: order.global_id,
    orderStatus: order.status,
    rowVersion: Number(order.row_version),
    replayed: true,
  }
}

function completedPickHandoffResult(
  receipt: Pick<CommandReceiptRow, 'result_payload'>,
): OperationsPickHandoffResult {
  const payload = receipt.result_payload
  if (
    payload
    && typeof payload.orderGlobalId === 'string'
    && payload.orderStatus === 'released'
    && Number.isSafeInteger(Number(payload.previousRowVersion))
    && Number.isSafeInteger(Number(payload.rowVersion))
    && Number(payload.rowVersion) === Number(payload.previousRowVersion) + 1
    && typeof payload.exceptionGlobalId === 'string'
    && /^gex(?:[0-9]{7}|[0-9a-v]{12})$/.test(payload.exceptionGlobalId)
    && Number.isSafeInteger(Number(payload.assignedTaskCount))
    && Number(payload.assignedTaskCount) > 0
    && (
      payload.blockedConfirmationIdempotencyKey === null
      || typeof payload.blockedConfirmationIdempotencyKey === 'string'
    )
    && Number(payload.providerWrites) === 0
  ) {
    return {
      orderGlobalId: payload.orderGlobalId,
      orderStatus: 'released',
      previousRowVersion: Number(payload.previousRowVersion),
      rowVersion: Number(payload.rowVersion),
      exceptionGlobalId: payload.exceptionGlobalId,
      assignedTaskCount: Number(payload.assignedTaskCount),
      blockedConfirmationIdempotencyKey:
        payload.blockedConfirmationIdempotencyKey as string | null,
      providerWrites: 0,
      replayed: true,
    }
  }
  throw new OperationsRequestError(
    'OPERATIONS_COMMAND_RECEIPT_INVALID',
    'Completed picker handoff result is unavailable',
    409,
  )
}

function completedManagePickAssignmentResult(
  receipt: Pick<CommandReceiptRow, 'result_payload'>,
): OperationsManagePickAssignmentResult {
  const payload = receipt.result_payload
  if (
    payload
    && typeof payload.orderGlobalId === 'string'
    && payload.orderStatus === 'released'
    && Number.isSafeInteger(Number(payload.previousRowVersion))
    && Number.isSafeInteger(Number(payload.rowVersion))
    && Number(payload.rowVersion) === Number(payload.previousRowVersion) + 1
    && Number.isSafeInteger(Number(payload.taskCount))
    && Number(payload.taskCount) > 0
    && (
      payload.previousAssignedTo === null
      || payload.previousAssignedTo === 'mixed'
      || typeof payload.previousAssignedTo === 'string'
    )
    && (
      payload.assignedTo === null
      || typeof payload.assignedTo === 'string'
    )
    && (
      payload.interventionExceptionGlobalId === null
      || (
        typeof payload.interventionExceptionGlobalId === 'string'
        && /^gex(?:[0-9]{7}|[0-9a-v]{12})$/.test(
          payload.interventionExceptionGlobalId,
        )
      )
    )
    && Number(payload.providerWrites) === 0
  ) {
    return {
      orderGlobalId: payload.orderGlobalId,
      orderStatus: 'released',
      previousRowVersion: Number(payload.previousRowVersion),
      rowVersion: Number(payload.rowVersion),
      taskCount: Number(payload.taskCount),
      previousAssignedTo:
        payload.previousAssignedTo as string | null | 'mixed',
      assignedTo: payload.assignedTo as string | null,
      interventionExceptionGlobalId:
        payload.interventionExceptionGlobalId as string | null,
      providerWrites: 0,
      replayed: true,
    }
  }
  throw new OperationsRequestError(
    'OPERATIONS_COMMAND_RECEIPT_INVALID',
    'Completed manager pick-assignment result is unavailable',
    409,
  )
}

function completedExternalFulfillmentReconciliationResult(
  receipt: Pick<CommandReceiptRow, 'result_payload'>,
): OperationsExternalFulfillmentReconciliationResult {
  const payload = receipt.result_payload
  if (
    payload
    && typeof payload.orderGlobalId === 'string'
    && payload.orderStatus === 'cancelled'
    && Number.isSafeInteger(Number(payload.rowVersion))
    && typeof payload.reconciliationGlobalId === 'string'
    && typeof payload.providerFulfillmentId === 'string'
    && typeof payload.providerFulfillmentName === 'string'
    && Number(payload.providerReads) === 2
    && Number(payload.providerWrites) === 0
  ) {
    return {
      orderGlobalId: payload.orderGlobalId,
      orderStatus: 'cancelled',
      rowVersion: Number(payload.rowVersion),
      reconciliationGlobalId: payload.reconciliationGlobalId,
      providerFulfillmentId: payload.providerFulfillmentId,
      providerFulfillmentName: payload.providerFulfillmentName,
      providerReads: 2,
      providerWrites: 0,
      replayed: true,
    }
  }
  throw new OperationsRequestError(
    'OPERATIONS_COMMAND_RECEIPT_INVALID',
    'Completed Shopify external-fulfillment reconciliation is unavailable',
    409,
  )
}

function completedPlanCommandResult(
  receipt: Pick<CommandReceiptRow, 'result_payload'>,
): OperationsPlanCommandResult {
  const payload = receipt.result_payload
  if (payload
    && typeof payload.orderGlobalId === 'string'
    && payload.orderStatus === 'planned'
    && Number.isSafeInteger(Number(payload.rowVersion))
    && typeof payload.fulfillmentPlanGlobalId === 'string'
    && typeof payload.cartonizationEvidenceGlobalId === 'string'
    && Number.isSafeInteger(Number(payload.packageCount))
    && typeof payload.carrier === 'string'
    && typeof payload.serviceCode === 'string'
    && typeof payload.serviceName === 'string'
    && Number.isSafeInteger(Number(payload.carrierCostMinor))
    && typeof payload.currency === 'string'
    && (
      payload.checkoutShippingChargeMinor === null
      || Number.isSafeInteger(Number(payload.checkoutShippingChargeMinor))
    )
    && (
      payload.checkoutVarianceMinor === null
      || Number.isSafeInteger(Number(payload.checkoutVarianceMinor))
    )) {
    return {
      orderGlobalId: payload.orderGlobalId,
      orderStatus: 'planned',
      rowVersion: Number(payload.rowVersion),
      fulfillmentPlanGlobalId: payload.fulfillmentPlanGlobalId,
      cartonizationEvidenceGlobalId:
        payload.cartonizationEvidenceGlobalId,
      packageCount: Number(payload.packageCount),
      carrier: payload.carrier,
      serviceCode: payload.serviceCode,
      serviceName: payload.serviceName,
      carrierCostMinor: Number(payload.carrierCostMinor),
      currency: payload.currency,
      checkoutShippingChargeMinor:
        payload.checkoutShippingChargeMinor === null
          ? null
          : Number(payload.checkoutShippingChargeMinor),
      checkoutVarianceMinor:
        payload.checkoutVarianceMinor === null
          ? null
          : Number(payload.checkoutVarianceMinor),
      replayed: true,
    }
  }
  throw new OperationsRequestError(
    'OPERATIONS_COMMAND_RECEIPT_INVALID',
    'Completed fulfillment-planning result is unavailable',
    409,
  )
}

async function completedPackingSlipCommandResult(
  receipt: Pick<CommandReceiptRow, 'result_payload'>,
): Promise<OperationsPackingSlipCommandResult> {
  const payload = receipt.result_payload
  if (payload
    && typeof payload.orderGlobalId === 'string'
    && payload.orderStatus === 'packed'
    && Number.isSafeInteger(Number(payload.rowVersion))
    && typeof payload.packageGlobalId === 'string'
    && Number.isSafeInteger(Number(payload.packageNumber))
    && typeof payload.packingSlipArtifactGlobalId === 'string'
    && typeof payload.contentUrl === 'string') {
    const isPackWorkInstruction = (
      payload.documentKind === 'pack_work_instruction'
      && payload.documentStage === 'pre_label_pack_work_instruction'
      && payload.finalPackingSlip === false
    )
    return {
      orderGlobalId: payload.orderGlobalId,
      orderStatus: 'packed',
      rowVersion: Number(payload.rowVersion),
      packageGlobalId: payload.packageGlobalId,
      packageNumber: Number(payload.packageNumber),
      documentKind: isPackWorkInstruction
        ? 'pack_work_instruction'
        : 'legacy_prelabel_packing_list',
      documentStage: isPackWorkInstruction
        ? 'pre_label_pack_work_instruction'
        : 'legacy_prelabel_packing_list',
      finalPackingSlip: false,
      packingSlipArtifactGlobalId: payload.packingSlipArtifactGlobalId,
      contentUrl: payload.contentUrl,
      replayed: true,
    }
  }
  throw new OperationsRequestError(
    'OPERATIONS_COMMAND_RECEIPT_INVALID',
    'Completed Pack Work Instruction result is unavailable',
    409,
  )
}

async function completedShipmentCommandResult(
  organizationId: string,
  receipt: Pick<CommandReceiptRow, 'result_global_id' | 'result_payload'>,
): Promise<OperationsShipmentCommandResult> {
  const payload = receipt.result_payload
  if (payload
    && typeof payload.orderGlobalId === 'string'
    && payload.orderStatus === 'shipped'
    && Number.isSafeInteger(Number(payload.rowVersion))
    && typeof payload.shipmentGlobalId === 'string'
    && typeof payload.trackingNumber === 'string'
    && typeof payload.packingSlipArtifactGlobalId === 'string'
    && typeof payload.commerceExportGlobalId === 'string'
    && ['succeeded', 'unsupported', 'failed']
      .includes(String(payload.commerceExportState))) {
    let notificationDecision = customerNotificationDecision(
      payload.customerNotification,
    )
    if (notificationDecision.source === 'legacy_safe_default') {
      const exactExport = await query<QueryResultRow & {
        provider: string
        payload_snapshot: Record<string, unknown>
      }>(
        `SELECT fulfillment_export.provider,
                fulfillment_export.payload_snapshot
         FROM operations_commerce_fulfillment_exports fulfillment_export
         JOIN operations_orders source_order
           ON source_order.organization_id = fulfillment_export.organization_id
          AND source_order.id = fulfillment_export.order_id
         JOIN operations_shipments shipment
           ON shipment.organization_id = fulfillment_export.organization_id
          AND shipment.id = fulfillment_export.shipment_id
         WHERE fulfillment_export.organization_id = $1::uuid
           AND fulfillment_export.global_id = $2
           AND source_order.global_id = $3
           AND shipment.global_id = $4
         LIMIT 1`,
        [
          organizationId,
          payload.commerceExportGlobalId,
          payload.orderGlobalId,
          payload.shipmentGlobalId,
        ],
      )
      const recoveredDecision = exactExport.rows[0]
        && hasRetainedShopifySandboxAuthorization(
            exactExport.rows[0].payload_snapshot,
            exactExport.rows[0].provider,
          )
        ? commerceExportCustomerNotificationDecision(
            exactExport.rows[0].payload_snapshot,
            exactExport.rows[0].provider,
          )
        : notificationDecision
      if (recoveredDecision.source === 'sandbox_e2e_suppression') {
        notificationDecision = recoveredDecision
      }
    }
    return {
      orderGlobalId: payload.orderGlobalId,
      orderStatus: 'shipped',
      rowVersion: Number(payload.rowVersion),
      shipmentGlobalId: payload.shipmentGlobalId,
      trackingNumber: payload.trackingNumber,
      packingSlipArtifactGlobalId: payload.packingSlipArtifactGlobalId,
      commerceExportGlobalId: payload.commerceExportGlobalId,
      commerceExportState: payload.commerceExportState as OperationsShipmentCommandResult['commerceExportState'],
      customerNotification: notificationDecision,
      replayed: true,
      printJobGlobalId: typeof payload.printJobGlobalId === 'string'
        ? payload.printJobGlobalId
        : null,
      printWarning: typeof payload.printWarning === 'string'
        ? payload.printWarning
        : null,
    }
  }
  const orderGlobalId = receipt.result_global_id
  if (!orderGlobalId) {
    throw new OperationsRequestError(
      'OPERATIONS_COMMAND_RECEIPT_INVALID',
      'Completed command receipt has no shipment result',
      409,
    )
  }
  const receiptCommerceExportGlobalId = (
    payload && typeof payload.commerceExportGlobalId === 'string'
      ? payload.commerceExportGlobalId
      : null
  )
  const result = await query<QueryResultRow & {
    order_global_id: string
    order_status: OperationsOrderStatus
    row_version: string
    shipment_global_id: string
    tracking_number: string
    artifact_global_id: string
    export_global_id: string
    export_provider: string
    export_state: string
    export_payload_snapshot: Record<string, unknown>
    print_job_global_id: string | null
  }>(
    `SELECT source_order.global_id AS order_global_id,
            source_order.status AS order_status,
            source_order.row_version::text,
            shipment.global_id AS shipment_global_id,
            shipment.tracking_number,
            artifact.global_id AS artifact_global_id,
            fulfillment_export.global_id AS export_global_id,
            fulfillment_export.provider AS export_provider,
            fulfillment_export.state AS export_state,
            fulfillment_export.payload_snapshot AS export_payload_snapshot,
            print_job.global_id AS print_job_global_id
     FROM operations_orders source_order
     JOIN LATERAL (
       SELECT candidate.id, candidate.global_id, candidate.tracking_number
       FROM operations_shipments candidate
       WHERE candidate.organization_id = source_order.organization_id
         AND candidate.order_id = source_order.id
       ORDER BY candidate.shipped_at DESC, candidate.id DESC
       LIMIT 1
     ) shipment ON true
     JOIN operations_print_artifacts artifact
       ON artifact.organization_id = source_order.organization_id
      AND artifact.source_shipment_id = shipment.id
      AND artifact.document_type = 'packing_slip'
     JOIN operations_commerce_fulfillment_exports fulfillment_export
       ON fulfillment_export.organization_id = source_order.organization_id
      AND fulfillment_export.shipment_id = shipment.id
     LEFT JOIN LATERAL (
       SELECT candidate.global_id
       FROM operations_print_jobs candidate
       WHERE candidate.organization_id = artifact.organization_id
         AND candidate.artifact_id = artifact.id
       ORDER BY candidate.created_at DESC, candidate.id DESC
       LIMIT 1
     ) print_job ON true
     WHERE source_order.organization_id = $1::uuid
       AND source_order.global_id = $2
       AND ($3::text IS NULL OR fulfillment_export.global_id = $3)
     ORDER BY fulfillment_export.requested_at DESC, fulfillment_export.id DESC
     LIMIT 1`,
    [organizationId, orderGlobalId, receiptCommerceExportGlobalId],
  )
  const row = result.rows[0]
  if (!row || row.order_status !== 'shipped') {
    throw new OperationsRequestError(
      'OPERATIONS_COMMAND_RECEIPT_INVALID',
      'Completed shipment result is unavailable',
      409,
    )
  }
  const exportState = ['succeeded', 'unsupported', 'failed']
    .includes(row.export_state)
    ? row.export_state as OperationsShipmentCommandResult['commerceExportState']
    : 'failed'
  return {
    orderGlobalId: row.order_global_id,
    orderStatus: 'shipped',
    rowVersion: Number(row.row_version),
    shipmentGlobalId: row.shipment_global_id,
    trackingNumber: row.tracking_number,
    packingSlipArtifactGlobalId: row.artifact_global_id,
    commerceExportGlobalId: row.export_global_id,
    commerceExportState: exportState,
    customerNotification: commerceExportCustomerNotificationDecision(
      row.export_payload_snapshot,
      row.export_provider,
    ),
    replayed: true,
    printJobGlobalId: row.print_job_global_id,
    printWarning: exportState === 'failed' && row.export_state !== 'failed'
      ? 'Commerce fulfillment export has not reached a terminal state.'
      : null,
  }
}

function canonicalProofLines(proof: MockOperationsProofInput): MockOperationsProofLineInput[] {
  const suppliedLines = proof.lines?.length
    ? proof.lines
    : [{
        productGlobalId: proof.productGlobalId || '',
        quantity: Number(proof.quantity),
        openingQuantity: Number(proof.openingQuantity),
      }]
  if (suppliedLines.length < 1 || suppliedLines.length > 25) {
    throw new OperationsRequestError(
      'OPERATIONS_ORDER_LINES_INVALID',
      'A proof order must contain from 1 to 25 product lines',
    )
  }
  const seen = new Set<string>()
  return suppliedLines.map((line) => {
    const productGlobalId = String(line.productGlobalId || '').trim()
    if (!/^gp(?:[0-9]{7}|[0-9a-v]{12})$/.test(productGlobalId)) {
      throw new OperationsRequestError('OPERATIONS_PRODUCT_NOT_FOUND', 'Select an active CRM product from the active workspace', 404)
    }
    if (seen.has(productGlobalId)) {
      throw new OperationsRequestError('OPERATIONS_ORDER_LINES_INVALID', 'Each product may appear only once on an order')
    }
    seen.add(productGlobalId)
    const quantity = assertPositiveQuantity(line.quantity)
    const openingQuantity = assertPositiveQuantity(line.openingQuantity)
    if (!Number.isSafeInteger(quantity) || quantity > 1_000
      || !Number.isSafeInteger(openingQuantity) || openingQuantity > 100_000) {
      throw new OperationsRequestError('OPERATIONS_ORDER_LINES_INVALID', 'Order quantities are outside the supported range')
    }
    return { productGlobalId, quantity, openingQuantity }
  })
}

export async function runMockOperationsProofFromPostgres(input: {
  organizationId: string
  actorEmail: string
  proof: MockOperationsProofInput
}): Promise<MockOperationsProofResult> {
  const organizationId = requireOrganizationId(input.organizationId)
  const actorEmail = String(input.actorEmail || '').trim().toLowerCase()
  if (!actorEmail) throw new OperationsRequestError('OPERATIONS_ACTOR_REQUIRED', 'A signed-in user is required', 401)
  const proofLines = canonicalProofLines(input.proof)
  const executionMode = input.proof.executionMode === 'shipped' ? 'shipped' : 'planned'
  const canonicalProof: MockOperationsProofInput = {
    customerGlobalId: input.proof.customerGlobalId,
    externalOrderId: input.proof.externalOrderId,
    orderNumber: input.proof.orderNumber,
    lines: proofLines,
    requestedDeliveryAt: input.proof.requestedDeliveryAt,
    shipTo: input.proof.shipTo,
    executionMode,
  }

  const command = await prepareCommandReceipt({
    organizationId,
    commandType: 'prepare_mock_operations_order',
    idempotencyKey: `mock-commerce:${input.proof.externalOrderId}:${executionMode}`,
    requestHash: commandRequestHash(canonicalProof),
    actorEmail,
  })
  if (command.completed) {
    return completedProofResult(organizationId, command.receipt)
  }

  try {
    return await withTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(
      client,
      `operations:proof-order:${organizationId}:${input.proof.externalOrderId}`,
    )
    const activation = await resolveActivation(client, organizationId)
    if (activation.state !== 'shadow') {
      throw new OperationsRequestError(
        'OPERATIONS_PROOF_REQUIRES_SHADOW',
        'Mock proof orders are available only while Operations is in shadow mode',
        409,
      )
    }
    const pipeline = {
      id: activation.data_pipeline_id,
      name: activation.pipeline_name,
      owner_email: activation.pipeline_owner_email,
    }
    const customer = await resolveCustomer(client, pipeline.id, input.proof.customerGlobalId)
    const products = new Map<string, ProductRow>()
    for (const proofLine of proofLines) {
      products.set(
        proofLine.productGlobalId,
        await resolveProduct(client, pipeline.id, proofLine.productGlobalId),
      )
    }
    const packagingByProductId = await readDefaultProductPackagingWithClient(client, {
      organizationId,
      pipelineId: pipeline.id,
      productIds: [...products.values()].map((product) => product.id),
    })
    const totalQuantity = proofLines.reduce((sum, line) => sum + line.quantity, 0)
    const currency = assertCurrency('USD')
    const requestedDeliveryAt = new Date(input.proof.requestedDeliveryAt)
    if (Number.isNaN(requestedDeliveryAt.getTime())) {
      throw new OperationsRequestError('OPERATIONS_DATE_INVALID', 'Requested delivery date is invalid')
    }
    const commerce = new MockCommerceAdapter()
    const carrier = new MockCarrierAdapter()
    const printerAdapter = new MockPrintAdapter()
    const proofLineByExternalId = new Map(proofLines.map((proofLine, index) => [
      `${input.proof.externalOrderId}:${index + 1}`,
      proofLine,
    ]))
    const normalized: CommerceOrderInput = commerce.normalizeOrder({
      provider: 'mock-commerce',
      externalOrderId: input.proof.externalOrderId,
      orderNumber: input.proof.orderNumber,
      customerGlobalId: customer.reference_code,
      currency,
      requestedDeliveryAt: requestedDeliveryAt.toISOString(),
      shipTo: input.proof.shipTo,
      lines: proofLines.map((proofLine, index) => {
        const product = products.get(proofLine.productGlobalId)
        if (!product) throw new Error('OPERATIONS_PRODUCT_RESOLUTION_MISSING')
        const packaging = packagingByProductId.get(product.id)
        return {
          externalLineId: `${input.proof.externalOrderId}:${index + 1}`,
          channelSku: product.sku || product.reference_code,
          description: product.name,
          quantity: proofLine.quantity,
          unitPriceMinor: moneyMinorFromDecimal(product.price),
          weightGrams: packaging?.weightGrams || 350,
          unitsPerPackage: packaging?.unitsPerPackage || 1,
          dimensionsMm: packaging
            ? { length: packaging.lengthMm, width: packaging.widthMm, height: packaging.heightMm }
            : { length: 220, width: 160, height: 90 },
        }
      }),
      sourcePayload: {
        proof: true,
        lineCount: proofLines.length,
        packaging: [...products.values()].map((product) => {
          const packaging = packagingByProductId.get(product.id)
          return {
            productGlobalId: product.reference_code,
            profileGlobalId: packaging?.globalId || null,
            source: packaging ? 'team_managed_profile' : 'conservative_fallback',
          }
        }),
      },
    })
    const configuration = await ensureProofConfiguration(client, {
      organizationId,
      pipeline,
      customer,
      products: [...products.values()],
      actorEmail,
      currency,
    })

    const duplicateResult = await client.query<OrderIdentityRow>(
      `SELECT orders.id::text, orders.global_id, orders.status,
              shipment.tracking_number
       FROM operations_orders orders
       LEFT JOIN LATERAL (
         SELECT tracking_number FROM operations_shipments candidate
         WHERE candidate.organization_id = orders.organization_id
           AND candidate.order_id = orders.id
         ORDER BY candidate.shipped_at DESC LIMIT 1
       ) shipment ON true
       WHERE orders.organization_id = $1::uuid
         AND orders.integration_account_id = $2::uuid
         AND orders.external_order_id = $3
       LIMIT 1`,
      [organizationId, configuration.integration.id, normalized.externalOrderId],
    )
    const duplicate = duplicateResult.rows[0]
    if (duplicate) {
      const result: MockOperationsProofResult = {
        orderGlobalId: duplicate.global_id,
        orderStatus: duplicate.status,
        duplicate: true,
        trackingNumber: duplicate.tracking_number || null,
        steps: proofSteps(duplicate.status),
      }
      await completeCommandReceipt(client, command.receipt.id, duplicate.global_id, result)
      return result
    }

    const correlationId = command.receipt.correlation_id
    const merchandiseTotalMinor = normalized.lines.reduce((sum, line) => (
      sum + integerMinor(line.unitPriceMinor) * BigInt(Math.ceil(line.quantity))
    ), BigInt(0))
    const orderResult = await client.query<OrderIdentityRow>(
      `INSERT INTO operations_orders (
         organization_id, pipeline_id, customer_id, integration_account_id,
         contract_version_id, source_provider, external_order_id, order_number,
         status, currency, merchandise_total_minor, requested_delivery_at,
         ship_to, source_payload, created_by, updated_by
       ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
         $6, $7, $8, 'imported', $9, $10, $11::timestamptz,
         $12::jsonb, $13::jsonb, $14, $14)
       RETURNING id::text, global_id, status`,
      [
        organizationId,
        pipeline.id,
        customer.id,
        configuration.integration.id,
        configuration.contractVersion.id,
        normalized.provider,
        normalized.externalOrderId,
        normalized.orderNumber,
        normalized.currency,
        merchandiseTotalMinor.toString(),
        normalized.requestedDeliveryAt,
        JSON.stringify(normalized.shipTo),
        JSON.stringify(normalized.sourcePayload || {}),
        actorEmail,
      ],
    )
    const order = orderResult.rows[0]
    await client.query(
      `INSERT INTO operations_external_identifiers (
         organization_id, integration_account_id, entity_type, entity_global_id, external_id
       ) VALUES ($1::uuid, $2::uuid, 'operations.order', $3, $4)`,
      [organizationId, configuration.integration.id, order.global_id, normalized.externalOrderId],
    )
    await appendDomainEvent(client, {
      organizationId,
      aggregateType: 'operations.order',
      aggregateId: order.id,
      aggregateGlobalId: order.global_id,
      eventType: 'operations.order.imported',
      actorEmail,
      correlationId,
      idempotencyKey: `${order.global_id}:imported`,
      payload: {
        provider: normalized.provider,
        externalOrderId: normalized.externalOrderId,
        customerGlobalId: customer.reference_code,
        mock: true,
      },
    })

    const fulfillmentLines: Array<{
      orderLine: OrderLineIdentityRow
      product: ProductRow
      position: PositionRow
      quantity: number
      openingQuantity: number
    }> = []
    for (const line of normalized.lines) {
      const proofLine = proofLineByExternalId.get(line.externalLineId)
      if (!proofLine) throw new Error('OPERATIONS_ORDER_LINE_RESOLUTION_MISSING')
      const product = products.get(proofLine.productGlobalId)
      if (!product) throw new Error('OPERATIONS_PRODUCT_RESOLUTION_MISSING')
      const position = configuration.positions.get(product.id)
      if (!position) throw new Error('OPERATIONS_INVENTORY_POSITION_MISSING')
      const orderLineResult = await client.query<OrderLineIdentityRow>(
        `INSERT INTO operations_order_lines (
           organization_id, order_id, pipeline_id, product_id, external_line_id,
           channel_sku, description, quantity, unit_price_minor, weight_grams, dimensions_mm
         ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5,
           $6, $7, $8, $9, $10, $11::jsonb)
         RETURNING id::text, global_id, external_line_id`,
        [
          organizationId,
          order.id,
          pipeline.id,
          product.id,
          line.externalLineId,
          line.channelSku,
          line.description,
          line.quantity,
          line.unitPriceMinor,
          line.weightGrams,
          JSON.stringify(line.dimensionsMm),
        ],
      )
      fulfillmentLines.push({
        orderLine: orderLineResult.rows[0],
        product,
        position,
        quantity: proofLine.quantity,
        openingQuantity: proofLine.openingQuantity,
      })
    }
    await transitionOrder(client, {
      organizationId,
      order,
      status: 'validated',
      eventType: 'operations.order.validated',
      actorEmail,
      correlationId,
      eventKey: 'validated',
      payload: {
        productGlobalIds: fulfillmentLines.map((item) => item.product.reference_code),
        lineCount: fulfillmentLines.length,
        mapping: 'resolved',
        packageProfileGlobalIds: [...packagingByProductId.values()].map((profile) => profile.globalId),
        packageFallbackProductGlobalIds: fulfillmentLines
          .filter((item) => !packagingByProductId.has(item.product.id))
          .map((item) => item.product.reference_code),
      },
    })

    const availableByProductId = new Map(fulfillmentLines.map((item) => [
      item.product.id,
      Math.max(numberValue(item.position.on_hand_quantity), item.openingQuantity)
        - numberValue(item.position.reserved_quantity),
    ]))
    const optimizer = new DeterministicFulfillmentOptimizer()
    const optimization = await optimizer.plan({
      orderGlobalId: order.global_id,
      demand: fulfillmentLines.map((item) => ({ productId: item.product.id, quantity: item.quantity })),
      candidates: [{
        warehouseId: configuration.warehouse.id,
        warehouseGlobalId: configuration.warehouse.global_id,
        warehouseName: configuration.warehouse.name,
        availableByProductId,
        handlingCostMinor: BigInt(0),
      }],
      allowMultiWarehouse: false,
    })
    if (optimization.solverStatus === 'infeasible' || !optimization.warehouseIds[0]) {
      throw new OperationsRequestError(
        'OPERATIONS_FULFILLMENT_INFEASIBLE',
        optimization.fallbackReason || 'No fulfillment plan can satisfy this order',
        409,
      )
    }

    const packages = cartonizeSinglePackage(normalized.lines)
    const ratedAt = new Date().toISOString()
    const rawRates = await carrier.rate({
      origin: address(configuration.warehouse.address),
      destination: normalized.shipTo,
      packages,
      requestedDeliveryAt: normalized.requestedDeliveryAt,
      ratedAt,
    })
    const pricedRates = rawRates.map((rate) => applyFreightPricing(rate, configuration.directives))
    let selectedRate
    try {
      selectedRate = selectPromiseRate(pricedRates)
    } catch {
      throw new OperationsRequestError(
        'OPERATIONS_PROMISE_UNAVAILABLE',
        'No carrier service meets the requested delivery promise',
        409,
      )
    }
    const pricing = priceContract({
      directives: configuration.directives,
      totalUnits: totalQuantity,
      freightCostMinor: selectedRate.internalCostMinor,
      packageCount: packages.length,
    })
    const expectedMarginMinor = pricing.revenueMinor - selectedRate.internalCostMinor
    await transitionOrder(client, {
      organizationId,
      order,
      status: 'promised',
      eventType: 'operations.order.promised',
      actorEmail,
      correlationId,
      eventKey: 'promised',
      promisedDeliveryAt: selectedRate.estimatedDeliveryAt,
      payload: {
        carrier: selectedRate.carrier,
        serviceCode: selectedRate.serviceCode,
        deliveryAt: selectedRate.estimatedDeliveryAt,
      },
    })

    const reservedLines: Array<(typeof fulfillmentLines)[number] & { reservation: IdRow }> = []
    for (const item of fulfillmentLines) {
      const reservation = await prepareAndReserveInventory(client, {
        organizationId,
        order,
        orderLine: item.orderLine,
        position: item.position,
        quantity: item.quantity,
        openingQuantity: item.openingQuantity,
        actorEmail,
      })
      reservedLines.push({ ...item, reservation })
    }
    await transitionOrder(client, {
      organizationId,
      order,
      status: 'reserved',
      eventType: 'operations.inventory.reserved',
      actorEmail,
      correlationId,
      eventKey: 'reserved',
      payload: {
        reservations: reservedLines.map((item) => ({
          reservationGlobalId: item.reservation.global_id,
          inventoryPositionGlobalId: item.position.global_id,
          productGlobalId: item.product.reference_code,
          quantity: item.quantity,
        })),
        totalQuantity,
      },
    })

    const planResult = await client.query<IdRow>(
      `INSERT INTO operations_fulfillment_plans (
         organization_id, order_id, warehouse_id, version_number, status,
         method, solver_status, fallback_reason, estimated_cost_minor,
         estimated_revenue_minor, estimated_margin_minor, promised_delivery_at,
         explanation, created_by
       ) VALUES ($1::uuid, $2::uuid, $3::uuid, 1, 'planned',
         $4, $5, $6, $7, $8, $9, $10::timestamptz, $11::jsonb, $12)
       RETURNING id::text, global_id`,
      [
        organizationId,
        order.id,
        configuration.warehouse.id,
        optimization.method,
        optimization.solverStatus,
        optimization.fallbackReason,
        selectedRate.internalCostMinor.toString(),
        pricing.revenueMinor.toString(),
        expectedMarginMinor.toString(),
        selectedRate.estimatedDeliveryAt,
        JSON.stringify(optimization.explanation),
        actorEmail,
      ],
    )
    const plan = planResult.rows[0]
    const allocatedLines: Array<(typeof reservedLines)[number] & { allocation: IdRow }> = []
    for (const item of reservedLines) {
      const allocationResult = await client.query<IdRow>(
        `INSERT INTO operations_fulfillment_allocations (
           organization_id, plan_id, order_line_id, reservation_id, position_id, quantity
         ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6)
         RETURNING id::text, global_id`,
        [
          organizationId,
          plan.id,
          item.orderLine.id,
          item.reservation.id,
          item.position.id,
          item.quantity,
        ],
      )
      allocatedLines.push({ ...item, allocation: allocationResult.rows[0] })
    }
    await client.query(
      `INSERT INTO operations_carton_plans (
         organization_id, plan_id, algorithm, package_count, total_weight_grams, packages
       ) VALUES ($1::uuid, $2::uuid, 'deterministic_single_carton', $3, $4, $5::jsonb)`,
      [
        organizationId,
        plan.id,
        packages.length,
        packages.reduce((sum, item) => sum + item.weightGrams, 0),
        JSON.stringify(packages),
      ],
    )

    let selectedRateIdentity: IdRow | null = null
    for (const rate of pricedRates) {
      const selected = rate.carrier === selectedRate.carrier && rate.serviceCode === selectedRate.serviceCode
      const rateResult = await client.query<IdRow>(
        `INSERT INTO operations_carrier_rates (
           organization_id, plan_id, carrier, service_code, service_name,
           internal_cost_minor, customer_charge_minor, transit_days,
           estimated_delivery_at, meets_promise, selected, quote_snapshot
         ) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8,
           $9::timestamptz, $10, $11, $12::jsonb)
         RETURNING id::text, global_id`,
        [
          organizationId,
          plan.id,
          rate.carrier,
          rate.serviceCode,
          rate.serviceName,
          rate.internalCostMinor.toString(),
          rate.customerChargeMinor.toString(),
          rate.transitDays,
          rate.estimatedDeliveryAt,
          rate.meetsPromise,
          selected,
          JSON.stringify(rate.providerPayload),
        ],
      )
      if (selected) selectedRateIdentity = rateResult.rows[0]
    }
    if (!selectedRateIdentity) throw new Error('OPERATIONS_SELECTED_RATE_MISSING')

    const allocatedLineByExternalId = new Map(
      allocatedLines.map((item) => [item.orderLine.external_line_id, item]),
    )
    const packagedQuantityByExternalId = new Map<string, number>()
    const packageNumbers = new Set<number>()
    for (const packagePlan of packages) {
      if (packageNumbers.has(packagePlan.packageNumber)) {
        throw new OperationsRequestError(
          'OPERATIONS_CARTONIZATION_INVALID',
          'Cartonization returned a duplicate package number',
          409,
        )
      }
      packageNumbers.add(packagePlan.packageNumber)
      if (!packagePlan.contents.length) {
        throw new OperationsRequestError(
          'OPERATIONS_PACKAGE_CONTENTS_REQUIRED',
          'Every physical package must retain its exact order-line quantities',
          409,
        )
      }
      for (const content of packagePlan.contents) {
        const allocated = allocatedLineByExternalId.get(content.lineExternalId)
        if (!allocated) {
          throw new OperationsRequestError(
            'OPERATIONS_PACKAGE_CONTENTS_INVALID',
            'Cartonization returned an order line outside the fulfillment plan',
            409,
          )
        }
        const quantity = assertPositiveQuantity(content.quantity)
        packagedQuantityByExternalId.set(
          content.lineExternalId,
          (packagedQuantityByExternalId.get(content.lineExternalId) || 0)
            + quantity,
        )
      }
    }
    for (const item of allocatedLines) {
      if (
        packagedQuantityByExternalId.get(item.orderLine.external_line_id)
        !== item.quantity
      ) {
        throw new OperationsRequestError(
          'OPERATIONS_PACKAGE_CONTENTS_INCOMPLETE',
          'Package allocations must equal every fulfillment-plan line quantity',
          409,
        )
      }
    }

    const plannedPackages: IdRow[] = []
    for (const packagePlan of packages) {
      const packageResult = await client.query<IdRow>(
        `INSERT INTO operations_packages (
           organization_id, plan_id, package_number, length_mm, width_mm,
           height_mm, weight_grams, status
         ) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, 'planned')
         RETURNING id::text, global_id`,
        [
          organizationId,
          plan.id,
          packagePlan.packageNumber,
          packagePlan.dimensionsMm.length,
          packagePlan.dimensionsMm.width,
          packagePlan.dimensionsMm.height,
          packagePlan.weightGrams,
        ],
      )
      const plannedPackage = packageResult.rows[0]
      plannedPackages.push(plannedPackage)
      for (const content of packagePlan.contents) {
        const allocated = allocatedLineByExternalId.get(content.lineExternalId)
        if (!allocated) {
          throw new OperationsRequestError(
            'OPERATIONS_PACKAGE_CONTENTS_INVALID',
            'Cartonization returned an unresolved order line',
            409,
          )
        }
        await client.query(
          `INSERT INTO operations_package_contents (
             organization_id, plan_id, order_id, package_id,
             order_line_id, quantity, created_by
           ) VALUES (
             $1::uuid, $2::uuid, $3::uuid, $4::uuid,
             $5::uuid, $6, $7
           )`,
          [
            organizationId,
            plan.id,
            order.id,
            plannedPackage.id,
            allocated.orderLine.id,
            assertPositiveQuantity(content.quantity),
            actorEmail,
          ],
        )
      }
    }
    const packedPackage = plannedPackages[0]
    await transitionOrder(client, {
      organizationId,
      order,
      status: 'planned',
      eventType: 'operations.fulfillment.planned',
      actorEmail,
      correlationId,
      eventKey: 'planned',
      payload: {
        planGlobalId: plan.global_id,
        method: optimization.method,
        solverStatus: optimization.solverStatus,
        fallbackReason: optimization.fallbackReason,
      },
    })

    if (executionMode === 'planned') {
      await recordAuditEvent({
        actor: actorEmail,
        eventType: 'operations.proof_order.planned',
        aggregateType: 'operations.order',
        aggregateId: order.global_id,
        subject: normalized.orderNumber,
        organizationId,
        eventKey: `operations:proof-order:planned:${organizationId}:${normalized.externalOrderId}`,
        payload: {
          customerGlobalId: customer.reference_code,
          productGlobalIds: fulfillmentLines.map((item) => item.product.reference_code),
          lineCount: fulfillmentLines.length,
          totalQuantity,
          warehouseGlobalId: configuration.warehouse.global_id,
          planGlobalId: plan.global_id,
          mock: true,
        },
      }, client)
      const result: MockOperationsProofResult = {
        orderGlobalId: order.global_id,
        orderStatus: 'planned',
        duplicate: false,
        trackingNumber: null,
        steps: proofSteps('planned'),
      }
      await completeCommandReceipt(client, command.receipt.id, order.global_id, result)
      return result
    }
    if (plannedPackages.length !== 1) {
      throw new OperationsRequestError(
        'OPERATIONS_MULTI_PACKAGE_EXECUTION_UNSUPPORTED',
        'The optimizer produced multiple physical packages, but this proof command can execute labels and shipment confirmation only for one package. No proof records were committed; use planned mode to retain the carton plan and print its package-specific Pack Work Instructions.',
        409,
      )
    }

    const waveResult = await client.query<IdRow>(
      `INSERT INTO operations_waves (
         organization_id, warehouse_id, name, status, optimization_method,
         released_by, released_at
       ) VALUES ($1::uuid, $2::uuid, $3, 'released', $4, $5, now())
       RETURNING id::text, global_id`,
      [
        organizationId,
        configuration.warehouse.id,
        `Proof wave ${order.global_id}`,
        optimization.method,
        actorEmail,
      ],
    )
    const wave = waveResult.rows[0]
    await client.query(
      `UPDATE operations_fulfillment_plans
       SET status = 'released', updated_at = now()
       WHERE organization_id = $1::uuid AND id = $2::uuid`,
      [organizationId, plan.id],
    )
    await transitionOrder(client, {
      organizationId,
      order,
      status: 'released',
      eventType: 'operations.wave.released',
      actorEmail,
      correlationId,
      eventKey: 'wave-released',
      payload: { waveGlobalId: wave.global_id },
    })

    const pickLines: Array<(typeof allocatedLines)[number] & { pick: IdRow }> = []
    for (const [index, item] of allocatedLines.entries()) {
      const pickResult = await client.query<IdRow>(
        `INSERT INTO operations_pick_tasks (
           organization_id, wave_id, plan_id, allocation_id, from_location_id,
           quantity, sequence_number, status, assigned_to, assigned_at
         ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
           $6, $7, 'ready', $8, now())
         RETURNING id::text, global_id`,
        [
          organizationId,
          wave.id,
          plan.id,
          item.allocation.id,
          configuration.location.id,
          item.quantity,
          index + 1,
          actorEmail,
        ],
      )
      pickLines.push({ ...item, pick: pickResult.rows[0] })
    }
    await transitionOrder(client, {
      organizationId,
      order,
      status: 'picking',
      eventType: 'operations.pick.started',
      actorEmail,
      correlationId,
      eventKey: 'pick-started',
      payload: {
        pickGlobalIds: pickLines.map((item) => item.pick.global_id),
        totalQuantity,
      },
    })
    for (const item of pickLines) {
      await client.query(
        `UPDATE operations_pick_tasks
         SET status = 'picked', picked_quantity = quantity, picked_at = now(), updated_at = now()
         WHERE organization_id = $1::uuid AND id = $2::uuid`,
        [organizationId, item.pick.id],
      )
      await client.query(
        `INSERT INTO operations_inventory_ledger (
           organization_id, position_id, event_type, on_hand_delta, reserved_delta,
           on_hand_after, reserved_after, source_global_id, reason, idempotency_key, actor_email
         ) SELECT $1::uuid, position.id, 'pick', 0, 0,
           position.on_hand_quantity, position.reserved_quantity,
           $3, 'Picked mock proof order line', $4, $5
         FROM operations_inventory_positions position
         WHERE position.organization_id = $1::uuid AND position.id = $2::uuid`,
        [
          organizationId,
          item.position.id,
          item.orderLine.global_id,
          `${order.global_id}:${item.pick.global_id}:pick-ledger`,
          actorEmail,
        ],
      )
    }
    await appendDomainEvent(client, {
      organizationId,
      aggregateType: 'operations.order',
      aggregateId: order.id,
      aggregateGlobalId: order.global_id,
      eventType: 'operations.pick.completed',
      actorEmail,
      correlationId,
      idempotencyKey: `${order.global_id}:pick-completed`,
      payload: {
        picks: pickLines.map((item) => ({
          pickGlobalId: item.pick.global_id,
          orderLineGlobalId: item.orderLine.global_id,
          productGlobalId: item.product.reference_code,
          quantity: item.quantity,
        })),
        totalQuantity,
      },
    })

    await client.query(
      `UPDATE operations_packages
       SET status = 'packed', packed_by = $3, packed_at = now()
       WHERE organization_id = $1::uuid AND id = $2::uuid`,
      [organizationId, packedPackage.id, actorEmail],
    )
    await transitionOrder(client, {
      organizationId,
      order,
      status: 'packed',
      eventType: 'operations.package.packed',
      actorEmail,
      correlationId,
      eventKey: 'packed',
      payload: { packageGlobalId: packedPackage.global_id },
    })

    const labelIdempotencyKey = `${order.global_id}:label:1`
    const labelOutput = await carrier.createLabel({
      orderGlobalId: order.global_id,
      packageGlobalId: packedPackage.global_id,
      carrier: selectedRate.carrier,
      serviceCode: selectedRate.serviceCode,
      idempotencyKey: labelIdempotencyKey,
    })
    const labelResult = await client.query<IdRow>(
      `INSERT INTO operations_labels (
         organization_id, package_id, carrier_rate_id, carrier, service_code,
         tracking_number, format, label_payload, provider_label_id,
         idempotency_key, status
       ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9, $10, 'created')
       RETURNING id::text, global_id`,
      [
        organizationId,
        packedPackage.id,
        selectedRateIdentity.id,
        selectedRate.carrier,
        selectedRate.serviceCode,
        labelOutput.trackingNumber,
        labelOutput.format,
        labelOutput.payload,
        labelOutput.providerLabelId,
        labelIdempotencyKey,
      ],
    )
    const label = labelResult.rows[0]
    await client.query(
      `UPDATE operations_packages SET status = 'labeled'
       WHERE organization_id = $1::uuid AND id = $2::uuid`,
      [organizationId, packedPackage.id],
    )
    await appendDomainEvent(client, {
      organizationId,
      aggregateType: 'operations.order',
      aggregateId: order.id,
      aggregateGlobalId: order.global_id,
      eventType: 'operations.label.created',
      actorEmail,
      correlationId,
      idempotencyKey: `${order.global_id}:label-created`,
      payload: {
        labelGlobalId: label.global_id,
        trackingNumber: labelOutput.trackingNumber,
        carrier: selectedRate.carrier,
      },
    })

    const printIdempotencyKey = `${order.global_id}:print:1`
    const printOutput = await printerAdapter.print({
      printerGlobalId: configuration.printer.global_id,
      labelGlobalId: label.global_id,
      format: labelOutput.format,
      payload: labelOutput.payload,
      idempotencyKey: printIdempotencyKey,
    })
    const printJobResult = await client.query<IdRow>(
      `INSERT INTO operations_print_jobs (
         organization_id, label_id, printer_id, status, routing_reason,
         attempts, idempotency_key, printed_at, last_error
       ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, 1, $6,
         $7::timestamptz, $8)
       RETURNING id::text, global_id`,
      [
        organizationId,
        label.id,
        configuration.printer.id,
        printOutput.accepted ? 'printed' : 'failed',
        'Matched active ZPL printer route priority 1',
        printIdempotencyKey,
        printOutput.printedAt,
        printOutput.error,
      ],
    )
    const printJob = printJobResult.rows[0]
    if (!printOutput.accepted) {
      throw new OperationsRequestError('OPERATIONS_PRINT_FAILED', printOutput.error || 'Mock print failed', 502)
    }
    await appendDomainEvent(client, {
      organizationId,
      aggregateType: 'operations.order',
      aggregateId: order.id,
      aggregateGlobalId: order.global_id,
      eventType: 'operations.print.completed',
      actorEmail,
      correlationId,
      idempotencyKey: `${order.global_id}:print-completed`,
      payload: {
        printJobGlobalId: printJob.global_id,
        printerGlobalId: configuration.printer.global_id,
      },
    })

    const shipmentResult = await client.query<IdRow>(
      `INSERT INTO operations_shipments (
       organization_id, order_id, plan_id, package_id, label_id, status,
         tracking_number, shipped_at, quoted_carrier_cost_minor, confirmed_by
       ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
         'confirmed', $6, now(), $7, $8)
       RETURNING id::text, global_id`,
      [
        organizationId,
        order.id,
        plan.id,
        packedPackage.id,
        label.id,
        labelOutput.trackingNumber,
        selectedRate.internalCostMinor.toString(),
        actorEmail,
      ],
    )
    const shipment = shipmentResult.rows[0]
    for (const item of reservedLines) {
      await consumeReservedInventory(client, {
        organizationId,
        order,
        position: item.position,
        reservation: item.reservation,
        quantity: item.quantity,
        actorEmail,
      })
    }
    await client.query(
      `UPDATE operations_packages SET status = 'shipped'
       WHERE organization_id = $1::uuid AND id = $2::uuid`,
      [organizationId, packedPackage.id],
    )
    await client.query(
      `UPDATE operations_fulfillment_plans SET status = 'fulfilled', updated_at = now()
       WHERE organization_id = $1::uuid AND id = $2::uuid`,
      [organizationId, plan.id],
    )
    await client.query(
      `UPDATE operations_waves SET status = 'completed', completed_at = now()
       WHERE organization_id = $1::uuid AND id = $2::uuid`,
      [organizationId, wave.id],
    )
    await appendDomainEvent(client, {
      organizationId,
      aggregateType: 'operations.order',
      aggregateId: order.id,
      aggregateGlobalId: order.global_id,
      eventType: 'operations.shipment.confirmed',
      actorEmail,
      correlationId,
      idempotencyKey: `${order.global_id}:shipment-confirmed`,
      payload: {
        shipmentGlobalId: shipment.global_id,
        trackingNumber: labelOutput.trackingNumber,
        carrier: selectedRate.carrier,
      },
    })
    await appendDomainEvent(client, {
      organizationId,
      aggregateType: 'operations.order',
      aggregateId: order.id,
      aggregateGlobalId: order.global_id,
      eventType: 'operations.inventory.consumed',
      actorEmail,
      correlationId,
      idempotencyKey: `${order.global_id}:inventory-consumed`,
      payload: {
        positions: reservedLines.map((item) => ({
          inventoryPositionGlobalId: item.position.global_id,
          productGlobalId: item.product.reference_code,
          quantity: item.quantity,
        })),
        totalQuantity,
      },
    })

    const eventTypeForDirective: Record<PricingDirective['type'], string> = {
      fixed_order_fee: 'order',
      pick_fee: 'pick',
      tiered_pick_fee: 'pick',
      pack_fee: 'pack',
      freight_markup_percent: 'freight',
      storage_fee: 'storage',
      special_handling: 'special_handling',
    }
    for (const charge of pricing.charges.filter((item) => item.type !== 'freight_markup_percent')) {
      const eventType = eventTypeForDirective[charge.type as PricingDirective['type']]
      await client.query(
        `INSERT INTO operations_billable_events (
           organization_id, pipeline_id, customer_id, order_id, contract_version_id,
           directive_id, event_type, quantity, amount_minor, currency, status,
           source_global_id, idempotency_key
         ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
           $6::uuid, $7, $8, $9, $10, 'unbilled', $11, $12)`,
        [
          organizationId,
          pipeline.id,
          customer.id,
          order.id,
          configuration.contractVersion.id,
          charge.directiveId,
          eventType,
          charge.quantity,
          charge.amountMinor.toString(),
          currency,
          order.global_id,
          `${order.global_id}:billable:${charge.directiveGlobalId}`,
        ],
      )
    }
    const freightDirective = configuration.directives.find((item) => item.type === 'freight_markup_percent')
    await client.query(
      `INSERT INTO operations_billable_events (
         organization_id, pipeline_id, customer_id, order_id, contract_version_id,
         directive_id, event_type, quantity, amount_minor, currency, status,
         source_global_id, idempotency_key
       ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
         $6::uuid, 'freight', 1, $7, $8, 'unbilled', $9, $10)`,
      [
        organizationId,
        pipeline.id,
        customer.id,
        order.id,
        configuration.contractVersion.id,
        freightDirective?.id || null,
        pricing.freightChargeMinor.toString(),
        currency,
        shipment.global_id,
        `${order.global_id}:billable:freight`,
      ],
    )
    await appendDomainEvent(client, {
      organizationId,
      aggregateType: 'operations.order',
      aggregateId: order.id,
      aggregateGlobalId: order.global_id,
      eventType: 'operations.billing.accrued',
      actorEmail,
      correlationId,
      idempotencyKey: `${order.global_id}:billing-accrued`,
      payload: {
        currency,
        revenueMinor: pricing.revenueMinor.toString(),
        expectedMarginMinor: expectedMarginMinor.toString(),
      },
    })

    const fulfillmentIdempotencyKey = `${order.global_id}:channel-fulfillment`
    const fulfillment = await commerce.updateFulfillment({
      externalOrderId: normalized.externalOrderId,
      trackingNumber: labelOutput.trackingNumber,
      carrier: selectedRate.carrier,
      shippedAt: new Date().toISOString(),
      idempotencyKey: fulfillmentIdempotencyKey,
    })
    await client.query(
      `INSERT INTO sync_outbox (
         aggregate_type, aggregate_id, operation, target_system, payload,
         status, attempts, idempotency_key, created_at, available_at,
         processed_at, updated_at
       ) VALUES ('operations.order', $1, 'update_fulfillment', 'mock-commerce',
         $2::jsonb, 'succeeded', 1, $3, now(), now(), now(), now())
       ON CONFLICT (target_system, idempotency_key)
       WHERE idempotency_key IS NOT NULL
       DO NOTHING`,
      [
        order.global_id,
        JSON.stringify({
          mock: true,
          externalOrderId: normalized.externalOrderId,
          trackingNumber: labelOutput.trackingNumber,
          carrier: selectedRate.carrier,
          accepted: fulfillment.accepted,
          providerReference: fulfillment.providerReference,
        }),
        fulfillmentIdempotencyKey,
      ],
    )
    await appendDomainEvent(client, {
      organizationId,
      aggregateType: 'operations.order',
      aggregateId: order.id,
      aggregateGlobalId: order.global_id,
      eventType: 'operations.channel.fulfillment_succeeded',
      actorEmail,
      correlationId,
      idempotencyKey: `${order.global_id}:channel-fulfillment-succeeded`,
      payload: { providerReference: fulfillment.providerReference, mock: true },
    })
    await transitionOrder(client, {
      organizationId,
      order,
      status: 'shipped',
      eventType: 'operations.order.shipped',
      actorEmail,
      correlationId,
      eventKey: 'shipped',
      payload: { trackingNumber: labelOutput.trackingNumber, shipmentGlobalId: shipment.global_id },
    })
    await recordAuditEvent({
      actor: actorEmail,
      eventType: 'operations.proof_order.completed',
      aggregateType: 'operations.order',
      aggregateId: order.global_id,
      subject: normalized.orderNumber,
      organizationId,
      eventKey: `operations:proof-order:${organizationId}:${normalized.externalOrderId}`,
      payload: {
        customerGlobalId: customer.reference_code,
        productGlobalIds: fulfillmentLines.map((item) => item.product.reference_code),
        lineCount: fulfillmentLines.length,
        totalQuantity,
        warehouseGlobalId: configuration.warehouse.global_id,
        trackingNumber: labelOutput.trackingNumber,
        mock: true,
      },
    }, client)
    const result: MockOperationsProofResult = {
      orderGlobalId: order.global_id,
      orderStatus: 'shipped',
      duplicate: false,
      trackingNumber: labelOutput.trackingNumber,
      steps: [...MOCK_PROOF_STEPS],
    }
    await completeCommandReceipt(client, command.receipt.id, order.global_id, result)

    return result
    })
  } catch (error) {
    await failCommandReceipt(command.receipt.id, error)
    throw error
  }
}

function planningOrderEvidenceMismatch(): OperationsRequestError {
  return new OperationsRequestError(
    'OPERATIONS_ORDER_EVIDENCE_MISMATCH',
    'The order and cartonization evidence do not share one promoted commerce candidate',
    409,
  )
}

async function resolvePlanningOrderTarget(input: {
  organizationId: string
  requestedOrderGlobalId: string
  evidenceGlobalId: string
}): Promise<{ orderGlobalId: string; sourceProvider: string }> {
  const result = await query<{
    global_id: string
    source_provider: string
  }>(
    `SELECT source_order.global_id, source_order.source_provider
     FROM operations_orders source_order
     JOIN operations_commerce_order_candidates candidate
       ON candidate.organization_id = source_order.organization_id
      AND candidate.integration_account_id =
            source_order.integration_account_id
      AND candidate.canonical_order_id = source_order.id
     JOIN operations_cartonization_rate_evidence evidence
       ON evidence.organization_id = candidate.organization_id
      AND evidence.integration_account_id = candidate.integration_account_id
      AND evidence.order_candidate_id = candidate.id
     WHERE source_order.organization_id = $1::uuid
       AND source_order.global_id = $2
       AND evidence.global_id = $3
       AND candidate.workflow_state = 'promoted'
     LIMIT 1`,
    [
      input.organizationId,
      input.requestedOrderGlobalId,
      input.evidenceGlobalId,
    ],
  )
  const authoritativeOrderGlobalId = result.rows[0]?.global_id
  if (!authoritativeOrderGlobalId) {
    throw planningOrderEvidenceMismatch()
  }
  return {
    orderGlobalId: authoritativeOrderGlobalId,
    sourceProvider: String(result.rows[0]?.source_provider || '').trim(),
  }
}

type RetainedShopifyPlanningAuthority = {
  authorityHash: string
  snapshot: ShopifyOrderPlanningAuthoritySnapshot
}

function retainedShopifyPlanningAuthority(
  planSnapshot: Record<string, unknown>,
): RetainedShopifyPlanningAuthority {
  if (
    !Object.hasOwn(planSnapshot, 'shopifyOrderPlanningAuthority')
    || !Object.hasOwn(planSnapshot, 'shopifyOrderPlanningAuthorityHash')
  ) {
    throw new OperationsRequestError(
      'OPERATIONS_CARTONIZATION_SHOPIFY_AUTHORITY_REQUIRED',
      'Re-run cartonization to seal current Shopify order and fulfillment authority before planning.',
      409,
    )
  }
  const authorityHash = assertShopifyOrderPlanningAuthorityHash(
    planSnapshot.shopifyOrderPlanningAuthorityHash,
  )
  const snapshot = normalizeShopifyOrderPlanningAuthoritySnapshot(
    planSnapshot.shopifyOrderPlanningAuthority,
  )
  if (shopifyOrderPlanningAuthorityHash(snapshot) !== authorityHash) {
    throw new OperationsRequestError(
      'OPERATIONS_CARTONIZATION_SHOPIFY_AUTHORITY_CORRUPT',
      'The sealed Shopify planning authority no longer matches its retained hash. Re-run cartonization.',
      409,
    )
  }
  return { authorityHash, snapshot }
}

function exactShopifyPlanningAuthorityMatch(
  retained: RetainedShopifyPlanningAuthority,
  live: ShopifyOrderPlanningAuthorityEvidence,
) {
  const liveHash = assertShopifyOrderPlanningAuthorityHash(
    live.authorityHash,
  )
  const liveSnapshot = normalizeShopifyOrderPlanningAuthoritySnapshot(
    live.snapshot,
  )
  return (
    retained.authorityHash === liveHash
    && shopifyOrderPlanningAuthorityHash(liveSnapshot) === liveHash
    && canonicalJson(retained.snapshot) === canonicalJson(liveSnapshot)
  )
}

function shopifyPlanningAuthorityChanged(): OperationsRequestError {
  return new OperationsRequestError(
    'OPERATIONS_CARTONIZATION_SHOPIFY_AUTHORITY_STALE',
    'Shopify order or fulfillment authority changed after cartonization. Re-run cartonization and compare rates.',
    409,
  )
}

function normalizeShopifyPlanningError(error: unknown): unknown {
  if (error instanceof ShopifyOrderPlanningAuthorityError) {
    return new OperationsRequestError(error.code, error.message, error.status)
  }
  return error
}

export async function planOperationsOrderFromPostgres(input: {
  organizationId: string
  actorEmail: string
  orderGlobalId: string
  cartonizationEvidenceGlobalId: string
  expectedRowVersion: number
  reason: string
  idempotencyKey: string
}): Promise<OperationsPlanCommandResult> {
  const organizationId = requireOrganizationId(input.organizationId)
  const actorEmail = String(input.actorEmail || '').trim().toLowerCase()
  const requestedOrderGlobalId = String(input.orderGlobalId || '').trim()
  const evidenceGlobalId = String(
    input.cartonizationEvidenceGlobalId || '',
  ).trim()
  const reason = String(input.reason || '').trim()
  const idempotencyKey = String(input.idempotencyKey || '').trim()
  if (!actorEmail) {
    throw new OperationsRequestError(
      'OPERATIONS_ACTOR_REQUIRED',
      'A signed-in user is required',
      401,
    )
  }
  if (!/^gor(?:[0-9]{7}|[0-9a-v]{12})$/.test(requestedOrderGlobalId)) {
    throw new OperationsRequestError(
      'OPERATIONS_ORDER_INVALID',
      'Order is invalid',
    )
  }
  if (!/^gcte(?:[0-9]{7}|[0-9a-v]{12})$/.test(evidenceGlobalId)) {
    throw new OperationsRequestError(
      'OPERATIONS_CARTONIZATION_EVIDENCE_INVALID',
      'Cartonization evidence is invalid',
    )
  }
  if (
    !Number.isSafeInteger(input.expectedRowVersion)
    || input.expectedRowVersion < 0
  ) {
    throw new OperationsRequestError(
      'OPERATIONS_ORDER_VERSION_INVALID',
      'Order version is invalid',
    )
  }
  if (!reason || reason.length > 500) {
    throw new OperationsRequestError(
      'OPERATIONS_PLANNING_REASON_INVALID',
      'A planning reason is required',
    )
  }
  if (!/^[A-Za-z0-9._:-]{8,200}$/.test(idempotencyKey)) {
    throw new OperationsRequestError(
      'OPERATIONS_IDEMPOTENCY_KEY_INVALID',
      'A valid idempotency key is required',
    )
  }

  const planningTarget = await resolvePlanningOrderTarget({
    organizationId,
    requestedOrderGlobalId,
    evidenceGlobalId,
  })
  const { orderGlobalId } = planningTarget
  const evidence = await readCartonizationRateEvidenceByGlobalId({
    organizationId,
    evidenceGlobalId,
  })
  if (!evidence) {
    throw planningOrderEvidenceMismatch()
  }
  if (
    evidence.evidenceMode !== 'operational'
    || evidence.status === 'failed'
    || evidence.packages.length < 1
  ) {
    throw new OperationsRequestError(
      'OPERATIONS_CARTONIZATION_EVIDENCE_NOT_OPERATIONAL',
      'Only successful sealed operational cartonization evidence can become warehouse work',
      409,
    )
  }
  if (evidence.packages.some((item) => (
    item.planningMethod === 'sandbox_fixed_axis'
  ))) {
    throw new OperationsRequestError(
      'OPERATIONS_CARTONIZATION_SANDBOX_PACKAGE_FORBIDDEN',
      'Assumption-backed sandbox fixed-axis packages cannot become warehouse work',
      409,
    )
  }

  const command = await prepareCommandReceipt({
    organizationId,
    commandType: 'plan_operations_order',
    idempotencyKey,
    requestHash: commandRequestHash({
      orderGlobalId,
      cartonizationEvidenceGlobalId: evidenceGlobalId,
      expectedRowVersion: input.expectedRowVersion,
      reason,
    }),
    actorEmail,
    targetGlobalId: orderGlobalId,
  })
  if (command.completed) {
    return completedPlanCommandResult(command.receipt)
  }

  try {
    let liveShopifyPlanningAuthority:
      ShopifyOrderPlanningAuthorityEvidence | null = null
    if (planningTarget.sourceProvider === 'shopify') {
      const retainedAuthority = retainedShopifyPlanningAuthority(
        evidence.planSnapshot,
      )
      liveShopifyPlanningAuthority =
        await inspectShopifyOrderPlanningAuthority({
          organizationId,
          accountGlobalId: evidence.accountGlobalId,
          candidateGlobalId: evidence.candidateGlobalId,
          expectedCandidateRowVersion: evidence.candidateRowVersion,
          warehouseGlobalId: evidence.warehouse.globalId,
        })
      if (!exactShopifyPlanningAuthorityMatch(
        retainedAuthority,
        liveShopifyPlanningAuthority,
      )) {
        throw shopifyPlanningAuthorityChanged()
      }
    }
    return await withTransaction(async (client) => {
      await acquireTransactionAdvisoryLock(
        client,
        `operations:activation:${organizationId}`,
      )
      await acquireTransactionAdvisoryLock(
        client,
        `operations:order:${organizationId}:${orderGlobalId}`,
      )
      const activation = await resolveActivation(client, organizationId)
      if (!['shadow', 'active'].includes(activation.state)) {
        throw new OperationsRequestError(
          'OPERATIONS_EXECUTION_STATE_INVALID',
          'Set Operations to Shadow or Active before planning warehouse work',
          409,
        )
      }

      type PlanningOrderRow = OrderIdentityRow & {
        pipeline_id: string
        customer_id: string
        integration_account_id: string
        source_provider: string
        currency: string
        requested_delivery_at: Date | null
        source_payload: Record<string, unknown>
        candidate_id: string
        candidate_global_id: string
        candidate_row_version: string
        candidate_workflow_state: string
        candidate_source_hash: string
        account_global_id: string
        account_provider: string
        account_status: string
        account_credential_version: number
        account_external_account_id: string | null
        evidence_id: string
        evidence_candidate_source_hash: string
        evidence_mode: string
        evidence_status: string
        evidence_sealed_at: Date | null
        evidence_plan_snapshot: Record<string, unknown>
        evidence_inventory_sync_run_id: string | null
        warehouse_id: string
        warehouse_global_id: string
        warehouse_status: string
      }
      const orderResult = await client.query<PlanningOrderRow>(
        `SELECT
           orders.id::text,
           orders.global_id,
           orders.status,
           orders.row_version::text,
           orders.pipeline_id::text,
           orders.customer_id::text,
           orders.integration_account_id::text,
           orders.source_provider,
           orders.currency,
           orders.requested_delivery_at,
           orders.source_payload,
           candidate.id::text AS candidate_id,
           candidate.global_id AS candidate_global_id,
           candidate.row_version::text AS candidate_row_version,
           candidate.workflow_state AS candidate_workflow_state,
           candidate.source_hash AS candidate_source_hash,
           account.global_id AS account_global_id,
           account.provider AS account_provider,
           account.status AS account_status,
           account.commerce_credential_generation
             AS account_credential_version,
           account.external_account_id AS account_external_account_id,
           evidence.id::text AS evidence_id,
           evidence.candidate_source_hash
             AS evidence_candidate_source_hash,
           evidence.evidence_mode,
           evidence.status AS evidence_status,
           evidence.sealed_at AS evidence_sealed_at,
           evidence.plan_snapshot AS evidence_plan_snapshot,
           evidence.inventory_sync_run_id::text
             AS evidence_inventory_sync_run_id,
           warehouse.id::text AS warehouse_id,
           warehouse.global_id AS warehouse_global_id,
           warehouse.status AS warehouse_status
         FROM operations_orders orders
         JOIN operations_commerce_order_candidates candidate
           ON candidate.organization_id = orders.organization_id
          AND candidate.integration_account_id =
                orders.integration_account_id
          AND candidate.canonical_order_id = orders.id
         JOIN operations_integration_accounts account
           ON account.organization_id = candidate.organization_id
          AND account.id = candidate.integration_account_id
         JOIN operations_cartonization_rate_evidence evidence
           ON evidence.organization_id = candidate.organization_id
          AND evidence.integration_account_id =
                candidate.integration_account_id
          AND evidence.order_candidate_id = candidate.id
          AND evidence.global_id = $3
         JOIN operations_warehouses warehouse
           ON warehouse.organization_id = evidence.organization_id
          AND warehouse.id = evidence.warehouse_id
         WHERE orders.organization_id = $1::uuid
           AND orders.global_id = $2
         FOR UPDATE OF orders, candidate, account, evidence, warehouse`,
        [organizationId, orderGlobalId, evidenceGlobalId],
      )
      const order = orderResult.rows[0]
      if (!order || order.row_version === undefined) {
        throw planningOrderEvidenceMismatch()
      }
      if (Number(order.row_version) !== input.expectedRowVersion) {
        throw new OperationsRequestError(
          'OPERATIONS_ORDER_VERSION_CONFLICT',
          'This order changed after it was opened. Refresh it before planning warehouse work.',
          409,
        )
      }
      await requireCurrentCommerceOrderRevision(client, {
        organizationId,
        orderId: order.id,
        operation: 'plan',
      })
      if (order.status !== 'imported') {
        throw new OperationsRequestError(
          'OPERATIONS_ORDER_TRANSITION_INVALID',
          `Order cannot be planned from ${order.status}`,
          409,
        )
      }
      if (
        order.candidate_workflow_state !== 'promoted'
        || order.candidate_global_id !== evidence.candidateGlobalId
        || Number(order.candidate_row_version)
          !== evidence.candidateRowVersion
        || order.candidate_source_hash !== evidence.candidateSourceHash
        || order.account_global_id !== evidence.accountGlobalId
        || order.evidence_candidate_source_hash
          !== evidence.candidateSourceHash
        || order.evidence_mode !== 'operational'
        || order.evidence_status === 'failed'
        || !order.evidence_sealed_at
        || order.warehouse_status !== 'active'
        || order.warehouse_global_id !== evidence.warehouse.globalId
      ) {
        throw new OperationsRequestError(
          'OPERATIONS_CARTONIZATION_EVIDENCE_STALE',
          'Cartonization evidence is no longer the sealed operational version for this order and warehouse',
          409,
        )
      }
      if (order.source_provider === 'shopify') {
        if (!liveShopifyPlanningAuthority) {
          throw new OperationsRequestError(
            'OPERATIONS_CARTONIZATION_SHOPIFY_AUTHORITY_REQUIRED',
            'Current Shopify order authority is required before planning.',
            409,
          )
        }
        const lockedAuthority = retainedShopifyPlanningAuthority(
          order.evidence_plan_snapshot,
        )
        type LockedShopifyAuthorityRow = {
          credential_version: number
          credential_external_account_id: string
          credential_verification_status: string
          mapping_global_id: string
          mapping_row_version: string
          mapping_external_location_id: string
          mapping_warehouse_id: string
        }
        const lockedShopifyAuthority =
          await client.query<LockedShopifyAuthorityRow>(
            `SELECT
               credential.credential_version,
               credential.external_account_id
                 AS credential_external_account_id,
               credential.verification_status
                 AS credential_verification_status,
               mapping.global_id AS mapping_global_id,
               mapping.row_version::text AS mapping_row_version,
               mapping.external_location_id
                 AS mapping_external_location_id,
               mapping.warehouse_id::text AS mapping_warehouse_id
             FROM operations_commerce_credentials credential
             JOIN operations_commerce_inventory_location_mappings mapping
               ON mapping.organization_id = credential.organization_id
              AND mapping.integration_account_id =
                    credential.integration_account_id
             WHERE credential.organization_id = $1::uuid
               AND credential.integration_account_id = $2::uuid
               AND mapping.warehouse_id = $3::uuid
               AND mapping.active = true
             FOR UPDATE OF credential, mapping`,
            [
              organizationId,
              order.integration_account_id,
              order.warehouse_id,
            ],
          )
        const lockedProvider = lockedShopifyAuthority.rows[0]
        const sealedSnapshot = lockedAuthority.snapshot
        const liveSnapshot =
          normalizeShopifyOrderPlanningAuthoritySnapshot(
            liveShopifyPlanningAuthority.snapshot,
          )
        if (
          lockedShopifyAuthority.rows.length !== 1
          || !lockedProvider
          || order.candidate_global_id
            !== sealedSnapshot.candidate.globalId
          || order.candidate_global_id
            !== liveSnapshot.candidate.globalId
          || Number(order.candidate_row_version)
            !== sealedSnapshot.candidate.rowVersion
          || Number(order.candidate_row_version)
            !== liveSnapshot.candidate.rowVersion
          || order.candidate_source_hash
            !== sealedSnapshot.candidate.sourceHash
          || order.candidate_source_hash
            !== liveSnapshot.candidate.sourceHash
          || order.account_global_id !== sealedSnapshot.accountGlobalId
          || order.account_global_id !== liveSnapshot.accountGlobalId
          || order.account_provider !== 'shopify'
          || order.account_status !== 'active'
          || order.account_credential_version
            !== sealedSnapshot.credentialVersion
          || order.account_credential_version
            !== liveSnapshot.credentialVersion
          || order.account_external_account_id !== sealedSnapshot.shopId
          || order.account_external_account_id !== liveSnapshot.shopId
          || lockedProvider.credential_version
            !== sealedSnapshot.credentialVersion
          || lockedProvider.credential_version
            !== liveSnapshot.credentialVersion
          || lockedProvider.credential_external_account_id
            !== sealedSnapshot.shopId
          || lockedProvider.credential_external_account_id
            !== liveSnapshot.shopId
          || lockedProvider.credential_verification_status !== 'verified'
          || order.warehouse_global_id
            !== sealedSnapshot.warehouse.globalId
          || order.warehouse_global_id
            !== liveSnapshot.warehouse.globalId
          || lockedProvider.mapping_global_id
            !== sealedSnapshot.warehouse.locationMappingGlobalId
          || lockedProvider.mapping_global_id
            !== liveSnapshot.warehouse.locationMappingGlobalId
          || Number(lockedProvider.mapping_row_version)
            !== sealedSnapshot.warehouse.locationMappingRowVersion
          || Number(lockedProvider.mapping_row_version)
            !== liveSnapshot.warehouse.locationMappingRowVersion
          || lockedProvider.mapping_external_location_id
            !== sealedSnapshot.warehouse.shopifyLocationId
          || lockedProvider.mapping_external_location_id
            !== liveSnapshot.warehouse.shopifyLocationId
          || lockedProvider.mapping_warehouse_id !== order.warehouse_id
        ) {
          throw shopifyPlanningAuthorityChanged()
        }
        if (!exactShopifyPlanningAuthorityMatch(
          lockedAuthority,
          liveShopifyPlanningAuthority,
        )) {
          throw shopifyPlanningAuthorityChanged()
        }
      } else if (liveShopifyPlanningAuthority) {
        throw new OperationsRequestError(
          'OPERATIONS_CARTONIZATION_SHOPIFY_AUTHORITY_MISMATCH',
          'Shopify planning authority cannot be applied to a non-Shopify order.',
          409,
        )
      }
      const carrierReadEnvironment = String(
        order.evidence_plan_snapshot?.carrierReadEnvironment || '',
      ).trim().toLowerCase()
      if (!['sandbox', 'production'].includes(carrierReadEnvironment)) {
        throw new OperationsRequestError(
          'OPERATIONS_CARTONIZATION_RATE_ENVIRONMENT_INVALID',
          'Cartonization evidence does not identify a supported carrier-read environment',
          409,
        )
      }
      if (
        activation.state === 'active'
        && carrierReadEnvironment !== 'production'
      ) {
        throw new OperationsRequestError(
          'OPERATIONS_ACTIVE_RATE_EVIDENCE_REQUIRES_PRODUCTION',
          'Active warehouse planning requires production carrier-read evidence. Use Shadow for sandbox carrier estimates.',
          409,
        )
      }

      const existingPlan = await client.query<{ global_id: string }>(
        `SELECT global_id
         FROM operations_fulfillment_plans
         WHERE organization_id = $1::uuid
           AND (
             order_id = $2::uuid
             OR cartonization_evidence_id = $3::uuid
           )
         LIMIT 1
         FOR UPDATE`,
        [organizationId, order.id, order.evidence_id],
      )
      if (existingPlan.rows[0]) {
        throw new OperationsRequestError(
          'OPERATIONS_FULFILLMENT_PLAN_EXISTS',
          `Order already has fulfillment plan ${existingPlan.rows[0].global_id}`,
          409,
        )
      }

      type PlanningPackagingMaterialRow = {
        package_key: string
        planning_method: string
        material_id: string
        material_global_id: string
      }
      const lockedPackagingMaterials =
        await client.query<PlanningPackagingMaterialRow>(
         `SELECT
           package.package_key,
           package.planning_method,
           material.id::text AS material_id,
           material.global_id AS material_global_id
         FROM operations_cartonization_rate_evidence_packages package
         JOIN operations_packaging_materials material
           ON material.organization_id = package.organization_id
          AND material.id = package.packaging_material_id
         WHERE package.organization_id = $1::uuid
           AND package.evidence_id = $2::uuid
         ORDER BY material.id
         FOR UPDATE OF material`,
        [organizationId, order.evidence_id],
      )
      if (
        lockedPackagingMaterials.rows.length !== evidence.packages.length
      ) {
        throw new OperationsRequestError(
          'OPERATIONS_CARTONIZATION_PACKAGING_STALE',
          'Sealed packaging-material evidence is incomplete. Re-run the plan.',
          409,
        )
      }
      if (lockedPackagingMaterials.rows.some((item) => (
        item.planning_method === 'sandbox_fixed_axis'
      ))) {
        throw new OperationsRequestError(
          'OPERATIONS_CARTONIZATION_SANDBOX_PACKAGE_FORBIDDEN',
          'Assumption-backed sandbox fixed-axis packages cannot become warehouse work',
          409,
        )
      }
      const expectedOrToolsProfiles = evidence.packages.flatMap(
        (packageEvidence) => {
          if (packageEvidence.planningMethod !== 'or_tools') {
            if (packageEvidence.orToolsProfiles.length !== 0) {
              throw new OperationsRequestError(
                'OPERATIONS_CARTONIZATION_PROFILE_EVIDENCE_INVALID',
                'A non-OR-Tools package retained unexpected geometry profile evidence',
                409,
              )
            }
            return []
          }
          if (
            packageEvidence.orToolsProfiles.length < 1
            || packageEvidence.orToolsProfiles.length
              !== packageEvidence.allocations.length
          ) {
            throw new OperationsRequestError(
              'OPERATIONS_CARTONIZATION_PROFILE_EVIDENCE_INCOMPLETE',
              'Sealed OR-Tools packages require one exact product profile edge per allocation line. Re-run the plan.',
              409,
            )
          }
          return packageEvidence.orToolsProfiles.map((profile) => ({
            packageKey: packageEvidence.packageKey,
            ...profile,
          }))
        },
      )
      type PlanningProfileEvidenceRow = {
        package_key: string
        line_global_id: string
        product_global_id: string
        input_profile_version_global_id: string
        input_profile_version_row_version: string
        fit_model: string
        unit_dimensions_mm: {
          length: number
          width: number
          height: number
        }
        unit_weight_grams: number
        quantity: number
        candidate_line_global_id: string
        candidate_line_product_global_id: string
        candidate_line_requires_shipping: boolean
        candidate_line_mapping_state: string
        candidate_line_packaging_state: string
        candidate_line_pack_profile_version_id: string | null
        candidate_line_pack_profile_version_row_version: string | null
        current_profile_global_id: string
        current_profile_row_version: string
        current_profile_lifecycle_state: string
        current_profile_is_current: boolean
        current_profile_dimension_basis: string
        current_profile_fit_model: string
        current_profile_length_mm: number | null
        current_profile_width_mm: number | null
        current_profile_height_mm: number | null
        current_profile_gross_weight_grams: number | null
      }
      const lockedOrToolsProfiles =
        await client.query<PlanningProfileEvidenceRow>(
          `SELECT
             profile_edge.package_key,
             profile_edge.line_global_id,
             profile_edge.product_global_id,
             profile_edge.input_profile_version_global_id,
             profile_edge.input_profile_version_row_version::text,
             profile_edge.fit_model,
             profile_edge.unit_dimensions_mm,
             profile_edge.unit_weight_grams,
             profile_edge.quantity,
             candidate_line.global_id AS candidate_line_global_id,
             product.reference_code AS candidate_line_product_global_id,
             candidate_line.requires_shipping
               AS candidate_line_requires_shipping,
             candidate_line.mapping_state AS candidate_line_mapping_state,
             candidate_line.packaging_state
               AS candidate_line_packaging_state,
             candidate_line.pack_profile_version_id::text
               AS candidate_line_pack_profile_version_id,
             candidate_line.pack_profile_version_row_version::text
               AS candidate_line_pack_profile_version_row_version,
             profile_version.global_id AS current_profile_global_id,
             profile_version.row_version::text
               AS current_profile_row_version,
             profile_version.lifecycle_state
               AS current_profile_lifecycle_state,
             profile_version.is_current AS current_profile_is_current,
             profile_version.dimension_basis
               AS current_profile_dimension_basis,
             profile_version.fit_model AS current_profile_fit_model,
             profile_version.length_mm AS current_profile_length_mm,
             profile_version.width_mm AS current_profile_width_mm,
             profile_version.height_mm AS current_profile_height_mm,
             profile_version.gross_weight_grams
               AS current_profile_gross_weight_grams
           FROM operations_cartonization_rate_evidence_package_profiles
             profile_edge
           JOIN operations_cartonization_rate_evidence evidence
             ON evidence.organization_id = profile_edge.organization_id
            AND evidence.id = profile_edge.evidence_id
           JOIN operations_commerce_current_planning_lines candidate_line
             ON candidate_line.organization_id = evidence.organization_id
            AND candidate_line.integration_account_id =
                 evidence.integration_account_id
            AND candidate_line.order_candidate_id = evidence.order_candidate_id
            AND candidate_line.global_id = profile_edge.line_global_id
           JOIN crm_products product
             ON product.pipeline_id = candidate_line.pipeline_id
            AND product.id = candidate_line.product_id
           JOIN operations_product_pack_profile_versions profile_version
             ON profile_version.organization_id =
                  candidate_line.organization_id
            AND profile_version.pipeline_id = candidate_line.pipeline_id
            AND profile_version.product_id = candidate_line.product_id
            AND profile_version.id =
                  profile_edge.input_pack_profile_version_id
            AND profile_version.id = candidate_line.pack_profile_version_id
           WHERE profile_edge.organization_id = $1::uuid
             AND profile_edge.evidence_id = $2::uuid
             AND evidence.evidence_mode = 'operational'
           ORDER BY candidate_line.id, profile_version.id,
                    profile_edge.package_key,
                    profile_edge.line_global_id
           FOR UPDATE OF profile_version`,
          [organizationId, order.evidence_id],
        )
      const expectedProfileByKey = new Map(
        expectedOrToolsProfiles.map((profile) => [
          `${profile.packageKey}:${profile.lineGlobalId}`,
          profile,
        ]),
      )
      if (
        expectedProfileByKey.size !== expectedOrToolsProfiles.length
        || lockedOrToolsProfiles.rows.length
          !== expectedOrToolsProfiles.length
        || lockedOrToolsProfiles.rows.some((row) => {
          const expected = expectedProfileByKey.get(
            `${row.package_key}:${row.line_global_id}`,
          )
          return (
            !expected
            || expected.productGlobalId !== row.product_global_id
            || expected.inputProfileVersionGlobalId
              !== row.input_profile_version_global_id
            || expected.inputProfileVersionRowVersion
              !== Number(row.input_profile_version_row_version)
            || expected.fitModel !== row.fit_model
            || expected.unitDimensionsMm.length
              !== row.unit_dimensions_mm.length
            || expected.unitDimensionsMm.width
              !== row.unit_dimensions_mm.width
            || expected.unitDimensionsMm.height
              !== row.unit_dimensions_mm.height
            || expected.unitWeightGrams !== row.unit_weight_grams
            || expected.quantity !== row.quantity
            || row.candidate_line_global_id !== row.line_global_id
            || row.candidate_line_product_global_id
              !== row.product_global_id
            || row.candidate_line_requires_shipping !== true
            || row.candidate_line_mapping_state !== 'resolved'
            || row.candidate_line_packaging_state !== 'resolved'
            || !row.candidate_line_pack_profile_version_id
            || row.candidate_line_pack_profile_version_row_version === null
            || Number(row.candidate_line_pack_profile_version_row_version)
              !== Number(row.input_profile_version_row_version)
            || row.current_profile_global_id
              !== row.input_profile_version_global_id
            || Number(row.current_profile_row_version)
              !== Number(row.input_profile_version_row_version)
            || row.current_profile_lifecycle_state !== 'active'
            || row.current_profile_is_current !== true
            || row.current_profile_dimension_basis !== 'outer'
            || row.current_profile_fit_model !== 'rigid_3d'
            || row.current_profile_length_mm
              !== row.unit_dimensions_mm.length
            || row.current_profile_width_mm
              !== row.unit_dimensions_mm.width
            || row.current_profile_height_mm
              !== row.unit_dimensions_mm.height
            || row.current_profile_gross_weight_grams
              !== row.unit_weight_grams
          )
        })
      ) {
        throw new OperationsRequestError(
          'OPERATIONS_CARTONIZATION_PROFILE_EVIDENCE_STALE',
          'An OR-Tools product profile changed after cartonization. Re-run the plan before creating warehouse work.',
          409,
        )
      }
      const evidencePackageByKey = new Map(
        evidence.packages.map((packageEvidence) => [
          packageEvidence.packageKey,
          packageEvidence,
        ]),
      )
      const requiredPackagingByMaterialId = new Map<string, {
        materialGlobalId: string
        quantity: number
      }>()
      for (const lockedMaterial of lockedPackagingMaterials.rows) {
        const packageEvidence = evidencePackageByKey.get(
          lockedMaterial.package_key,
        )
        if (
          !packageEvidence
          || packageEvidence.packagingMaterialGlobalId
            !== lockedMaterial.material_global_id
        ) {
          throw new OperationsRequestError(
            'OPERATIONS_CARTONIZATION_PACKAGING_STALE',
            'A sealed package no longer references the reviewed packaging material',
            409,
          )
        }
        const current = requiredPackagingByMaterialId.get(
          lockedMaterial.material_id,
        )
        requiredPackagingByMaterialId.set(lockedMaterial.material_id, {
          materialGlobalId: lockedMaterial.material_global_id,
          quantity: (current?.quantity || 0) + 1,
        })
      }
      await client.query(
        `SELECT recipe.id
         FROM operations_cartonization_rate_evidence_packages package
         JOIN operations_approved_pack_recipes recipe
           ON recipe.organization_id = package.organization_id
          AND recipe.id = package.approved_pack_recipe_id
         WHERE package.organization_id = $1::uuid
           AND package.evidence_id = $2::uuid
         ORDER BY recipe.id
         FOR UPDATE OF recipe`,
        [organizationId, order.evidence_id],
      )
      const stalePackaging = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count
         FROM operations_cartonization_rate_evidence_packages package
         JOIN operations_packaging_materials material
           ON material.organization_id = package.organization_id
          AND material.id = package.packaging_material_id
         LEFT JOIN operations_approved_pack_recipes recipe
           ON recipe.organization_id = package.organization_id
          AND recipe.id = package.approved_pack_recipe_id
         WHERE package.organization_id = $1::uuid
           AND package.evidence_id = $2::uuid
           AND (
             material.row_version <> package.material_row_version
             OR material.status <> 'active'
             OR (
               package.approved_pack_recipe_id IS NOT NULL
               AND (
                 recipe.id IS NULL
                 OR recipe.row_version <> package.recipe_row_version
                 OR recipe.is_current IS DISTINCT FROM true
                 OR recipe.lifecycle_state NOT IN (
                   'customer_confirmed', 'active'
                 )
               )
             )
           )`,
        [organizationId, order.evidence_id],
      )
      if (Number(stalePackaging.rows[0]?.count || 0) > 0) {
        throw new OperationsRequestError(
          'OPERATIONS_CARTONIZATION_PACKAGING_STALE',
          'A packaging material or approved pack recipe changed after cartonization. Re-run the plan.',
          409,
        )
      }

      type PlanningPackagingStockRow = {
        id: string
        packaging_material_id: string
        is_available: boolean
        on_hand_quantity: number | null
        row_version: string
      }
      const packagingMaterialIds = [
        ...requiredPackagingByMaterialId.keys(),
      ]
      const lockedPackagingStock =
        await client.query<PlanningPackagingStockRow>(
          `SELECT
             stock.id::text,
             stock.packaging_material_id::text,
             stock.is_available,
             stock.on_hand_quantity,
             stock.row_version::text
           FROM operations_packaging_material_stock stock
           WHERE stock.organization_id = $1::uuid
             AND stock.warehouse_id = $2::uuid
             AND stock.packaging_material_id = ANY($3::uuid[])
           ORDER BY stock.id
           FOR UPDATE OF stock`,
          [
            organizationId,
            order.warehouse_id,
            packagingMaterialIds,
          ],
        )
      const stockByMaterialId = new Map(
        lockedPackagingStock.rows.map((stock) => [
          stock.packaging_material_id,
          stock,
        ]),
      )
      if (stockByMaterialId.size !== requiredPackagingByMaterialId.size) {
        throw new OperationsRequestError(
          'OPERATIONS_PACKAGING_MATERIAL_STOCK_REQUIRED',
          'Every selected packaging material requires warehouse-specific stock before planning',
          409,
        )
      }
      type ActivePackagingClaimRow = {
        id: string
        packaging_material_id: string
        quantity: number
      }
      const activePackagingClaims =
        await client.query<ActivePackagingClaimRow>(
          `SELECT
             claim.id::text,
             claim.packaging_material_id::text,
             claim.quantity
           FROM operations_packaging_material_claims claim
           WHERE claim.organization_id = $1::uuid
             AND claim.warehouse_id = $2::uuid
             AND claim.packaging_material_id = ANY($3::uuid[])
             AND claim.status = 'active'
           ORDER BY claim.id
           FOR UPDATE OF claim`,
          [
            organizationId,
            order.warehouse_id,
            packagingMaterialIds,
          ],
        )
      const activeClaimedByMaterialId = new Map<string, number>()
      for (const claim of activePackagingClaims.rows) {
        activeClaimedByMaterialId.set(
          claim.packaging_material_id,
          (
            activeClaimedByMaterialId.get(claim.packaging_material_id)
            || 0
          ) + Number(claim.quantity),
        )
      }
      const packagingClaimInputs = packagingMaterialIds.map((materialId) => {
        const requirement = requiredPackagingByMaterialId.get(materialId)
        const stock = stockByMaterialId.get(materialId)
        if (!requirement || !stock) {
          throw new Error('OPERATIONS_PACKAGING_CLAIM_INPUT_MISSING')
        }
        const activeClaimed = (
          activeClaimedByMaterialId.get(materialId) || 0
        )
        if (
          stock.is_available !== true
          || stock.on_hand_quantity === null
          || stock.on_hand_quantity - activeClaimed
            < requirement.quantity
        ) {
          throw new OperationsRequestError(
            'OPERATIONS_PACKAGING_MATERIAL_STOCK_EXHAUSTED',
            `${requirement.materialGlobalId} does not have enough unclaimed warehouse stock for ${requirement.quantity} package(s)`,
            409,
          )
        }
        return {
          materialId,
          materialGlobalId: requirement.materialGlobalId,
          quantity: requirement.quantity,
          stockId: stock.id,
          stockRowVersion: Number(stock.row_version),
          onHandQuantity: stock.on_hand_quantity,
        }
      })

      await client.query(
        `SELECT recipe.id, profile_version.id
         FROM
           operations_cartonization_rate_evidence_package_recipes edge
         JOIN operations_approved_pack_recipes recipe
           ON recipe.organization_id = edge.organization_id
          AND recipe.id = edge.approved_pack_recipe_id
         JOIN operations_product_pack_profile_versions profile_version
           ON profile_version.organization_id = edge.organization_id
          AND profile_version.id = edge.input_pack_profile_version_id
         WHERE edge.organization_id = $1::uuid
           AND edge.evidence_id = $2::uuid
         ORDER BY recipe.id, profile_version.id
         FOR UPDATE OF recipe, profile_version`,
        [organizationId, order.evidence_id],
      )
      const staleRecipeInputs = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count
         FROM
           operations_cartonization_rate_evidence_package_recipes edge
         JOIN operations_approved_pack_recipes recipe
           ON recipe.organization_id = edge.organization_id
          AND recipe.id = edge.approved_pack_recipe_id
         JOIN operations_product_pack_profile_versions profile_version
           ON profile_version.organization_id = edge.organization_id
          AND profile_version.id = edge.input_pack_profile_version_id
         WHERE edge.organization_id = $1::uuid
           AND edge.evidence_id = $2::uuid
           AND (
             recipe.row_version <> edge.recipe_row_version
             OR recipe.is_current IS DISTINCT FROM true
             OR recipe.lifecycle_state NOT IN (
               'customer_confirmed', 'active'
             )
             OR profile_version.row_version
                  <> edge.input_profile_version_row_version
             OR profile_version.is_current IS DISTINCT FROM true
             OR profile_version.lifecycle_state NOT IN (
               'customer_confirmed', 'active'
             )
           )`,
        [organizationId, order.evidence_id],
      )
      if (Number(staleRecipeInputs.rows[0]?.count || 0) > 0) {
        throw new OperationsRequestError(
          'OPERATIONS_CARTONIZATION_PACK_PROFILE_STALE',
          'A product pack profile changed after cartonization. Re-run the plan.',
          409,
        )
      }

      if (evidence.inventorySyncRunGlobalId) {
        const latestInventory = await client.query<{
          id: string
          global_id: string
        }>(
          `SELECT id::text, global_id
           FROM operations_commerce_inventory_sync_runs
           WHERE organization_id = $1::uuid
             AND integration_account_id = $2::uuid
             AND warehouse_id = $3::uuid
             AND status = 'succeeded'
           ORDER BY completed_at DESC, id DESC
           LIMIT 1`,
          [
            organizationId,
            order.integration_account_id,
            order.warehouse_id,
          ],
        )
        if (
          latestInventory.rows[0]?.global_id
            !== evidence.inventorySyncRunGlobalId
          || latestInventory.rows[0]?.id
            !== order.evidence_inventory_sync_run_id
        ) {
          throw new OperationsRequestError(
            'OPERATIONS_CARTONIZATION_INVENTORY_STALE',
            'Provider inventory changed after cartonization. Refresh inventory and re-run the plan.',
            409,
          )
        }
      } else if (order.source_provider === 'shopify') {
        throw new OperationsRequestError(
          'OPERATIONS_CARTONIZATION_INVENTORY_REQUIRED',
          'Shopify orders require exact successful inventory-sync evidence before planning',
          409,
        )
      }

      type PlanningLineRow = {
        id: string
        global_id: string
        product_id: string
        product_global_id: string
        quantity: string
        candidate_line_global_id: string
      }
      const lineResult = await client.query<PlanningLineRow>(
        `SELECT
           line.id::text,
           line.global_id,
           line.product_id::text,
           product.reference_code AS product_global_id,
           line.quantity::text,
           candidate_line.global_id AS candidate_line_global_id
         FROM operations_current_order_lines line
         JOIN crm_products product
           ON product.pipeline_id = line.pipeline_id
          AND product.id = line.product_id
         JOIN operations_commerce_current_planning_lines candidate_line
           ON candidate_line.organization_id = line.organization_id
          AND candidate_line.order_candidate_id = $3::uuid
          AND candidate_line.canonical_order_line_id = line.id
          AND candidate_line.workflow_state = 'promoted'
         WHERE line.organization_id = $1::uuid
           AND line.order_id = $2::uuid
         ORDER BY line.global_id
         FOR UPDATE OF line`,
        [organizationId, order.id, order.candidate_id],
      )
      if (!lineResult.rows.length) {
        throw new OperationsRequestError(
          'OPERATIONS_ORDER_LINES_INVALID',
          'The promoted order has no canonical fulfillment lines',
          409,
        )
      }

      const lineByCandidateGlobalId = new Map(
        lineResult.rows.map((line) => [
          line.candidate_line_global_id,
          line,
        ]),
      )
      const quantityByLineId = new Map<string, number>()
      for (const packageEvidence of evidence.packages) {
        const packageLineIds = new Set<string>()
        for (const allocation of packageEvidence.allocations) {
          const line = lineByCandidateGlobalId.get(
            allocation.lineGlobalId,
          )
          if (
            !line
            || line.product_global_id !== allocation.productGlobalId
          ) {
            throw new OperationsRequestError(
              'OPERATIONS_PACKAGE_CONTENTS_INVALID',
              'Sealed package allocations do not match the promoted order lines',
              409,
            )
          }
          if (packageLineIds.has(line.id)) {
            throw new OperationsRequestError(
              'OPERATIONS_PACKAGE_CONTENTS_DUPLICATE',
              `Sealed package ${packageEvidence.packageKey} repeats canonical order line ${line.global_id}`,
              409,
            )
          }
          packageLineIds.add(line.id)
          const quantity = assertPositiveQuantity(allocation.quantity)
          if (!Number.isSafeInteger(quantity)) {
            throw new OperationsRequestError(
              'OPERATIONS_PACKAGE_CONTENTS_INVALID',
              'Sealed package allocations must use exact whole units',
              409,
            )
          }
          quantityByLineId.set(
            line.id,
            (quantityByLineId.get(line.id) || 0) + quantity,
          )
        }
      }
      for (const line of lineResult.rows) {
        if (
          !Number.isSafeInteger(Number(line.quantity))
          || quantityByLineId.get(line.id) !== Number(line.quantity)
        ) {
          throw new OperationsRequestError(
            'OPERATIONS_PACKAGE_CONTENTS_INCOMPLETE',
            'Every canonical order-line quantity must be assigned to exactly one or more sealed packages',
            409,
          )
        }
      }

      let rateSelection
      const offers = canonicalRateOffers(evidence)
      try {
        rateSelection = selectCanonicalFulfillmentRate({
          packagePlanHash: evidence.planResultHash,
          packageCount: evidence.packages.length,
          packageKeys: evidence.packages.map(
            (packageEvidence) => packageEvidence.packageKey,
          ),
          expectedCurrency: order.currency,
          requestedDeliveryAt:
            order.requested_delivery_at?.toISOString() || null,
          actualCheckoutShippingChargeMinor:
            authorizedCheckoutShippingChargeMinor(
              order.source_payload,
            ),
          offers,
        })
      } catch (error) {
        if (error instanceof CanonicalFulfillmentPlanningError) {
          throw new OperationsRequestError(
            `OPERATIONS_${error.code}`,
            error.message,
            409,
          )
        }
        throw error
      }

      type PlanningPositionRow = PositionRow & {
        inventory_level_id: string | null
        inventory_level_global_id: string | null
        provider_committed_quantity: string | null
        available_whole_units: string | null
      }
      type PlannedInventoryAllocation = {
        reservation: IdRow
        position: PlanningPositionRow
        quantity: number
      }
      const inventoryAllocationsByLineId = new Map<
        string,
        PlannedInventoryAllocation[]
      >()
      for (const line of lineResult.rows) {
        const quantity = Number(line.quantity)
        let positionRows: PlanningPositionRow[]
        let positionAllocations: Array<{
          position: PlanningPositionRow
          quantity: number
        }>
        if (order.evidence_inventory_sync_run_id) {
          const positionResult =
            await client.query<PlanningPositionRow>(
              `SELECT
                 position.id::text,
                 position.global_id,
                 position.warehouse_id::text,
                 warehouse.global_id AS warehouse_global_id,
                 warehouse.name AS warehouse_name,
                 position.location_id::text,
                 position.on_hand_quantity::text,
                 position.reserved_quantity::text,
                 position.source_authority,
                 level.id::text AS inventory_level_id,
                 level.global_id AS inventory_level_global_id,
                 level.provider_committed_quantity::text
                   AS provider_committed_quantity,
                 NULL::text AS available_whole_units
               FROM operations_commerce_inventory_levels level
               JOIN operations_inventory_positions position
                 ON position.organization_id = level.organization_id
                AND position.id = level.inventory_position_id
               JOIN operations_warehouses warehouse
                 ON warehouse.organization_id = position.organization_id
                AND warehouse.id = position.warehouse_id
               JOIN operations_locations location
                 ON location.organization_id = position.organization_id
                AND location.id = position.location_id
               JOIN operations_inventory_pools pool
                 ON pool.organization_id = position.organization_id
                AND pool.id = position.pool_id
               WHERE level.organization_id = $1::uuid
                 AND level.sync_run_id = $2::uuid
                 AND level.product_id = $3::uuid
                 AND level.warehouse_id = $4::uuid
                 AND level.pipeline_id = $5::uuid
                 AND level.location_id = position.location_id
                 AND level.inventory_pool_id = position.pool_id
                 AND level.mapping_state = 'mapped'
                 AND level.projection_state = 'projected'
                 AND level.tracked = true
                 AND level.equation_matches = true
                 AND position.pipeline_id = $5::uuid
                 AND position.source_authority = 'shopify'
                 AND location.active = true
                 AND pool.active = true
                 AND (
                   pool.pool_type = 'shared'
                   OR pool.owner_customer_id = $6::uuid
                   OR EXISTS (
                     SELECT 1
                     FROM operations_inventory_pool_customers eligible
                     WHERE eligible.organization_id =
                             pool.organization_id
                       AND eligible.pool_id = pool.id
                       AND eligible.customer_id = $6::uuid
                       AND eligible.effective_from <= now()
                       AND (
                         eligible.effective_to IS NULL
                         OR eligible.effective_to > now()
                       )
                   )
                 )
               ORDER BY level.id
               FOR UPDATE OF position, location, pool`,
              [
                organizationId,
                order.evidence_inventory_sync_run_id,
                line.product_id,
                order.warehouse_id,
                order.pipeline_id,
                order.customer_id,
              ],
            )
          positionRows = positionResult.rows
          if (
            positionRows.length !== 1
            || !positionRows[0].inventory_level_id
          ) {
            throw new OperationsRequestError(
              'OPERATIONS_PROVIDER_INVENTORY_AMBIGUOUS',
              `Exact provider inventory evidence is unavailable for ${line.product_global_id}`,
              409,
            )
          }
          const claimed = await client.query<{ quantity: string }>(
            `SELECT COALESCE(sum(quantity), 0)::text AS quantity
             FROM operations_reservations
             WHERE organization_id = $1::uuid
               AND position_id = $2::uuid
               AND reservation_authority = 'provider_commitment'
               AND status = 'active'`,
            [organizationId, positionRows[0].id],
          )
          if (
            Number(claimed.rows[0]?.quantity || 0) + quantity
            > Number(
              positionRows[0].provider_committed_quantity || 0,
            )
          ) {
            throw new OperationsRequestError(
              'OPERATIONS_PROVIDER_COMMITMENT_EXHAUSTED',
              `Provider committed inventory cannot cover ${line.product_global_id} without double-claiming another order`,
              409,
            )
          }
          positionAllocations = [{
            position: positionRows[0],
            quantity,
          }]
        } else {
          const positionResult =
            await client.query<PlanningPositionRow>(
              `SELECT
                 position.id::text,
                 position.global_id,
                 position.warehouse_id::text,
                 warehouse.global_id AS warehouse_global_id,
                 warehouse.name AS warehouse_name,
                 position.location_id::text,
                 position.on_hand_quantity::text,
                 position.reserved_quantity::text,
                 position.source_authority,
                 NULL::text AS inventory_level_id,
                 NULL::text AS inventory_level_global_id,
                 NULL::text AS provider_committed_quantity,
                 floor(
                   position.on_hand_quantity
                     - position.reserved_quantity
                     - position.damaged_quantity
                 )::text AS available_whole_units
               FROM operations_inventory_positions position
               JOIN operations_warehouses warehouse
                 ON warehouse.organization_id = position.organization_id
                AND warehouse.id = position.warehouse_id
               JOIN operations_locations location
                 ON location.organization_id = position.organization_id
                AND location.id = position.location_id
               JOIN operations_inventory_pools pool
                 ON pool.organization_id = position.organization_id
                AND pool.id = position.pool_id
               WHERE position.organization_id = $1::uuid
                 AND position.pipeline_id = $2::uuid
                 AND position.product_id = $3::uuid
                 AND position.warehouse_id = $4::uuid
                 AND position.source_authority = 'clawpilot'
                 AND location.active = true
                 AND pool.active = true
                 AND (
                   pool.pool_type = 'shared'
                   OR pool.owner_customer_id = $5::uuid
                   OR EXISTS (
                     SELECT 1
                     FROM operations_inventory_pool_customers eligible
                     WHERE eligible.organization_id =
                             pool.organization_id
                       AND eligible.pool_id = pool.id
                       AND eligible.customer_id = $5::uuid
                       AND eligible.effective_from <= now()
                       AND (
                         eligible.effective_to IS NULL
                         OR eligible.effective_to > now()
                       )
                   )
                 )
                 AND position.on_hand_quantity
                       - position.reserved_quantity
                       - position.damaged_quantity > 0
               ORDER BY
                 location.pick_sequence,
                 position.global_id
               FOR UPDATE OF position`,
              [
                organizationId,
                order.pipeline_id,
                line.product_id,
                order.warehouse_id,
                order.customer_id,
              ],
            )
          positionRows = positionResult.rows
          let remainingQuantity = quantity
          positionAllocations = []
          for (const position of positionRows) {
            const availableWholeUnits = Number(
              position.available_whole_units,
            )
            if (
              !Number.isSafeInteger(availableWholeUnits)
              || availableWholeUnits < 0
            ) {
              throw new OperationsRequestError(
                'OPERATIONS_INVENTORY_BALANCE_INVALID',
                `Available ClawPilot inventory is invalid for ${line.product_global_id}`,
                409,
              )
            }
            const allocatedQuantity = Math.min(
              remainingQuantity,
              availableWholeUnits,
            )
            if (allocatedQuantity < 1) continue
            positionAllocations.push({
              position,
              quantity: allocatedQuantity,
            })
            remainingQuantity -= allocatedQuantity
            if (remainingQuantity === 0) break
          }
          if (remainingQuantity !== 0) {
            throw new OperationsRequestError(
              'OPERATIONS_INVENTORY_SHORTAGE',
              `Available ClawPilot inventory cannot cover ${line.product_global_id}`,
              409,
            )
          }
        }
        const inventoryAllocations: PlannedInventoryAllocation[] = []
        for (const positionAllocation of positionAllocations) {
          const { position } = positionAllocation
          const reservationResult = await client.query<IdRow>(
            `INSERT INTO operations_reservations (
               organization_id, order_id, order_line_id, position_id,
               quantity, status, idempotency_key, created_by,
               reservation_authority, provider_inventory_sync_run_id,
               provider_inventory_level_id
             ) VALUES (
               $1::uuid, $2::uuid, $3::uuid, $4::uuid,
               $5, 'active', $6, $7, $8,
               $9::uuid, $10::uuid
             )
             RETURNING id::text, global_id`,
            [
              organizationId,
              order.id,
              line.id,
              position.id,
              positionAllocation.quantity,
              [
                order.global_id,
                'canonical-plan',
                line.global_id,
                position.global_id,
              ].join(':'),
              actorEmail,
              position.source_authority === 'shopify'
                ? 'provider_commitment'
                : 'local_balance',
              position.source_authority === 'shopify'
                ? order.evidence_inventory_sync_run_id
                : null,
              position.source_authority === 'shopify'
                ? position.inventory_level_id
                : null,
            ],
          )
          const reservation = reservationResult.rows[0]
          inventoryAllocations.push({
            reservation,
            position,
            quantity: positionAllocation.quantity,
          })

          if (position.source_authority === 'clawpilot') {
            const balances = await client.query<{
              on_hand_quantity: string
              reserved_quantity: string
            }>(
              `UPDATE operations_inventory_positions
               SET reserved_quantity = reserved_quantity + $3,
                   version = version + 1,
                   updated_at = now()
               WHERE organization_id = $1::uuid
                 AND id = $2::uuid
                 AND on_hand_quantity
                       - reserved_quantity
                       - damaged_quantity >= $3
               RETURNING on_hand_quantity::text,
                         reserved_quantity::text`,
              [
                organizationId,
                position.id,
                positionAllocation.quantity,
              ],
            )
            if (!balances.rows[0]) {
              throw new OperationsRequestError(
                'OPERATIONS_INVENTORY_CONFLICT',
                `Inventory changed while planning ${line.product_global_id}`,
                409,
              )
            }
            await client.query(
              `INSERT INTO operations_inventory_ledger (
                 organization_id, position_id, event_type,
                 on_hand_delta, reserved_delta, on_hand_after,
                 reserved_after, source_global_id, reason,
                 idempotency_key, actor_email, source_authority
               ) VALUES (
                 $1::uuid, $2::uuid, 'reservation',
                 0, $3, $4, $5, $6, $7, $8, $9, 'clawpilot'
               )`,
              [
                organizationId,
                position.id,
                positionAllocation.quantity,
                balances.rows[0].on_hand_quantity,
                balances.rows[0].reserved_quantity,
                line.global_id,
                reason,
                `${order.global_id}:${reservation.global_id}:reservation-ledger`,
                actorEmail,
              ],
            )
          }
        }
        if (
          inventoryAllocations.reduce(
            (sum, allocation) => sum + allocation.quantity,
            0,
          ) !== quantity
        ) {
          throw new Error('OPERATIONS_INVENTORY_ALLOCATION_INCOMPLETE')
        }
        inventoryAllocationsByLineId.set(line.id, inventoryAllocations)
      }

      const actualCheckoutCharge =
        rateSelection.actualCheckoutShippingChargeMinor
      const estimatedRevenueMinor = actualCheckoutCharge
      const estimatedMarginMinor = actualCheckoutCharge === null
        ? null
        : actualCheckoutCharge - rateSelection.carrierCostMinor
      const planResult = await client.query<IdRow>(
        `INSERT INTO operations_fulfillment_plans (
           organization_id, order_id, warehouse_id, version_number,
           status, method, solver_status, fallback_reason,
           estimated_cost_minor, estimated_revenue_minor,
           estimated_margin_minor, promised_delivery_at,
           explanation, created_by, cartonization_evidence_id
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, 1,
           'planned', $4, 'sealed_evidence_accepted', NULL,
           $5, $6, $7, $8::timestamptz,
           $9::jsonb, $10, $11::uuid
         )
         RETURNING id::text, global_id`,
        [
          organizationId,
          order.id,
          order.warehouse_id,
          evidence.packages.some(
            (packageEvidence) =>
              packageEvidence.planningMethod === 'or_tools',
          )
            ? 'optimizer'
            : 'deterministic_fallback',
          rateSelection.carrierCostMinor,
          estimatedRevenueMinor,
          estimatedMarginMinor,
          rateSelection.estimatedDeliveryAt,
          JSON.stringify({
            version: 'canonical-fulfillment-plan-v1',
            reason,
            candidateGlobalId: order.candidate_global_id,
            cartonizationEvidenceGlobalId: evidence.globalId,
            inventorySyncRunGlobalId:
              evidence.inventorySyncRunGlobalId,
            packagePlanHash: evidence.planResultHash,
            packageCount: evidence.packages.length,
            carrierReadEnvironment,
            packagingMaterialClaimCount: packagingClaimInputs.length,
            packagingStockDecremented: false,
            selectedWholeShipmentRate: rateSelection,
            checkoutShippingChargeMinor: actualCheckoutCharge,
            customerPaidVarianceMinor:
              rateSelection.customerPaidVarianceMinor,
            shopifyOrderPlanningAuthorityHash:
              liveShopifyPlanningAuthority?.authorityHash || null,
            planningAuthorityProviderReads:
              liveShopifyPlanningAuthority?.providerReads || 0,
            mudApplied: false,
            providerWrites: 0,
            labelWrites: 0,
            shipmentWrites: 0,
          }),
          actorEmail,
          order.evidence_id,
        ],
      )
      const plan = planResult.rows[0]
      for (const claimInput of packagingClaimInputs) {
        await client.query(
          `INSERT INTO operations_packaging_material_claims (
             organization_id, plan_id, packaging_material_id,
             warehouse_id, packaging_material_stock_id, quantity,
             status, stock_row_version_at_claim,
             on_hand_quantity_at_claim, created_by, updated_by
           ) VALUES (
             $1::uuid, $2::uuid, $3::uuid,
             $4::uuid, $5::uuid, $6,
             'active', $7, $8, $9, $9
           )`,
          [
            organizationId,
            plan.id,
            claimInput.materialId,
            order.warehouse_id,
            claimInput.stockId,
            claimInput.quantity,
            claimInput.stockRowVersion,
            claimInput.onHandQuantity,
            actorEmail,
          ],
        )
      }
      for (const line of lineResult.rows) {
        const inventoryAllocations =
          inventoryAllocationsByLineId.get(line.id)
        if (!inventoryAllocations?.length) {
          throw new Error('OPERATIONS_RESERVATION_RESULT_MISSING')
        }
        for (const inventoryAllocation of inventoryAllocations) {
          await client.query(
            `INSERT INTO operations_fulfillment_allocations (
               organization_id, plan_id, order_line_id,
               reservation_id, position_id, quantity
             ) VALUES (
               $1::uuid, $2::uuid, $3::uuid,
               $4::uuid, $5::uuid, $6
             )`,
            [
              organizationId,
              plan.id,
              line.id,
              inventoryAllocation.reservation.id,
              inventoryAllocation.position.id,
              inventoryAllocation.quantity,
            ],
          )
        }
      }

      const canonicalPackageSnapshots = evidence.packages.map(
        (packageEvidence) => ({
          packageNumber: packageEvidence.packageSequence,
          packageKey: packageEvidence.packageKey,
          planningMethod: packageEvidence.planningMethod,
          packagingMaterialGlobalId:
            packageEvidence.packagingMaterialGlobalId,
          packagingMaterialName: packageEvidence.packagingMaterialName,
          approvedPackRecipeGlobalIds:
            packageEvidence.recipes.map((recipe) => recipe.recipeGlobalId),
          innerDimensionsMm: packageEvidence.innerDimensionsMm,
          ratedOuterDimensionsMm:
            packageEvidence.ratedOuterDimensionsMm,
          contentWeightGrams: packageEvidence.contentWeightGrams,
          tareWeightGrams: packageEvidence.tareWeightGrams,
          ratedGrossWeightGrams:
            packageEvidence.ratedGrossWeightGrams,
          packageHash: packageEvidence.packageHash,
          allocations: packageEvidence.allocations,
        }),
      )
      await client.query(
        `INSERT INTO operations_carton_plans (
           organization_id, plan_id, algorithm, package_count,
           total_weight_grams, packages
         ) VALUES (
           $1::uuid, $2::uuid, $3, $4, $5, $6::jsonb
         )`,
        [
          organizationId,
          plan.id,
          evidence.algorithmVersion,
          evidence.packages.length,
          evidence.packages.reduce(
            (sum, packageEvidence) =>
              sum + packageEvidence.ratedGrossWeightGrams,
            0,
          ),
          JSON.stringify(canonicalPackageSnapshots),
        ],
      )

      for (const offer of offers) {
        const carrier = offer.provider === 'ups_rest' ? 'UPS' : 'FedEx'
        const selected = (
          offer.provider === rateSelection.carrierProvider
          && offer.serviceCode.toLowerCase()
            === rateSelection.serviceCode
        )
        await client.query(
          `INSERT INTO operations_carrier_rates (
             organization_id, plan_id, carrier, service_code,
             service_name, internal_cost_minor,
             customer_charge_minor, transit_days,
             estimated_delivery_at, meets_promise, selected,
             quote_snapshot
           ) VALUES (
             $1::uuid, $2::uuid, $3, $4, $5, $6,
             $7, $8, $9::timestamptz, $10, $11, $12::jsonb
           )`,
          [
            organizationId,
            plan.id,
            carrier,
            offer.serviceCode.toLowerCase(),
            offer.serviceName,
            offer.carrierCostMinor,
            actualCheckoutCharge,
            offer.transitDays,
            offer.estimatedDeliveryAt,
            order.requested_delivery_at === null
              || new Date(offer.estimatedDeliveryAt).getTime()
                <= order.requested_delivery_at.getTime(),
            selected,
            JSON.stringify({
              version: 'canonical-whole-shipment-rate-evidence-v1',
              rateEvidenceGlobalId: offer.rateEvidenceGlobalId,
              rateScope: offer.rateScope,
              packagePlanHash: offer.packagePlanHash,
              packageCount: offer.packageCount,
              packageKeys: offer.packageKeys,
              provider: offer.provider,
              currency: offer.currency,
              checkoutShippingChargeMinor: actualCheckoutCharge,
              mudApplied: false,
            }),
          ],
        )
      }

      for (const packageEvidence of evidence.packages) {
        const packageResult = await client.query<IdRow>(
          `INSERT INTO operations_packages (
             organization_id, plan_id, package_number,
             length_mm, width_mm, height_mm, weight_grams,
             status, cartonization_evidence_id,
             evidence_package_key
           ) VALUES (
             $1::uuid, $2::uuid, $3, $4, $5, $6, $7,
             'planned', $8::uuid, $9
           )
           RETURNING id::text, global_id`,
          [
            organizationId,
            plan.id,
            packageEvidence.packageSequence,
            packageEvidence.ratedOuterDimensionsMm.length,
            packageEvidence.ratedOuterDimensionsMm.width,
            packageEvidence.ratedOuterDimensionsMm.height,
            packageEvidence.ratedGrossWeightGrams,
            order.evidence_id,
            packageEvidence.packageKey,
          ],
        )
        const packageRow = packageResult.rows[0]
        for (const allocation of packageEvidence.allocations) {
          const line = lineByCandidateGlobalId.get(
            allocation.lineGlobalId,
          )
          if (!line) {
            throw new Error('OPERATIONS_PACKAGE_LINE_RESULT_MISSING')
          }
          await client.query(
            `INSERT INTO operations_package_contents (
               organization_id, plan_id, order_id, package_id,
               order_line_id, quantity, created_by
             ) VALUES (
               $1::uuid, $2::uuid, $3::uuid, $4::uuid,
               $5::uuid, $6, $7
             )`,
            [
              organizationId,
              plan.id,
              order.id,
              packageRow.id,
              line.id,
              allocation.quantity,
              actorEmail,
            ],
          )
        }
      }

      await transitionOrder(client, {
        organizationId,
        order,
        status: 'planned',
        eventType: 'operations.fulfillment.planned',
        actorEmail,
        correlationId: command.receipt.correlation_id,
        eventKey: `canonical-plan:${evidence.globalId}`,
        promisedDeliveryAt: rateSelection.estimatedDeliveryAt,
        payload: {
          planGlobalId: plan.global_id,
          candidateGlobalId: order.candidate_global_id,
          cartonizationEvidenceGlobalId: evidence.globalId,
          inventorySyncRunGlobalId:
            evidence.inventorySyncRunGlobalId,
          packageCount: evidence.packages.length,
          selectedCarrier: rateSelection.carrierName,
          selectedServiceCode: rateSelection.serviceCode,
          selectedServiceName: rateSelection.serviceName,
          selectedCarrierCostMinor:
            rateSelection.carrierCostMinor,
          checkoutShippingChargeMinor: actualCheckoutCharge,
          customerPaidVarianceMinor:
            rateSelection.customerPaidVarianceMinor,
          selectionPolicy: rateSelection.policy,
          shopifyOrderPlanningAuthorityHash:
            liveShopifyPlanningAuthority?.authorityHash || null,
          planningAuthorityProviderReads:
            liveShopifyPlanningAuthority?.providerReads || 0,
          mudApplied: false,
          providerWrites: 0,
          labelsCreated: 0,
          shipmentsCreated: 0,
        },
      })
      const updatedOrder = await client.query<{ row_version: string }>(
        `SELECT row_version::text
         FROM operations_orders
         WHERE organization_id = $1::uuid AND id = $2::uuid`,
        [organizationId, order.id],
      )
      const result: OperationsPlanCommandResult = {
        orderGlobalId: order.global_id,
        orderStatus: 'planned',
        rowVersion: Number(updatedOrder.rows[0].row_version),
        fulfillmentPlanGlobalId: plan.global_id,
        cartonizationEvidenceGlobalId: evidence.globalId,
        packageCount: evidence.packages.length,
        carrier: rateSelection.carrierName,
        serviceCode: rateSelection.serviceCode,
        serviceName: rateSelection.serviceName,
        carrierCostMinor: rateSelection.carrierCostMinor,
        currency: rateSelection.currency,
        checkoutShippingChargeMinor: actualCheckoutCharge,
        checkoutVarianceMinor:
          rateSelection.customerPaidVarianceMinor,
        replayed: false,
      }
      await recordAuditEvent({
        actor: actorEmail,
        eventType: 'operations.fulfillment_plan.accepted',
        aggregateType: 'operations.order',
        aggregateId: order.global_id,
        subject: order.global_id,
        organizationId,
        eventKey:
          `operations:fulfillment-plan:${organizationId}:${plan.global_id}`,
        payload: {
          ...result,
          candidateGlobalId: order.candidate_global_id,
          reason,
          shopifyOrderPlanningAuthorityHash:
            liveShopifyPlanningAuthority?.authorityHash || null,
          planningAuthorityProviderReads:
            liveShopifyPlanningAuthority?.providerReads || 0,
          providerWrites: 0,
          labelsCreated: 0,
          shipmentsCreated: 0,
        },
      }, client)
      await completeCommandReceipt(
        client,
        command.receipt.id,
        order.global_id,
        result,
      )
      return result
    })
  } catch (error) {
    const normalizedError = normalizeShopifyPlanningError(error)
    await failCommandReceipt(command.receipt.id, normalizedError)
    throw normalizedError
  }
}

export async function releaseOperationsOrderFromPostgres(input: {
  organizationId: string
  actorEmail: string
  orderGlobalId: string
  expectedRowVersion: number
  reason: string
  idempotencyKey: string
  assignedTo?: string
}): Promise<OperationsOrderCommandResult> {
  const organizationId = requireOrganizationId(input.organizationId)
  const actorEmail = String(input.actorEmail || '').trim().toLowerCase()
  const orderGlobalId = String(input.orderGlobalId || '').trim()
  const reason = String(input.reason || '').trim()
  const idempotencyKey = String(input.idempotencyKey || '').trim()
  const explicitAssignedTo = String(input.assignedTo || '').trim().toLowerCase()
  const assignedTo = explicitAssignedTo || actorEmail
  if (!actorEmail) throw new OperationsRequestError('OPERATIONS_ACTOR_REQUIRED', 'A signed-in user is required', 401)
  if (!/^gor(?:[0-9]{7}|[0-9a-v]{12})$/.test(orderGlobalId)) {
    throw new OperationsRequestError('OPERATIONS_ORDER_INVALID', 'Order is invalid')
  }
  if (!Number.isSafeInteger(input.expectedRowVersion) || input.expectedRowVersion < 0) {
    throw new OperationsRequestError('OPERATIONS_ORDER_VERSION_INVALID', 'Order version is invalid')
  }
  if (!reason || reason.length > 500) {
    throw new OperationsRequestError('OPERATIONS_RELEASE_REASON_INVALID', 'A release reason is required')
  }
  if (!assignedTo.includes('@') || assignedTo.length > 254) {
    throw new OperationsRequestError('OPERATIONS_PICKER_INVALID', 'Choose a valid picker')
  }
  if (!/^[A-Za-z0-9._:-]{8,200}$/.test(idempotencyKey)) {
    throw new OperationsRequestError('OPERATIONS_IDEMPOTENCY_KEY_INVALID', 'A valid idempotency key is required')
  }
  const command = await prepareCommandReceipt({
    organizationId,
    commandType: 'release_operations_order',
    idempotencyKey,
    requestHash: commandRequestHash({
      orderGlobalId,
      expectedRowVersion: input.expectedRowVersion,
      reason,
      assignedTo,
    }),
    actorEmail,
  })
  if (command.completed) {
    return completedOrderCommandResult(organizationId, command.receipt)
  }

  try {
    return await withTransaction(async (client) => {
      await acquireTransactionAdvisoryLock(
        client,
        `operations:activation:${organizationId}`,
      )
      await acquireTransactionAdvisoryLock(client, `operations:order:${organizationId}:${orderGlobalId}`)
      const activation = await resolveActivation(client, organizationId)
      if (!['shadow', 'active'].includes(activation.state)) {
        throw new OperationsRequestError(
          'OPERATIONS_EXECUTION_STATE_INVALID',
          'Set Operations to Shadow or Active before releasing warehouse work',
          409,
        )
      }
      if (explicitAssignedTo) {
        await requireEligibleOperationsPicker(client, organizationId, assignedTo)
      }

      const orderResult = await client.query<OrderIdentityRow & {
        source_provider: string
        integration_account_id: string | null
      }>(
        `SELECT id::text, global_id, status, row_version::text,
                source_provider, integration_account_id::text
         FROM operations_orders
         WHERE organization_id = $1::uuid AND global_id = $2
         FOR UPDATE`,
        [organizationId, orderGlobalId],
      )
      const order = orderResult.rows[0]
      if (!order || order.row_version === undefined) {
        throw new OperationsRequestError('OPERATIONS_ORDER_NOT_FOUND', 'Operations order was not found', 404)
      }
      if (Number(order.row_version) !== input.expectedRowVersion) {
        throw new OperationsRequestError(
          'OPERATIONS_ORDER_VERSION_CONFLICT',
          'This order changed after it was opened. Refresh the order before releasing it.',
          409,
        )
      }
      await requireCurrentCommerceOrderRevision(client, {
        organizationId,
        orderId: order.id,
        operation: 'release',
      })
      if (order.status !== 'planned') {
        throw new OperationsRequestError(
          'OPERATIONS_ORDER_TRANSITION_INVALID',
          `Order cannot be released from ${order.status}`,
          409,
        )
      }
      if (order.source_provider === 'shopify') {
        if (!order.integration_account_id) {
          throw new OperationsRequestError(
            'OPERATIONS_PROVIDER_ACCOUNT_REQUIRED',
            'The Shopify order is missing its integration account. Reconcile the order before warehouse release.',
            409,
          )
        }
        await acquireTransactionAdvisoryLock(
          client,
          [
            'shopify-inventory-apply',
            organizationId,
            order.integration_account_id,
          ].join(':'),
        )
        const reconciliationResult = await client.query<{
          checkout_shipping_service_code: string | null
          outcome: ShopifyCheckoutRateReconciliationOutcome | null
        }>(
          `SELECT candidate.checkout_shipping_service_code,
                  reconciliation.outcome
           FROM operations_commerce_order_candidates candidate
           LEFT JOIN
               operations_shopify_checkout_rate_current_reconciliations
               reconciliation
             ON reconciliation.organization_id = candidate.organization_id
            AND reconciliation.order_candidate_id = candidate.id
           WHERE candidate.organization_id = $1::uuid
             AND candidate.canonical_order_id = $2::uuid
             AND candidate.provider = 'shopify'
             AND candidate.workflow_state = 'promoted'
           ORDER BY candidate.promoted_at DESC, candidate.id DESC`,
          [organizationId, order.id],
        )
        const requiredLineage = reconciliationResult.rows.filter((row) => (
          shopifyCheckoutRateLineageIsRequired(
            row.checkout_shipping_service_code,
          )
        ))
        const reconciliationOutcome = requiredLineage.length === 1
          ? requiredLineage[0].outcome
          : null
        if (
          requiredLineage.length > 0
          && (
            requiredLineage.length !== 1
            || !shopifyCheckoutRateOutcomeAllowsFulfillment(
              reconciliationOutcome,
            )
          )
        ) {
          throw new OperationsRequestError(
            'OPERATIONS_SHOPIFY_CHECKOUT_RATE_RECONCILIATION_REQUIRED',
            requiredLineage.length > 1
              ? 'Multiple ClawPilot checkout-rate lineage records exist; resolve the ambiguity before releasing warehouse work'
              : reconciliationOutcome
              ? `Shopify checkout-rate reconciliation is ${reconciliationOutcome}; resolve the immutable quote lineage before releasing warehouse work`
              : 'Shopify checkout-rate reconciliation is missing; reconcile the immutable quote lineage before releasing warehouse work',
            409,
          )
        }
      }

      const planResult = await client.query<QueryResultRow & {
        id: string
        global_id: string
        warehouse_id: string
        status: string
        method: string
        cartonization_evidence_id: string | null
        carrier_read_environment: string | null
        one_off_live_authority: boolean
      }>(
        `SELECT plan.id::text, plan.global_id, plan.warehouse_id::text,
                plan.status, plan.method,
                plan.cartonization_evidence_id::text,
                evidence.plan_snapshot->>'carrierReadEnvironment'
                  AS carrier_read_environment,
                operations_one_off_plan_authority_is_valid(
                  plan.organization_id, plan.order_id, plan.warehouse_id,
                  plan.one_off_quote_id, plan.one_off_offer_id, 'live'
                ) AS one_off_live_authority
         FROM operations_fulfillment_plans plan
         LEFT JOIN operations_cartonization_rate_evidence evidence
           ON evidence.organization_id = plan.organization_id
          AND evidence.id = plan.cartonization_evidence_id
         WHERE plan.organization_id = $1::uuid
           AND plan.order_id = $2::uuid
         ORDER BY plan.version_number DESC
         LIMIT 1
         FOR UPDATE OF plan`,
        [organizationId, order.id],
      )
      const plan = planResult.rows[0]
      if (!plan || plan.status !== 'planned') {
        throw new OperationsRequestError(
          'OPERATIONS_FULFILLMENT_PLAN_INVALID',
          'The latest fulfillment plan is not ready for release',
          409,
        )
      }
      if (
        activation.state === 'active'
        && (
          !plan.cartonization_evidence_id
          || plan.carrier_read_environment !== 'production'
        )
        && !plan.one_off_live_authority
      ) {
        throw new OperationsRequestError(
          'OPERATIONS_ACTIVE_RATE_EVIDENCE_REQUIRES_PRODUCTION',
          'Active warehouse release requires production carrier-read evidence. Return to Shadow or replan against production rates.',
          409,
        )
      }

      const readinessResult = await client.query<QueryResultRow & {
        line_count: string
        ready_line_count: string
        allocation_row_count: string
      }>(
        `SELECT
           count(*)::text AS line_count,
           count(*) FILTER (
             WHERE allocation.quantity = line.quantity
               AND allocation.valid_row_count = allocation.row_count
               AND allocation.row_count > 0
           )::text AS ready_line_count,
           COALESCE(sum(allocation.row_count), 0)::text AS allocation_row_count
         FROM operations_current_order_lines line
         LEFT JOIN LATERAL (
           SELECT sum(allocation.quantity) AS quantity,
                  count(*) AS row_count,
                  count(*) FILTER (
                    WHERE reservation.status = 'active'
                      AND reservation.order_line_id =
                            allocation.order_line_id
                      AND reservation.position_id =
                            allocation.position_id
                      AND reservation.quantity = allocation.quantity
                  ) AS valid_row_count
           FROM operations_fulfillment_allocations allocation
           LEFT JOIN operations_reservations reservation
             ON reservation.organization_id =
                  allocation.organization_id
            AND reservation.id = allocation.reservation_id
           WHERE allocation.organization_id = line.organization_id
             AND allocation.plan_id = $3::uuid
             AND allocation.order_line_id = line.id
         ) allocation ON true
         WHERE line.organization_id = $1::uuid AND line.order_id = $2::uuid`,
        [organizationId, order.id, plan.id],
      )
      const readiness = readinessResult.rows[0]
      const lineCount = Number(readiness?.line_count || 0)
      const allocationRowCount = Number(
        readiness?.allocation_row_count || 0,
      )
      if (lineCount < 1
        || Number(readiness?.ready_line_count || 0) !== lineCount
        || allocationRowCount < lineCount) {
        throw new OperationsRequestError(
          'OPERATIONS_ORDER_NOT_READY',
          'Every order line must have a complete reservation and allocation before release',
          409,
        )
      }
      const providerCommitmentRevalidation =
        await revalidateProviderCommitmentsForPlan(
          client,
          {
            organizationId,
            planId: plan.id,
          },
        )

      const blockingResult = await client.query<QueryResultRow & { count: string }>(
        `SELECT count(*)::text AS count
         FROM operations_exceptions
         WHERE organization_id = $1::uuid AND order_id = $2::uuid
           AND status IN ('open', 'acknowledged')
           AND severity IN ('high', 'critical')`,
        [organizationId, order.id],
      )
      if (Number(blockingResult.rows[0]?.count || 0) > 0) {
        throw new OperationsRequestError(
          'OPERATIONS_ORDER_BLOCKED_BY_EXCEPTION',
          'Resolve high or critical order exceptions before release',
          409,
        )
      }

      const waveResult = await client.query<IdRow>(
        `INSERT INTO operations_waves (
           organization_id, warehouse_id, name, status, optimization_method,
           released_by, released_at
         ) VALUES ($1::uuid, $2::uuid, $3, 'released', $4, $5, now())
         RETURNING id::text, global_id`,
        [organizationId, plan.warehouse_id, `Wave ${order.global_id}`, plan.method, actorEmail],
      )
      const wave = waveResult.rows[0]

      const planUpdate = await client.query(
        `UPDATE operations_fulfillment_plans
         SET status = 'released', updated_at = now()
         WHERE organization_id = $1::uuid AND id = $2::uuid AND status = 'planned'
         RETURNING id`,
        [organizationId, plan.id],
      )
      if (planUpdate.rowCount !== 1) {
        throw new OperationsRequestError('OPERATIONS_FULFILLMENT_PLAN_INVALID', 'Fulfillment plan changed before release', 409)
      }

      const pickResult = await client.query<QueryResultRow & { global_id: string }>(
        `INSERT INTO operations_pick_tasks (
           organization_id, wave_id, plan_id, allocation_id, from_location_id,
           quantity, sequence_number, status, assigned_to, assigned_at
         )
         SELECT allocation.organization_id, $3::uuid, allocation.plan_id, allocation.id,
                position.location_id, allocation.quantity,
                row_number() OVER (
                  ORDER BY location.pick_sequence, position.global_id,
                           allocation.id
                )::integer,
                'ready', $4, CASE WHEN $4::text IS NULL THEN NULL ELSE now() END
         FROM operations_fulfillment_allocations allocation
         JOIN operations_inventory_positions position
           ON position.organization_id = allocation.organization_id
          AND position.id = allocation.position_id
         JOIN operations_locations location
           ON location.organization_id = position.organization_id
          AND location.id = position.location_id
         WHERE allocation.organization_id = $1::uuid AND allocation.plan_id = $2::uuid
         ON CONFLICT (allocation_id) DO NOTHING
         RETURNING global_id`,
        [organizationId, plan.id, wave.id, assignedTo],
      )
      if (Number(pickResult.rowCount || 0) !== allocationRowCount) {
        throw new OperationsRequestError('OPERATIONS_PICK_TASKS_INCOMPLETE', 'Warehouse pick tasks could not be created', 409)
      }

      const updatedOrder = await client.query<OrderIdentityRow>(
        `UPDATE operations_orders
         SET status = 'released', updated_by = $4, updated_at = now(), row_version = row_version + 1
         WHERE organization_id = $1::uuid AND id = $2::uuid
           AND status = 'planned' AND row_version = $3
         RETURNING id::text, global_id, status, row_version::text`,
        [organizationId, order.id, input.expectedRowVersion, actorEmail],
      )
      const released = updatedOrder.rows[0]
      if (!released || released.row_version === undefined) {
        throw new OperationsRequestError(
          'OPERATIONS_ORDER_VERSION_CONFLICT',
          'This order changed before it could be released. Refresh and try again.',
          409,
        )
      }

      await appendDomainEvent(client, {
        organizationId,
        aggregateType: 'operations.order',
        aggregateId: order.id,
        aggregateGlobalId: order.global_id,
        eventType: 'operations.wave.released',
        actorEmail,
        correlationId: command.receipt.correlation_id,
        idempotencyKey: `${order.global_id}:release:${command.receipt.id}`,
        payload: {
          status: 'released',
          planGlobalId: plan.global_id,
          waveGlobalId: wave.global_id,
          pickTaskGlobalIds: pickResult.rows.map((row) => row.global_id),
          providerCommitmentsRevalidated:
            providerCommitmentRevalidation.count,
          providerCommitmentInventorySyncRunGlobalIds:
            providerCommitmentRevalidation
              .latestInventorySyncRunGlobalIds,
          reason,
          assignedTo,
        },
      })
      await recordAuditEvent({
        actor: actorEmail,
        eventType: 'operations.order.released',
        aggregateType: 'operations.order',
        aggregateId: order.global_id,
        subject: `Released ${order.global_id} to warehouse execution`,
        organizationId,
        eventKey: `operations:order-release:${command.receipt.id}`,
        payload: {
          previousStatus: 'planned',
          status: 'released',
          previousRowVersion: input.expectedRowVersion,
          rowVersion: Number(released.row_version),
          planGlobalId: plan.global_id,
          waveGlobalId: wave.global_id,
          providerCommitmentsRevalidated:
            providerCommitmentRevalidation.count,
          providerCommitmentInventorySyncRunGlobalIds:
            providerCommitmentRevalidation
              .latestInventorySyncRunGlobalIds,
          reason,
          assignedTo,
        },
      }, client)
      const result: OperationsOrderCommandResult = {
        orderGlobalId: released.global_id,
        orderStatus: released.status,
        rowVersion: Number(released.row_version),
        replayed: false,
      }
      await completeCommandReceipt(client, command.receipt.id, order.global_id, result)

      return result
    })
  } catch (error) {
    await failCommandReceipt(command.receipt.id, error)
    throw error
  }
}

export async function assignOperationsOrderPicksFromPostgres(input: {
  organizationId: string
  actorEmail: string
  orderGlobalId: string
  expectedRowVersion: number
  assignedTo: string
  reason: string
  idempotencyKey: string
}): Promise<OperationsOrderCommandResult> {
  const organizationId = requireOrganizationId(input.organizationId)
  const actorEmail = String(input.actorEmail || '').trim().toLowerCase()
  const orderGlobalId = String(input.orderGlobalId || '').trim()
  const assignedTo = String(input.assignedTo || '').trim().toLowerCase()
  const reason = String(input.reason || '').trim()
  const idempotencyKey = String(input.idempotencyKey || '').trim()
  if (!actorEmail) throw new OperationsRequestError('OPERATIONS_ACTOR_REQUIRED', 'A signed-in user is required', 401)
  if (!/^gor(?:[0-9]{7}|[0-9a-v]{12})$/.test(orderGlobalId)) {
    throw new OperationsRequestError('OPERATIONS_ORDER_INVALID', 'Order is invalid')
  }
  if (!Number.isSafeInteger(input.expectedRowVersion) || input.expectedRowVersion < 0) {
    throw new OperationsRequestError('OPERATIONS_ORDER_VERSION_INVALID', 'Order version is invalid')
  }
  if (!assignedTo.includes('@') || assignedTo.length > 254) {
    throw new OperationsRequestError('OPERATIONS_PICKER_INVALID', 'Choose a valid picker')
  }
  if (!reason || reason.length > 500) {
    throw new OperationsRequestError('OPERATIONS_ASSIGNMENT_REASON_INVALID', 'An assignment reason is required')
  }
  if (!/^[A-Za-z0-9._:-]{8,200}$/.test(idempotencyKey)) {
    throw new OperationsRequestError('OPERATIONS_IDEMPOTENCY_KEY_INVALID', 'A valid idempotency key is required')
  }

  const command = await prepareCommandReceipt({
    organizationId,
    commandType: 'assign_operations_order_picks',
    idempotencyKey,
    requestHash: commandRequestHash({
      orderGlobalId,
      expectedRowVersion: input.expectedRowVersion,
      assignedTo,
      reason,
    }),
    actorEmail,
    targetGlobalId: orderGlobalId,
  })
  if (command.completed) {
    return completedOrderCommandResult(organizationId, command.receipt)
  }

  try {
    return await withTransaction(async (client) => {
      await acquireTransactionAdvisoryLock(
        client,
        `operations:order:${organizationId}:${orderGlobalId}`,
      )
      await requireEligibleOperationsPicker(client, organizationId, assignedTo)
      const orderResult = await client.query<OrderIdentityRow>(
        `SELECT id::text, global_id, status, row_version::text
         FROM operations_orders
         WHERE organization_id = $1::uuid AND global_id = $2
         FOR UPDATE`,
        [organizationId, orderGlobalId],
      )
      const order = orderResult.rows[0]
      if (!order || order.row_version === undefined) {
        throw new OperationsRequestError('OPERATIONS_ORDER_NOT_FOUND', 'Operations order was not found', 404)
      }
      if (Number(order.row_version) !== input.expectedRowVersion) {
        throw new OperationsRequestError(
          'OPERATIONS_ORDER_VERSION_CONFLICT',
          'This order changed before the picker assignment was saved. Refresh and try again.',
          409,
        )
      }
      await requireCurrentCommerceOrderRevision(client, {
        organizationId,
        orderId: order.id,
        operation: 'assign',
      })
      if (order.status !== 'released') {
        throw new OperationsRequestError(
          'OPERATIONS_PICK_ASSIGNMENT_INVALID',
          'Only a released order with unstarted picks can be assigned',
          409,
        )
      }

      const assignmentContext = await lockManageablePickAssignment(client, {
        organizationId,
        orderId: order.id,
        orderRowVersion: input.expectedRowVersion,
      })
      const taskCount = assignmentContext.tasks.length

      const assignment = await client.query(
        `UPDATE operations_pick_tasks
         SET assigned_to = $3, assigned_at = now(), updated_at = now()
         WHERE organization_id = $1::uuid
           AND id = ANY($2::uuid[])
           AND status = 'ready'
           AND COALESCE(picked_quantity, 0) = 0
           AND picked_at IS NULL
         RETURNING id`,
        [
          organizationId,
          assignmentContext.tasks.map((task) => task.id),
          assignedTo,
        ],
      )
      if (Number(assignment.rowCount || 0) !== taskCount) {
        throw new OperationsRequestError(
          'OPERATIONS_PICK_ASSIGNMENT_INCOMPLETE',
          'Not every pick task could be assigned',
          409,
        )
      }

      const updated = await client.query<OrderIdentityRow>(
        `UPDATE operations_orders
         SET updated_by = $4, updated_at = now(), row_version = row_version + 1
         WHERE organization_id = $1::uuid
           AND id = $2::uuid
           AND status = 'released'
           AND row_version = $3
         RETURNING id::text, global_id, status, row_version::text`,
        [organizationId, order.id, input.expectedRowVersion, actorEmail],
      )
      const assignedOrder = updated.rows[0]
      if (!assignedOrder || assignedOrder.row_version === undefined) {
        throw new OperationsRequestError(
          'OPERATIONS_ORDER_VERSION_CONFLICT',
          'This order changed before the picker assignment was saved. Refresh and try again.',
          409,
        )
      }
      const result: OperationsOrderCommandResult = {
        orderGlobalId: assignedOrder.global_id,
        orderStatus: assignedOrder.status,
        rowVersion: Number(assignedOrder.row_version),
        replayed: false,
      }
      await appendDomainEvent(client, {
        organizationId,
        aggregateType: 'operations.order',
        aggregateId: order.id,
        aggregateGlobalId: order.global_id,
        eventType: 'operations.pick.assigned',
        actorEmail,
        correlationId: command.receipt.correlation_id,
        idempotencyKey: `picker-assignment:${command.receipt.id}`,
        payload: {
          previousAssignedTo: assignmentContext.previousAssignedTo,
          assignedTo,
          taskCount,
          reason,
          scanEvidenceCount: 0,
          countEvidenceCount: 0,
          physicalWorkStarted: false,
        },
      })
      await recordAuditEvent({
        actor: actorEmail,
        eventType: 'operations.pick.assigned',
        aggregateType: 'operations.order',
        aggregateId: order.global_id,
        subject: `Assigned ${order.global_id} picks to ${assignedTo}`,
        organizationId,
        eventKey: `operations:pick-assignment:${command.receipt.id}`,
        payload: {
          assignedTo,
          previousAssignedTo: assignmentContext.previousAssignedTo,
          taskCount,
          reason,
          previousRowVersion: input.expectedRowVersion,
          rowVersion: result.rowVersion,
        },
      }, client)
      await completeCommandReceipt(client, command.receipt.id, order.global_id, result)
      return result
    })
  } catch (error) {
    await failCommandReceipt(command.receipt.id, error)
    throw error
  }
}

export async function manageOperationsOrderPickAssignmentFromPostgres(input: {
  organizationId: string
  actorEmail: string
  orderGlobalId: string
  expectedRowVersion: number
  expectedTaskCount: number
  expectedAssignmentFingerprint: string
  assignedTo: string | null
  reason: string
  idempotencyKey: string
}): Promise<OperationsManagePickAssignmentResult> {
  const organizationId = requireOrganizationId(input.organizationId)
  const actorEmail = String(input.actorEmail || '').trim().toLowerCase()
  const orderGlobalId = String(input.orderGlobalId || '').trim()
  const assignedTo = String(input.assignedTo || '').trim().toLowerCase() || null
  const expectedAssignmentFingerprint = String(
    input.expectedAssignmentFingerprint || '',
  ).trim().toLowerCase()
  const reason = String(input.reason || '').trim()
  const idempotencyKey = String(input.idempotencyKey || '').trim()
  if (!actorEmail) {
    throw new OperationsRequestError(
      'OPERATIONS_ACTOR_REQUIRED',
      'A signed-in user is required',
      401,
    )
  }
  if (!/^gor(?:[0-9]{7}|[0-9a-v]{12})$/.test(orderGlobalId)) {
    throw new OperationsRequestError(
      'OPERATIONS_ORDER_INVALID',
      'Order is invalid',
    )
  }
  if (
    !Number.isSafeInteger(input.expectedRowVersion)
    || input.expectedRowVersion < 0
  ) {
    throw new OperationsRequestError(
      'OPERATIONS_ORDER_VERSION_INVALID',
      'Order version is invalid',
    )
  }
  if (
    !Number.isSafeInteger(input.expectedTaskCount)
    || input.expectedTaskCount < 1
    || input.expectedTaskCount > 200
  ) {
    throw new OperationsRequestError(
      'OPERATIONS_PICK_ASSIGNMENT_TASKS_CHANGED',
      'Expected pick task count is invalid',
    )
  }
  if (!/^[a-f0-9]{64}$/.test(expectedAssignmentFingerprint)) {
    throw new OperationsRequestError(
      'OPERATIONS_PICK_ASSIGNMENT_CHANGED',
      'Expected picker-assignment fingerprint is invalid',
    )
  }
  if (assignedTo && (!assignedTo.includes('@') || assignedTo.length > 254)) {
    throw new OperationsRequestError(
      'OPERATIONS_PICKER_INVALID',
      'Choose a valid picker or explicitly leave the work unassigned',
    )
  }
  if (!reason || reason.length > 500 || /[\u0000-\u001f\u007f]/u.test(reason)) {
    throw new OperationsRequestError(
      'OPERATIONS_ASSIGNMENT_REASON_INVALID',
      'A manager intervention reason is required',
    )
  }
  if (!/^[A-Za-z0-9._:-]{8,200}$/.test(idempotencyKey)) {
    throw new OperationsRequestError(
      'OPERATIONS_IDEMPOTENCY_KEY_INVALID',
      'A valid idempotency key is required',
    )
  }

  const command = await prepareCommandReceipt({
    organizationId,
    commandType: 'manage_operations_order_pick_assignment',
    idempotencyKey,
    requestHash: commandRequestHash({
      orderGlobalId,
      expectedRowVersion: input.expectedRowVersion,
      expectedTaskCount: input.expectedTaskCount,
      expectedAssignmentFingerprint,
      assignedTo,
      reason,
    }),
    actorEmail,
    targetGlobalId: orderGlobalId,
  })
  if (command.completed) {
    return completedManagePickAssignmentResult(command.receipt)
  }

  try {
    return await withTransaction(async (client) => {
      await acquireTransactionAdvisoryLock(
        client,
        `operations:order:${organizationId}:${orderGlobalId}`,
      )
      const orderResult = await client.query<OrderIdentityRow>(
        `SELECT id::text, global_id, status, row_version::text
         FROM operations_orders
         WHERE organization_id = $1::uuid AND global_id = $2
         FOR UPDATE`,
        [organizationId, orderGlobalId],
      )
      const order = orderResult.rows[0]
      if (!order || order.row_version === undefined) {
        throw new OperationsRequestError(
          'OPERATIONS_ORDER_NOT_FOUND',
          'Operations order was not found',
          404,
        )
      }
      if (Number(order.row_version) !== input.expectedRowVersion) {
        throw new OperationsRequestError(
          'OPERATIONS_ORDER_VERSION_CONFLICT',
          'This order changed before the manager intervention was saved. Refresh and try again.',
          409,
        )
      }
      await requireCurrentCommerceOrderRevision(client, {
        organizationId,
        orderId: order.id,
        operation: 'assign',
      })
      if (order.status !== 'released') {
        throw new OperationsRequestError(
          'OPERATIONS_PICK_ASSIGNMENT_INVALID',
          'Only a released order with unstarted picks can change assignment',
          409,
        )
      }
      if (assignedTo) {
        await requireEligibleOperationsPicker(client, organizationId, assignedTo)
      }

      const assignmentContext = await lockManageablePickAssignment(client, {
        organizationId,
        orderId: order.id,
        orderRowVersion: input.expectedRowVersion,
        expectedTaskCount: input.expectedTaskCount,
        expectedAssignmentFingerprint,
      })
      if (
        assignmentContext.previousAssignedTo !== 'mixed'
        && assignmentContext.previousAssignedTo === assignedTo
      ) {
        throw new OperationsRequestError(
          'OPERATIONS_PICK_ASSIGNMENT_UNCHANGED',
          assignedTo
            ? 'This picker is already assigned to every task'
            : 'Every pick task is already unassigned',
          409,
        )
      }

      const assignment = await client.query(
        `UPDATE operations_pick_tasks
         SET assigned_to = $3,
             assigned_at = CASE WHEN $3::text IS NULL THEN NULL ELSE now() END,
             updated_at = now()
         WHERE organization_id = $1::uuid
           AND id = ANY($2::uuid[])
           AND status = 'ready'
           AND COALESCE(picked_quantity, 0) = 0
           AND picked_at IS NULL
         RETURNING id`,
        [
          organizationId,
          assignmentContext.tasks.map((task) => task.id),
          assignedTo,
        ],
      )
      if (
        Number(assignment.rowCount || 0) !== assignmentContext.tasks.length
      ) {
        throw new OperationsRequestError(
          'OPERATIONS_PICK_ASSIGNMENT_TASKS_CHANGED',
          'Pick tasks changed before the manager intervention was saved',
          409,
        )
      }

      const updatedOrder = await client.query<OrderIdentityRow>(
        `UPDATE operations_orders
         SET updated_by = $4, updated_at = now(), row_version = row_version + 1
         WHERE organization_id = $1::uuid
           AND id = $2::uuid
           AND status = 'released'
           AND row_version = $3
         RETURNING id::text, global_id, status, row_version::text`,
        [organizationId, order.id, input.expectedRowVersion, actorEmail],
      )
      const managedOrder = updatedOrder.rows[0]
      if (!managedOrder || managedOrder.row_version === undefined) {
        throw new OperationsRequestError(
          'OPERATIONS_ORDER_VERSION_CONFLICT',
          'This order changed before the manager intervention was saved',
          409,
        )
      }
      const rowVersion = Number(managedOrder.row_version)

      let interventionExceptionGlobalId =
        assignmentContext.openManagerInterventionExceptionGlobalId
      if (!assignedTo && !interventionExceptionGlobalId) {
        const exceptionDetails = {
          commandReceiptId: command.receipt.id,
          orderGlobalId,
          previousAssignedTo: assignmentContext.previousAssignedTo,
          assignedTaskCount: assignmentContext.tasks.length,
          reason,
          previousRowVersion: input.expectedRowVersion,
          rowVersion,
          openHandoffExceptionGlobalId:
            assignmentContext.openHandoffExceptionGlobalId,
          priorManagerInterventionExceptionGlobalId:
            assignmentContext.openManagerInterventionExceptionGlobalId,
          scanEvidenceCount: 0,
          countEvidenceCount: 0,
          durableEvidenceCleared: false,
          physicalWorkChanged: false,
          providerWrites: 0,
          recommendedAction: [
            'Review why the manager removed the picker.',
            'Assign every exact ready task to an eligible picker before work resumes.',
            'If physical picking has begun outside ClawPilot, reconcile that work instead of assigning over it.',
          ].join(' '),
        }
        const exceptionResult = await client.query<IdRow>(
          `INSERT INTO operations_exceptions (
             organization_id, order_id, exception_type, severity, status,
             title, details, assigned_to
           ) VALUES (
             $1::uuid, $2::uuid, 'manager_pick_intervention', 'high', 'open',
             $3, $4::jsonb, $5
           )
           RETURNING id::text, global_id`,
          [
            organizationId,
            order.id,
            `Manager removed picker from ${order.global_id}`,
            JSON.stringify(exceptionDetails),
            actorEmail,
          ],
        )
        const exception = exceptionResult.rows[0]
        if (!exception) {
          throw new OperationsRequestError(
            'OPERATIONS_PICK_INTERVENTION_EXCEPTION_FAILED',
            'Manager intervention could not be retained',
            500,
          )
        }
        interventionExceptionGlobalId = exception.global_id
      }

      const previousAssignedTo = assignmentContext.previousAssignedTo
      const eventType = !assignedTo
        ? 'operations.pick.manager_unassigned'
        : previousAssignedTo === null
          ? 'operations.pick.assigned'
          : 'operations.pick.reassigned'
      const eventPayload = {
        previousAssignedTo,
        assignedTo,
        taskCount: assignmentContext.tasks.length,
        pickTaskGlobalIds:
          assignmentContext.tasks.map((task) => task.global_id),
        planGlobalId: assignmentContext.plan.global_id,
        waveGlobalId: assignmentContext.wave.global_id,
        openHandoffExceptionGlobalId:
          assignmentContext.openHandoffExceptionGlobalId,
        interventionExceptionGlobalId,
        previousRowVersion: input.expectedRowVersion,
        rowVersion,
        reason,
        scanEvidenceCount: 0,
        countEvidenceCount: 0,
        durableEvidenceCleared: false,
        physicalWorkChanged: false,
        providerWrites: 0,
      }
      await appendDomainEvent(client, {
        organizationId,
        aggregateType: 'operations.order',
        aggregateId: order.id,
        aggregateGlobalId: order.global_id,
        eventType,
        actorEmail,
        correlationId: command.receipt.correlation_id,
        idempotencyKey:
          `${order.global_id}:manager-pick-assignment:${command.receipt.id}`,
        payload: eventPayload,
      })
      await recordAuditEvent({
        actor: actorEmail,
        eventType: `operations.order.${eventType.split('.').slice(1).join('_')}`,
        aggregateType: 'operations.order',
        aggregateId: order.global_id,
        subject: assignedTo
          ? `Assigned ${order.global_id} picks to ${assignedTo}`
          : `Manager removed picker from ${order.global_id}`,
        organizationId,
        eventKey: `operations:manager-pick-assignment:${command.receipt.id}`,
        payload: eventPayload,
      }, client)

      const result: OperationsManagePickAssignmentResult = {
        orderGlobalId: managedOrder.global_id,
        orderStatus: 'released',
        previousRowVersion: input.expectedRowVersion,
        rowVersion,
        taskCount: assignmentContext.tasks.length,
        previousAssignedTo,
        assignedTo,
        interventionExceptionGlobalId,
        providerWrites: 0,
        replayed: false,
      }
      await completeCommandReceipt(
        client,
        command.receipt.id,
        order.global_id,
        result,
      )
      return result
    })
  } catch (error) {
    await failCommandReceipt(command.receipt.id, error)
    throw error
  }
}

type PickHandoffTaskRow = QueryResultRow & {
  id: string
  global_id: string
  wave_id: string
  status: string
  assigned_to: string | null
  picked_quantity: string | null
  picked_at: string | Date | null
}

type BlockedPickConfirmationReceiptRow = QueryResultRow & {
  id: string
  target_global_id: string | null
  actor_email: string
  status: 'processing' | 'succeeded' | 'failed'
  error_code: string | null
  request_hash: string
}

export async function requestOperationsPickHandoffFromPostgres(input: {
  organizationId: string
  actorEmail: string
  orderGlobalId: string
  expectedRowVersion: number
  expectedAssignedTaskCount: number
  reason: string
  blockedConfirmationIdempotencyKey?: string
  idempotencyKey: string
}): Promise<OperationsPickHandoffResult> {
  const organizationId = requireOrganizationId(input.organizationId)
  const actorEmail = String(input.actorEmail || '').trim().toLowerCase()
  const orderGlobalId = String(input.orderGlobalId || '').trim()
  const reason = String(input.reason || '').trim()
  const blockedConfirmationIdempotencyKey = String(
    input.blockedConfirmationIdempotencyKey || '',
  ).trim() || undefined
  const idempotencyKey = String(input.idempotencyKey || '').trim()
  if (!actorEmail) {
    throw new OperationsRequestError(
      'OPERATIONS_ACTOR_REQUIRED',
      'A signed-in user is required',
      401,
    )
  }
  if (!/^gor(?:[0-9]{7}|[0-9a-v]{12})$/.test(orderGlobalId)) {
    throw new OperationsRequestError(
      'OPERATIONS_ORDER_INVALID',
      'Order is invalid',
    )
  }
  if (!Number.isSafeInteger(input.expectedRowVersion) || input.expectedRowVersion < 0) {
    throw new OperationsRequestError(
      'OPERATIONS_ORDER_VERSION_INVALID',
      'Order version is invalid',
    )
  }
  if (
    !Number.isSafeInteger(input.expectedAssignedTaskCount)
    || input.expectedAssignedTaskCount < 1
    || input.expectedAssignedTaskCount > 200
  ) {
    throw new OperationsRequestError(
      'OPERATIONS_PICK_HANDOFF_TASKS_CHANGED',
      'Assigned task count is invalid',
    )
  }
  if (!reason || reason.length > 500 || /[\u0000-\u001f\u007f]/u.test(reason)) {
    throw new OperationsRequestError(
      'OPERATIONS_PICK_HANDOFF_REASON_INVALID',
      'A picker handoff reason is required',
    )
  }
  if (!/^[A-Za-z0-9._:-]{8,200}$/.test(idempotencyKey)) {
    throw new OperationsRequestError(
      'OPERATIONS_IDEMPOTENCY_KEY_INVALID',
      'A valid idempotency key is required',
    )
  }
  if (
    blockedConfirmationIdempotencyKey
    && !/^[A-Za-z0-9._:-]{8,200}$/.test(blockedConfirmationIdempotencyKey)
  ) {
    throw new OperationsRequestError(
      'OPERATIONS_PICK_HANDOFF_CONFIRMATION_INVALID',
      'Blocked confirmation idempotency key is invalid',
    )
  }

  const command = await prepareCommandReceipt({
    organizationId,
    commandType: 'request_operations_pick_handoff',
    idempotencyKey,
    requestHash: commandRequestHash({
      orderGlobalId,
      expectedRowVersion: input.expectedRowVersion,
      expectedAssignedTaskCount: input.expectedAssignedTaskCount,
      actorEmail,
      reason,
      blockedConfirmationIdempotencyKey:
        blockedConfirmationIdempotencyKey || null,
    }),
    actorEmail,
    targetGlobalId: orderGlobalId,
  })
  if (command.completed) return completedPickHandoffResult(command.receipt)

  try {
    return await withTransaction(async (client) => {
      await acquireTransactionAdvisoryLock(
        client,
        `operations:order:${organizationId}:${orderGlobalId}`,
      )
      const orderResult = await client.query<OrderIdentityRow>(
        `SELECT id::text, global_id, status, row_version::text
         FROM operations_orders
         WHERE organization_id = $1::uuid AND global_id = $2
         FOR UPDATE`,
        [organizationId, orderGlobalId],
      )
      const order = orderResult.rows[0]
      if (!order || order.row_version === undefined) {
        throw new OperationsRequestError(
          'OPERATIONS_ORDER_NOT_FOUND',
          'Operations order was not found',
          404,
        )
      }
      if (Number(order.row_version) !== input.expectedRowVersion) {
        throw new OperationsRequestError(
          'OPERATIONS_ORDER_VERSION_CONFLICT',
          'This order changed before the picker handoff was requested. Refresh and try again.',
          409,
        )
      }
      if (order.status !== 'released') {
        throw new OperationsRequestError(
          'OPERATIONS_PICK_HANDOFF_INVALID',
          'Only a released order with wholly unpicked work can be handed off',
          409,
        )
      }

      const planResult = await client.query<IdRow & { status: string }>(
        `SELECT id::text, global_id, status
         FROM operations_fulfillment_plans
         WHERE organization_id = $1::uuid AND order_id = $2::uuid
         ORDER BY version_number DESC
         LIMIT 1
         FOR UPDATE`,
        [organizationId, order.id],
      )
      const plan = planResult.rows[0]
      if (!plan || plan.status !== 'released') {
        throw new OperationsRequestError(
          'OPERATIONS_PICK_HANDOFF_INVALID',
          'The released fulfillment plan is unavailable for picker handoff',
          409,
        )
      }

      const waveResult = await client.query<IdRow & { status: string }>(
        `SELECT wave.id::text, wave.global_id, wave.status
         FROM operations_waves wave
         WHERE wave.organization_id = $1::uuid
           AND wave.id IN (
             SELECT DISTINCT pick.wave_id
             FROM operations_pick_tasks pick
             WHERE pick.organization_id = $1::uuid
               AND pick.plan_id = $2::uuid
           )
         ORDER BY wave.id
         FOR UPDATE`,
        [organizationId, plan.id],
      )
      if (waveResult.rows.length !== 1 || waveResult.rows[0].status !== 'released') {
        throw new OperationsRequestError(
          'OPERATIONS_PICK_HANDOFF_INVALID',
          'Exactly one released warehouse wave is required for picker handoff',
          409,
        )
      }
      const wave = waveResult.rows[0]

      const pickResult = await client.query<PickHandoffTaskRow>(
        `SELECT pick.id::text, pick.global_id,
                pick.wave_id::text, pick.status,
                lower(pick.assigned_to) AS assigned_to,
                pick.picked_quantity::text, pick.picked_at
         FROM operations_pick_tasks pick
         WHERE pick.organization_id = $1::uuid
           AND pick.plan_id = $2::uuid
         ORDER BY pick.sequence_number, pick.id
         FOR UPDATE`,
        [organizationId, plan.id],
      )
      if (pickResult.rows.length < 1) {
        throw new OperationsRequestError(
          'OPERATIONS_PICK_HANDOFF_INVALID',
          'No assigned pick tasks are available for handoff',
          409,
        )
      }
      if (pickResult.rows.length !== input.expectedAssignedTaskCount) {
        throw new OperationsRequestError(
          'OPERATIONS_PICK_HANDOFF_TASKS_CHANGED',
          'Assigned pick tasks changed before handoff could be recorded',
          409,
        )
      }
      if (pickResult.rows.some((pick) => (
        pick.wave_id !== wave.id
        || pick.status !== 'ready'
        || Number(pick.picked_quantity || 0) !== 0
        || pick.picked_at !== null
      ))) {
        throw new OperationsRequestError(
          'OPERATIONS_PICK_HANDOFF_ALREADY_STARTED',
          'Picker handoff is blocked after any task has started or recorded a picked quantity',
          409,
        )
      }
      if (pickResult.rows.some((pick) => pick.assigned_to !== actorEmail)) {
        throw new OperationsRequestError(
          'OPERATIONS_PICK_HANDOFF_ACTOR_MISMATCH',
          'Every pick task must be assigned to the signed-in picker requesting handoff',
          409,
        )
      }

      const acknowledgedScanResult = await client.query<{
        id: string
        command_receipt_id: string
      }>(
        `SELECT evidence.id::text, receipt.id::text AS command_receipt_id
         FROM operations_wearable_pick_scan_evidence evidence
         JOIN operations_command_receipts receipt
           ON receipt.organization_id = evidence.organization_id
          AND receipt.id = evidence.command_receipt_id
         WHERE evidence.organization_id = $1::uuid
           AND evidence.order_id = $2::uuid
           AND evidence.order_row_version = $3::bigint
           AND lower(evidence.recorded_by) = $4
           AND receipt.command_type = 'record_wearable_pick_scan_evidence'
           AND receipt.status = 'succeeded'
           AND lower(receipt.actor_email) = $4
           AND receipt.target_global_id = $5
         ORDER BY evidence.server_observed_at, evidence.id
         LIMIT 1
         FOR SHARE OF evidence, receipt`,
        [
          organizationId,
          order.id,
          input.expectedRowVersion,
          actorEmail,
          orderGlobalId,
        ],
      )
      const acknowledgedScan = acknowledgedScanResult.rows[0]
      if (blockedConfirmationIdempotencyKey && !acknowledgedScan) {
        throw new OperationsRequestError(
          'OPERATIONS_PICK_HANDOFF_CONFIRMATION_INVALID',
          'Blocked confirmation handoff requires exact acknowledged wearable scan evidence for this picker, order, and version',
          409,
        )
      }
      if (!blockedConfirmationIdempotencyKey && acknowledgedScan) {
        throw new OperationsRequestError(
          'OPERATIONS_PICK_HANDOFF_ALREADY_STARTED',
          'Picker handoff is blocked after wearable scan evidence was acknowledged',
          409,
        )
      }

      const packageResult = await client.query<QueryResultRow & {
        id: string
        status: string
        packed_at: string | Date | null
      }>(
        `SELECT package.id::text, package.status, package.packed_at
         FROM operations_packages package
         WHERE package.organization_id = $1::uuid
           AND package.plan_id = $2::uuid
         ORDER BY package.id
         FOR UPDATE`,
        [organizationId, plan.id],
      )
      if (packageResult.rows.some((item) => (
        item.status !== 'planned' || item.packed_at !== null
      ))) {
        throw new OperationsRequestError(
          'OPERATIONS_PICK_HANDOFF_ALREADY_STARTED',
          'Picker handoff is blocked after packing has started',
          409,
        )
      }
      const labelResult = await client.query<{ id: string }>(
        `SELECT label.id::text
         FROM operations_labels label
         JOIN operations_packages package
           ON package.organization_id = label.organization_id
          AND package.id = label.package_id
         WHERE label.organization_id = $1::uuid
           AND package.plan_id = $2::uuid
         ORDER BY label.id
         FOR UPDATE OF label`,
        [organizationId, plan.id],
      )
      const labelAttemptResult = await client.query<{ id: string }>(
        `SELECT attempt.id::text
         FROM operations_label_attempts attempt
         WHERE attempt.organization_id = $1::uuid
           AND attempt.order_id = $2::uuid
         ORDER BY attempt.id
         FOR UPDATE`,
        [organizationId, order.id],
      )
      if (labelResult.rows.length > 0 || labelAttemptResult.rows.length > 0) {
        throw new OperationsRequestError(
          'OPERATIONS_PICK_HANDOFF_ALREADY_STARTED',
          'Picker handoff is blocked after label preparation has started',
          409,
        )
      }

      let blockedConfirmationErrorCode: string | null = null
      let blockedConfirmationRequestHash: string | null = null
      if (blockedConfirmationIdempotencyKey) {
        const blockedReceiptResult = await client.query<
          BlockedPickConfirmationReceiptRow
        >(
          `SELECT id::text, target_global_id, lower(actor_email) AS actor_email,
                  status, error_code, request_hash
           FROM operations_command_receipts
           WHERE organization_id = $1::uuid
             AND command_type = 'confirm_operations_order_picks'
             AND idempotency_key = $2
           LIMIT 1
           FOR UPDATE`,
          [organizationId, blockedConfirmationIdempotencyKey],
        )
        const blockedReceipt = blockedReceiptResult.rows[0]
        if (
          !blockedReceipt
          || blockedReceipt.target_global_id !== orderGlobalId
          || blockedReceipt.actor_email !== actorEmail
          || blockedReceipt.status !== 'failed'
          || blockedReceipt.error_code
            !== 'OPERATIONS_SHOPIFY_EXTERNAL_FULFILLMENT_RECONCILIATION_REQUIRED'
        ) {
          throw new OperationsRequestError(
            'OPERATIONS_PICK_HANDOFF_CONFIRMATION_INVALID',
            'Blocked confirmation must be the exact Shopify reconciliation conflict for this picker and order',
            409,
          )
        }
        blockedConfirmationErrorCode = blockedReceipt.error_code
        blockedConfirmationRequestHash = blockedReceipt.request_hash
      }

      const taskIds = pickResult.rows.map((pick) => pick.id)
      const unassigned = await client.query(
        `UPDATE operations_pick_tasks
         SET assigned_to = NULL, assigned_at = NULL, updated_at = now()
         WHERE organization_id = $1::uuid
           AND id = ANY($2::uuid[])
           AND status = 'ready'
           AND COALESCE(picked_quantity, 0) = 0
           AND picked_at IS NULL
           AND lower(assigned_to) = $3
         RETURNING id`,
        [organizationId, taskIds, actorEmail],
      )
      if (Number(unassigned.rowCount || 0) !== taskIds.length) {
        throw new OperationsRequestError(
          'OPERATIONS_PICK_HANDOFF_TASKS_CHANGED',
          'Pick tasks changed before handoff could be recorded',
          409,
        )
      }

      const updatedOrder = await client.query<OrderIdentityRow>(
        `UPDATE operations_orders
         SET updated_by = $4, updated_at = now(), row_version = row_version + 1
         WHERE organization_id = $1::uuid
           AND id = $2::uuid
           AND status = 'released'
           AND row_version = $3
         RETURNING id::text, global_id, status, row_version::text`,
        [organizationId, order.id, input.expectedRowVersion, actorEmail],
      )
      const handedOffOrder = updatedOrder.rows[0]
      if (!handedOffOrder || handedOffOrder.row_version === undefined) {
        throw new OperationsRequestError(
          'OPERATIONS_ORDER_VERSION_CONFLICT',
          'This order changed before the picker handoff was saved',
          409,
        )
      }

      const rowVersion = Number(handedOffOrder.row_version)
      const recommendedAction = [
        'Review the picker reason and current provider state.',
        'Either reassign every ready task to an eligible picker, then resolve this exception,',
        'or use the separate external-fulfillment reconciliation/cancel path when its evidence supports that disposition.',
        'This handoff did not modify Shopify, and resolving the exception alone does not reassign work.',
      ].join(' ')
      const exceptionDetails = {
        commandReceiptId: command.receipt.id,
        orderGlobalId,
        actorEmail,
        assignedTaskCount: taskIds.length,
        reason,
        previousRowVersion: input.expectedRowVersion,
        rowVersion,
        blockedConfirmationIdempotencyKey:
          blockedConfirmationIdempotencyKey || null,
        blockedConfirmationErrorCode,
        blockedConfirmationRequestHash,
        blockedConfirmationScanEvidenceId: acknowledgedScan?.id || null,
        blockedConfirmationScanEvidenceReceiptId:
          acknowledgedScan?.command_receipt_id || null,
        recommendedAction,
        providerWrites: 0,
      }
      const exceptionResult = await client.query<IdRow>(
        `INSERT INTO operations_exceptions (
           organization_id, order_id, exception_type, severity, status,
           title, details, assigned_to
         ) VALUES (
           $1::uuid, $2::uuid, 'picker_handoff_requested', 'high', 'open',
           $3, $4::jsonb, NULL
         )
         RETURNING id::text, global_id`,
        [
          organizationId,
          order.id,
          `Picker handoff requested for ${order.global_id}`,
          JSON.stringify(exceptionDetails),
        ],
      )
      const exception = exceptionResult.rows[0]
      if (!exception) {
        throw new OperationsRequestError(
          'OPERATIONS_PICK_HANDOFF_EXCEPTION_FAILED',
          'Picker handoff exception could not be retained',
          500,
        )
      }

      const eventPayload = {
        exceptionGlobalId: exception.global_id,
        planGlobalId: plan.global_id,
        waveGlobalId: wave.global_id,
        ...exceptionDetails,
      }
      await appendDomainEvent(client, {
        organizationId,
        aggregateType: 'operations.order',
        aggregateId: order.id,
        aggregateGlobalId: order.global_id,
        eventType: 'operations.pick.handoff_requested',
        actorEmail,
        correlationId: command.receipt.correlation_id,
        idempotencyKey: `${order.global_id}:pick-handoff:${command.receipt.id}`,
        payload: eventPayload,
      })
      await recordAuditEvent({
        actor: actorEmail,
        eventType: 'operations.order.pick_handoff_requested',
        aggregateType: 'operations.order',
        aggregateId: order.global_id,
        subject: `Picker handoff requested for ${order.global_id}`,
        organizationId,
        eventKey: `operations:pick-handoff:${command.receipt.id}`,
        payload: eventPayload,
      }, client)

      const result: OperationsPickHandoffResult = {
        orderGlobalId: handedOffOrder.global_id,
        orderStatus: 'released',
        previousRowVersion: input.expectedRowVersion,
        rowVersion,
        exceptionGlobalId: exception.global_id,
        assignedTaskCount: taskIds.length,
        blockedConfirmationIdempotencyKey:
          blockedConfirmationIdempotencyKey || null,
        providerWrites: 0,
        replayed: false,
      }
      await completeCommandReceipt(
        client,
        command.receipt.id,
        order.global_id,
        result,
      )
      return result
    })
  } catch (error) {
    await failCommandReceipt(command.receipt.id, error)
    throw error
  }
}

type WearablePickScanContextRow = QueryResultRow & {
  pick_task_id: string
  pick_task_global_id: string
  pick_status: string
  quantity: string
  assigned_to: string | null
  assigned_at: string | Date | null
  pick_created_at: string | Date
  warehouse_id: string
  warehouse_global_id: string
  location_id: string
  location_global_id: string
  policy_location_scan_required: boolean
  policy_row_version: string
  policy_updated_at: string | Date | null
  wave_released_at: string | Date | null
  assigned_product_barcode: string | null
  provider_product_barcode: string | null
}

type WearablePickScanEvidenceRow = QueryResultRow & {
  pick_task_id: string
  order_id: string
  order_row_version: string
  warehouse_id: string
  location_id: string
  policy_row_version: string
  expected_location_barcode: string
  observed_location_barcode: string
  location_captured_at: string | Date
  location_source: 'iphone_camera' | 'meta'
  expected_product_barcode: string
  observed_product_barcode: string
  product_captured_at: string | Date
  product_source: 'iphone_camera' | 'meta'
  evidence_hash: string
}

export type WearablePickScanEvidenceCommandResult = {
  orderGlobalId: string
  orderRowVersion: number
  evidenceCount: number
  serverObservedAt: string
  replayed: boolean
}

const WEARABLE_SCAN_MAX_AGE_MS = 24 * 60 * 60 * 1_000
const WEARABLE_SCAN_CLOCK_SKEW_MS = 5 * 60 * 1_000
const WEARABLE_LOCATION_TO_PRODUCT_MAX_MS = 30 * 60 * 1_000
const WEARABLE_PRODUCT_TO_COUNT_MAX_MS = 30 * 60 * 1_000

function wearableScanExpectedProductBarcode(row: WearablePickScanContextRow) {
  if (row.assigned_product_barcode) return row.assigned_product_barcode
  return providerBarcodeIdentity(row.provider_product_barcode)?.value || null
}

function wearableProductBarcodeMatches(observed: string, expected: string) {
  if (observed === expected) return true
  if (
    observed.length === 13
    && observed.startsWith('0')
    && observed.slice(1) === expected
    && /^\d+$/.test(observed)
    && /^\d+$/.test(expected)
  ) return true
  return expected.length === 13
    && expected.startsWith('0')
    && expected.slice(1) === observed
    && /^\d+$/.test(observed)
    && /^\d+$/.test(expected)
}

function wearableScanTime(value: string | Date | null, label: string) {
  if (value === null) return null
  const parsed = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(parsed.getTime())) {
    throw new OperationsRequestError(
      'OPERATIONS_WEARABLE_SCAN_EVIDENCE_INVALID',
      `${label} is invalid`,
      409,
    )
  }
  return parsed
}

function wearableCountTime(value: string | Date | null, label: string) {
  if (value === null) return null
  const parsed = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(parsed.getTime())) {
    throw new OperationsRequestError(
      'OPERATIONS_WEARABLE_COUNT_EVIDENCE_INVALID',
      `${label} is invalid`,
      409,
    )
  }
  return parsed
}

async function readWearablePickScanContexts(
  client: PoolClient,
  input: {
    organizationId: string
    orderId: string
    planId: string
    waveId: string
  },
) {
  const result = await client.query<WearablePickScanContextRow>(
    `SELECT pick.id::text AS pick_task_id,
            pick.global_id AS pick_task_global_id,
            pick.status AS pick_status,
            pick.quantity::text,
            lower(pick.assigned_to) AS assigned_to,
            pick.assigned_at,
            pick.created_at AS pick_created_at,
            warehouse.id::text AS warehouse_id,
            warehouse.global_id AS warehouse_global_id,
            location.id::text AS location_id,
            location.global_id AS location_global_id,
            COALESCE(scan_policy.location_scan_required, false)
              AS policy_location_scan_required,
            COALESCE(scan_policy.row_version, 0)::text AS policy_row_version,
            scan_policy.updated_at AS policy_updated_at,
            wave.released_at AS wave_released_at,
            product_barcode.barcode_value AS assigned_product_barcode,
            product_channel.provider_barcode AS provider_product_barcode
     FROM operations_pick_tasks pick
     JOIN operations_fulfillment_allocations allocation
       ON allocation.organization_id = pick.organization_id
      AND allocation.id = pick.allocation_id
     JOIN operations_current_order_lines line
       ON line.organization_id = allocation.organization_id
      AND line.id = allocation.order_line_id
     JOIN operations_orders orders
       ON orders.organization_id = line.organization_id
      AND orders.id = line.order_id
     JOIN operations_waves wave
       ON wave.organization_id = pick.organization_id
      AND wave.id = pick.wave_id
     JOIN operations_locations location
       ON location.organization_id = pick.organization_id
      AND location.id = pick.from_location_id
     JOIN operations_warehouses warehouse
       ON warehouse.organization_id = location.organization_id
      AND warehouse.id = location.warehouse_id
      AND warehouse.id = wave.warehouse_id
     LEFT JOIN operations_wearable_location_scan_policies scan_policy
       ON scan_policy.organization_id = warehouse.organization_id
      AND scan_policy.warehouse_id = warehouse.id
     LEFT JOIN operations_product_barcodes product_barcode
       ON product_barcode.organization_id = line.organization_id
      AND product_barcode.pipeline_id = line.pipeline_id
      AND product_barcode.product_id = line.product_id
     LEFT JOIN LATERAL (
       SELECT channel.provider_barcode
       FROM operations_product_channel_states channel
       WHERE channel.organization_id = line.organization_id
         AND channel.integration_account_id = orders.integration_account_id
         AND channel.pipeline_id = line.pipeline_id
         AND channel.product_id = line.product_id
         AND channel.provider_sku = line.channel_sku
         AND channel.provider_active = true
         AND channel.provider_barcode IS NOT NULL
       ORDER BY channel.observed_at DESC, channel.id DESC
       LIMIT 1
     ) product_channel ON true
     WHERE pick.organization_id = $1::uuid
       AND orders.id = $2::uuid
       AND pick.plan_id = $3::uuid
       AND pick.wave_id = $4::uuid
     ORDER BY pick.sequence_number, pick.id`,
    [input.organizationId, input.orderId, input.planId, input.waveId],
  )
  return result.rows
}

function requiredWearablePickScanContexts(rows: WearablePickScanContextRow[]) {
  return rows.filter((row) => row.policy_location_scan_required === true)
}

function validateWearablePickScanEvidence(
  input: {
    actorEmail: string
    scanEvidence: WearablePickTaskScanEvidenceInput[]
    contexts: WearablePickScanContextRow[]
    now?: Date
  },
) {
  const required = requiredWearablePickScanContexts(input.contexts)
  if (required.length < 1) {
    throw new OperationsRequestError(
      'OPERATIONS_WEARABLE_SCAN_POLICY_DISABLED',
      'This order does not currently require location-first scan evidence',
      409,
    )
  }
  if (input.scanEvidence.length !== required.length) {
    throw new OperationsRequestError(
      'OPERATIONS_WEARABLE_SCAN_EVIDENCE_INCOMPLETE',
      'Every policy-required pick task needs one location and one product scan',
      409,
    )
  }
  const evidenceByTask = new Map(
    input.scanEvidence.map((evidence) => [evidence.pickTaskGlobalId, evidence]),
  )
  if (evidenceByTask.size !== input.scanEvidence.length) {
    throw new OperationsRequestError(
      'OPERATIONS_WEARABLE_SCAN_EVIDENCE_DUPLICATE',
      'Scan evidence contains the same pick task more than once',
      409,
    )
  }
  const now = input.now || new Date()
  const validated = required.map((context) => {
    const evidence = evidenceByTask.get(context.pick_task_global_id)
    if (!evidence) {
      throw new OperationsRequestError(
        'OPERATIONS_WEARABLE_SCAN_EVIDENCE_INCOMPLETE',
        `Scan evidence is missing for pick task ${context.pick_task_global_id}`,
        409,
      )
    }
    if (context.pick_status !== 'ready') {
      throw new OperationsRequestError(
        'OPERATIONS_WEARABLE_SCAN_EVIDENCE_STALE',
        'A pick task changed after it was scanned. Refresh and scan again.',
        409,
      )
    }
    if (context.assigned_to !== input.actorEmail) {
      throw new OperationsRequestError(
        'OPERATIONS_WEARABLE_SCAN_EVIDENCE_ACTOR_MISMATCH',
        'Only the picker assigned to every task may submit its scan evidence',
        403,
      )
    }
    const policyRowVersion = Number(context.policy_row_version)
    if (
      !Number.isSafeInteger(policyRowVersion)
      || policyRowVersion < 1
      || evidence.policyRowVersion !== policyRowVersion
    ) {
      throw new OperationsRequestError(
        'OPERATIONS_WEARABLE_SCAN_EVIDENCE_STALE',
        'The warehouse location scan policy changed. Refresh and scan again.',
        409,
      )
    }
    const expectedLocationBarcode = locationBarcode(context.location_global_id)
    if (evidence.location.barcode !== expectedLocationBarcode) {
      throw new OperationsRequestError(
        'OPERATIONS_WEARABLE_LOCATION_SCAN_MISMATCH',
        `Location scan does not match pick task ${context.pick_task_global_id}`,
        409,
      )
    }
    const expectedProductBarcode = wearableScanExpectedProductBarcode(context)
    if (!expectedProductBarcode) {
      throw new OperationsRequestError(
        'OPERATIONS_WEARABLE_PRODUCT_BARCODE_REQUIRED',
        `Pick task ${context.pick_task_global_id} has no authoritative product barcode`,
        409,
      )
    }
    if (!wearableProductBarcodeMatches(evidence.product.barcode, expectedProductBarcode)) {
      throw new OperationsRequestError(
        'OPERATIONS_WEARABLE_PRODUCT_SCAN_MISMATCH',
        `Product scan does not match pick task ${context.pick_task_global_id}`,
        409,
      )
    }
    const locationCapturedAt = wearableScanTime(
      evidence.location.capturedAt,
      'Location capture time',
    )!
    const productCapturedAt = wearableScanTime(
      evidence.product.capturedAt,
      'Product capture time',
    )!
    const minimumContextTime = [
      wearableScanTime(context.assigned_at, 'Pick assignment time'),
      wearableScanTime(context.pick_created_at, 'Pick creation time'),
      wearableScanTime(context.policy_updated_at, 'Scan policy update time'),
      wearableScanTime(context.wave_released_at, 'Wave release time'),
    ].filter((value): value is Date => value !== null)
      .reduce((latest, value) => value > latest ? value : latest, new Date(0))
    if (
      locationCapturedAt.getTime() < minimumContextTime.getTime() - WEARABLE_SCAN_CLOCK_SKEW_MS
      || locationCapturedAt.getTime() < now.getTime() - WEARABLE_SCAN_MAX_AGE_MS
      || locationCapturedAt.getTime() > now.getTime() + WEARABLE_SCAN_CLOCK_SKEW_MS
      || productCapturedAt.getTime() < locationCapturedAt.getTime()
      || productCapturedAt.getTime() - locationCapturedAt.getTime()
        > WEARABLE_LOCATION_TO_PRODUCT_MAX_MS
      || productCapturedAt.getTime() > now.getTime() + WEARABLE_SCAN_CLOCK_SKEW_MS
    ) {
      throw new OperationsRequestError(
        'OPERATIONS_WEARABLE_SCAN_EVIDENCE_STALE',
        `Scan timing is stale or out of sequence for pick task ${context.pick_task_global_id}`,
        409,
      )
    }
    return {
      context,
      evidence,
      policyRowVersion,
      expectedLocationBarcode,
      expectedProductBarcode,
      locationCapturedAt,
      productCapturedAt,
    }
  })
  if (validated.length !== evidenceByTask.size) {
    throw new OperationsRequestError(
      'OPERATIONS_WEARABLE_SCAN_EVIDENCE_CONTEXT_MISMATCH',
      'Scan evidence includes a task outside the current policy-required order',
      409,
    )
  }
  return validated
}

function validateWearablePickCountEvidence(input: {
  actorEmail: string
  countEvidenceIdempotencyKey?: string
  countEvidence?: WearablePickTaskCountEvidenceInput[]
  contexts: WearablePickScanContextRow[]
  acknowledgedScanProductObservations?: Array<{
    pickTaskId: string
    barcode: string
    capturedAt: string
    source: 'iphone_camera' | 'meta'
  }>
  now?: Date
}) {
  const idempotencyKey = String(
    input.countEvidenceIdempotencyKey || '',
  ).trim() || undefined
  const evidence = input.countEvidence
  if (idempotencyKey === undefined && evidence === undefined) {
    return {
      enforced: false as const,
      countEvidenceIdempotencyKey: null as string | null,
      validated: [],
    }
  }
  if (
    !idempotencyKey
    || !/^[A-Za-z0-9._:-]{8,200}$/.test(idempotencyKey)
    || !Array.isArray(evidence)
    || evidence.length < 1
    || evidence.length > 200
  ) {
    throw new OperationsRequestError(
      'OPERATIONS_WEARABLE_COUNT_EVIDENCE_INVALID',
      'Count evidence and its valid idempotency key must be supplied together',
    )
  }

  for (const context of input.contexts) {
    const quantity = Number(context.quantity)
    if (!Number.isSafeInteger(quantity) || quantity < 1) {
      throw new OperationsRequestError(
        'OPERATIONS_WEARABLE_COUNT_REQUIRED_QUANTITY_INVALID',
        `Pick task ${context.pick_task_global_id} does not have a positive whole-unit quantity`,
        409,
      )
    }
  }
  const required = input.contexts.filter((context) => Number(context.quantity) > 1)
  if (required.length < 1) {
    throw new OperationsRequestError(
      'OPERATIONS_WEARABLE_COUNT_EVIDENCE_NOT_REQUIRED',
      'This order has no multi-unit pick task requiring exact count evidence',
      409,
    )
  }
  if (evidence.length !== required.length) {
    throw new OperationsRequestError(
      'OPERATIONS_WEARABLE_COUNT_EVIDENCE_INCOMPLETE',
      'Every multi-unit pick task needs one exact count before confirmation',
      409,
    )
  }
  const evidenceByTask = new Map(
    evidence.map((item) => [item.pickTaskGlobalId, item]),
  )
  if (evidenceByTask.size !== evidence.length) {
    throw new OperationsRequestError(
      'OPERATIONS_WEARABLE_COUNT_EVIDENCE_DUPLICATE',
      'Count evidence contains the same pick task more than once',
      409,
    )
  }
  const now = input.now || new Date()
  const scanProductByTask = new Map(
    (input.acknowledgedScanProductObservations || []).map(
      (observation) => [observation.pickTaskId, observation],
    ),
  )
  const validated = required.map((context) => {
    const item = evidenceByTask.get(context.pick_task_global_id)
    if (!item) {
      throw new OperationsRequestError(
        'OPERATIONS_WEARABLE_COUNT_EVIDENCE_INCOMPLETE',
        `Count evidence is missing for pick task ${context.pick_task_global_id}`,
        409,
      )
    }
    if (context.pick_status !== 'ready') {
      throw new OperationsRequestError(
        'OPERATIONS_WEARABLE_COUNT_EVIDENCE_STALE',
        'A pick task changed after it was counted. Refresh and scan again.',
        409,
      )
    }
    if (context.assigned_to !== input.actorEmail) {
      throw new OperationsRequestError(
        'OPERATIONS_WEARABLE_COUNT_EVIDENCE_ACTOR_MISMATCH',
        'Only the picker assigned to every task may submit its count evidence',
        403,
      )
    }
    const requiredQuantity = Number(context.quantity)
    if (
      !Number.isSafeInteger(item.requiredQuantity)
      || item.requiredQuantity < 1
      || item.requiredQuantity !== requiredQuantity
    ) {
      throw new OperationsRequestError(
        'OPERATIONS_WEARABLE_COUNT_REQUIRED_QUANTITY_STALE',
        `Required quantity changed for pick task ${context.pick_task_global_id}`,
        409,
      )
    }
    if (
      !Number.isSafeInteger(item.enteredQuantity)
      || item.enteredQuantity < 1
      || item.enteredQuantity !== requiredQuantity
    ) {
      throw new OperationsRequestError(
        'OPERATIONS_WEARABLE_COUNT_MISMATCH',
        `Entered quantity must exactly equal ${requiredQuantity} for pick task ${context.pick_task_global_id}`,
        409,
      )
    }
    if (
      item.countSource !== 'iphone'
      && item.countSource !== 'watch'
    ) {
      throw new OperationsRequestError(
        'OPERATIONS_WEARABLE_COUNT_EVIDENCE_INVALID',
        `Count source is invalid for pick task ${context.pick_task_global_id}`,
      )
    }
    if (
      item.product.source !== 'iphone_camera'
      && item.product.source !== 'meta'
    ) {
      throw new OperationsRequestError(
        'OPERATIONS_WEARABLE_COUNT_EVIDENCE_INVALID',
        `Product scan source is invalid for pick task ${context.pick_task_global_id}`,
      )
    }
    const expectedProductBarcode = wearableScanExpectedProductBarcode(context)
    if (!expectedProductBarcode) {
      throw new OperationsRequestError(
        'OPERATIONS_WEARABLE_PRODUCT_BARCODE_REQUIRED',
        `Pick task ${context.pick_task_global_id} has no authoritative product barcode`,
        409,
      )
    }
    if (!wearableProductBarcodeMatches(item.product.barcode, expectedProductBarcode)) {
      throw new OperationsRequestError(
        'OPERATIONS_WEARABLE_PRODUCT_SCAN_MISMATCH',
        `Product scan does not match pick task ${context.pick_task_global_id}`,
        409,
      )
    }
    const acknowledgedScanProduct = scanProductByTask.get(context.pick_task_id)
    if (
      context.policy_location_scan_required
      && (
        !acknowledgedScanProduct
        || acknowledgedScanProduct.barcode !== item.product.barcode
        || acknowledgedScanProduct.capturedAt !== item.product.capturedAt
        || acknowledgedScanProduct.source !== item.product.source
      )
    ) {
      throw new OperationsRequestError(
        'OPERATIONS_WEARABLE_COUNT_SCAN_EVIDENCE_MISMATCH',
        `Count evidence does not reference the acknowledged product scan for pick task ${context.pick_task_global_id}`,
        409,
      )
    }
    const productCapturedAt = wearableCountTime(
      item.product.capturedAt,
      'Product capture time',
    )!
    const countedAt = wearableCountTime(item.countedAt, 'Count time')!
    const minimumContextTime = [
      wearableCountTime(context.assigned_at, 'Pick assignment time'),
      wearableCountTime(context.pick_created_at, 'Pick creation time'),
      wearableCountTime(context.wave_released_at, 'Wave release time'),
    ].filter((value): value is Date => value !== null)
      .reduce((latest, value) => value > latest ? value : latest, new Date(0))
    if (
      productCapturedAt.getTime()
        < minimumContextTime.getTime() - WEARABLE_SCAN_CLOCK_SKEW_MS
      || productCapturedAt.getTime()
        < now.getTime() - WEARABLE_SCAN_MAX_AGE_MS
      || productCapturedAt.getTime()
        > now.getTime() + WEARABLE_SCAN_CLOCK_SKEW_MS
      || countedAt.getTime() <= productCapturedAt.getTime()
      || countedAt.getTime() - productCapturedAt.getTime()
        > WEARABLE_PRODUCT_TO_COUNT_MAX_MS
      || countedAt.getTime() > now.getTime() + WEARABLE_SCAN_CLOCK_SKEW_MS
    ) {
      throw new OperationsRequestError(
        'OPERATIONS_WEARABLE_COUNT_EVIDENCE_STALE',
        `Count timing is stale or out of sequence for pick task ${context.pick_task_global_id}`,
        409,
      )
    }
    return {
      context,
      evidence: item,
      requiredQuantity,
      expectedProductBarcode,
      productCapturedAt,
      countedAt,
    }
  })
  if (evidenceByTask.size !== required.length) {
    throw new OperationsRequestError(
      'OPERATIONS_WEARABLE_COUNT_EVIDENCE_CONTEXT_MISMATCH',
      'Count evidence includes a task outside the current multi-unit order',
      409,
    )
  }
  return {
    enforced: true as const,
    countEvidenceIdempotencyKey: idempotencyKey,
    validated,
  }
}

function completedWearablePickScanEvidenceResult(
  receipt: Pick<CommandReceiptRow, 'result_payload'>,
): WearablePickScanEvidenceCommandResult {
  const payload = receipt.result_payload
  const orderGlobalId = String(payload?.orderGlobalId || '')
  const orderRowVersion = Number(payload?.orderRowVersion)
  const evidenceCount = Number(payload?.evidenceCount)
  const serverObservedAt = String(payload?.serverObservedAt || '')
  if (
    !/^gor(?:[0-9]{7}|[0-9a-v]{12})$/.test(orderGlobalId)
    || !Number.isSafeInteger(orderRowVersion)
    || orderRowVersion < 0
    || !Number.isSafeInteger(evidenceCount)
    || evidenceCount < 1
    || !Number.isFinite(new Date(serverObservedAt).getTime())
  ) {
    throw new OperationsRequestError(
      'OPERATIONS_WEARABLE_SCAN_EVIDENCE_RECEIPT_INVALID',
      'Stored wearable scan evidence receipt is invalid',
      500,
    )
  }
  return {
    orderGlobalId,
    orderRowVersion,
    evidenceCount,
    serverObservedAt,
    replayed: true,
  }
}

export async function recordWearablePickScanEvidenceFromPostgres(input: {
  organizationId: string
  actorEmail: string
  orderGlobalId: string
  expectedRowVersion: number
  scanEvidence: WearablePickTaskScanEvidenceInput[]
  idempotencyKey: string
}): Promise<WearablePickScanEvidenceCommandResult> {
  const organizationId = requireOrganizationId(input.organizationId)
  const actorEmail = String(input.actorEmail || '').trim().toLowerCase()
  const orderGlobalId = String(input.orderGlobalId || '').trim()
  const idempotencyKey = String(input.idempotencyKey || '').trim()
  if (!actorEmail) throw new OperationsRequestError('OPERATIONS_ACTOR_REQUIRED', 'A signed-in user is required', 401)
  if (!/^gor(?:[0-9]{7}|[0-9a-v]{12})$/.test(orderGlobalId)) {
    throw new OperationsRequestError('OPERATIONS_ORDER_INVALID', 'Order is invalid')
  }
  if (!Number.isSafeInteger(input.expectedRowVersion) || input.expectedRowVersion < 0) {
    throw new OperationsRequestError('OPERATIONS_ORDER_VERSION_INVALID', 'Order version is invalid')
  }
  if (!Array.isArray(input.scanEvidence) || input.scanEvidence.length < 1 || input.scanEvidence.length > 200) {
    throw new OperationsRequestError(
      'OPERATIONS_WEARABLE_SCAN_EVIDENCE_INVALID',
      'Scan evidence must contain between one and 200 pick tasks',
    )
  }
  if (!/^[A-Za-z0-9._:-]{8,200}$/.test(idempotencyKey)) {
    throw new OperationsRequestError('OPERATIONS_IDEMPOTENCY_KEY_INVALID', 'A valid idempotency key is required')
  }

  const command = await prepareCommandReceipt({
    organizationId,
    commandType: 'record_wearable_pick_scan_evidence',
    idempotencyKey,
    requestHash: commandRequestHash({
      orderGlobalId,
      expectedRowVersion: input.expectedRowVersion,
      scanEvidence: input.scanEvidence,
    }),
    actorEmail,
    targetGlobalId: orderGlobalId,
  })
  if (command.completed) {
    return completedWearablePickScanEvidenceResult(command.receipt)
  }

  try {
    return await withTransaction(async (client) => {
      await acquireTransactionAdvisoryLock(
        client,
        `operations:order:${organizationId}:${orderGlobalId}`,
      )
      const activation = await resolveActivation(client, organizationId)
      if (!['shadow', 'active'].includes(activation.state)) {
        throw new OperationsRequestError(
          'OPERATIONS_EXECUTION_STATE_INVALID',
          'Set Operations to Shadow or Active before recording warehouse scans',
          409,
        )
      }
      const orderResult = await client.query<OrderIdentityRow>(
        `SELECT id::text, global_id, status, row_version::text
         FROM operations_orders
         WHERE organization_id = $1::uuid AND global_id = $2
         FOR UPDATE`,
        [organizationId, orderGlobalId],
      )
      const order = orderResult.rows[0]
      if (!order || order.row_version === undefined) {
        throw new OperationsRequestError('OPERATIONS_ORDER_NOT_FOUND', 'Operations order was not found', 404)
      }
      if (
        Number(order.row_version) !== input.expectedRowVersion
        || order.status !== 'released'
      ) {
        throw new OperationsRequestError(
          'OPERATIONS_WEARABLE_SCAN_EVIDENCE_STALE',
          'The order changed after its scan queue was loaded. Refresh and scan again.',
          409,
        )
      }
      await requireCurrentCommerceOrderRevision(client, {
        organizationId,
        orderId: order.id,
        operation: 'pick',
      })
      const planResult = await client.query<QueryResultRow & {
        id: string
        global_id: string
        status: string
      }>(
        `SELECT id::text, global_id, status
         FROM operations_fulfillment_plans
         WHERE organization_id = $1::uuid AND order_id = $2::uuid
         ORDER BY version_number DESC
         LIMIT 1
         FOR UPDATE`,
        [organizationId, order.id],
      )
      const plan = planResult.rows[0]
      if (!plan || plan.status !== 'released') {
        throw new OperationsRequestError(
          'OPERATIONS_WEARABLE_SCAN_EVIDENCE_STALE',
          'The released fulfillment plan changed. Refresh and scan again.',
          409,
        )
      }
      const waveResult = await client.query<IdRow & {
        status: string
        warehouse_global_id: string
      }>(
        `SELECT wave.id::text, wave.global_id, wave.status,
                warehouse.global_id AS warehouse_global_id
         FROM operations_waves wave
         JOIN operations_warehouses warehouse
           ON warehouse.organization_id = wave.organization_id
          AND warehouse.id = wave.warehouse_id
         WHERE wave.organization_id = $1::uuid
           AND wave.id = (
             SELECT pick.wave_id
             FROM operations_pick_tasks pick
             WHERE pick.organization_id = $1::uuid AND pick.plan_id = $2::uuid
             ORDER BY pick.created_at, pick.id
             LIMIT 1
           )
         FOR UPDATE OF wave`,
        [organizationId, plan.id],
      )
      const wave = waveResult.rows[0]
      if (!wave || wave.status !== 'released') {
        throw new OperationsRequestError(
          'OPERATIONS_WEARABLE_SCAN_EVIDENCE_STALE',
          'The released wave changed. Refresh and scan again.',
          409,
        )
      }
      await acquireTransactionAdvisoryLock(
        client,
        `operations:wearable-location-scan-policy:${organizationId}:${wave.warehouse_global_id}`,
      )
      const contexts = await readWearablePickScanContexts(client, {
        organizationId,
        orderId: order.id,
        planId: plan.id,
        waveId: wave.id,
      })
      const validated = validateWearablePickScanEvidence({
        actorEmail,
        scanEvidence: input.scanEvidence,
        contexts,
      })
      for (const item of validated) {
        const hash = commandRequestHash({
          orderGlobalId,
          orderRowVersion: input.expectedRowVersion,
          pickTaskGlobalId: item.context.pick_task_global_id,
          warehouseGlobalId: item.context.warehouse_global_id,
          locationGlobalId: item.context.location_global_id,
          policyRowVersion: item.policyRowVersion,
          expectedLocationBarcode: item.expectedLocationBarcode,
          observedLocationBarcode: item.evidence.location.barcode,
          locationCapturedAt: item.evidence.location.capturedAt,
          locationSource: item.evidence.location.source,
          expectedProductBarcode: item.expectedProductBarcode,
          observedProductBarcode: item.evidence.product.barcode,
          productCapturedAt: item.evidence.product.capturedAt,
          productSource: item.evidence.product.source,
        })
        await client.query(
          `INSERT INTO operations_wearable_pick_scan_evidence (
             organization_id, command_receipt_id, order_id, order_row_version,
             pick_task_id, warehouse_id, location_id, policy_row_version,
             expected_location_barcode, observed_location_barcode,
             location_captured_at, location_source,
             expected_product_barcode, observed_product_barcode,
             product_captured_at, product_source, evidence_hash, recorded_by
           ) VALUES (
             $1::uuid, $2::uuid, $3::uuid, $4,
             $5::uuid, $6::uuid, $7::uuid, $8,
             $9, $10, $11::timestamptz, $12,
             $13, $14, $15::timestamptz, $16, $17, $18
           )`,
          [
            organizationId,
            command.receipt.id,
            order.id,
            input.expectedRowVersion,
            item.context.pick_task_id,
            item.context.warehouse_id,
            item.context.location_id,
            item.policyRowVersion,
            item.expectedLocationBarcode,
            item.evidence.location.barcode,
            item.evidence.location.capturedAt,
            item.evidence.location.source,
            item.expectedProductBarcode,
            item.evidence.product.barcode,
            item.evidence.product.capturedAt,
            item.evidence.product.source,
            hash,
            actorEmail,
          ],
        )
      }
      const observed = await client.query<{ server_observed_at: Date }>(
        `SELECT now() AS server_observed_at`,
      )
      const serverObservedAt = observed.rows[0].server_observed_at.toISOString()
      const result: WearablePickScanEvidenceCommandResult = {
        orderGlobalId,
        orderRowVersion: input.expectedRowVersion,
        evidenceCount: validated.length,
        serverObservedAt,
        replayed: false,
      }
      await appendDomainEvent(client, {
        organizationId,
        aggregateType: 'operations.order',
        aggregateId: order.id,
        aggregateGlobalId: order.global_id,
        eventType: 'operations.pick.scan_evidence_recorded',
        actorEmail,
        correlationId: command.receipt.correlation_id,
        idempotencyKey: `wearable-scan-evidence:${command.receipt.id}`,
        payload: {
          orderRowVersion: input.expectedRowVersion,
          planGlobalId: plan.global_id,
          waveGlobalId: wave.global_id,
          pickTaskGlobalIds: validated.map((item) => item.context.pick_task_global_id),
          policyRowVersions: [...new Set(validated.map((item) => item.policyRowVersion))],
          evidenceHashes: validated.map((item) => commandRequestHash({
            pickTaskGlobalId: item.context.pick_task_global_id,
            locationCapturedAt: item.evidence.location.capturedAt,
            productCapturedAt: item.evidence.product.capturedAt,
          })),
          serverObservedAt,
        },
      })
      await recordAuditEvent({
        actor: actorEmail,
        eventType: 'operations.pick.scan_evidence_recorded',
        aggregateType: 'operations.order',
        aggregateId: order.global_id,
        subject: `Recorded scan evidence for ${order.global_id}`,
        organizationId,
        eventKey: `operations:wearable-pick-scan-evidence:${command.receipt.id}`,
        payload: {
          orderRowVersion: input.expectedRowVersion,
          evidenceCount: validated.length,
          pickTaskGlobalIds: validated.map((item) => item.context.pick_task_global_id),
          sources: [...new Set(validated.flatMap((item) => [
            item.evidence.location.source,
            item.evidence.product.source,
          ]))],
          serverObservedAt,
        },
      }, client)
      await completeCommandReceipt(
        client,
        command.receipt.id,
        order.global_id,
        result,
      )
      return result
    })
  } catch (error) {
    await failCommandReceipt(command.receipt.id, error)
    throw error
  }
}

async function requireAcknowledgedWearablePickScanEvidence(
  client: PoolClient,
  input: {
    organizationId: string
    actorEmail: string
    orderId: string
    orderGlobalId: string
    orderRowVersion: number
    contexts: WearablePickScanContextRow[]
    scanEvidenceIdempotencyKey?: string
  },
) {
  const required = requiredWearablePickScanContexts(input.contexts)
  if (required.length < 1) {
    if (input.scanEvidenceIdempotencyKey) {
      throw new OperationsRequestError(
        'OPERATIONS_WEARABLE_SCAN_EVIDENCE_STALE',
        'The warehouse scan policy changed. Refresh before confirming picks.',
        409,
      )
    }
    const productObservations: Array<{
      pickTaskId: string
      barcode: string
      capturedAt: string
      source: 'iphone_camera' | 'meta'
    }> = []
    return { enforced: false, evidenceCount: 0, receiptId: null as string | null, productObservations }
  }
  const idempotencyKey = String(input.scanEvidenceIdempotencyKey || '').trim()
  if (!/^[A-Za-z0-9._:-]{8,200}$/.test(idempotencyKey)) {
    throw new OperationsRequestError(
      'OPERATIONS_WEARABLE_SCAN_EVIDENCE_REQUIRED',
      'Sync and acknowledge the required location and product scans before confirming picks',
      409,
    )
  }
  const receiptResult = await client.query<CommandReceiptRow>(
    `SELECT id::text, request_hash, target_global_id,
            status, correlation_id::text,
            result_global_id, result_payload, attempts, updated_at
     FROM operations_command_receipts
     WHERE organization_id = $1::uuid
       AND command_type = 'record_wearable_pick_scan_evidence'
       AND idempotency_key = $2
       AND actor_email = $3
       AND target_global_id = $4
     LIMIT 1`,
    [
      input.organizationId,
      idempotencyKey,
      input.actorEmail,
      input.orderGlobalId,
    ],
  )
  const receipt = receiptResult.rows[0]
  if (!receipt || receipt.status !== 'succeeded') {
    throw new OperationsRequestError(
      'OPERATIONS_WEARABLE_SCAN_EVIDENCE_REQUIRED',
      'Scan evidence has not been durably acknowledged by ClawPilot',
      409,
    )
  }
  const evidenceResult = await client.query<WearablePickScanEvidenceRow>(
    `SELECT pick_task_id::text, order_id::text, order_row_version::text,
            warehouse_id::text, location_id::text, policy_row_version::text,
            expected_location_barcode, observed_location_barcode,
            location_captured_at, location_source,
            expected_product_barcode, observed_product_barcode,
            product_captured_at, product_source, evidence_hash
     FROM operations_wearable_pick_scan_evidence
     WHERE organization_id = $1::uuid
       AND command_receipt_id = $2::uuid
     ORDER BY pick_task_id`,
    [input.organizationId, receipt.id],
  )
  if (evidenceResult.rows.length !== required.length) {
    throw new OperationsRequestError(
      'OPERATIONS_WEARABLE_SCAN_EVIDENCE_INCOMPLETE',
      'Acknowledged scan evidence does not cover every policy-required pick task',
      409,
    )
  }
  const byTask = new Map(evidenceResult.rows.map((row) => [row.pick_task_id, row]))
  for (const context of required) {
    const evidence = byTask.get(context.pick_task_id)
    const expectedProductBarcode = wearableScanExpectedProductBarcode(context)
    if (
      !evidence
      || evidence.order_id !== input.orderId
      || context.assigned_to !== input.actorEmail
      || Number(evidence.order_row_version) !== input.orderRowVersion
      || evidence.warehouse_id !== context.warehouse_id
      || evidence.location_id !== context.location_id
      || Number(evidence.policy_row_version) !== Number(context.policy_row_version)
      || evidence.expected_location_barcode !== locationBarcode(context.location_global_id)
      || evidence.observed_location_barcode !== evidence.expected_location_barcode
      || !expectedProductBarcode
      || evidence.expected_product_barcode !== expectedProductBarcode
      || !wearableProductBarcodeMatches(
        evidence.observed_product_barcode,
        expectedProductBarcode,
      )
    ) {
      throw new OperationsRequestError(
        'OPERATIONS_WEARABLE_SCAN_EVIDENCE_STALE',
        'Acknowledged scan evidence no longer matches the current pick context',
        409,
      )
    }
  }
  if (byTask.size !== required.length) {
    throw new OperationsRequestError(
      'OPERATIONS_WEARABLE_SCAN_EVIDENCE_CONTEXT_MISMATCH',
      'Acknowledged scan evidence includes a task outside the current order',
      409,
    )
  }
  return {
    enforced: true,
    evidenceCount: required.length,
    receiptId: receipt.id,
    productObservations: evidenceResult.rows.map((row) => ({
      pickTaskId: row.pick_task_id,
      barcode: row.observed_product_barcode,
      capturedAt: new Date(row.product_captured_at).toISOString(),
      source: row.product_source,
    })),
  }
}

type ShopifyExternalFulfillmentDatabaseTarget = {
  orderId: string
  orderGlobalId: string
  orderRowVersion: number
  integrationAccountId: string
  integrationAccountGlobalId: string
  planId: string
  planGlobalId: string
  waveId: string
  waveGlobalId: string
  positionIds: string[]
  reservationIds: string[]
  pickTaskIds: string[]
  reconciliationRequired: boolean
  target: ShopifyExternalFulfillmentTarget
}

async function readShopifyExternalFulfillmentDatabaseTarget(
  client: PoolClient,
  input: {
    organizationId: string
    orderGlobalId: string
    lock: boolean
  },
): Promise<ShopifyExternalFulfillmentDatabaseTarget> {
  const orderResult = await client.query<QueryResultRow & {
    id: string
    global_id: string
    external_order_id: string
    order_number: string
    source_provider: string
    status: OperationsOrderStatus
    row_version: string
    integration_account_id: string
    integration_account_global_id: string
  }>(
    `SELECT orders.id::text, orders.global_id, orders.external_order_id,
            orders.order_number, orders.source_provider, orders.status,
            orders.row_version::text, orders.integration_account_id::text,
            account.global_id AS integration_account_global_id
     FROM operations_orders orders
     JOIN operations_integration_accounts account
       ON account.organization_id = orders.organization_id
      AND account.id = orders.integration_account_id
     WHERE orders.organization_id = $1::uuid
       AND orders.global_id = $2
       AND orders.archived_at IS NULL
     LIMIT 1
     ${input.lock ? 'FOR UPDATE OF orders' : ''}`,
    [input.organizationId, input.orderGlobalId],
  )
  const order = orderResult.rows[0]
  if (!order) {
    throw new OperationsRequestError(
      'OPERATIONS_ORDER_NOT_FOUND',
      'Operations order was not found',
      404,
    )
  }
  if (order.source_provider !== 'shopify' || order.status !== 'released') {
    throw new OperationsRequestError(
      'OPERATIONS_SHOPIFY_EXTERNAL_FULFILLMENT_ORDER_INVALID',
      'Only a released Shopify order can be reconciled as externally fulfilled',
      409,
    )
  }

  const planResult = await client.query<QueryResultRow & {
    id: string
    global_id: string
    status: string
  }>(
    `SELECT id::text, global_id, status
     FROM operations_fulfillment_plans
     WHERE organization_id = $1::uuid AND order_id = $2::uuid
     ORDER BY version_number DESC
     LIMIT 1
     ${input.lock ? 'FOR UPDATE' : ''}`,
    [input.organizationId, order.id],
  )
  const plan = planResult.rows[0]
  if (!plan || plan.status !== 'released') {
    throw new OperationsRequestError(
      'OPERATIONS_SHOPIFY_EXTERNAL_FULFILLMENT_PLAN_INVALID',
      'The latest fulfillment plan must remain released',
      409,
    )
  }

  const pickResult = await client.query<QueryResultRow & {
    id: string
    global_id: string
    allocation_id: string
    status: string
    picked_quantity: string | null
    picked_at: Date | null
    wave_id: string
    wave_global_id: string
    wave_status: string
    wave_released_at: Date | string | null
  }>(
    `SELECT pick.id::text, pick.global_id,
            pick.allocation_id::text, pick.status,
            pick.picked_quantity::text, pick.picked_at,
            wave.id::text AS wave_id, wave.global_id AS wave_global_id,
            wave.status AS wave_status,
            wave.released_at AS wave_released_at
     FROM operations_pick_tasks pick
     JOIN operations_waves wave
       ON wave.organization_id = pick.organization_id
      AND wave.id = pick.wave_id
     WHERE pick.organization_id = $1::uuid
       AND pick.plan_id = $2::uuid
     ORDER BY pick.sequence_number, pick.id
     ${input.lock ? 'FOR UPDATE OF pick, wave' : ''}`,
    [input.organizationId, plan.id],
  )
  const waveIds = new Set(pickResult.rows.map((pick) => pick.wave_id))
  const wave = pickResult.rows[0]
  if (
    !wave
    || waveIds.size !== 1
    || wave.wave_status !== 'released'
    || !wave.wave_released_at
    || pickResult.rows.some((pick) => (
      pick.status !== 'ready'
      || numberValue(pick.picked_quantity) !== 0
      || pick.picked_at !== null
    ))
    || new Set(pickResult.rows.map((pick) => pick.allocation_id)).size
      !== pickResult.rows.length
  ) {
    throw new OperationsRequestError(
      'OPERATIONS_SHOPIFY_EXTERNAL_FULFILLMENT_PICKS_INVALID',
      'External fulfillment reconciliation requires one released wave whose picks are all ready and wholly unpicked',
      409,
    )
  }

  if (input.lock) {
    await client.query(
      `SELECT reservation.id
       FROM operations_fulfillment_allocations allocation
       JOIN operations_reservations reservation
         ON reservation.organization_id = allocation.organization_id
        AND reservation.id = allocation.reservation_id
       WHERE allocation.organization_id = $1::uuid
         AND allocation.plan_id = $2::uuid
       ORDER BY reservation.id
       FOR UPDATE OF reservation`,
      [input.organizationId, plan.id],
    )
  }

  const lineResult = await client.query<QueryResultRow & {
    external_line_id: string
    quantity: string
    allocation_count: string
    allocation_quantity: string
    active_reservation_count: string
    active_reservation_quantity: string
    authority_exact: boolean | null
    provider_location_ids: string[] | null
    position_ids: string[] | null
    reservation_ids: string[] | null
  }>(
    `SELECT line.external_line_id, line.quantity::text,
            count(allocation.id)::text AS allocation_count,
            COALESCE(sum(allocation.quantity), 0)::text
              AS allocation_quantity,
            count(reservation.id) FILTER (
              WHERE reservation.status = 'active'
            )::text AS active_reservation_count,
            COALESCE(sum(reservation.quantity) FILTER (
              WHERE reservation.status = 'active'
            ), 0)::text AS active_reservation_quantity,
            bool_and(
              reservation.status = 'active'
              AND reservation.reservation_authority = 'provider_commitment'
              AND reservation.order_id = line.order_id
              AND reservation.order_line_id = line.id
              AND reservation.position_id = allocation.position_id
              AND reservation.quantity = allocation.quantity
              AND position.source_authority = 'shopify'
              AND source_level.integration_account_id =
                    orders.integration_account_id
              AND source_level.inventory_position_id = reservation.position_id
            ) AS authority_exact,
            array_agg(DISTINCT source_level.provider_location_id) FILTER (
              WHERE source_level.provider_location_id IS NOT NULL
            ) AS provider_location_ids,
            array_agg(DISTINCT reservation.position_id::text) FILTER (
              WHERE reservation.id IS NOT NULL
            ) AS position_ids,
            array_agg(DISTINCT reservation.id::text) FILTER (
              WHERE reservation.id IS NOT NULL
            ) AS reservation_ids
     FROM operations_current_order_lines line
     JOIN operations_orders orders
       ON orders.organization_id = line.organization_id
      AND orders.id = line.order_id
     LEFT JOIN operations_fulfillment_allocations allocation
       ON allocation.organization_id = line.organization_id
      AND allocation.order_line_id = line.id
      AND allocation.plan_id = $3::uuid
     LEFT JOIN operations_reservations reservation
       ON reservation.organization_id = allocation.organization_id
      AND reservation.id = allocation.reservation_id
     LEFT JOIN operations_inventory_positions position
       ON position.organization_id = reservation.organization_id
      AND position.id = reservation.position_id
     LEFT JOIN operations_commerce_inventory_levels source_level
       ON source_level.organization_id = reservation.organization_id
      AND source_level.id = reservation.provider_inventory_level_id
      AND source_level.sync_run_id =
            reservation.provider_inventory_sync_run_id
     WHERE line.organization_id = $1::uuid
       AND line.order_id = $2::uuid
     GROUP BY line.id, line.external_line_id, line.quantity
     ORDER BY line.external_line_id`,
    [input.organizationId, order.id, plan.id],
  )
  const allocationCount = lineResult.rows.reduce(
    (total, line) => total + Number(line.allocation_count || 0),
    0,
  )
  if (
    lineResult.rows.length < 1
    || allocationCount !== pickResult.rows.length
    || lineResult.rows.some((line) => (
      Number(line.allocation_count || 0) < 1
      || Number(line.active_reservation_count || 0)
        !== Number(line.allocation_count || 0)
      || numberValue(line.allocation_quantity) !== numberValue(line.quantity)
      || numberValue(line.active_reservation_quantity)
        !== numberValue(line.quantity)
      || line.authority_exact !== true
      || !Number.isSafeInteger(numberValue(line.quantity))
      || numberValue(line.quantity) < 1
    ))
  ) {
    throw new OperationsRequestError(
      'OPERATIONS_SHOPIFY_EXTERNAL_FULFILLMENT_RESERVATIONS_INVALID',
      'Every released line must have exact active Shopify provider-commitment allocations before reconciliation',
      409,
    )
  }
  const providerLocationIds = new Set(
    lineResult.rows.flatMap((line) => line.provider_location_ids || []),
  )
  if (providerLocationIds.size !== 1) {
    throw new OperationsRequestError(
      'OPERATIONS_SHOPIFY_EXTERNAL_FULFILLMENT_LOCATION_INVALID',
      'External fulfillment reconciliation requires one exact Shopify fulfillment location',
      409,
    )
  }

  const blockerResult = await client.query<QueryResultRow & {
    fulfillment_execution_count: string
    active_execution_count: string
    shipment_count: string
    label_attempt_count: string
    label_count: string
    commerce_export_count: string
  }>(
    `SELECT
       (SELECT count(*) FROM operations_fulfillment_executions execution
        WHERE execution.organization_id = $1::uuid
          AND execution.order_id = $2::uuid)::text
         AS fulfillment_execution_count,
       (SELECT count(*) FROM operations_active_fulfillment_executions execution
        WHERE execution.organization_id = $1::uuid
          AND execution.order_id = $2::uuid)::text AS active_execution_count,
       (SELECT count(*) FROM operations_shipments shipment
        WHERE shipment.organization_id = $1::uuid
          AND shipment.order_id = $2::uuid)::text AS shipment_count,
       (SELECT count(*) FROM operations_label_attempts attempt
        WHERE attempt.organization_id = $1::uuid
          AND attempt.order_id = $2::uuid)::text AS label_attempt_count,
       (SELECT count(*) FROM operations_labels label
        JOIN operations_packages package
          ON package.organization_id = label.organization_id
         AND package.id = label.package_id
        WHERE package.organization_id = $1::uuid
          AND package.plan_id = $3::uuid)::text AS label_count,
       (SELECT count(*) FROM operations_commerce_fulfillment_exports export
        WHERE export.organization_id = $1::uuid
          AND export.order_id = $2::uuid)::text AS commerce_export_count`,
    [input.organizationId, order.id, plan.id],
  )
  const blockers = blockerResult.rows[0]
  if (
    !blockers
    || Object.values(blockers).some((count) => Number(count || 0) !== 0)
  ) {
    throw new OperationsRequestError(
      'OPERATIONS_SHOPIFY_EXTERNAL_FULFILLMENT_EXECUTION_EXISTS',
      'ClawPilot fulfillment, label, shipment, or export evidence already exists for this order',
      409,
    )
  }

  const signalResult = await client.query<{ required: boolean }>(
    `SELECT operations_shopify_external_fulfillment_reconciliation_required(
       $1::uuid,
       $2::uuid
     ) AS required`,
    [input.organizationId, plan.id],
  )
  return {
    orderId: order.id,
    orderGlobalId: order.global_id,
    orderRowVersion: Number(order.row_version),
    integrationAccountId: order.integration_account_id,
    integrationAccountGlobalId: order.integration_account_global_id,
    planId: plan.id,
    planGlobalId: plan.global_id,
    waveId: wave.wave_id,
    waveGlobalId: wave.wave_global_id,
    positionIds: [...new Set(
      lineResult.rows.flatMap((line) => line.position_ids || []),
    )].sort(),
    reservationIds: [...new Set(
      lineResult.rows.flatMap((line) => line.reservation_ids || []),
    )].sort(),
    pickTaskIds: pickResult.rows.map((pick) => pick.id),
    reconciliationRequired: signalResult.rows[0]?.required === true,
    target: {
      externalOrderId: order.external_order_id,
      orderName: order.order_number,
      releasedAt: new Date(wave.wave_released_at).toISOString(),
      providerLocationId: [...providerLocationIds][0],
      lines: lineResult.rows.map((line) => ({
        externalLineId: line.external_line_id,
        quantity: numberValue(line.quantity),
      })),
    },
  }
}

export async function reconcileShopifyExternalFulfillmentFromPostgres(input: {
  organizationId: string
  actorEmail: string
  orderGlobalId: string
  expectedRowVersion: number
  reason: string
  idempotencyKey: string
}): Promise<OperationsExternalFulfillmentReconciliationResult> {
  const organizationId = requireOrganizationId(input.organizationId)
  const actorEmail = String(input.actorEmail || '').trim().toLowerCase()
  const orderGlobalId = String(input.orderGlobalId || '').trim()
  const reason = String(input.reason || '').trim()
  const idempotencyKey = String(input.idempotencyKey || '').trim()
  if (!actorEmail) {
    throw new OperationsRequestError(
      'OPERATIONS_ACTOR_REQUIRED',
      'A signed-in user is required',
      401,
    )
  }
  if (!/^gor(?:[0-9]{7}|[0-9a-v]{12})$/.test(orderGlobalId)) {
    throw new OperationsRequestError(
      'OPERATIONS_ORDER_INVALID',
      'Order is invalid',
    )
  }
  if (!Number.isSafeInteger(input.expectedRowVersion) || input.expectedRowVersion < 0) {
    throw new OperationsRequestError(
      'OPERATIONS_ORDER_VERSION_INVALID',
      'Order version is invalid',
    )
  }
  if (!reason || reason.length > 500 || /[\u0000-\u001f\u007f]/u.test(reason)) {
    throw new OperationsRequestError(
      'OPERATIONS_EXTERNAL_FULFILLMENT_REASON_INVALID',
      'An external-fulfillment reconciliation reason is required',
    )
  }
  if (!/^[A-Za-z0-9._:-]{8,200}$/.test(idempotencyKey)) {
    throw new OperationsRequestError(
      'OPERATIONS_IDEMPOTENCY_KEY_INVALID',
      'A valid idempotency key is required',
    )
  }

  const command = await prepareCommandReceipt({
    organizationId,
    commandType: 'reconcile_shopify_external_fulfillment',
    idempotencyKey,
    requestHash: commandRequestHash({
      orderGlobalId,
      expectedRowVersion: input.expectedRowVersion,
      reason,
    }),
    actorEmail,
    targetGlobalId: orderGlobalId,
  })
  if (command.completed) {
    return completedExternalFulfillmentReconciliationResult(command.receipt)
  }

  try {
    const preflight = await withTransaction((client) => (
      readShopifyExternalFulfillmentDatabaseTarget(client, {
        organizationId,
        orderGlobalId,
        lock: false,
      })
    ))
    if (preflight.orderRowVersion !== input.expectedRowVersion) {
      throw new OperationsRequestError(
        'OPERATIONS_ORDER_VERSION_CONFLICT',
        'This order changed after it was opened. Refresh before reconciling fulfillment.',
        409,
      )
    }
    if (!preflight.reconciliationRequired) {
      throw new OperationsRequestError(
        'OPERATIONS_SHOPIFY_EXTERNAL_FULFILLMENT_RECONCILIATION_NOT_REQUIRED',
        'No newer Shopify inventory evidence requires external-fulfillment reconciliation',
        409,
      )
    }

    let evidence: ShopifyExternalFulfillmentEvidence & {
      providerReads: 2
      providerWrites: 0
    }
    try {
      evidence = await inspectShopifyExternalFulfillment({
        organizationId,
        accountGlobalId: preflight.integrationAccountGlobalId,
        target: preflight.target,
      })
    } catch (error) {
      if (error instanceof ShopifyExternalFulfillmentReconciliationError) {
        throw new OperationsRequestError(
          error.code,
          error.message,
          error.status,
        )
      }
      throw error
    }

    return await withTransaction(async (client) => {
      await acquireTransactionAdvisoryLock(
        client,
        `operations:order:${organizationId}:${orderGlobalId}`,
      )
      const activation = await resolveActivation(client, organizationId)
      if (!['shadow', 'active'].includes(activation.state)) {
        throw new OperationsRequestError(
          'OPERATIONS_EXECUTION_STATE_INVALID',
          'Set Operations to Shadow or Active before reconciling warehouse work',
          409,
        )
      }
      const current = await readShopifyExternalFulfillmentDatabaseTarget(
        client,
        { organizationId, orderGlobalId, lock: true },
      )
      if (current.orderRowVersion !== input.expectedRowVersion) {
        throw new OperationsRequestError(
          'OPERATIONS_ORDER_VERSION_CONFLICT',
          'This order changed before fulfillment could be reconciled. Refresh and try again.',
          409,
        )
      }
      if (
        current.integrationAccountId !== preflight.integrationAccountId
        || current.planId !== preflight.planId
        || current.waveId !== preflight.waveId
        || canonicalJson(current.target) !== canonicalJson(preflight.target)
      ) {
        throw new OperationsRequestError(
          'OPERATIONS_SHOPIFY_EXTERNAL_FULFILLMENT_TARGET_CHANGED',
          'Released Shopify fulfillment authority changed during reconciliation',
          409,
        )
      }

      for (const positionId of current.positionIds) {
        await acquireTransactionAdvisoryLock(
          client,
          `operations:inventory-reservation:${organizationId}:${positionId}`,
        )
      }
      const lockedPositions = await client.query<{ id: string }>(
        `SELECT id::text
         FROM operations_inventory_positions
         WHERE organization_id = $1::uuid
           AND id = ANY($2::uuid[])
         ORDER BY id
         FOR UPDATE`,
        [organizationId, current.positionIds],
      )
      if (Number(lockedPositions.rowCount || 0) !== current.positionIds.length) {
        throw new OperationsRequestError(
          'OPERATIONS_INVENTORY_POSITION_CHANGED',
          'Reserved inventory changed before fulfillment could be reconciled',
          409,
        )
      }

      const packagingClaims = await client.query<{ id: string }>(
        `SELECT id::text
         FROM operations_packaging_material_claims
         WHERE organization_id = $1::uuid
           AND plan_id = $2::uuid
           AND status = 'active'
         ORDER BY id
         FOR UPDATE`,
        [organizationId, current.planId],
      )

      const fulfillment = evidence.snapshot.fulfillment
      const inserted = await client.query<{
        id: string
        global_id: string
      }>(
        `INSERT INTO
           operations_shopify_external_fulfillment_reconciliations (
             organization_id, command_receipt_id, order_id,
             integration_account_id, plan_id, wave_id,
             external_order_id, provider_order_name,
             provider_order_updated_at, provider_order_closed_at,
             provider_fulfillment_id, provider_fulfillment_name,
             provider_fulfillment_created_at,
             provider_fulfillment_updated_at, provider_location_id,
             provider_fulfillment_order_ids, evidence_hash,
             evidence_snapshot, provider_read_count,
             provider_write_count, reason, reconciled_by
           ) VALUES (
             $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
             $6::uuid, $7, $8, $9::timestamptz, $10::timestamptz,
             $11, $12, $13::timestamptz, $14::timestamptz, $15,
             $16::text[], $17, $18::jsonb, 2, 0, $19, $20
           )
         RETURNING id::text, global_id`,
        [
          organizationId,
          command.receipt.id,
          current.orderId,
          current.integrationAccountId,
          current.planId,
          current.waveId,
          current.target.externalOrderId,
          evidence.snapshot.order.name,
          evidence.snapshot.order.updatedAt,
          evidence.snapshot.order.closedAt,
          fulfillment.id,
          fulfillment.name,
          fulfillment.createdAt,
          fulfillment.updatedAt,
          evidence.snapshot.locationId,
          evidence.snapshot.fulfillmentOrders.map((item) => item.id),
          evidence.evidenceHash,
          JSON.stringify(evidence.snapshot),
          reason,
          actorEmail,
        ],
      )
      const reconciliation = inserted.rows[0]
      if (!reconciliation) {
        throw new OperationsRequestError(
          'OPERATIONS_SHOPIFY_EXTERNAL_FULFILLMENT_EVIDENCE_FAILED',
          'Shopify external-fulfillment evidence could not be retained',
          500,
        )
      }

      const cancelledPicks = await client.query<{ global_id: string }>(
        `UPDATE operations_pick_tasks
         SET status = 'cancelled', updated_at = now()
         WHERE organization_id = $1::uuid
           AND id = ANY($2::uuid[])
           AND status = 'ready'
           AND COALESCE(picked_quantity, 0) = 0
           AND picked_at IS NULL
         RETURNING global_id`,
        [organizationId, current.pickTaskIds],
      )
      if (Number(cancelledPicks.rowCount || 0) !== current.pickTaskIds.length) {
        throw new OperationsRequestError(
          'OPERATIONS_SHOPIFY_EXTERNAL_FULFILLMENT_PICKS_CHANGED',
          'Pick tasks changed before fulfillment could be reconciled',
          409,
        )
      }

      const cancelledWave = await client.query(
        `UPDATE operations_waves
         SET status = 'cancelled'
         WHERE organization_id = $1::uuid
           AND id = $2::uuid
           AND status = 'released'
         RETURNING id`,
        [organizationId, current.waveId],
      )
      const cancelledPlan = await client.query(
        `UPDATE operations_fulfillment_plans
         SET status = 'cancelled', updated_at = now()
         WHERE organization_id = $1::uuid
           AND id = $2::uuid
           AND status = 'released'
         RETURNING id`,
        [organizationId, current.planId],
      )
      if (cancelledWave.rowCount !== 1 || cancelledPlan.rowCount !== 1) {
        throw new OperationsRequestError(
          'OPERATIONS_SHOPIFY_EXTERNAL_FULFILLMENT_WAREHOUSE_CHANGED',
          'Released warehouse work changed before it could be reconciled',
          409,
        )
      }

      const releasedReservations = await client.query<{ global_id: string }>(
        `UPDATE operations_reservations
         SET status = 'released', released_at = now()
         WHERE organization_id = $1::uuid
           AND id = ANY($2::uuid[])
           AND status = 'active'
           AND reservation_authority = 'provider_commitment'
         RETURNING global_id`,
        [organizationId, current.reservationIds],
      )
      if (
        Number(releasedReservations.rowCount || 0)
          !== current.reservationIds.length
      ) {
        throw new OperationsRequestError(
          'OPERATIONS_SHOPIFY_EXTERNAL_FULFILLMENT_RESERVATIONS_CHANGED',
          'Provider commitments changed before fulfillment could be reconciled',
          409,
        )
      }

      const releasedPackagingClaims = await client.query<{ global_id: string }>(
        `UPDATE operations_packaging_material_claims
         SET status = 'released', released_at = now(),
             updated_by = $3, updated_at = now()
         WHERE organization_id = $1::uuid
           AND plan_id = $2::uuid
           AND status = 'active'
         RETURNING global_id`,
        [organizationId, current.planId, actorEmail],
      )
      if (
        Number(releasedPackagingClaims.rowCount || 0)
          !== Number(packagingClaims.rowCount || 0)
      ) {
        throw new OperationsRequestError(
          'OPERATIONS_SHOPIFY_EXTERNAL_FULFILLMENT_PACKAGING_CHANGED',
          'Packaging claims changed before fulfillment could be reconciled',
          409,
        )
      }

      const updatedOrder = await client.query<OrderIdentityRow>(
        `UPDATE operations_orders
         SET status = 'cancelled',
             hold_reason = $4,
             updated_by = $5,
             updated_at = now(),
             row_version = row_version + 1
         WHERE organization_id = $1::uuid
           AND id = $2::uuid
           AND status = 'released'
           AND row_version = $3
         RETURNING id::text, global_id, status, row_version::text`,
        [
          organizationId,
          current.orderId,
          input.expectedRowVersion,
          `Shopify ${fulfillment.name} was fulfilled externally; reconciled by ${reconciliation.global_id}`,
          actorEmail,
        ],
      )
      const cancelledOrder = updatedOrder.rows[0]
      if (!cancelledOrder || cancelledOrder.row_version === undefined) {
        throw new OperationsRequestError(
          'OPERATIONS_ORDER_VERSION_CONFLICT',
          'This order changed before fulfillment could be reconciled',
          409,
        )
      }

      const eventPayload = {
        previousStatus: 'released',
        status: 'cancelled',
        planGlobalId: current.planGlobalId,
        waveGlobalId: current.waveGlobalId,
        reconciliationGlobalId: reconciliation.global_id,
        providerOrderId: evidence.snapshot.order.id,
        providerOrderName: evidence.snapshot.order.name,
        providerFulfillmentId: fulfillment.id,
        providerFulfillmentName: fulfillment.name,
        providerFulfillmentCreatedAt: fulfillment.createdAt,
        providerLocationId: evidence.snapshot.locationId,
        providerFulfillmentOrderIds:
          evidence.snapshot.fulfillmentOrders.map((item) => item.id),
        evidenceHash: evidence.evidenceHash,
        cancelledPickTaskCount: Number(cancelledPicks.rowCount || 0),
        releasedProviderCommitmentCount:
          Number(releasedReservations.rowCount || 0),
        releasedPackagingClaimCount:
          Number(releasedPackagingClaims.rowCount || 0),
        providerReads: evidence.providerReads,
        providerWrites: evidence.providerWrites,
        shipmentCreated: false,
        commerceExportCreated: false,
        customerNotificationSent: false,
        providerNotificationNotRepeated: true,
        reason,
      }
      await appendDomainEvent(client, {
        organizationId,
        aggregateType: 'operations.order',
        aggregateId: current.orderId,
        aggregateGlobalId: current.orderGlobalId,
        eventType: 'operations.shopify.external_fulfillment_reconciled',
        actorEmail,
        correlationId: command.receipt.correlation_id,
        idempotencyKey:
          `${current.orderGlobalId}:shopify-external-fulfillment:${command.receipt.id}`,
        payload: eventPayload,
      })
      await recordAuditEvent({
        actor: actorEmail,
        eventType: 'operations.order.shopify_external_fulfillment_reconciled',
        aggregateType: 'operations.order',
        aggregateId: current.orderGlobalId,
        subject: `Reconciled Shopify fulfillment for ${current.orderGlobalId}`,
        organizationId,
        eventKey:
          `operations:shopify-external-fulfillment:${command.receipt.id}`,
        payload: {
          ...eventPayload,
          previousRowVersion: input.expectedRowVersion,
          rowVersion: Number(cancelledOrder.row_version),
        },
      }, client)

      const result: OperationsExternalFulfillmentReconciliationResult = {
        orderGlobalId: cancelledOrder.global_id,
        orderStatus: 'cancelled',
        rowVersion: Number(cancelledOrder.row_version),
        reconciliationGlobalId: reconciliation.global_id,
        providerFulfillmentId: fulfillment.id,
        providerFulfillmentName: fulfillment.name,
        providerReads: 2,
        providerWrites: 0,
        replayed: false,
      }
      await completeCommandReceipt(
        client,
        command.receipt.id,
        cancelledOrder.global_id,
        result,
      )
      return result
    })
  } catch (error) {
    await failCommandReceipt(command.receipt.id, error)
    throw error
  }
}

export async function confirmOperationsOrderPicksFromPostgres(input: {
  organizationId: string
  actorEmail: string
  orderGlobalId: string
  expectedRowVersion: number
  reason: string
  scanEvidenceIdempotencyKey?: string
  countEvidenceIdempotencyKey?: string
  countEvidence?: WearablePickTaskCountEvidenceInput[]
  idempotencyKey: string
}): Promise<OperationsOrderCommandResult> {
  const organizationId = requireOrganizationId(input.organizationId)
  const actorEmail = String(input.actorEmail || '').trim().toLowerCase()
  const orderGlobalId = String(input.orderGlobalId || '').trim()
  const reason = String(input.reason || '').trim()
  const scanEvidenceIdempotencyKey = String(
    input.scanEvidenceIdempotencyKey || '',
  ).trim() || undefined
  const countEvidenceIdempotencyKey = String(
    input.countEvidenceIdempotencyKey || '',
  ).trim() || undefined
  const countEvidence = input.countEvidence
  const idempotencyKey = String(input.idempotencyKey || '').trim()
  if (!actorEmail) throw new OperationsRequestError('OPERATIONS_ACTOR_REQUIRED', 'A signed-in user is required', 401)
  if (!/^gor(?:[0-9]{7}|[0-9a-v]{12})$/.test(orderGlobalId)) {
    throw new OperationsRequestError('OPERATIONS_ORDER_INVALID', 'Order is invalid')
  }
  if (!Number.isSafeInteger(input.expectedRowVersion) || input.expectedRowVersion < 0) {
    throw new OperationsRequestError('OPERATIONS_ORDER_VERSION_INVALID', 'Order version is invalid')
  }
  if (!reason || reason.length > 500) {
    throw new OperationsRequestError('OPERATIONS_PICK_REASON_INVALID', 'A pick confirmation reason is required')
  }
  if (!/^[A-Za-z0-9._:-]{8,200}$/.test(idempotencyKey)) {
    throw new OperationsRequestError('OPERATIONS_IDEMPOTENCY_KEY_INVALID', 'A valid idempotency key is required')
  }
  if (
    scanEvidenceIdempotencyKey
    && !/^[A-Za-z0-9._:-]{8,200}$/.test(scanEvidenceIdempotencyKey)
  ) {
    throw new OperationsRequestError(
      'OPERATIONS_WEARABLE_SCAN_EVIDENCE_INVALID',
      'Scan evidence idempotency key is invalid',
    )
  }
  if (
    (countEvidenceIdempotencyKey === undefined)
      !== (countEvidence === undefined)
    || (
      countEvidenceIdempotencyKey
      && !/^[A-Za-z0-9._:-]{8,200}$/.test(countEvidenceIdempotencyKey)
    )
    || (countEvidence !== undefined && (
      !Array.isArray(countEvidence)
      || countEvidence.length < 1
      || countEvidence.length > 200
    ))
  ) {
    throw new OperationsRequestError(
      'OPERATIONS_WEARABLE_COUNT_EVIDENCE_INVALID',
      'Count evidence and its valid idempotency key must be supplied together',
    )
  }

  const command = await prepareCommandReceipt({
    organizationId,
    commandType: 'confirm_operations_order_picks',
    idempotencyKey,
    requestHash: commandRequestHash({
      orderGlobalId,
      expectedRowVersion: input.expectedRowVersion,
      reason,
      scanEvidenceIdempotencyKey: scanEvidenceIdempotencyKey || null,
      countEvidenceIdempotencyKey: countEvidenceIdempotencyKey || null,
      countEvidence: countEvidence || null,
    }),
    actorEmail,
    targetGlobalId: orderGlobalId,
  })
  if (command.completed) {
    return completedOrderCommandResult(organizationId, command.receipt)
  }

  try {
    return await withTransaction(async (client) => {
      await acquireTransactionAdvisoryLock(client, `operations:order:${organizationId}:${orderGlobalId}`)
      if (countEvidenceIdempotencyKey) {
        await acquireTransactionAdvisoryLock(
          client,
          `operations:wearable-count-evidence:${organizationId}:${countEvidenceIdempotencyKey}`,
        )
      }
      const activation = await resolveActivation(client, organizationId)
      if (!['shadow', 'active'].includes(activation.state)) {
        throw new OperationsRequestError(
          'OPERATIONS_EXECUTION_STATE_INVALID',
          'Set Operations to Shadow or Active before confirming warehouse work',
          409,
        )
      }

      const orderResult = await client.query<OrderIdentityRow>(
        `SELECT id::text, global_id, status, row_version::text
         FROM operations_orders
         WHERE organization_id = $1::uuid AND global_id = $2
         FOR UPDATE`,
        [organizationId, orderGlobalId],
      )
      const order = orderResult.rows[0]
      if (!order || order.row_version === undefined) {
        throw new OperationsRequestError('OPERATIONS_ORDER_NOT_FOUND', 'Operations order was not found', 404)
      }
      if (Number(order.row_version) !== input.expectedRowVersion) {
        throw new OperationsRequestError(
          'OPERATIONS_ORDER_VERSION_CONFLICT',
          'This order changed after it was opened. Refresh the order before confirming picks.',
          409,
        )
      }
      await requireCurrentCommerceOrderRevision(client, {
        organizationId,
        orderId: order.id,
        operation: 'pick',
      })
      if (order.status !== 'released') {
        throw new OperationsRequestError(
          'OPERATIONS_ORDER_TRANSITION_INVALID',
          `Order picks cannot be confirmed from ${order.status}`,
          409,
        )
      }

      const planResult = await client.query<QueryResultRow & {
        id: string
        global_id: string
        status: string
      }>(
        `SELECT id::text, global_id, status
         FROM operations_fulfillment_plans
         WHERE organization_id = $1::uuid AND order_id = $2::uuid
         ORDER BY version_number DESC
         LIMIT 1
         FOR UPDATE`,
        [organizationId, order.id],
      )
      const plan = planResult.rows[0]
      if (!plan || plan.status !== 'released') {
        throw new OperationsRequestError(
          'OPERATIONS_FULFILLMENT_PLAN_INVALID',
          'The released fulfillment plan is unavailable for picking',
          409,
        )
      }

      const externalFulfillmentConflict = await client.query<{
        required: boolean
      }>(
        `SELECT operations_shopify_external_fulfillment_reconciliation_required(
           $1::uuid,
           $2::uuid
         ) AS required`,
        [organizationId, plan.id],
      )
      if (externalFulfillmentConflict.rows[0]?.required) {
        throw new OperationsRequestError(
          'OPERATIONS_SHOPIFY_EXTERNAL_FULFILLMENT_RECONCILIATION_REQUIRED',
          'Newer Shopify evidence no longer supports this provider commitment. Reconcile the external fulfillment before confirming picks.',
          409,
        )
      }

      const waveResult = await client.query<IdRow & {
        status: string
        warehouse_global_id: string
      }>(
        `SELECT wave.id::text, wave.global_id, wave.status,
                warehouse.global_id AS warehouse_global_id
         FROM operations_waves wave
         JOIN operations_warehouses warehouse
           ON warehouse.organization_id = wave.organization_id
          AND warehouse.id = wave.warehouse_id
         WHERE wave.organization_id = $1::uuid
           AND wave.id = (
             SELECT pick.wave_id
             FROM operations_pick_tasks pick
             WHERE pick.organization_id = $1::uuid AND pick.plan_id = $2::uuid
             ORDER BY pick.created_at, pick.id
             LIMIT 1
           )
         FOR UPDATE OF wave`,
        [organizationId, plan.id],
      )
      const wave = waveResult.rows[0]
      if (!wave || wave.status !== 'released') {
        throw new OperationsRequestError(
          'OPERATIONS_WAVE_INVALID',
          'The released warehouse wave is unavailable for picking',
          409,
        )
      }
      await acquireTransactionAdvisoryLock(
        client,
        `operations:wearable-location-scan-policy:${organizationId}:${wave.warehouse_global_id}`,
      )

      const pickResult = await client.query<QueryResultRow & {
        id: string
        global_id: string
        status: string
        quantity: string
        allocation_quantity: string
        position_id: string
        from_location_id: string
        position_location_id: string
        reservation_quantity: string
        reservation_order_line_id: string
        reservation_position_id: string
        allocation_order_line_id: string
        allocation_count: string
        source_authority: 'clawpilot' | 'shopify'
        reservation_authority: 'local_balance' | 'provider_commitment'
        reservation_status: 'active' | 'released' | 'consumed'
      }>(
        `SELECT pick.id::text, pick.global_id, pick.status,
                pick.quantity::text,
                allocation.quantity::text AS allocation_quantity,
                allocation.order_line_id::text AS allocation_order_line_id,
                allocation.position_id::text,
                pick.from_location_id::text,
                position.location_id::text AS position_location_id,
                reservation.quantity::text AS reservation_quantity,
                reservation.order_line_id::text
                  AS reservation_order_line_id,
                reservation.position_id::text
                  AS reservation_position_id,
                reservation.reservation_authority,
                reservation.status AS reservation_status,
                position.source_authority,
                expected.allocation_count::text
         FROM operations_pick_tasks pick
         JOIN operations_fulfillment_allocations allocation
           ON allocation.organization_id = pick.organization_id
          AND allocation.id = pick.allocation_id
         JOIN operations_inventory_positions position
           ON position.organization_id = allocation.organization_id
          AND position.id = allocation.position_id
         JOIN operations_reservations reservation
           ON reservation.organization_id = allocation.organization_id
          AND reservation.id = allocation.reservation_id
         CROSS JOIN LATERAL (
           SELECT count(*) AS allocation_count
           FROM operations_fulfillment_allocations expected_allocation
           WHERE expected_allocation.organization_id =
                   allocation.organization_id
             AND expected_allocation.plan_id = allocation.plan_id
         ) expected
         WHERE pick.organization_id = $1::uuid AND pick.plan_id = $2::uuid
         ORDER BY pick.sequence_number, pick.id
         FOR UPDATE OF pick`,
        [organizationId, plan.id],
      )
      if (
        pickResult.rows.length < 1
        || pickResult.rows.length
          !== Number(pickResult.rows[0]?.allocation_count || 0)
        || pickResult.rows.some((pick) => (
          pick.status !== 'ready'
          || numberValue(pick.quantity)
            !== numberValue(pick.allocation_quantity)
          || numberValue(pick.quantity)
            !== numberValue(pick.reservation_quantity)
          || pick.from_location_id !== pick.position_location_id
          || pick.reservation_order_line_id
            !== pick.allocation_order_line_id
          || pick.reservation_position_id !== pick.position_id
        ))
      ) {
        throw new OperationsRequestError(
          'OPERATIONS_PICK_TASKS_NOT_READY',
          'Every allocation must have one exact, ready pick task before confirming this wave',
          409,
        )
      }
      if (pickResult.rows.some((pick) => (
        pick.reservation_status !== 'active'
        || (pick.source_authority === 'shopify'
          && pick.reservation_authority !== 'provider_commitment')
        || (pick.source_authority === 'clawpilot'
          && pick.reservation_authority !== 'local_balance')
      ))) {
        throw new OperationsRequestError(
          'OPERATIONS_RESERVATION_AUTHORITY_INVALID',
          'Pick inventory authority no longer matches its reservation. Refresh and replan the order.',
          409,
        )
      }

      const wearableScanContexts = await readWearablePickScanContexts(client, {
        organizationId,
        orderId: order.id,
        planId: plan.id,
        waveId: wave.id,
      })
      if (wearableScanContexts.length !== pickResult.rows.length) {
        throw new OperationsRequestError(
          'OPERATIONS_WEARABLE_SCAN_EVIDENCE_CONTEXT_MISMATCH',
          'Warehouse scan context no longer matches every ready pick task',
          409,
        )
      }
      const scanEvidenceAcknowledgement =
        await requireAcknowledgedWearablePickScanEvidence(client, {
          organizationId,
          actorEmail,
          orderId: order.id,
          orderGlobalId: order.global_id,
          orderRowVersion: input.expectedRowVersion,
          contexts: wearableScanContexts,
          scanEvidenceIdempotencyKey,
        })
      const countEvidenceAcknowledgement = validateWearablePickCountEvidence({
        actorEmail,
        countEvidenceIdempotencyKey,
        countEvidence,
        contexts: wearableScanContexts,
        acknowledgedScanProductObservations:
          scanEvidenceAcknowledgement.productObservations,
      })

      const blockingResult = await client.query<QueryResultRow & { count: string }>(
        `SELECT count(*)::text AS count
         FROM operations_exceptions
         WHERE organization_id = $1::uuid AND order_id = $2::uuid
           AND status IN ('open', 'acknowledged')
           AND severity IN ('high', 'critical')`,
        [organizationId, order.id],
      )
      if (Number(blockingResult.rows[0]?.count || 0) > 0) {
        throw new OperationsRequestError(
          'OPERATIONS_ORDER_BLOCKED_BY_EXCEPTION',
          'Resolve high or critical order exceptions before confirming picks',
          409,
        )
      }

      const positionIds = [...new Set(pickResult.rows.map((pick) => pick.position_id))]
      const lockedPositions = await client.query<{ id: string }>(
        `SELECT id::text
         FROM operations_inventory_positions
         WHERE organization_id = $1::uuid AND id = ANY($2::uuid[])
         ORDER BY id
         FOR UPDATE`,
        [organizationId, positionIds],
      )
      if (Number(lockedPositions.rowCount || 0) !== positionIds.length) {
        throw new OperationsRequestError(
          'OPERATIONS_INVENTORY_POSITION_CHANGED',
          'Reserved inventory changed before picks could be confirmed. Refresh and try again.',
          409,
        )
      }

      for (const item of countEvidenceAcknowledgement.validated) {
        const evidenceHash = commandRequestHash({
          orderGlobalId,
          orderRowVersion: input.expectedRowVersion,
          pickTaskGlobalId: item.context.pick_task_global_id,
          requiredQuantity: item.requiredQuantity,
          enteredQuantity: item.evidence.enteredQuantity,
          expectedProductBarcode: item.expectedProductBarcode,
          observedProductBarcode: item.evidence.product.barcode,
          productCapturedAt: item.evidence.product.capturedAt,
          productSource: item.evidence.product.source,
          countedAt: item.evidence.countedAt,
          countSource: item.evidence.countSource,
        })
        await client.query(
          `INSERT INTO operations_wearable_pick_count_evidence (
             organization_id, command_receipt_id,
             count_evidence_idempotency_key, order_id, order_row_version,
             pick_task_id, required_quantity, entered_quantity,
             expected_product_barcode, observed_product_barcode,
             product_captured_at, product_source, counted_at, count_source,
             evidence_hash, recorded_by
           ) VALUES (
             $1::uuid, $2::uuid, $3, $4::uuid, $5,
             $6::uuid, $7, $8,
             $9, $10, $11::timestamptz, $12, $13::timestamptz, $14,
             $15, $16
           )`,
          [
            organizationId,
            command.receipt.id,
            countEvidenceAcknowledgement.countEvidenceIdempotencyKey,
            order.id,
            input.expectedRowVersion,
            item.context.pick_task_id,
            item.requiredQuantity,
            item.evidence.enteredQuantity,
            item.expectedProductBarcode,
            item.evidence.product.barcode,
            item.evidence.product.capturedAt,
            item.evidence.product.source,
            item.evidence.countedAt,
            item.evidence.countSource,
            evidenceHash,
            actorEmail,
          ],
        )
      }

      const updatedPicks = await client.query<QueryResultRow & { global_id: string }>(
        `UPDATE operations_pick_tasks
         SET status = 'picked', picked_quantity = quantity, picked_at = now(), updated_at = now()
         WHERE organization_id = $1::uuid AND plan_id = $2::uuid AND status = 'ready'
         RETURNING global_id`,
        [organizationId, plan.id],
      )
      if (Number(updatedPicks.rowCount || 0) !== pickResult.rows.length) {
        throw new OperationsRequestError(
          'OPERATIONS_PICK_TASKS_CHANGED',
          'Pick tasks changed before they could be confirmed. Refresh and try again.',
          409,
        )
      }

      let localPickLedgerCount = 0
      let providerCommitmentPickCount = 0
      for (const pick of pickResult.rows) {
        if (pick.source_authority === 'shopify') {
          providerCommitmentPickCount += 1
          continue
        }
        const ledgerEvent = await client.query(
          `INSERT INTO operations_inventory_ledger (
             organization_id, position_id, event_type,
             on_hand_delta, reserved_delta, on_hand_after, reserved_after,
             source_global_id, reason, idempotency_key, actor_email
           )
           SELECT position.organization_id, position.id, 'pick',
                  0, 0, position.on_hand_quantity, position.reserved_quantity,
                  $3, $4, $5, $6
           FROM operations_inventory_positions position
           WHERE position.organization_id = $1::uuid AND position.id = $2::uuid
           RETURNING id`,
          [
            organizationId,
            pick.position_id,
            pick.global_id,
            reason,
            `${pick.global_id}:confirmed:${command.receipt.id}`,
            actorEmail,
          ],
        )
        if (ledgerEvent.rowCount !== 1) {
          throw new OperationsRequestError(
            'OPERATIONS_INVENTORY_POSITION_CHANGED',
            'Pick inventory evidence could not be recorded. Refresh and try again.',
            409,
          )
        }
        localPickLedgerCount += 1
      }

      const completedWave = await client.query(
        `UPDATE operations_waves
         SET status = 'completed', completed_at = now()
         WHERE organization_id = $1::uuid AND id = $2::uuid AND status = 'released'
         RETURNING id`,
        [organizationId, wave.id],
      )
      if (completedWave.rowCount !== 1) {
        throw new OperationsRequestError('OPERATIONS_WAVE_INVALID', 'Warehouse wave changed before completion', 409)
      }

      const updatedOrder = await client.query<OrderIdentityRow>(
        `UPDATE operations_orders
         SET status = 'picking', updated_by = $4, updated_at = now(), row_version = row_version + 1
         WHERE organization_id = $1::uuid AND id = $2::uuid
           AND status = 'released' AND row_version = $3
         RETURNING id::text, global_id, status, row_version::text`,
        [organizationId, order.id, input.expectedRowVersion, actorEmail],
      )
      const picked = updatedOrder.rows[0]
      if (!picked || picked.row_version === undefined) {
        throw new OperationsRequestError(
          'OPERATIONS_ORDER_VERSION_CONFLICT',
          'This order changed before picks could be confirmed. Refresh and try again.',
          409,
        )
      }

      await appendDomainEvent(client, {
        organizationId,
        aggregateType: 'operations.order',
        aggregateId: order.id,
        aggregateGlobalId: order.global_id,
        eventType: 'operations.pick.completed',
        actorEmail,
        correlationId: command.receipt.correlation_id,
        idempotencyKey: `${order.global_id}:picks-confirmed:${command.receipt.id}`,
        payload: {
          status: 'picking',
          planGlobalId: plan.global_id,
          waveGlobalId: wave.global_id,
          pickTaskGlobalIds: updatedPicks.rows.map((pick) => pick.global_id),
          reason,
          reservationsRetained: true,
          localPickLedgerCount,
          providerCommitmentPickCount,
          scanEvidenceEnforced: scanEvidenceAcknowledgement.enforced,
          scanEvidenceCount: scanEvidenceAcknowledgement.evidenceCount,
          scanEvidenceReceiptId: scanEvidenceAcknowledgement.receiptId,
          countEvidenceEnforced: countEvidenceAcknowledgement.enforced,
          countEvidenceCount: countEvidenceAcknowledgement.validated.length,
          countEvidenceIdempotencyKey:
            countEvidenceAcknowledgement.countEvidenceIdempotencyKey,
          countedPickTaskGlobalIds:
            countEvidenceAcknowledgement.validated.map(
              (item) => item.context.pick_task_global_id,
            ),
          countSources: [...new Set(
            countEvidenceAcknowledgement.validated.map(
              (item) => item.evidence.countSource,
            ),
          )],
        },
      })
      await recordAuditEvent({
        actor: actorEmail,
        eventType: 'operations.order.picks_confirmed',
        aggregateType: 'operations.order',
        aggregateId: order.global_id,
        subject: `Confirmed picks for ${order.global_id}`,
        organizationId,
        eventKey: `operations:order-picks-confirmed:${command.receipt.id}`,
        payload: {
          previousStatus: 'released',
          status: 'picking',
          previousRowVersion: input.expectedRowVersion,
          rowVersion: Number(picked.row_version),
          planGlobalId: plan.global_id,
          waveGlobalId: wave.global_id,
          pickTaskCount: updatedPicks.rows.length,
          reason,
          reservationsRetained: true,
          localPickLedgerCount,
          providerCommitmentPickCount,
          scanEvidenceEnforced: scanEvidenceAcknowledgement.enforced,
          scanEvidenceCount: scanEvidenceAcknowledgement.evidenceCount,
          scanEvidenceReceiptId: scanEvidenceAcknowledgement.receiptId,
          countEvidenceEnforced: countEvidenceAcknowledgement.enforced,
          countEvidenceCount: countEvidenceAcknowledgement.validated.length,
          countEvidenceIdempotencyKey:
            countEvidenceAcknowledgement.countEvidenceIdempotencyKey,
          countedPickTaskGlobalIds:
            countEvidenceAcknowledgement.validated.map(
              (item) => item.context.pick_task_global_id,
            ),
          countSources: [...new Set(
            countEvidenceAcknowledgement.validated.map(
              (item) => item.evidence.countSource,
            ),
          )],
        },
      }, client)
      const result: OperationsOrderCommandResult = {
        orderGlobalId: picked.global_id,
        orderStatus: picked.status,
        rowVersion: Number(picked.row_version),
        replayed: false,
      }
      await completeCommandReceipt(client, command.receipt.id, order.global_id, result)

      return result
    })
  } catch (error) {
    await failCommandReceipt(command.receipt.id, error)
    throw error
  }
}

export async function verifyOperationsOrderPackFromPostgres(input: {
  organizationId: string
  actorEmail: string
  orderGlobalId: string
  expectedRowVersion: number
  reason: string
  idempotencyKey: string
}): Promise<OperationsOrderCommandResult> {
  const organizationId = requireOrganizationId(input.organizationId)
  const actorEmail = String(input.actorEmail || '').trim().toLowerCase()
  const orderGlobalId = String(input.orderGlobalId || '').trim()
  const reason = String(input.reason || '').trim()
  const idempotencyKey = String(input.idempotencyKey || '').trim()
  if (!actorEmail) throw new OperationsRequestError('OPERATIONS_ACTOR_REQUIRED', 'A signed-in user is required', 401)
  if (!/^gor(?:[0-9]{7}|[0-9a-v]{12})$/.test(orderGlobalId)) {
    throw new OperationsRequestError('OPERATIONS_ORDER_INVALID', 'Order is invalid')
  }
  if (!Number.isSafeInteger(input.expectedRowVersion) || input.expectedRowVersion < 0) {
    throw new OperationsRequestError('OPERATIONS_ORDER_VERSION_INVALID', 'Order version is invalid')
  }
  if (!reason || reason.length > 500) {
    throw new OperationsRequestError('OPERATIONS_PACK_REASON_INVALID', 'A package verification reason is required')
  }
  if (!/^[A-Za-z0-9._:-]{8,200}$/.test(idempotencyKey)) {
    throw new OperationsRequestError('OPERATIONS_IDEMPOTENCY_KEY_INVALID', 'A valid idempotency key is required')
  }

  const command = await prepareCommandReceipt({
    organizationId,
    commandType: 'verify_operations_order_pack',
    idempotencyKey,
    requestHash: commandRequestHash({ orderGlobalId, expectedRowVersion: input.expectedRowVersion, reason }),
    actorEmail,
  })
  if (command.completed) {
    return completedOrderCommandResult(organizationId, command.receipt)
  }

  try {
    return await withTransaction(async (client) => {
      await acquireTransactionAdvisoryLock(client, `operations:order:${organizationId}:${orderGlobalId}`)
      const activation = await resolveActivation(client, organizationId)
      if (!['shadow', 'active'].includes(activation.state)) {
        throw new OperationsRequestError(
          'OPERATIONS_EXECUTION_STATE_INVALID',
          'Set Operations to Shadow or Active before verifying packages',
          409,
        )
      }

      const orderResult = await client.query<OrderIdentityRow & {
        pipeline_id: string
        customer_id: string
        contract_version_id: string | null
        currency: string
      }>(
        `SELECT id::text, global_id, status, row_version::text,
                pipeline_id::text, customer_id::text, contract_version_id::text, currency
         FROM operations_orders
         WHERE organization_id = $1::uuid AND global_id = $2
         FOR UPDATE`,
        [organizationId, orderGlobalId],
      )
      const order = orderResult.rows[0]
      if (!order || order.row_version === undefined) {
        throw new OperationsRequestError('OPERATIONS_ORDER_NOT_FOUND', 'Operations order was not found', 404)
      }
      if (Number(order.row_version) !== input.expectedRowVersion) {
        throw new OperationsRequestError(
          'OPERATIONS_ORDER_VERSION_CONFLICT',
          'This order changed after it was opened. Refresh the order before verifying packages.',
          409,
        )
      }
      await requireCurrentCommerceOrderRevision(client, {
        organizationId,
        orderId: order.id,
        operation: 'pack',
      })
      if (order.status !== 'picking') {
        throw new OperationsRequestError(
          'OPERATIONS_ORDER_TRANSITION_INVALID',
          `Order packages cannot be verified from ${order.status}`,
          409,
        )
      }

      const planResult = await client.query<QueryResultRow & {
        id: string
        global_id: string
        status: string
      }>(
        `SELECT id::text, global_id, status
         FROM operations_fulfillment_plans
         WHERE organization_id = $1::uuid AND order_id = $2::uuid
         ORDER BY version_number DESC
         LIMIT 1
         FOR UPDATE`,
        [organizationId, order.id],
      )
      const plan = planResult.rows[0]
      if (!plan || plan.status !== 'released') {
        throw new OperationsRequestError(
          'OPERATIONS_FULFILLMENT_PLAN_INVALID',
          'The released fulfillment plan is unavailable for package verification',
          409,
        )
      }

      const waveResult = await client.query<IdRow & { status: string }>(
        `SELECT wave.id::text, wave.global_id, wave.status
         FROM operations_waves wave
         WHERE wave.organization_id = $1::uuid
           AND wave.id = (
             SELECT pick.wave_id
             FROM operations_pick_tasks pick
             WHERE pick.organization_id = $1::uuid AND pick.plan_id = $2::uuid
             ORDER BY pick.created_at, pick.id
             LIMIT 1
           )
         FOR UPDATE`,
        [organizationId, plan.id],
      )
      const wave = waveResult.rows[0]
      if (!wave || wave.status !== 'completed') {
        throw new OperationsRequestError(
          'OPERATIONS_WAVE_INVALID',
          'The warehouse wave must be complete before verifying packages',
          409,
        )
      }

      const pickResult = await client.query<QueryResultRow & {
        global_id: string
        status: string
        quantity: string
        picked_quantity: string
      }>(
        `SELECT global_id, status, quantity::text, picked_quantity::text
         FROM operations_pick_tasks
         WHERE organization_id = $1::uuid AND plan_id = $2::uuid
         ORDER BY sequence_number, id
         FOR UPDATE`,
        [organizationId, plan.id],
      )
      if (pickResult.rows.length < 1 || pickResult.rows.some((pick) => (
        pick.status !== 'picked' || Number(pick.picked_quantity) !== Number(pick.quantity)
      ))) {
        throw new OperationsRequestError(
          'OPERATIONS_PICK_TASKS_INCOMPLETE',
          'Every pick task must be complete before verifying packages',
          409,
        )
      }

      const packageResult = await client.query<QueryResultRow & {
        id: string
        global_id: string
        package_number: number
        status: string
      }>(
        `SELECT id::text, global_id, package_number, status
         FROM operations_packages
         WHERE organization_id = $1::uuid AND plan_id = $2::uuid
         ORDER BY package_number, id
         FOR UPDATE`,
        [organizationId, plan.id],
      )
      if (packageResult.rows.length < 1 || packageResult.rows.some((item) => item.status !== 'planned')) {
        throw new OperationsRequestError(
          'OPERATIONS_PACKAGES_NOT_PLANNED',
          'Every package must be in the planned state before verification',
          409,
        )
      }

      const blockingResult = await client.query<QueryResultRow & { count: string }>(
        `SELECT count(*)::text AS count
         FROM operations_exceptions
         WHERE organization_id = $1::uuid AND order_id = $2::uuid
           AND status IN ('open', 'acknowledged')
           AND severity IN ('high', 'critical')`,
        [organizationId, order.id],
      )
      if (Number(blockingResult.rows[0]?.count || 0) > 0) {
        throw new OperationsRequestError(
          'OPERATIONS_ORDER_BLOCKED_BY_EXCEPTION',
          'Resolve high or critical order exceptions before verifying packages',
          409,
        )
      }

      const packedPackages = await client.query<QueryResultRow & { global_id: string }>(
        `UPDATE operations_packages
         SET status = 'packed', packed_by = $3, packed_at = now()
         WHERE organization_id = $1::uuid AND plan_id = $2::uuid AND status = 'planned'
         RETURNING global_id`,
        [organizationId, plan.id, actorEmail],
      )
      if (Number(packedPackages.rowCount || 0) !== packageResult.rows.length) {
        throw new OperationsRequestError(
          'OPERATIONS_PACKAGES_CHANGED',
          'Packages changed before they could be verified. Refresh and try again.',
          409,
        )
      }

      let billableEventCount = 0
      if (order.contract_version_id) {
        const directiveResult = await client.query<QueryResultRow & {
          id: string
          global_id: string
          directive_type: PricingDirective['type']
          priority: number
          configuration: Record<string, unknown>
        }>(
          `SELECT id::text, global_id, directive_type, priority, configuration
           FROM operations_pricing_directives
           WHERE organization_id = $1::uuid AND contract_version_id = $2::uuid
             AND directive_type = 'pack_fee'
           ORDER BY priority, global_id`,
          [organizationId, order.contract_version_id],
        )
        const directives: PricingDirective[] = directiveResult.rows.map((directive) => ({
          id: directive.id,
          globalId: directive.global_id,
          type: directive.directive_type,
          priority: directive.priority,
          configuration: json(directive.configuration),
        }))
        for (const packageRow of packageResult.rows) {
          for (const directive of directives) {
            const charge = priceContract({
              directives: [directive],
              totalUnits: 1,
              freightCostMinor: BigInt(0),
              packageCount: 1,
            }).charges[0]
            if (!charge) continue
            const billable = await client.query(
              `INSERT INTO operations_billable_events (
                 organization_id, pipeline_id, customer_id, order_id, contract_version_id,
                 directive_id, event_type, quantity, amount_minor, currency, status,
                 source_global_id, idempotency_key
               ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
                 $6::uuid, 'pack', 1, $7, $8, 'unbilled', $9, $10)
               ON CONFLICT (organization_id, idempotency_key) DO NOTHING
               RETURNING id`,
              [
                organizationId,
                order.pipeline_id,
                order.customer_id,
                order.id,
                order.contract_version_id,
                charge.directiveId,
                charge.amountMinor.toString(),
                order.currency,
                packageRow.global_id,
                `${order.global_id}:pack:${packageRow.global_id}:${charge.directiveGlobalId}`,
              ],
            )
            billableEventCount += Number(billable.rowCount || 0)
          }
        }
      }

      const updatedOrder = await client.query<OrderIdentityRow>(
        `UPDATE operations_orders
         SET status = 'packed', updated_by = $4, updated_at = now(), row_version = row_version + 1
         WHERE organization_id = $1::uuid AND id = $2::uuid
           AND status = 'picking' AND row_version = $3
         RETURNING id::text, global_id, status, row_version::text`,
        [organizationId, order.id, input.expectedRowVersion, actorEmail],
      )
      const packed = updatedOrder.rows[0]
      if (!packed || packed.row_version === undefined) {
        throw new OperationsRequestError(
          'OPERATIONS_ORDER_VERSION_CONFLICT',
          'This order changed before packages could be verified. Refresh and try again.',
          409,
        )
      }

      await appendDomainEvent(client, {
        organizationId,
        aggregateType: 'operations.order',
        aggregateId: order.id,
        aggregateGlobalId: order.global_id,
        eventType: 'operations.package.packed',
        actorEmail,
        correlationId: command.receipt.correlation_id,
        idempotencyKey: `${order.global_id}:pack-verified:${command.receipt.id}`,
        payload: {
          status: 'packed',
          planGlobalId: plan.global_id,
          waveGlobalId: wave.global_id,
          packageGlobalIds: packedPackages.rows.map((item) => item.global_id),
          billableEventCount,
          reason,
          reservationsRetained: true,
          labelPurchased: false,
          shipmentCreated: false,
        },
      })
      await recordAuditEvent({
        actor: actorEmail,
        eventType: 'operations.order.pack_verified',
        aggregateType: 'operations.order',
        aggregateId: order.global_id,
        subject: `Verified packages for ${order.global_id}`,
        organizationId,
        eventKey: `operations:order-pack-verified:${command.receipt.id}`,
        payload: {
          previousStatus: 'picking',
          status: 'packed',
          previousRowVersion: input.expectedRowVersion,
          rowVersion: Number(packed.row_version),
          planGlobalId: plan.global_id,
          waveGlobalId: wave.global_id,
          packageCount: packedPackages.rows.length,
          billableEventCount,
          reason,
          reservationsRetained: true,
          labelPurchased: false,
          shipmentCreated: false,
        },
      }, client)
      const result: OperationsOrderCommandResult = {
        orderGlobalId: packed.global_id,
        orderStatus: packed.status,
        rowVersion: Number(packed.row_version),
        replayed: false,
      }
      await completeCommandReceipt(client, command.receipt.id, order.global_id, result)

      return result
    })
  } catch (error) {
    await failCommandReceipt(command.receipt.id, error)
    throw error
  }
}

export async function generateOperationsPackagePackingSlipInPostgres(input: {
  organizationId: string
  actorEmail: string
  orderGlobalId: string
  packageGlobalId: string
  expectedRowVersion: number
  idempotencyKey: string
}): Promise<OperationsPackingSlipCommandResult> {
  const organizationId = requireOrganizationId(input.organizationId)
  const actorEmail = String(input.actorEmail || '').trim().toLowerCase()
  const orderGlobalId = String(input.orderGlobalId || '').trim()
  const packageGlobalId = String(input.packageGlobalId || '').trim()
  const idempotencyKey = String(input.idempotencyKey || '').trim()
  if (!actorEmail) {
    throw new OperationsRequestError(
      'OPERATIONS_ACTOR_REQUIRED',
      'A signed-in user is required',
      401,
    )
  }
  if (!/^gor(?:[0-9]{7}|[0-9a-v]{12})$/.test(orderGlobalId)) {
    throw new OperationsRequestError(
      'OPERATIONS_ORDER_INVALID',
      'Order is invalid',
    )
  }
  if (!/^gpa(?:[0-9]{7}|[0-9a-v]{12})$/.test(packageGlobalId)) {
    throw new OperationsRequestError(
      'OPERATIONS_PACKAGE_INVALID',
      'Package is invalid',
    )
  }
  if (
    !Number.isSafeInteger(input.expectedRowVersion)
    || input.expectedRowVersion < 0
  ) {
    throw new OperationsRequestError(
      'OPERATIONS_ORDER_VERSION_INVALID',
      'Order version is invalid',
    )
  }
  if (!/^[A-Za-z0-9._:-]{8,200}$/.test(idempotencyKey)) {
    throw new OperationsRequestError(
      'OPERATIONS_IDEMPOTENCY_KEY_INVALID',
      'A valid idempotency key is required',
    )
  }

  const command = await prepareCommandReceipt({
    organizationId,
    commandType: 'generate_operations_package_packing_slip',
    idempotencyKey,
    requestHash: commandRequestHash({
      orderGlobalId,
      packageGlobalId,
      expectedRowVersion: input.expectedRowVersion,
    }),
    actorEmail,
  })
  if (command.completed) {
    return completedPackingSlipCommandResult(command.receipt)
  }

  try {
    return await withTransaction(async (client) => {
      await acquireTransactionAdvisoryLock(
        client,
        `operations:package-packing-list:${organizationId}:${packageGlobalId}`,
      )
      const activation = await resolveActivation(client, organizationId)
      if (!['shadow', 'active'].includes(activation.state)) {
        throw new OperationsRequestError(
          'OPERATIONS_EXECUTION_STATE_INVALID',
          'Set Operations to Shadow or Active before generating warehouse documents',
          409,
        )
      }

      const packageResult = await client.query<QueryResultRow & {
        order_id: string
        order_global_id: string
        order_status: OperationsOrderStatus
        row_version: string
        order_number: string
        ship_to: Record<string, unknown>
        customer_global_id: string
        customer_name: string
        plan_id: string
        plan_global_id: string
        plan_status: string
        warehouse_id: string
        warehouse_global_id: string
        warehouse_name: string
        package_id: string
        package_global_id: string
        package_number: number
        package_status: string
        package_count: string
      }>(
        `SELECT
           source_order.id::text AS order_id,
           source_order.global_id AS order_global_id,
           source_order.status AS order_status,
           source_order.row_version::text,
           source_order.order_number,
           source_order.ship_to,
           customer.reference_code AS customer_global_id,
           customer.name AS customer_name,
           plan.id::text AS plan_id,
           plan.global_id AS plan_global_id,
           plan.status AS plan_status,
           plan.warehouse_id::text AS warehouse_id,
           warehouse.global_id AS warehouse_global_id,
           warehouse.name AS warehouse_name,
           package.id::text AS package_id,
           package.global_id AS package_global_id,
           package.package_number,
           package.status AS package_status,
           (
             SELECT count(*)::text
             FROM operations_packages candidate
             WHERE candidate.organization_id = package.organization_id
               AND candidate.plan_id = package.plan_id
           ) AS package_count
         FROM operations_orders source_order
         JOIN crm_organizations customer
           ON customer.pipeline_id = source_order.pipeline_id
          AND customer.id = source_order.customer_id
         JOIN LATERAL (
           SELECT candidate.*
           FROM operations_fulfillment_plans candidate
           WHERE candidate.organization_id = source_order.organization_id
             AND candidate.order_id = source_order.id
           ORDER BY candidate.version_number DESC
           LIMIT 1
         ) plan ON true
         JOIN operations_warehouses warehouse
           ON warehouse.organization_id = plan.organization_id
          AND warehouse.id = plan.warehouse_id
         JOIN operations_packages package
           ON package.organization_id = plan.organization_id
          AND package.plan_id = plan.id
          AND package.global_id = $3
         WHERE source_order.organization_id = $1::uuid
           AND source_order.global_id = $2
         FOR UPDATE OF source_order, plan, package`,
        [organizationId, orderGlobalId, packageGlobalId],
      )
      const source = packageResult.rows[0]
      if (!source) {
        throw new OperationsRequestError(
          'OPERATIONS_PACKAGE_NOT_FOUND',
          'Package was not found on the latest fulfillment plan for this order',
          404,
        )
      }
      if (source.order_status !== 'packed') {
        throw new OperationsRequestError(
          'OPERATIONS_PACKING_LIST_STAGE_INVALID',
          `Pack Work Instructions can be generated only while an order is packed, not ${source.order_status}`,
          409,
        )
      }
      if (Number(source.row_version) !== input.expectedRowVersion) {
        throw new OperationsRequestError(
          'OPERATIONS_ORDER_VERSION_CONFLICT',
          'This order changed after it was opened. Refresh before generating the Pack Work Instruction.',
          409,
        )
      }
      await requireCurrentCommerceOrderRevision(client, {
        organizationId,
        orderId: source.order_id,
        operation: 'packing_slip',
      })
      if (
        source.plan_status !== 'released'
        || !['packed', 'labeled'].includes(source.package_status)
      ) {
        throw new OperationsRequestError(
          'OPERATIONS_PACKING_LIST_STAGE_INVALID',
          'Verify the physical package before generating its Pack Work Instruction',
          409,
        )
      }

      const completenessResult = await client.query<QueryResultRow & {
        line_count: string
        complete_line_count: string
      }>(
        `SELECT
           count(*)::text AS line_count,
           count(*) FILTER (
             WHERE COALESCE(package_total.quantity, 0) = source_line.quantity
           )::text AS complete_line_count
         FROM operations_current_order_lines source_line
         LEFT JOIN LATERAL (
           SELECT sum(content.quantity) AS quantity
           FROM operations_package_contents content
           WHERE content.organization_id = source_line.organization_id
             AND content.plan_id = $3::uuid
             AND content.order_line_id = source_line.id
         ) package_total ON true
         WHERE source_line.organization_id = $1::uuid
           AND source_line.order_id = $2::uuid`,
        [organizationId, source.order_id, source.plan_id],
      )
      const completeness = completenessResult.rows[0]
      if (
        Number(completeness?.line_count || 0) < 1
        || Number(completeness?.complete_line_count || 0)
          !== Number(completeness?.line_count || 0)
      ) {
        throw new OperationsRequestError(
          'OPERATIONS_PACKAGE_CONTENTS_INCOMPLETE',
          'Exact line quantities are not allocated across every physical package. Correct cartonization before generating a Pack Work Instruction.',
          409,
        )
      }

      const contentResult = await client.query<QueryResultRow & {
        product_global_id: string
        product_name: string
        channel_sku: string
        quantity: string
      }>(
        `SELECT
           product.reference_code AS product_global_id,
           product.name AS product_name,
           source_line.channel_sku,
           content.quantity::text
         FROM operations_package_contents content
         JOIN operations_current_order_lines source_line
           ON source_line.organization_id = content.organization_id
          AND source_line.id = content.order_line_id
         JOIN crm_products product
           ON product.pipeline_id = source_line.pipeline_id
          AND product.id = source_line.product_id
         WHERE content.organization_id = $1::uuid
           AND content.plan_id = $2::uuid
           AND content.package_id = $3::uuid
         ORDER BY source_line.created_at, source_line.id`,
        [organizationId, source.plan_id, source.package_id],
      )
      if (contentResult.rows.length < 1) {
        throw new OperationsRequestError(
          'OPERATIONS_PACKAGE_CONTENTS_INCOMPLETE',
          'This physical package has no exact line allocation',
          409,
        )
      }
      const packingSnapshot = {
        documentKind: 'pack_work_instruction' as const,
        documentStage: 'pre_label_pack_work_instruction' as const,
        finalPackingSlip: false as const,
        orderGlobalId: source.order_global_id,
        orderNumber: source.order_number,
        customerName: source.customer_name,
        customerGlobalId: source.customer_global_id,
        fulfillmentPlanGlobalId: source.plan_global_id,
        warehouseId: source.warehouse_id,
        warehouseGlobalId: source.warehouse_global_id,
        warehouseName: source.warehouse_name,
        packageGlobalId: source.package_global_id,
        packageNumber: Number(source.package_number),
        packageCount: Number(source.package_count),
        shipTo: address(source.ship_to),
        lines: contentResult.rows.map((content) => ({
          productGlobalId: content.product_global_id,
          productName: content.product_name,
          channelSku: content.channel_sku,
          quantity: assertPositiveQuantity(content.quantity),
        })),
      }
      const rendered = renderPackagePackWorkInstruction(packingSnapshot)
      const storageReference = (
        `clawpilot-document:${source.package_global_id}:pack-work-instruction:${rendered.contentSha256}`
      )
      const insertedArtifact = await client.query<IdRow>(
        `INSERT INTO operations_print_artifacts (
           organization_id, source_order_id, source_package_id,
           document_type, format, media_size, content_sha256,
           byte_length, storage_reference, created_by
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid,
           'packing_slip', 'PDF', 'letter', $4, $5, $6, $7
         )
         ON CONFLICT (
           organization_id, source_package_id, format, media_size
         ) WHERE document_type = 'packing_slip'
           AND source_package_id IS NOT NULL
           AND source_shipment_id IS NULL
           AND storage_reference LIKE
             'clawpilot-document:%:pack-work-instruction:%'
         DO NOTHING
         RETURNING id::text, global_id`,
        [
          organizationId,
          source.order_id,
          source.package_id,
          rendered.contentSha256,
          rendered.byteLength,
          storageReference,
          actorEmail,
        ],
      )
      let artifact = insertedArtifact.rows[0]
      if (artifact) {
        await client.query(
          `INSERT INTO operations_print_artifact_payloads (
             artifact_id, organization_id, mime_type, filename, payload,
             template_version, render_snapshot
           ) VALUES (
             $1::uuid, $2::uuid, $3, $4, $5, $6, $7::jsonb
           )`,
          [
            artifact.id,
            organizationId,
            rendered.mimeType,
            rendered.filename,
            rendered.payload,
            PACKAGE_PACK_WORK_INSTRUCTION_TEMPLATE_VERSION,
            JSON.stringify(packingSnapshot),
          ],
        )
      } else {
        const existing = await client.query<IdRow & {
          content_sha256: string
          byte_length: string
          payload_sha256: string | null
          payload_byte_length: string | null
        }>(
          `SELECT artifact.id::text, artifact.global_id,
                  artifact.content_sha256, artifact.byte_length::text,
                  encode(digest(payload.payload, 'sha256'), 'hex') AS payload_sha256,
                  octet_length(payload.payload)::text AS payload_byte_length
           FROM operations_print_artifacts artifact
           JOIN operations_print_artifact_payloads payload
             ON payload.organization_id = artifact.organization_id
            AND payload.artifact_id = artifact.id
           WHERE artifact.organization_id = $1::uuid
             AND artifact.source_package_id = $2::uuid
             AND artifact.source_shipment_id IS NULL
             AND artifact.document_type = 'packing_slip'
             AND artifact.storage_reference LIKE
               'clawpilot-document:%:pack-work-instruction:%'
             AND artifact.format = 'PDF'
             AND artifact.media_size = 'letter'
           FOR SHARE OF artifact, payload`,
          [organizationId, source.package_id],
        )
        const existingArtifact = existing.rows[0]
        if (
          !existingArtifact
          || existingArtifact.content_sha256 !== rendered.contentSha256
          || Number(existingArtifact.byte_length) !== rendered.byteLength
          || existingArtifact.payload_sha256 !== rendered.contentSha256
          || Number(existingArtifact.payload_byte_length) !== rendered.byteLength
        ) {
          throw new OperationsRequestError(
            'OPERATIONS_PACKING_LIST_CONFLICT',
            'The existing Pack Work Instruction does not match its immutable allocation',
            409,
          )
        }
        artifact = existingArtifact
      }
      const contentUrl = (
        `/api/operations/artifacts/${encodeURIComponent(artifact.global_id)}`
      )

      await appendDomainEvent(client, {
        organizationId,
        aggregateType: 'operations.order',
        aggregateId: source.order_id,
        aggregateGlobalId: source.order_global_id,
        eventType: 'operations.package.pack_work_instruction_generated',
        actorEmail,
        correlationId: command.receipt.correlation_id,
        idempotencyKey: `${artifact.global_id}:generated`,
        payload: {
          packageGlobalId: source.package_global_id,
          packageNumber: source.package_number,
          packageCount: Number(source.package_count),
          documentKind: packingSnapshot.documentKind,
          documentStage: packingSnapshot.documentStage,
          finalPackingSlip: packingSnapshot.finalPackingSlip,
          packingSlipArtifactGlobalId: artifact.global_id,
          lineCount: packingSnapshot.lines.length,
          carrierActionPerformed: false,
        },
      })
      await recordAuditEvent({
        actor: actorEmail,
        eventType: 'operations.package.pack_work_instruction_generated',
        aggregateType: 'operations.package',
        aggregateId: source.package_global_id,
        subject: `Generated package ${source.package_number} Pack Work Instruction for ${source.order_global_id}`,
        organizationId,
        eventKey: `operations:package-pack-work-instruction:${artifact.global_id}`,
        payload: {
          orderGlobalId: source.order_global_id,
          packageGlobalId: source.package_global_id,
          documentKind: packingSnapshot.documentKind,
          documentStage: packingSnapshot.documentStage,
          finalPackingSlip: packingSnapshot.finalPackingSlip,
          packingSlipArtifactGlobalId: artifact.global_id,
          lineCount: packingSnapshot.lines.length,
          contentSha256: rendered.contentSha256,
          byteLength: rendered.byteLength,
          templateVersion: PACKAGE_PACK_WORK_INSTRUCTION_TEMPLATE_VERSION,
          carrierActionPerformed: false,
        },
      }, client)

      const result: OperationsPackingSlipCommandResult = {
        orderGlobalId: source.order_global_id,
        orderStatus: 'packed',
        rowVersion: Number(source.row_version),
        packageGlobalId: source.package_global_id,
        packageNumber: Number(source.package_number),
        documentKind: packingSnapshot.documentKind,
        documentStage: packingSnapshot.documentStage,
        finalPackingSlip: packingSnapshot.finalPackingSlip,
        packingSlipArtifactGlobalId: artifact.global_id,
        contentUrl,
        replayed: false,
      }
      await completeCommandReceipt(
        client,
        command.receipt.id,
        source.order_global_id,
        result,
      )
      return result
    })
  } catch (error) {
    await failCommandReceipt(command.receipt.id, error)
    throw error
  }
}

type CommerceFulfillmentExportExecutionRow = QueryResultRow & {
  order_id: string
  order_currency: string
  global_id: string
  provider: string
  state: 'queued' | 'processing' | 'succeeded' | 'failed' | 'unsupported'
  external_order_id: string
  payload_snapshot: Record<string, unknown>
  idempotency_key: string
  attempts: number
  provider_reference: string | null
  error_code: string | null
  error_message: string | null
  updated_at: Date
  integration_account_id: string | null
  account_global_id: string | null
  provider_attempt_id: string | null
  provider_attempt_global_id: string | null
  provider_attempt_state: string | null
  provider_attempt_number: number | null
  provider_attempt_request_hash: string | null
  provider_attempt_request: Record<string, unknown> | null
}

const SHOPIFY_FULFILLMENT_PROVIDER_ATTEMPT_ACTION =
  'shopify.fulfillment.create'
const SHOPIFY_FULFILLMENT_PROVIDER_ATTEMPT_ADAPTER =
  'shopify-fulfillment-writeback-v2'
const FAIRE_FULFILLMENT_PROVIDER_ATTEMPT_ACTION =
  'faire.fulfillment.shipments.create'
const FAIRE_FULFILLMENT_PROVIDER_ATTEMPT_ADAPTER =
  'faire-fulfillment-writeback-v2'
const FAIRE_FULFILLMENT_PROVIDER_WRITE_PROTOCOL =
  'faire-fulfillment-attempt-v1'

type FaireFulfillmentAttemptRequest = {
  version: 1
  externalOrderId: string
  expectedShipDate: string
  authorizationRevision: number
  packages: Array<{
    packageReference: string
    carrier: string
    trackingCode: string
    makerCost?: {
      amountMinor: number
      currency: string
    }
  }>
}

function normalizeFaireFulfillmentPackages(value: unknown) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100) {
    throw new OperationsRequestError(
      'OPERATIONS_FAIRE_FULFILLMENT_PACKAGES_INVALID',
      'Faire fulfillment requires exact evidence for every physical package',
      409,
    )
  }
  const packageReferences = new Set<string>()
  const trackingCodes = new Set<string>()
  return value.map((candidate) => {
    const packageSnapshot = json(candidate)
    const packageReference = String(
      packageSnapshot.packageReference || '',
    ).trim()
    const carrier = String(packageSnapshot.carrier || '').trim()
    const trackingCode = String(packageSnapshot.trackingCode || '').trim()
    const makerCostSnapshot = packageSnapshot.makerCost === undefined
      || packageSnapshot.makerCost === null
      ? null
      : json(packageSnapshot.makerCost)
    const makerCost = makerCostSnapshot === null
      ? null
      : {
          amountMinor: Number(makerCostSnapshot.amountMinor),
          currency: String(makerCostSnapshot.currency || '')
            .trim()
            .toUpperCase(),
        }
    if (
      !/^gpa(?:[0-9]{7}|[0-9a-v]{12})$/.test(packageReference)
      || !carrier
      || carrier.length > 80
      || !trackingCode
      || trackingCode.length > 255
      || /[\u0000-\u001f\u007f]/.test(`${carrier}${trackingCode}`)
      || (
        makerCost !== null
        && (
          !Number.isSafeInteger(makerCost.amountMinor)
          || makerCost.amountMinor < 0
          || !/^[A-Z]{3}$/.test(makerCost.currency)
        )
      )
      || packageReferences.has(packageReference)
      || trackingCodes.has(trackingCode)
    ) {
      throw new OperationsRequestError(
        'OPERATIONS_FAIRE_FULFILLMENT_PACKAGES_INVALID',
        'Faire package carrier and tracking evidence is invalid or duplicated',
        409,
      )
    }
    packageReferences.add(packageReference)
    trackingCodes.add(trackingCode)
    return {
      packageReference,
      carrier,
      trackingCode,
      ...(makerCost === null ? {} : { makerCost }),
    }
  })
}

async function requireFaireFulfillmentPackageMakerCosts(input: {
  organizationId: string
  orderId: string
  orderCurrency: string
  packages: ReturnType<typeof normalizeFaireFulfillmentPackages>
}) {
  if (input.packages.every((item) => item.makerCost)) {
    return input.packages
  }
  const references = input.packages.map((item) => item.packageReference)
  const result = await query<{
    package_global_id: string
    quoted_carrier_cost_minor: string
  }>(
    `SELECT package.global_id AS package_global_id,
            shipment.quoted_carrier_cost_minor::text
     FROM operations_shipments shipment
     JOIN operations_packages package
       ON package.organization_id = shipment.organization_id
      AND package.id = shipment.package_id
     WHERE shipment.organization_id = $1::uuid
       AND shipment.order_id = $2::uuid
       AND package.global_id = ANY($3::text[])
     ORDER BY package.global_id`,
    [input.organizationId, input.orderId, references],
  )
  const costs = new Map(result.rows.map((row) => [
    row.package_global_id,
    Number(row.quoted_carrier_cost_minor),
  ]))
  if (
    costs.size !== references.length
    || [...costs.values()].some((amountMinor) => (
      !Number.isSafeInteger(amountMinor) || amountMinor < 0
    ))
    || !/^[A-Z]{3}$/.test(input.orderCurrency)
  ) {
    throw new OperationsRequestError(
      'OPERATIONS_FAIRE_FULFILLMENT_MAKER_COST_INVALID',
      'Faire fulfillment requires durable shipping-cost evidence for every package',
      409,
    )
  }
  return input.packages.map((item) => ({
    ...item,
    makerCost: item.makerCost || {
      amountMinor: costs.get(item.packageReference)!,
      currency: input.orderCurrency,
    },
  }))
}

function normalizeFaireFulfillmentAttemptRequest(
  value: unknown,
  expectedExternalOrderId: string,
): FaireFulfillmentAttemptRequest {
  const request = json(value)
  const externalOrderId = String(request.externalOrderId || '').trim()
  const expectedShipDate = String(request.expectedShipDate || '').trim()
  const authorizationRevision = Number(request.authorizationRevision)
  const parsedShipDate = new Date(expectedShipDate)
  if (
    request.version !== 1
    || externalOrderId !== expectedExternalOrderId
    || !/^bo_[A-Za-z0-9_-]+$/.test(externalOrderId)
    || !Number.isFinite(parsedShipDate.getTime())
    || !Number.isSafeInteger(authorizationRevision)
    || authorizationRevision < 1
  ) {
    throw new OperationsRequestError(
      'OPERATIONS_FAIRE_FULFILLMENT_SIGNATURE_INVALID',
      'The durable Faire fulfillment attempt signature is invalid or stale',
      409,
    )
  }
  return {
    version: 1,
    externalOrderId,
    expectedShipDate: parsedShipDate.toISOString(),
    authorizationRevision,
    packages: normalizeFaireFulfillmentPackages(request.packages),
  }
}

function faireFulfillmentAttemptRequestHash(
  request: FaireFulfillmentAttemptRequest,
) {
  return createHash('sha256')
    .update(JSON.stringify(request))
    .digest('hex')
}

function requireFaireFulfillmentAttemptRequestHash(
  request: FaireFulfillmentAttemptRequest,
  expectedHash: unknown,
) {
  const normalizedExpectedHash = String(expectedHash || '')
    .trim()
    .toLowerCase()
  if (
    !/^[a-f0-9]{64}$/.test(normalizedExpectedHash)
    || faireFulfillmentAttemptRequestHash(request) !== normalizedExpectedHash
  ) {
    throw new OperationsRequestError(
      'OPERATIONS_FAIRE_FULFILLMENT_SIGNATURE_INVALID',
      'The durable Faire fulfillment attempt request failed its integrity check',
      409,
    )
  }
}

async function registerShopifyFulfillmentProviderAttempt(input: {
  organizationId: string
  actorEmail: string | null
  commerceExportGlobalId: string
  integrationAccountId: string
  exportIdempotencyKey: string
  exportAttempt: number
  preparedRequest: unknown
}) {
  if (
    !input.preparedRequest
    || typeof input.preparedRequest !== 'object'
    || Array.isArray(input.preparedRequest)
  ) {
    throw new OperationsRequestError(
      'OPERATIONS_SHOPIFY_FULFILLMENT_SIGNATURE_INVALID',
      'Shopify fulfillment preparation returned an invalid durable signature',
      409,
    )
  }
  const serializedRequest = JSON.stringify(input.preparedRequest)
  const requestHash = createHash('sha256')
    .update(serializedRequest)
    .digest('hex')
  return withTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(
      client,
      `operations:commerce-fulfillment-export:${input.organizationId}:${input.commerceExportGlobalId}`,
    )
    const guardedExport = await client.query(
      `SELECT id
       FROM operations_commerce_fulfillment_exports
       WHERE organization_id = $1::uuid
         AND global_id = $2
         AND state = 'processing'
         AND attempts = $3
       FOR UPDATE`,
      [
        input.organizationId,
        input.commerceExportGlobalId,
        input.exportAttempt,
      ],
    )
    if (guardedExport.rowCount !== 1) {
      throw new OperationsRequestError(
        'OPERATIONS_COMMERCE_EXPORT_CHANGED',
        'Commerce fulfillment export changed before the provider attempt was registered',
        409,
      )
    }
    const existing = await client.query(
      `SELECT global_id
       FROM operations_commerce_provider_attempts
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid
         AND action = $3
         AND external_object_id = $4
       LIMIT 1`,
      [
        input.organizationId,
        input.integrationAccountId,
        SHOPIFY_FULFILLMENT_PROVIDER_ATTEMPT_ACTION,
        input.commerceExportGlobalId,
      ],
    )
    if (existing.rowCount) {
      throw new OperationsRequestError(
        'OPERATIONS_COMMERCE_EXPORT_RECONCILIATION_REQUIRED',
        'A durable Shopify provider attempt already exists; only read-only reconciliation is safe',
        409,
      )
    }
    const attempt = await client.query<{
      id: string
      global_id: string
    }>(
      `INSERT INTO operations_commerce_provider_attempts (
         organization_id, integration_account_id, action, adapter_version,
         external_object_id, idempotency_key, request_hash,
         redacted_request, redacted_response, state, attempt_number,
         lease_token, lease_expires_at, requested_at, created_by
       ) VALUES (
         $1::uuid, $2::uuid, $3, $4,
         $5, $6, $7, $8::jsonb, '{}'::jsonb, 'prepared', $9,
         $10::uuid, now() + interval '5 minutes', now(), $11
       )
       RETURNING id::text, global_id`,
      [
        input.organizationId,
        input.integrationAccountId,
        SHOPIFY_FULFILLMENT_PROVIDER_ATTEMPT_ACTION,
        SHOPIFY_FULFILLMENT_PROVIDER_ATTEMPT_ADAPTER,
        input.commerceExportGlobalId,
        input.exportIdempotencyKey,
        requestHash,
        serializedRequest,
        input.exportAttempt,
        randomUUID(),
        input.actorEmail,
      ],
    )
    return {
      id: attempt.rows[0].id,
      globalId: attempt.rows[0].global_id,
      requestHash,
    }
  })
}

async function registerFaireFulfillmentProviderAttempt(input: {
  organizationId: string
  actorEmail: string | null
  commerceExportGlobalId: string
  integrationAccountId: string
  exportIdempotencyKey: string
  exportAttempt: number
  preparedRequest: FaireFulfillmentAttemptRequest
}) {
  const serializedRequest = JSON.stringify(input.preparedRequest)
  const requestHash = faireFulfillmentAttemptRequestHash(
    input.preparedRequest,
  )
  return withTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(
      client,
      `operations:commerce-fulfillment-export:${input.organizationId}:${input.commerceExportGlobalId}`,
    )
    const guardedExport = await client.query(
      `SELECT id
       FROM operations_commerce_fulfillment_exports
       WHERE organization_id = $1::uuid
         AND global_id = $2
         AND state = 'processing'
         AND attempts = $3
       FOR UPDATE`,
      [
        input.organizationId,
        input.commerceExportGlobalId,
        input.exportAttempt,
      ],
    )
    if (guardedExport.rowCount !== 1) {
      throw new OperationsRequestError(
        'OPERATIONS_COMMERCE_EXPORT_CHANGED',
        'Commerce fulfillment export changed before the Faire attempt was registered',
        409,
      )
    }
    const existing = await client.query<{
      global_id: string
      state: string
      error_code: string | null
      request_hash: string
      redacted_request: Record<string, unknown>
    }>(
      `SELECT global_id, state, error_code, request_hash, redacted_request
       FROM operations_commerce_provider_attempts
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid
         AND action = $3
         AND external_object_id = $4
       ORDER BY attempt_number DESC, requested_at DESC, id DESC
       LIMIT 1`,
      [
        input.organizationId,
        input.integrationAccountId,
        FAIRE_FULFILLMENT_PROVIDER_ATTEMPT_ACTION,
        input.commerceExportGlobalId,
      ],
    )
    if (existing.rowCount) {
      const prior = existing.rows[0]
      const priorRevision = Number(
        json(prior.redacted_request).authorizationRevision,
      )
      const revisedKnownRejection = (
        prior.state === 'failed'
        && prior.error_code === 'FAIRE_REQUEST_REJECTED'
        && Number.isSafeInteger(priorRevision)
        && input.preparedRequest.authorizationRevision > priorRevision
        && requestHash !== prior.request_hash
      )
      if (!revisedKnownRejection) {
        throw new OperationsRequestError(
          'OPERATIONS_COMMERCE_EXPORT_RECONCILIATION_REQUIRED',
          'A durable Faire provider attempt already exists; a known rejection requires a newer reviewed authorization before resubmission',
          409,
        )
      }
    }
    const attempt = await client.query<{
      id: string
      global_id: string
    }>(
      `INSERT INTO operations_commerce_provider_attempts (
         organization_id, integration_account_id, action, adapter_version,
         external_object_id, idempotency_key, request_hash,
         redacted_request, redacted_response, state, attempt_number,
         lease_token, lease_expires_at, requested_at, created_by
       ) VALUES (
         $1::uuid, $2::uuid, $3, $4,
         $5, $6, $7, $8::jsonb, '{}'::jsonb, 'prepared', $9,
         $10::uuid, now() + interval '5 minutes', now(), $11
       )
       RETURNING id::text, global_id`,
      [
        input.organizationId,
        input.integrationAccountId,
        FAIRE_FULFILLMENT_PROVIDER_ATTEMPT_ACTION,
        FAIRE_FULFILLMENT_PROVIDER_ATTEMPT_ADAPTER,
        input.commerceExportGlobalId,
        input.exportIdempotencyKey,
        requestHash,
        serializedRequest,
        input.exportAttempt,
        randomUUID(),
        input.actorEmail,
      ],
    )
    return {
      id: attempt.rows[0].id,
      globalId: attempt.rows[0].global_id,
      requestHash,
    }
  })
}

export async function executeOperationsCommerceFulfillmentExportFromPostgres(input: {
  organizationId: string
  actorEmail: string | null
  commerceExportGlobalId: string
  reason: string
  auditEventKey: string
  preclaimed?: {
    attempt: number
    priorState: 'queued' | 'processing' | 'failed'
    priorErrorCode: string | null
    workerId: string
  }
}): Promise<OperationsCommerceFulfillmentRetryResult> {
  const claimed = await withTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(
      client,
      `operations:commerce-fulfillment-export:${input.organizationId}:${input.commerceExportGlobalId}`,
    )
    const result = await client.query<CommerceFulfillmentExportExecutionRow>(
      `SELECT fulfillment_export.order_id::text AS order_id,
              source_order.currency AS order_currency,
              fulfillment_export.global_id, fulfillment_export.provider,
              fulfillment_export.state, fulfillment_export.external_order_id,
              fulfillment_export.payload_snapshot,
              fulfillment_export.idempotency_key,
              fulfillment_export.attempts,
              fulfillment_export.provider_reference,
              fulfillment_export.error_code,
              fulfillment_export.error_message,
              fulfillment_export.updated_at,
              integration.id::text AS integration_account_id,
              integration.global_id AS account_global_id,
              provider_attempt.id::text AS provider_attempt_id,
              provider_attempt.global_id AS provider_attempt_global_id,
              provider_attempt.state AS provider_attempt_state,
              provider_attempt.attempt_number AS provider_attempt_number,
              provider_attempt.request_hash AS provider_attempt_request_hash,
              provider_attempt.redacted_request AS provider_attempt_request
       FROM operations_commerce_fulfillment_exports fulfillment_export
       JOIN operations_orders source_order
         ON source_order.organization_id = fulfillment_export.organization_id
        AND source_order.id = fulfillment_export.order_id
       LEFT JOIN operations_integration_accounts integration
         ON integration.organization_id = source_order.organization_id
        AND integration.id = source_order.integration_account_id
       LEFT JOIN LATERAL (
         SELECT attempt.id, attempt.global_id, attempt.state,
                attempt.attempt_number, attempt.request_hash,
                attempt.redacted_request,
                attempt.requested_at
         FROM operations_commerce_provider_attempts attempt
         WHERE attempt.organization_id = fulfillment_export.organization_id
           AND attempt.integration_account_id = integration.id
           AND attempt.action = CASE fulfillment_export.provider
             WHEN 'shopify' THEN 'shopify.fulfillment.create'
             WHEN 'faire' THEN 'faire.fulfillment.shipments.create'
             ELSE ''
           END
           AND attempt.external_object_id = fulfillment_export.global_id
         ORDER BY attempt.attempt_number DESC, attempt.requested_at DESC,
                  attempt.id DESC
         LIMIT 1
       ) provider_attempt ON true
       WHERE fulfillment_export.organization_id = $1::uuid
         AND fulfillment_export.global_id = $2
       LIMIT 1
       FOR UPDATE OF fulfillment_export`,
      [input.organizationId, input.commerceExportGlobalId],
    )
    const row = result.rows[0]
    if (!row) {
      throw new OperationsRequestError(
        'OPERATIONS_COMMERCE_EXPORT_NOT_FOUND',
        'Commerce fulfillment export was not found',
        404,
      )
    }
    await requireCurrentCommerceOrderRevision(client, {
      organizationId: input.organizationId,
      orderId: row.order_id,
      operation: 'export',
    })
    const decision = commerceExportCustomerNotificationDecision(
      row.payload_snapshot,
      row.provider,
    )
    if (['succeeded', 'unsupported'].includes(row.state)) {
      return { row, decision, terminal: true as const }
    }
    if (
      !input.preclaimed
      &&
      row.state === 'processing'
      && Date.now() - row.updated_at.getTime() < 5 * 60_000
    ) {
      throw new OperationsRequestError(
        'OPERATIONS_COMMERCE_EXPORT_IN_PROGRESS',
        'This commerce fulfillment export is already being processed',
        409,
      )
    }
    const exportSnapshot = json(row.payload_snapshot)
    const usesSafeShopifyAttemptProtocol = (
      exportSnapshot.providerWriteProtocol
      === 'shopify-fulfillment-attempt-v2'
    )
    const usesSafeFaireAttemptProtocol = (
      exportSnapshot.providerWriteProtocol
      === FAIRE_FULFILLMENT_PROVIDER_WRITE_PROTOCOL
    )
    const priorState: 'queued' | 'processing' | 'failed' = (
      input.preclaimed?.priorState
      || (row.state === 'processing' || row.state === 'failed'
        ? row.state
        : 'queued')
    )
    const priorErrorCode = input.preclaimed
      ? input.preclaimed.priorErrorCode
      : row.error_code
    const recoveryMode = commerceFulfillmentRecoveryMode({
      provider: row.provider,
      priorState,
      priorErrorCode,
      hasProviderAttempt: Boolean(row.provider_attempt_global_id),
      providerAttemptState: row.provider_attempt_state,
      usesSafeShopifyAttemptProtocol,
      usesSafeFaireAttemptProtocol,
    })
    let claimedRow: CommerceFulfillmentExportExecutionRow
    if (input.preclaimed) {
      if (
        row.state !== 'processing'
        || row.attempts !== input.preclaimed.attempt
      ) {
        throw new OperationsRequestError(
          'OPERATIONS_COMMERCE_EXPORT_CHANGED',
          'Commerce fulfillment export changed after the recovery worker claim',
          409,
        )
      }
      claimedRow = row
    } else {
      const updated = await client.query<CommerceFulfillmentExportExecutionRow>(
        `UPDATE operations_commerce_fulfillment_exports
         SET state = 'processing', attempts = attempts + 1,
             provider_reference = NULL, error_code = NULL, error_message = NULL,
             completed_at = NULL, updated_at = now()
         WHERE organization_id = $1::uuid
           AND global_id = $2
           AND attempts = $3
           AND state = $4
         RETURNING global_id, provider, state, external_order_id,
                   payload_snapshot, idempotency_key, attempts,
                   provider_reference, error_code, error_message, updated_at,
                   NULL::text AS integration_account_id,
                   NULL::text AS account_global_id,
                   NULL::text AS provider_attempt_id,
                   NULL::text AS provider_attempt_global_id,
                   NULL::text AS provider_attempt_state,
                   NULL::integer AS provider_attempt_number,
                   NULL::text AS provider_attempt_request_hash,
                   NULL::jsonb AS provider_attempt_request`,
        [
          input.organizationId,
          input.commerceExportGlobalId,
          row.attempts,
          row.state,
        ],
      )
      if (updated.rowCount !== 1) {
        throw new OperationsRequestError(
          'OPERATIONS_COMMERCE_EXPORT_CHANGED',
          'Commerce fulfillment export changed before it could be retried',
          409,
        )
      }
      claimedRow = {
        ...updated.rows[0],
        order_id: row.order_id,
        order_currency: row.order_currency,
        integration_account_id: row.integration_account_id,
        account_global_id: row.account_global_id,
        provider_attempt_id: row.provider_attempt_id,
        provider_attempt_global_id: row.provider_attempt_global_id,
        provider_attempt_state: row.provider_attempt_state,
        provider_attempt_number: row.provider_attempt_number,
        provider_attempt_request_hash: row.provider_attempt_request_hash,
        provider_attempt_request: row.provider_attempt_request,
      }
    }
    await recordAuditEvent({
      actor: input.preclaimed ? 'system' : input.actorEmail,
      isSystem: Boolean(input.preclaimed),
      eventType: 'operations.commerce_fulfillment.attempted',
      aggregateType: 'operations.commerce_fulfillment_export',
      aggregateId: row.global_id,
      subject: `Commerce fulfillment export ${row.global_id}`,
      organizationId: input.organizationId,
      eventKey: input.auditEventKey,
      payload: {
        provider: row.provider,
        attempt: claimedRow.attempts,
        priorState,
        recoveryMode,
        reason: input.reason,
        recoveryWorkerId: input.preclaimed?.workerId || null,
        originalConfirmer: input.preclaimed ? input.actorEmail : null,
        customerNotification: decision,
      },
    }, client)
    return {
      row: claimedRow,
      decision,
      recoveryMode,
      terminal: false as const,
    }
  })

  if (claimed.terminal) {
    return {
      commerceExportGlobalId: claimed.row.global_id,
      state: claimed.row.state as OperationsCommerceFulfillmentRetryResult['state'],
      providerReference: claimed.row.provider_reference,
      errorCode: claimed.row.error_code,
      errorMessage: claimed.row.error_message,
      customerNotification: claimed.decision,
      replayed: true,
    }
  }

  const snapshot = json(claimed.row.payload_snapshot)
  const trackingNumbers = Array.isArray(snapshot.trackingNumbers)
    ? [...new Set(snapshot.trackingNumbers
        .filter((value): value is string => typeof value === 'string')
        .map((value) => value.trim())
        .filter(Boolean))]
    : typeof snapshot.trackingNumber === 'string'
      ? [snapshot.trackingNumber.trim()].filter(Boolean)
      : []
  const carrier = typeof snapshot.carrier === 'string'
    ? snapshot.carrier.trim()
    : ''
  const shippedAt = typeof snapshot.shippedAt === 'string'
    ? snapshot.shippedAt
    : ''
  let state: OperationsCommerceFulfillmentRetryResult['state'] = 'failed'
  let providerReference: string | null = null
  let errorCode: string | null = null
  let errorMessage: string | null = null
  let registeredProviderAttempt: {
    id: string
    globalId: string
    requestHash: string
  } | null = null
  let providerAttemptResponse: Record<string, unknown> | null = null
  try {
    if (!carrier || trackingNumbers.length === 0) {
      throw new OperationsRequestError(
        'OPERATIONS_COMMERCE_EXPORT_SNAPSHOT_INVALID',
        'Commerce fulfillment export tracking evidence is incomplete',
        409,
      )
    }
    if (claimed.row.provider === 'mock-commerce') {
      if (claimed.recoveryMode === 'reconcile_only') {
        errorCode = 'OPERATIONS_COMMERCE_EXPORT_RECONCILIATION_REQUIRED'
        errorMessage = (
          'A stale fulfillment export was fenced. Repeated recovery remains '
          + 'read-only until provider state is unambiguous.'
        )
      } else {
        const commerceAdapter = new MockCommerceAdapter()
        const result = await commerceAdapter.updateFulfillment({
          externalOrderId: claimed.row.external_order_id,
          trackingNumber: trackingNumbers[0],
          carrier,
          shippedAt,
          idempotencyKey: claimed.row.idempotency_key,
        })
        state = result.accepted ? 'succeeded' : 'failed'
        providerReference = result.providerReference || null
        if (!result.accepted) {
          errorCode = 'OPERATIONS_COMMERCE_EXPORT_REJECTED'
          errorMessage = 'The commerce provider rejected the fulfillment export.'
        }
      }
    } else if (claimed.row.provider === 'shopify') {
      if (
        !claimed.row.account_global_id
        || !claimed.row.integration_account_id
      ) {
        throw new OperationsRequestError(
          'OPERATIONS_PROVIDER_ACCOUNT_REQUIRED',
          'The Shopify fulfillment export is missing its integration account',
          409,
        )
      }
      if (!Array.isArray(snapshot.shippedLines)) {
        throw new OperationsRequestError(
          'OPERATIONS_SHOPIFY_FULFILLMENT_SIGNATURE_REQUIRED',
          'The Shopify fulfillment export lacks exact packaged line evidence and requires manual review',
          409,
        )
      }
      const writebackInput = {
        organizationId: input.organizationId,
        accountGlobalId: claimed.row.account_global_id,
        externalOrderId: claimed.row.external_order_id,
        trackingNumbers,
        carrier,
        notifyCustomer: claimed.decision.notifyCustomer === true,
        expectedLineItems: snapshot.shippedLines,
      }
      if (claimed.recoveryMode === 'reconcile_only') {
        if (!claimed.row.provider_attempt_request) {
          throw new OperationsRequestError(
            'OPERATIONS_SHOPIFY_FULFILLMENT_SIGNATURE_REQUIRED',
            'The prior Shopify attempt predates durable exact signatures and cannot be replayed safely',
            409,
          )
        }
        const observed = await reconcileShopifyFulfillmentWriteback(
          {
            ...writebackInput,
            attemptSignature: claimed.row.provider_attempt_request,
          },
        )
        if (observed) {
          state = 'succeeded'
          providerReference = observed.providerReference
        } else {
          errorCode = 'OPERATIONS_COMMERCE_EXPORT_RECONCILIATION_REQUIRED'
          errorMessage = (
            'The durable Shopify attempt has no exact matching fulfillment yet. '
            + 'No provider write was made; later retries remain read-only.'
          )
        }
      } else {
        const prepared = await prepareShopifyFulfillmentWriteback(writebackInput)
        if (prepared.existing) {
          state = 'succeeded'
          providerReference = prepared.existing.providerReference
        } else {
          registeredProviderAttempt =
            await registerShopifyFulfillmentProviderAttempt({
              organizationId: input.organizationId,
              actorEmail: input.actorEmail,
              commerceExportGlobalId: input.commerceExportGlobalId,
              integrationAccountId: claimed.row.integration_account_id,
              exportIdempotencyKey: claimed.row.idempotency_key,
              exportAttempt: claimed.row.attempts,
              preparedRequest: prepared.signature,
            })
          const result = await executeShopifyFulfillmentWriteback({
            ...writebackInput,
            attemptSignature: prepared.signature,
          })
          state = 'succeeded'
          providerReference = result.providerReference
        }
      }
    } else if (claimed.row.provider === 'faire') {
      if (
        !claimed.row.account_global_id
        || !claimed.row.integration_account_id
      ) {
        throw new OperationsRequestError(
          'OPERATIONS_PROVIDER_ACCOUNT_REQUIRED',
          'The Faire fulfillment export is missing its integration account',
          409,
        )
      }
      let attemptRequest: FaireFulfillmentAttemptRequest
      let mode: 'execute' | 'reconcile_unknown'
      let writeAttempt: {
        attemptId: string
        authorizationRevision: number
        state: 'authorized' | 'outcome_unknown'
      }
      if (claimed.recoveryMode === 'reconcile_only') {
        if (
          !claimed.row.provider_attempt_global_id
          || !claimed.row.provider_attempt_request
        ) {
          throw new OperationsRequestError(
            'OPERATIONS_FAIRE_FULFILLMENT_SIGNATURE_REQUIRED',
            'The Faire export predates exact durable package evidence and cannot be submitted safely',
            409,
          )
        }
        attemptRequest = normalizeFaireFulfillmentAttemptRequest(
          claimed.row.provider_attempt_request,
          claimed.row.external_order_id,
        )
        requireFaireFulfillmentAttemptRequestHash(
          attemptRequest,
          claimed.row.provider_attempt_request_hash,
        )
        mode = 'reconcile_unknown'
        writeAttempt = {
          attemptId: claimed.row.provider_attempt_global_id,
          authorizationRevision: attemptRequest.authorizationRevision,
          state: 'outcome_unknown',
        }
        if (
          claimed.row.provider_attempt_state === 'prepared'
          && claimed.row.provider_attempt_id
          && claimed.row.provider_attempt_request_hash
        ) {
          registeredProviderAttempt = {
            id: claimed.row.provider_attempt_id,
            globalId: claimed.row.provider_attempt_global_id,
            requestHash: claimed.row.provider_attempt_request_hash,
          }
        }
      } else {
        const packages = await requireFaireFulfillmentPackageMakerCosts({
          organizationId: input.organizationId,
          orderId: claimed.row.order_id,
          orderCurrency: claimed.row.order_currency,
          packages: normalizeFaireFulfillmentPackages(snapshot.packages),
        })
        const authority = await prepareCurrentFaireFulfillmentAuthority({
          organizationId: input.organizationId,
          accountGlobalId: claimed.row.account_global_id,
        })
        attemptRequest = normalizeFaireFulfillmentAttemptRequest({
          version: 1,
          externalOrderId: claimed.row.external_order_id,
          expectedShipDate: shippedAt,
          authorizationRevision: authority.authorizationRevision,
          packages,
        }, claimed.row.external_order_id)
        registeredProviderAttempt =
          await registerFaireFulfillmentProviderAttempt({
            organizationId: input.organizationId,
            actorEmail: input.actorEmail,
            commerceExportGlobalId: input.commerceExportGlobalId,
            integrationAccountId: claimed.row.integration_account_id,
            exportIdempotencyKey: claimed.row.idempotency_key,
            exportAttempt: claimed.row.attempts,
            preparedRequest: attemptRequest,
          })
        mode = 'execute'
        writeAttempt = {
          attemptId: registeredProviderAttempt.globalId,
          authorizationRevision: attemptRequest.authorizationRevision,
          state: 'authorized',
        }
      }
      const result = await executeCurrentFaireFulfillmentWriteback({
        organizationId: input.organizationId,
        accountGlobalId: claimed.row.account_global_id,
        mode,
        writeAttempt,
        externalOrderId: attemptRequest.externalOrderId,
        expectedShipDate: attemptRequest.expectedShipDate,
        packages: attemptRequest.packages,
      })
      providerAttemptResponse = {
        outcome: result.outcome,
        providerOrderId: result.providerOrderId,
        providerState: result.providerState,
        providerShipmentReferences: result.providerShipmentReferences,
        trackingCodes: result.trackingCodes,
        replayed: result.replayed,
        reconciledUnknownOutcome: result.reconciledUnknownOutcome,
        ...(result.outcome === 'unknown' ? { reason: result.reason } : {}),
      }
      if (result.outcome === 'succeeded') {
        state = 'succeeded'
        providerReference = result.providerOrderId
      } else {
        errorCode = 'OPERATIONS_COMMERCE_EXPORT_RECONCILIATION_REQUIRED'
        errorMessage = (
          'The one-shot Faire shipment outcome is unknown. '
          + 'Later retries remain read-only until exact package tracking is observed.'
        )
      }
    } else {
      state = 'unsupported'
      errorCode = 'OPERATIONS_COMMERCE_PROVIDER_UNSUPPORTED'
      errorMessage = (
        `Fulfillment export adapter for ${claimed.row.provider} is not configured.`
      )
    }
  } catch (error) {
    state = 'failed'
    const faireAttemptIntegrityFailure = (
      claimed.row.provider === 'faire'
      && error
      && typeof error === 'object'
      && 'code' in error
      && error.code === 'OPERATIONS_FAIRE_FULFILLMENT_SIGNATURE_INVALID'
    )
    const faireRecoveryErrorIsRetryable = (
      claimed.row.provider === 'faire'
      && faireFulfillmentErrorAllowsAutomaticReconciliation(error)
    )
    const providerOutcomeUnknown = (
      (
        claimed.row.provider === 'shopify'
        && (
          claimed.recoveryMode === 'reconcile_only'
          || (
            error
            && typeof error === 'object'
            && (
              ('outcomeUnknown' in error && error.outcomeUnknown === true)
              || ('retryable' in error && error.retryable === true)
            )
          )
        )
      )
      || (
        claimed.row.provider === 'faire'
        && !faireAttemptIntegrityFailure
        && faireRecoveryErrorIsRetryable
        && (
          Boolean(registeredProviderAttempt)
          || Boolean(claimed.row.provider_attempt_global_id)
        )
      )
    )
    errorCode = providerOutcomeUnknown
      ? 'OPERATIONS_COMMERCE_EXPORT_RECONCILIATION_REQUIRED'
      : error && typeof error === 'object' && 'code' in error
        ? String(error.code).slice(0, 128)
        : 'OPERATIONS_COMMERCE_EXPORT_FAILED'
    errorMessage = error instanceof Error
      ? error.message.slice(0, 500)
      : 'Commerce fulfillment export failed'
  }

  const providerAttemptToFinalize = registeredProviderAttempt
  await withTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(
      client,
      `operations:commerce-fulfillment-export:${input.organizationId}:${input.commerceExportGlobalId}`,
    )
    if (providerAttemptToFinalize) {
      const providerAttemptState = state === 'succeeded'
        ? 'succeeded'
        : errorCode ===
            'OPERATIONS_COMMERCE_EXPORT_RECONCILIATION_REQUIRED'
          ? 'unknown'
          : 'failed'
      const finalizedProviderAttempt = await client.query(
        `UPDATE operations_commerce_provider_attempts
         SET state = $3, redacted_response = $4::jsonb,
             provider_reference = $5, error_code = $6,
             next_attempt_at = CASE WHEN $3 = 'unknown' THEN now() ELSE NULL END,
             lease_token = NULL, lease_expires_at = NULL,
             completed_at = now()
         WHERE organization_id = $1::uuid
           AND id = $2::uuid
           AND state = 'prepared'`,
        [
          input.organizationId,
          providerAttemptToFinalize.id,
          providerAttemptState,
          JSON.stringify({
            commerceExportState: state,
            providerReference,
            errorCode,
            errorMessage,
            ...(providerAttemptResponse
              ? { providerResult: providerAttemptResponse }
              : {}),
          }),
          providerReference,
          errorCode,
        ],
      )
      if (finalizedProviderAttempt.rowCount !== 1) {
        throw new OperationsRequestError(
          'OPERATIONS_COMMERCE_EXPORT_CHANGED',
          'The durable commerce provider attempt changed before finalization',
          409,
        )
      }
    }
    const updated = await client.query(
      `UPDATE operations_commerce_fulfillment_exports
       SET state = $3, provider_reference = $4,
           error_code = $5, error_message = $6,
           completed_at = now(), updated_at = now()
       WHERE organization_id = $1::uuid
         AND global_id = $2
         AND state = 'processing'
         AND attempts = $7`,
      [
        input.organizationId,
        input.commerceExportGlobalId,
        state,
        providerReference,
        errorCode,
        errorMessage,
        claimed.row.attempts,
      ],
    )
    if (updated.rowCount !== 1) {
      throw new OperationsRequestError(
        'OPERATIONS_COMMERCE_EXPORT_CHANGED',
        'Commerce fulfillment export changed while the provider attempt was running',
        409,
      )
    }
    await recordAuditEvent({
      actor: input.preclaimed ? 'system' : input.actorEmail,
      isSystem: Boolean(input.preclaimed),
      eventType: `operations.commerce_fulfillment.${state}`,
      aggregateType: 'operations.commerce_fulfillment_export',
      aggregateId: input.commerceExportGlobalId,
      subject: `Commerce fulfillment export ${input.commerceExportGlobalId}`,
      organizationId: input.organizationId,
      eventKey: `${input.auditEventKey}:outcome`,
      payload: {
        provider: claimed.row.provider,
        attempt: claimed.row.attempts,
        recoveryMode: claimed.recoveryMode,
        state,
        providerReference,
        errorCode,
        errorMessage,
        customerNotification: claimed.decision,
        providerAttemptGlobalId:
          providerAttemptToFinalize?.globalId
          || claimed.row.provider_attempt_global_id,
        providerAttemptRequestHash:
          providerAttemptToFinalize?.requestHash
          || null,
        originalConfirmer: input.preclaimed ? input.actorEmail : null,
      },
    }, client)
  })
  return {
    commerceExportGlobalId: input.commerceExportGlobalId,
    state,
    providerReference,
    errorCode,
    errorMessage,
    customerNotification: claimed.decision,
    replayed: false,
  }
}

export async function retryOperationsCommerceFulfillmentExportFromPostgres(input: {
  organizationId: string
  actorEmail: string
  commerceExportGlobalId: string
  reason: string
  idempotencyKey: string
}): Promise<OperationsCommerceFulfillmentRetryResult> {
  const organizationId = requireOrganizationId(input.organizationId)
  const actorEmail = String(input.actorEmail || '').trim().toLowerCase()
  const commerceExportGlobalId = String(input.commerceExportGlobalId || '').trim()
  const reason = String(input.reason || '').trim()
  const idempotencyKey = String(input.idempotencyKey || '').trim()
  if (!actorEmail) {
    throw new OperationsRequestError(
      'OPERATIONS_ACTOR_REQUIRED',
      'A signed-in user is required',
      401,
    )
  }
  if (!/^gfe(?:[0-9]{7}|[0-9a-v]{12})$/.test(commerceExportGlobalId)) {
    throw new OperationsRequestError(
      'OPERATIONS_COMMERCE_EXPORT_INVALID',
      'Commerce fulfillment export is invalid',
    )
  }
  if (
    reason.length < 10
    || reason.length > 500
    || /[\u0000-\u001f\u007f]/.test(reason)
  ) {
    throw new OperationsRequestError(
      'OPERATIONS_COMMERCE_EXPORT_RETRY_REASON_REQUIRED',
      'A commerce fulfillment retry reason of 10-500 characters is required',
    )
  }
  if (!/^[A-Za-z0-9._:-]{8,200}$/.test(idempotencyKey)) {
    throw new OperationsRequestError(
      'OPERATIONS_IDEMPOTENCY_KEY_INVALID',
      'A valid idempotency key is required',
    )
  }
  const command = await prepareCommandReceipt({
    organizationId,
    commandType: 'retry_operations_commerce_fulfillment_export',
    idempotencyKey,
    requestHash: commandRequestHash({ commerceExportGlobalId, reason }),
    actorEmail,
  })
  if (command.completed) {
    const payload = command.receipt.result_payload
    if (
      payload
      && payload.commerceExportGlobalId === commerceExportGlobalId
      && ['succeeded', 'unsupported', 'failed']
        .includes(String(payload.state))
    ) {
      return {
        commerceExportGlobalId,
        state: payload.state as OperationsCommerceFulfillmentRetryResult['state'],
        providerReference: typeof payload.providerReference === 'string'
          ? payload.providerReference
          : null,
        errorCode: typeof payload.errorCode === 'string' ? payload.errorCode : null,
        errorMessage: typeof payload.errorMessage === 'string'
          ? payload.errorMessage
          : null,
        customerNotification: customerNotificationDecision(
          payload.customerNotification,
        ),
        replayed: true,
      }
    }
    throw new OperationsRequestError(
      'OPERATIONS_COMMAND_RECEIPT_INVALID',
      'Completed fulfillment export retry result is unavailable',
      409,
    )
  }
  try {
    const result = await executeOperationsCommerceFulfillmentExportFromPostgres({
      organizationId,
      actorEmail,
      commerceExportGlobalId,
      reason,
      auditEventKey: `operations:commerce-fulfillment-retry:${command.receipt.id}`,
    })
    await withTransaction((client) => completeCommandReceipt(
      client,
      command.receipt.id,
      commerceExportGlobalId,
      result as unknown as Record<string, unknown>,
    ))
    return result
  } catch (error) {
    await failCommandReceipt(command.receipt.id, error)
    throw error
  }
}

type NativeOneOffShipmentAuthority = {
  groupAttemptId: string
  groupAttemptGlobalId: string
  environment: 'sandbox' | 'production'
  selectedAmountMinor: number
  currency: string
  allocatedCostByPackageId: Map<string, number>
}

async function lockNativeOneOffShipmentAuthority(
  client: PoolClient,
  input: {
    organizationId: string
    orderId: string
    planId: string
    activationState: OperationsActivationState
    canActivate: boolean
    packages: Array<{ id: string; global_id: string; status: string }>
  },
): Promise<NativeOneOffShipmentAuthority> {
  const attemptResult = await client.query<QueryResultRow & {
    id: string
    global_id: string
    state: 'prepared' | 'succeeded' | 'failed' | 'unknown'
    environment: 'sandbox' | 'production'
    provider: 'ups_rest' | 'fedex_rest'
    service_code: string
    package_count: number
    selected_amount_minor: string
    currency: string
  }>(
    `SELECT attempt.id::text, attempt.global_id, attempt.state,
            attempt.environment, attempt.provider, attempt.service_code,
            attempt.package_count,
            attempt.selected_amount_minor::text, attempt.currency
     FROM operations_one_off_carrier_group_attempts attempt
     WHERE attempt.organization_id = $1::uuid
       AND attempt.order_id = $2::uuid
       AND attempt.plan_id = $3::uuid
       AND attempt.action = 'create'
     ORDER BY attempt.requested_at DESC, attempt.id DESC
     LIMIT 1
     FOR UPDATE`,
    [input.organizationId, input.orderId, input.planId],
  )
  const attempt = attemptResult.rows[0]
  if (!attempt) {
    throw new OperationsRequestError(
      'OPERATIONS_ONE_OFF_GROUP_REQUIRED',
      'Purchase one complete one-off carrier shipment group before confirmation',
      409,
    )
  }
  if (attempt.state === 'prepared' || attempt.state === 'unknown') {
    throw new OperationsRequestError(
      'OPERATIONS_ONE_OFF_GROUP_UNRESOLVED',
      'Resolve the pending one-off carrier group before confirming shipment',
      409,
    )
  }
  if (attempt.state !== 'succeeded') {
    throw new OperationsRequestError(
      'OPERATIONS_ONE_OFF_GROUP_FAILED',
      'The latest one-off carrier group did not succeed. Re-rate and retry the group.',
      409,
    )
  }

  const executionMode = attempt.environment === 'sandbox' ? 'test' : 'live'
  const requiredActivation = executionMode === 'test' ? 'shadow' : 'active'
  if (input.activationState !== requiredActivation) {
    throw new OperationsRequestError(
      'OPERATIONS_ONE_OFF_GROUP_ACTIVATION_MISMATCH',
      executionMode === 'test'
        ? 'TEST confirmation requires Operations Shadow'
        : 'LIVE confirmation requires Operations Active',
      409,
    )
  }
  if (executionMode === 'live' && !input.canActivate) {
    throw new OperationsRequestError(
      'OPERATIONS_ACTIVATE_REQUIRED',
      'Operations activation permission is required to confirm LIVE postage',
      403,
    )
  }
  const authorityResult = await client.query<{ exact: boolean }>(
    `SELECT operations_one_off_plan_execution_is_exact(
       $1::uuid, $2::uuid, $3
     ) AS exact`,
    [input.organizationId, input.planId, executionMode],
  )
  if (authorityResult.rows[0]?.exact !== true) {
    throw new OperationsRequestError(
      'OPERATIONS_ONE_OFF_GROUP_AUTHORITY_INVALID',
      'The one-off carrier group no longer matches the exact selected rate and plan authority',
      409,
    )
  }

  const closeResult = await client.query<QueryResultRow & {
    id: string
    state: 'prepared' | 'succeeded' | 'failed' | 'unknown'
  }>(
    `SELECT closed.id::text, closed.state
     FROM operations_one_off_carrier_group_attempts closed
     WHERE closed.organization_id = $1::uuid
       AND closed.create_attempt_id = $2::uuid
       AND closed.action IN ('void', 'close_sample')
       AND closed.state IN ('prepared', 'succeeded', 'unknown')
     ORDER BY closed.requested_at DESC, closed.id DESC
     FOR UPDATE`,
    [input.organizationId, attempt.id],
  )
  if (closeResult.rows.length > 0) {
    throw new OperationsRequestError(
      'OPERATIONS_ONE_OFF_GROUP_CLOSED',
      closeResult.rows.some((row) => row.state === 'succeeded')
        ? 'The one-off carrier group was voided and cannot confirm shipment'
        : 'Resolve the pending whole-shipment void before confirming shipment',
      409,
    )
  }

  const lockedLabels = await client.query<QueryResultRow & {
    id: string
    one_off_carrier_group_attempt_id: string | null
  }>(
    `SELECT label.id::text,
            label.one_off_carrier_group_attempt_id::text
     FROM operations_labels label
     JOIN operations_packages package
       ON package.organization_id = label.organization_id
      AND package.id = label.package_id
     WHERE label.organization_id = $1::uuid
       AND package.plan_id = $2::uuid
       AND label.status = 'created'
     ORDER BY label.created_at, label.id
     FOR UPDATE OF label`,
    [input.organizationId, input.planId],
  )

  const memberResult = await client.query<QueryResultRow & {
    package_id: string
    package_global_id: string
    package_status: string
    package_number: number
    allocated_selected_cost_minor: string
    result_id: string | null
    result_package_number: number | null
    label_id: string | null
    label_package_id: string | null
    label_status: string | null
    label_environment: 'sandbox' | 'production' | 'mock' | null
    label_group_attempt_id: string | null
    label_void_group_attempt_id: string | null
    label_tracking_number: string | null
    result_tracking_number: string | null
    label_carrier: string | null
    label_service_code: string | null
  }>(
    `SELECT member.package_id::text, package.global_id AS package_global_id,
            package.status AS package_status, member.package_number,
            member.allocated_selected_cost_minor::text,
            package_result.id::text AS result_id,
            package_result.package_number AS result_package_number,
            label.id::text AS label_id,
            label.package_id::text AS label_package_id,
            label.status AS label_status,
            label.environment AS label_environment,
            label.one_off_carrier_group_attempt_id::text
              AS label_group_attempt_id,
            label.one_off_void_group_attempt_id::text
              AS label_void_group_attempt_id,
            label.tracking_number AS label_tracking_number,
            package_result.tracking_number AS result_tracking_number,
            label.carrier AS label_carrier,
            label.service_code AS label_service_code
     FROM operations_one_off_carrier_group_members member
     JOIN operations_packages package
       ON package.organization_id = member.organization_id
      AND package.id = member.package_id
      AND package.plan_id = member.plan_id
     LEFT JOIN operations_one_off_carrier_group_results package_result
       ON package_result.organization_id = member.organization_id
      AND package_result.carrier_group_attempt_id = member.carrier_group_attempt_id
      AND package_result.package_id = member.package_id
     LEFT JOIN operations_labels label
       ON label.organization_id = package_result.organization_id
      AND label.id = package_result.label_id
     WHERE member.organization_id = $1::uuid
       AND member.carrier_group_attempt_id = $2::uuid
     ORDER BY member.package_number, member.id`,
    [input.organizationId, attempt.id],
  )

  const canonicalPackageIds = new Set(input.packages.map((item) => item.id))
  const allocatedCostByPackageId = new Map<string, number>()
  let allocatedTotal = BigInt(0)
  for (const row of memberResult.rows) {
    let allocatedCost: bigint
    try {
      allocatedCost = BigInt(row.allocated_selected_cost_minor)
    } catch {
      throw new OperationsRequestError(
        'OPERATIONS_ONE_OFF_GROUP_COST_INVALID',
        'The one-off group contains an invalid package cost allocation',
        409,
      )
    }
    if (
      allocatedCost < BigInt(0)
      || allocatedCost > BigInt(Number.MAX_SAFE_INTEGER)
      || !canonicalPackageIds.has(row.package_id)
      || row.package_status !== 'labeled'
      || !row.result_id
      || row.result_package_number !== row.package_number
      || !row.label_id
      || row.label_package_id !== row.package_id
      || row.label_status !== 'created'
      || row.label_environment !== attempt.environment
      || row.label_group_attempt_id !== attempt.id
      || row.label_void_group_attempt_id !== null
      || row.label_tracking_number !== row.result_tracking_number
      || row.label_carrier !== (
        attempt.provider === 'ups_rest' ? 'UPS' : 'FedEx'
      )
      || row.label_service_code !== attempt.service_code
    ) {
      throw new OperationsRequestError(
        'OPERATIONS_ONE_OFF_GROUP_PARTIAL',
        'The one-off carrier group does not have one exact active result and label for every package',
        409,
      )
    }
    allocatedTotal += allocatedCost
    allocatedCostByPackageId.set(row.package_id, Number(allocatedCost))
  }

  let selectedAmount: bigint
  try {
    selectedAmount = BigInt(attempt.selected_amount_minor)
  } catch {
    throw new OperationsRequestError(
      'OPERATIONS_ONE_OFF_GROUP_COST_INVALID',
      'The one-off group selected amount is invalid',
      409,
    )
  }
  if (
    input.packages.length < 1
    || input.packages.some((item) => item.status !== 'labeled')
    || attempt.package_count !== input.packages.length
    || memberResult.rows.length !== input.packages.length
    || allocatedCostByPackageId.size !== input.packages.length
    || lockedLabels.rows.length !== input.packages.length
    || lockedLabels.rows.some((label) => (
      label.one_off_carrier_group_attempt_id !== attempt.id
    ))
    || allocatedTotal !== selectedAmount
    || selectedAmount > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    throw new OperationsRequestError(
      'OPERATIONS_ONE_OFF_GROUP_PARTIAL',
      'The one-off carrier group is partial or no longer matches every canonical package',
      409,
    )
  }

  return {
    groupAttemptId: attempt.id,
    groupAttemptGlobalId: attempt.global_id,
    environment: attempt.environment,
    selectedAmountMinor: Number(selectedAmount),
    currency: attempt.currency,
    allocatedCostByPackageId,
  }
}

export async function confirmOperationsOrderShipmentFromPostgres(input: {
  organizationId: string
  actorEmail: string
  orderGlobalId: string
  preferredPrinterGlobalId?: string | null
  expectedRowVersion: number
  reason: string
  idempotencyKey: string
  sandboxE2eAuthorizationGlobalId?: string | null
  expectedNotificationPolicyRevision?: number | null
  customerNotificationOverride?: boolean | null
  customerNotificationOverrideReason?: string | null
  canActivate?: boolean
}): Promise<OperationsShipmentCommandResult> {
  const organizationId = requireOrganizationId(input.organizationId)
  const actorEmail = String(input.actorEmail || '').trim().toLowerCase()
  const orderGlobalId = String(input.orderGlobalId || '').trim()
  const preferredPrinterGlobalId = String(input.preferredPrinterGlobalId || '').trim() || null
  const reason = String(input.reason || '').trim()
  const idempotencyKey = String(input.idempotencyKey || '').trim()
  const sandboxE2eAuthorizationGlobalId = String(
    input.sandboxE2eAuthorizationGlobalId || '',
  ).trim() || null
  const expectedNotificationPolicyRevision =
    input.expectedNotificationPolicyRevision ?? null
  if (
    expectedNotificationPolicyRevision !== null
    && (
      !Number.isSafeInteger(expectedNotificationPolicyRevision)
      || expectedNotificationPolicyRevision < 0
    )
  ) {
    throw new OperationsRequestError(
      'OPERATIONS_NOTIFICATION_POLICY_REVISION_INVALID',
      'A valid fulfillment notification policy revision is required',
    )
  }
  if (
    input.customerNotificationOverride !== undefined
    && input.customerNotificationOverride !== null
    && typeof input.customerNotificationOverride !== 'boolean'
  ) {
    throw new OperationsRequestError(
      'OPERATIONS_NOTIFICATION_OVERRIDE_INVALID',
      'Customer notification override must be true or false',
    )
  }
  const customerNotificationOverride =
    typeof input.customerNotificationOverride === 'boolean'
      ? input.customerNotificationOverride
      : null
  const customerNotificationOverrideReason = String(
    input.customerNotificationOverrideReason || '',
  ).trim() || null
  if (
    customerNotificationOverride !== null
    && (
      !customerNotificationOverrideReason
      || customerNotificationOverrideReason.length < 10
      || customerNotificationOverrideReason.length > 500
      || /[\u0000-\u001f\u007f]/.test(customerNotificationOverrideReason)
    )
  ) {
    throw new OperationsRequestError(
      'OPERATIONS_NOTIFICATION_OVERRIDE_REASON_REQUIRED',
      'A customer notification exception reason of 10-500 characters is required',
    )
  }
  if (
    customerNotificationOverride === null
    && customerNotificationOverrideReason
  ) {
    throw new OperationsRequestError(
      'OPERATIONS_NOTIFICATION_OVERRIDE_REASON_INVALID',
      'A customer notification exception reason requires an explicit override',
    )
  }
  if (!actorEmail) {
    throw new OperationsRequestError('OPERATIONS_ACTOR_REQUIRED', 'A signed-in user is required', 401)
  }
  if (!/^gor(?:[0-9]{7}|[0-9a-v]{12})$/.test(orderGlobalId)) {
    throw new OperationsRequestError('OPERATIONS_ORDER_INVALID', 'Order is invalid')
  }
  if (preferredPrinterGlobalId && !/^gpr(?:[0-9]{7}|[0-9a-v]{12})$/.test(preferredPrinterGlobalId)) {
    throw new OperationsRequestError('OPERATIONS_PRINTER_INVALID', 'Preferred printer is invalid')
  }
  if (!Number.isSafeInteger(input.expectedRowVersion) || input.expectedRowVersion < 0) {
    throw new OperationsRequestError('OPERATIONS_ORDER_VERSION_INVALID', 'Order version is invalid')
  }
  if (!reason || reason.length > 500) {
    throw new OperationsRequestError(
      'OPERATIONS_SHIPMENT_REASON_INVALID',
      'A shipment-confirmation reason is required',
    )
  }
  if (!/^[A-Za-z0-9._:-]{8,200}$/.test(idempotencyKey)) {
    throw new OperationsRequestError(
      'OPERATIONS_IDEMPOTENCY_KEY_INVALID',
      'A valid idempotency key is required',
    )
  }
  if (
    sandboxE2eAuthorizationGlobalId
    && !/^gsea(?:[0-9]{7}|[0-9a-v]{12})$/.test(sandboxE2eAuthorizationGlobalId)
  ) {
    throw new OperationsRequestError(
      'OPERATIONS_SANDBOX_E2E_AUTHORIZATION_INVALID',
      'Sandbox E2E authorization is invalid',
    )
  }

  const command = await prepareCommandReceipt({
    organizationId,
    commandType: 'confirm_operations_order_shipment',
    idempotencyKey,
    requestHash: commandRequestHash({
      orderGlobalId,
      preferredPrinterGlobalId,
      expectedRowVersion: input.expectedRowVersion,
      reason,
      sandboxE2eAuthorizationGlobalId,
      expectedNotificationPolicyRevision,
      customerNotificationOverride,
      customerNotificationOverrideReason,
    }),
    actorEmail,
  })
  if (command.completed) {
    return completedShipmentCommandResult(organizationId, command.receipt)
  }

  type ShipmentCommitContext = {
    result: OperationsShipmentCommandResult
    warehouseId: string
    storageReference: string
    renderedPackingSlip: ReturnType<typeof renderPackingSlip>
  }

  let committed = false
  try {
    const context = await withTransaction<ShipmentCommitContext>(async (client) => {
      await acquireTransactionAdvisoryLock(
        client,
        `operations:order:${organizationId}:${orderGlobalId}`,
      )
      const activation = await resolveActivation(client, organizationId)
      if (!['shadow', 'active'].includes(activation.state)) {
        throw new OperationsRequestError(
          'OPERATIONS_EXECUTION_STATE_INVALID',
          'Set Operations to Shadow or Active before confirming shipments',
          409,
        )
      }

      const orderResult = await client.query<OrderIdentityRow & {
        pipeline_id: string
        customer_id: string
        customer_global_id: string
        customer_name: string
        source_provider: string
        order_type: string
        integration_account_id: string | null
        integration_account_global_id: string
        external_order_id: string
        order_number: string
        currency: string
        ship_to: Record<string, unknown>
        line_count: string
      }>(
        `SELECT source_order.id::text, source_order.global_id, source_order.status,
                source_order.row_version::text, source_order.pipeline_id::text,
                source_order.customer_id::text,
                customer.reference_code AS customer_global_id,
                customer.name AS customer_name,
                source_order.source_provider, source_order.order_type,
                source_order.integration_account_id::text,
                integration.global_id AS integration_account_global_id,
                source_order.external_order_id,
                source_order.order_number, source_order.currency,
                source_order.ship_to,
                (SELECT count(*)::text
                 FROM operations_current_order_lines source_line
                 WHERE source_line.organization_id = source_order.organization_id
                   AND source_line.order_id = source_order.id) AS line_count
         FROM operations_orders source_order
         JOIN crm_organizations customer
           ON customer.pipeline_id = source_order.pipeline_id
          AND customer.id = source_order.customer_id
         JOIN operations_integration_accounts integration
           ON integration.organization_id = source_order.organization_id
          AND integration.id = source_order.integration_account_id
         WHERE source_order.organization_id = $1::uuid
           AND source_order.global_id = $2
         FOR UPDATE OF source_order`,
        [organizationId, orderGlobalId],
      )
      const order = orderResult.rows[0]
      if (!order || order.row_version === undefined) {
        throw new OperationsRequestError(
          'OPERATIONS_ORDER_NOT_FOUND',
          'Operations order was not found',
          404,
        )
      }
      if (Number(order.row_version) !== input.expectedRowVersion) {
        throw new OperationsRequestError(
          'OPERATIONS_ORDER_VERSION_CONFLICT',
          'This order changed after it was opened. Refresh the order before confirming shipment.',
          409,
        )
      }
      await requireCurrentCommerceOrderRevision(client, {
        organizationId,
        orderId: order.id,
        operation: 'ship',
      })
      if (order.status !== 'packed') {
        throw new OperationsRequestError(
          'OPERATIONS_ORDER_TRANSITION_INVALID',
          `Shipment cannot be confirmed from ${order.status}`,
          409,
        )
      }
      const nativeOneOff = order.source_provider === 'clawpilot_native'
        && order.order_type === 'one_off'
      if (nativeOneOff && sandboxE2eAuthorizationGlobalId) {
        throw new OperationsRequestError(
          'OPERATIONS_ONE_OFF_SANDBOX_AUTHORITY_CONFLICT',
          'Native one-off TEST shipments use their exact carrier-group authority and cannot mix sandbox E2E authorization',
          409,
        )
      }
      let resolvedCustomerNotification: OperationsCustomerNotificationDecision
      let sandboxE2eAuthorizationValidated = false
      if (sandboxE2eAuthorizationGlobalId) {
        await requireActiveSandboxCommerceE2eAuthorization(client, {
          organizationId,
          authorizationGlobalId: sandboxE2eAuthorizationGlobalId,
          orderGlobalId,
          actorEmail,
        })
        sandboxE2eAuthorizationValidated = true
      }
      if (order.source_provider === 'shopify') {
        if (!order.integration_account_id) {
          throw new OperationsRequestError(
            'OPERATIONS_PROVIDER_ACCOUNT_REQUIRED',
            'The Shopify order is missing its integration account. Reconcile the order before confirming shipment.',
            409,
          )
        }
        await acquireTransactionAdvisoryLock(
          client,
          [
            'shopify-inventory-apply',
            organizationId,
            order.integration_account_id,
          ].join(':'),
        )
        await acquireTransactionAdvisoryLock(
          client,
          [
            'commerce',
            'shopify-fulfillment-notification-policy',
            organizationId,
            order.integration_account_id,
          ].join(':'),
        )
        const policyResult = await client.query<{
          notify_customer_default: boolean
          revision: string | number
        }>(
          `SELECT notify_customer_default, revision::text
           FROM operations_shopify_fulfillment_notification_policies
           WHERE organization_id = $1::uuid
             AND integration_account_id = $2::uuid
           FOR UPDATE`,
          [organizationId, order.integration_account_id],
        )
        const policy = policyResult.rows[0] || null
        const policyRevision = policy ? Number(policy.revision) : 0
        const policyDefault = policy?.notify_customer_default === true
        if (
          expectedNotificationPolicyRevision === null
          || expectedNotificationPolicyRevision !== policyRevision
        ) {
          throw new OperationsRequestError(
            'OPERATIONS_NOTIFICATION_POLICY_REVISION_CONFLICT',
            'The Shopify fulfillment notification policy changed. Refresh the order before confirming shipment.',
            409,
          )
        }
        if (sandboxE2eAuthorizationGlobalId) {
          if (customerNotificationOverride === true) {
            throw new OperationsRequestError(
              'OPERATIONS_SANDBOX_NOTIFICATION_BLOCKED',
              'Sandbox E2E shipments cannot notify Shopify customers',
              409,
            )
          }
          resolvedCustomerNotification = {
            mode: 'clawpilot_explicit',
            notifyCustomer: false,
            source: 'sandbox_e2e_suppression',
            accountPolicyRevision: policyRevision,
            overrideReason: null,
            decidedBy: actorEmail,
          }
        } else if (customerNotificationOverride !== null) {
          if (customerNotificationOverride === policyDefault) {
            throw new OperationsRequestError(
              'OPERATIONS_NOTIFICATION_OVERRIDE_NOT_EXCEPTION',
              'The requested customer notification value matches the Shopify account default',
              409,
            )
          }
          resolvedCustomerNotification = {
            mode: 'clawpilot_explicit',
            notifyCustomer: customerNotificationOverride,
            source: 'order_override',
            accountPolicyRevision: policyRevision,
            overrideReason: customerNotificationOverrideReason,
            decidedBy: actorEmail,
          }
        } else {
          resolvedCustomerNotification = {
            mode: 'clawpilot_explicit',
            notifyCustomer: policyDefault,
            source: 'account_default',
            accountPolicyRevision: policyRevision,
            overrideReason: null,
            decidedBy: actorEmail,
          }
        }
      } else if (order.source_provider === 'faire') {
        if (customerNotificationOverride !== null) {
          throw new OperationsRequestError(
            'OPERATIONS_NOTIFICATION_PROVIDER_MANAGED',
            'Faire manages retailer shipment notifications and does not accept a ClawPilot override',
            409,
          )
        }
        resolvedCustomerNotification = {
          mode: 'provider_managed',
          notifyCustomer: null,
          source: 'provider_managed',
          accountPolicyRevision: null,
          overrideReason: null,
          decidedBy: actorEmail,
        }
      } else {
        resolvedCustomerNotification = {
          mode: 'clawpilot_explicit',
          notifyCustomer: false,
          source: 'legacy_safe_default',
          accountPolicyRevision: null,
          overrideReason: null,
          decidedBy: actorEmail,
        }
      }

      const planResult = await client.query<QueryResultRow & {
        id: string
        global_id: string
        status: string
        warehouse_id: string
        cartonization_evidence_id: string | null
      }>(
        `SELECT id::text, global_id, status, warehouse_id::text,
                cartonization_evidence_id::text
         FROM operations_fulfillment_plans
         WHERE organization_id = $1::uuid AND order_id = $2::uuid
         ORDER BY version_number DESC
         LIMIT 1
         FOR UPDATE`,
        [organizationId, order.id],
      )
      const plan = planResult.rows[0]
      if (!plan || plan.status !== 'released') {
        throw new OperationsRequestError(
          'OPERATIONS_FULFILLMENT_PLAN_INVALID',
          'The released fulfillment plan is unavailable for shipment confirmation',
          409,
        )
      }

      const waveResult = await client.query<IdRow & { status: string }>(
        `SELECT wave.id::text, wave.global_id, wave.status
         FROM operations_waves wave
         WHERE wave.organization_id = $1::uuid
           AND wave.id = (
             SELECT pick.wave_id
             FROM operations_pick_tasks pick
             WHERE pick.organization_id = $1::uuid
               AND pick.plan_id = $2::uuid
             ORDER BY pick.created_at, pick.id
             LIMIT 1
           )
         FOR UPDATE`,
        [organizationId, plan.id],
      )
      const wave = waveResult.rows[0]
      if (!wave || wave.status !== 'completed') {
        throw new OperationsRequestError(
          'OPERATIONS_WAVE_INVALID',
          'The warehouse wave must be complete before confirming shipment',
          409,
        )
      }

      const packageResult = await client.query<QueryResultRow & {
        id: string
        global_id: string
        status: string
      }>(
        `SELECT id::text, global_id, status
         FROM operations_packages
         WHERE organization_id = $1::uuid AND plan_id = $2::uuid
         ORDER BY package_number, id
         FOR UPDATE`,
        [organizationId, plan.id],
      )
      if (
        packageResult.rows.length < 1
        || packageResult.rows.some((item) => item.status !== 'labeled')
        || (
          !sandboxE2eAuthorizationGlobalId
          && !nativeOneOff
          && order.source_provider !== 'faire'
          && packageResult.rows.length !== 1
        )
      ) {
        throw new OperationsRequestError(
          'OPERATIONS_SHIPMENT_PACKAGE_INVALID',
          sandboxE2eAuthorizationGlobalId
            ? 'Authorized sandbox E2E completion requires every package to have a verified label'
            : 'Shipment confirmation requires a supported package set with every package verified and labeled',
          409,
        )
      }
      const nativeOneOffAuthority = nativeOneOff
        ? await lockNativeOneOffShipmentAuthority(client, {
            organizationId,
            orderId: order.id,
            planId: plan.id,
            activationState: activation.state,
            canActivate: input.canActivate === true,
            packages: packageResult.rows,
          })
        : null
      const unresolvedAttempts = await client.query<QueryResultRow & {
        id: string
        state: string
      }>(
        `SELECT id::text, state
         FROM operations_label_attempts
         WHERE organization_id = $1::uuid
           AND order_id = $2::uuid
           AND state IN ('prepared', 'unknown')
         FOR UPDATE`,
        [organizationId, order.id],
      )
      if (unresolvedAttempts.rows.length > 0) {
        throw new OperationsRequestError(
          'OPERATIONS_LABEL_ATTEMPT_UNRESOLVED',
          'Resolve pending or unknown carrier label attempts before confirming shipment',
          409,
        )
      }

      const labelResult = await client.query<QueryResultRow & {
        id: string
        global_id: string
        environment: 'mock' | 'sandbox' | 'production'
        tracking_number: string
        carrier: string
        service_code: string
        internal_cost_minor: string
        package_id: string
        package_global_id: string
      }>(
        `SELECT label.id::text, label.global_id, label.environment,
                label.tracking_number, label.carrier, label.service_code,
                rate.internal_cost_minor::text,
                package.id::text AS package_id,
                package.global_id AS package_global_id
         FROM operations_labels label
         JOIN operations_packages package
           ON package.organization_id = label.organization_id
          AND package.id = label.package_id
         JOIN operations_carrier_rates rate
           ON rate.organization_id = label.organization_id
          AND rate.id = label.carrier_rate_id
         WHERE label.organization_id = $1::uuid
           AND package.plan_id = $2::uuid
           AND label.status = 'created'
         ORDER BY package.package_number, label.created_at DESC, label.id DESC
         FOR UPDATE OF label`,
        [organizationId, plan.id],
      )
      if (
        labelResult.rows.length !== packageResult.rows.length
        || new Set(labelResult.rows.map((item) => item.package_id)).size
          !== packageResult.rows.length
      ) {
        throw new OperationsRequestError(
          'OPERATIONS_ACTIVE_LABEL_INVALID',
          'Exactly one active carrier label is required for every package before confirming shipment',
          409,
        )
      }
      if (
        labelResult.rows.some((item) => item.environment === 'sandbox')
        && !sandboxE2eAuthorizationGlobalId
        && !nativeOneOffAuthority
      ) {
        throw new OperationsRequestError(
          'OPERATIONS_SANDBOX_LABEL_CANNOT_SHIP',
          'Sandbox labels are test evidence only. Void the sandbox label; it cannot confirm shipment or consume inventory.',
          409,
        )
      }
      const allowedLabelEnvironments = nativeOneOffAuthority
        ? [nativeOneOffAuthority.environment]
        : sandboxE2eAuthorizationGlobalId
          ? ['sandbox']
          : ['mock', 'production']
      if (labelResult.rows.some((item) => (
        !allowedLabelEnvironments.includes(item.environment)
      ))) {
        throw new OperationsRequestError(
          'OPERATIONS_LABEL_ENVIRONMENT_INVALID',
          sandboxE2eAuthorizationGlobalId
            ? 'Authorized sandbox E2E completion requires sandbox labels only'
            : 'Only mock or production label evidence may confirm a shipment',
          409,
        )
      }
      if (
        order.source_provider === 'faire'
        && labelResult.rows.some((item) => item.environment !== 'production')
        && !sandboxE2eAuthorizationValidated
      ) {
        throw new OperationsRequestError(
          'OPERATIONS_FAIRE_PRODUCTION_LABEL_REQUIRED',
          'Faire fulfillment writeback requires a production carrier label for every package',
          409,
        )
      }
      if (
        new Set(labelResult.rows.map((item) => item.carrier)).size !== 1
        || new Set(labelResult.rows.map((item) => item.service_code)).size !== 1
      ) {
        throw new OperationsRequestError(
          'OPERATIONS_LABEL_SERVICE_MISMATCH',
          'Every package must use the same carrier and service',
          409,
        )
      }

      const blockingResult = await client.query<QueryResultRow & { count: string }>(
        `SELECT count(*)::text AS count
         FROM operations_exceptions
         WHERE organization_id = $1::uuid
           AND order_id = $2::uuid
           AND status IN ('open', 'acknowledged')
           AND severity IN ('high', 'critical')`,
        [organizationId, order.id],
      )
      if (Number(blockingResult.rows[0]?.count || 0) > 0) {
        throw new OperationsRequestError(
          'OPERATIONS_ORDER_BLOCKED_BY_EXCEPTION',
          'Resolve high or critical order exceptions before confirming shipment',
          409,
        )
      }

      const existingShipment = await client.query<IdRow>(
        `SELECT id::text, global_id
         FROM operations_shipments
         WHERE organization_id = $1::uuid AND order_id = $2::uuid
         FOR UPDATE`,
        [organizationId, order.id],
      )
      if (existingShipment.rows.length > 0) {
        throw new OperationsRequestError(
          'OPERATIONS_SHIPMENT_ALREADY_CONFIRMED',
          'This order already has shipment evidence',
          409,
        )
      }

      const allocationResult = await client.query<QueryResultRow & {
        line_id: string
        line_global_id: string
        line_quantity: string
        product_global_id: string
        product_name: string
        channel_sku: string
        allocation_quantity: string
        reservation_id: string
        reservation_global_id: string
        reservation_quantity: string
        reservation_status: string
        reservation_authority: 'local_balance' | 'provider_commitment'
        position_id: string
        position_global_id: string
        position_warehouse_id: string
        position_warehouse_global_id: string
        position_warehouse_name: string
        position_location_id: string
        on_hand_quantity: string
        reserved_quantity: string
        source_authority: 'clawpilot' | 'shopify'
      }>(
        `SELECT source_line.id::text AS line_id,
                source_line.global_id AS line_global_id,
                source_line.quantity::text AS line_quantity,
                product.reference_code AS product_global_id,
                product.name AS product_name,
                source_line.channel_sku,
                allocation.quantity::text AS allocation_quantity,
                reservation.id::text AS reservation_id,
                reservation.global_id AS reservation_global_id,
                reservation.quantity::text AS reservation_quantity,
                reservation.status AS reservation_status,
                reservation.reservation_authority,
                position.id::text AS position_id,
                position.global_id AS position_global_id,
                position.warehouse_id::text AS position_warehouse_id,
                warehouse.global_id AS position_warehouse_global_id,
                warehouse.name AS position_warehouse_name,
                position.location_id::text AS position_location_id,
                position.on_hand_quantity::text,
                position.reserved_quantity::text,
                position.source_authority
         FROM operations_fulfillment_allocations allocation
         JOIN operations_current_order_lines source_line
           ON source_line.organization_id = allocation.organization_id
          AND source_line.id = allocation.order_line_id
         JOIN crm_products product
           ON product.pipeline_id = source_line.pipeline_id
          AND product.id = source_line.product_id
         JOIN operations_reservations reservation
           ON reservation.organization_id = allocation.organization_id
          AND reservation.id = allocation.reservation_id
          AND reservation.order_line_id = allocation.order_line_id
          AND reservation.position_id = allocation.position_id
         JOIN operations_inventory_positions position
           ON position.organization_id = allocation.organization_id
          AND position.id = allocation.position_id
         JOIN operations_warehouses warehouse
           ON warehouse.organization_id = position.organization_id
          AND warehouse.id = position.warehouse_id
         WHERE allocation.organization_id = $1::uuid
           AND allocation.plan_id = $2::uuid
         ORDER BY source_line.created_at, source_line.id, allocation.created_at, allocation.id
         FOR UPDATE OF allocation, reservation, position, source_line`,
        [organizationId, plan.id],
      )
      const allocations = allocationResult.rows
      const allocatedByLine = new Map<string, number>()
      for (const allocation of allocations) {
        const quantity = numberValue(allocation.allocation_quantity)
        allocatedByLine.set(
          allocation.line_id,
          (allocatedByLine.get(allocation.line_id) || 0) + quantity,
        )
        if (
          allocation.reservation_status !== 'active'
          || numberValue(allocation.reservation_quantity) !== quantity
          || allocation.position_warehouse_id !== plan.warehouse_id
          || (
            allocation.source_authority === 'shopify'
            && allocation.reservation_authority !== 'provider_commitment'
          )
          || (
            allocation.source_authority === 'clawpilot'
            && allocation.reservation_authority !== 'local_balance'
          )
        ) {
          throw new OperationsRequestError(
            'OPERATIONS_RESERVATION_INVALID',
            'Shipment allocations no longer match active reservations in the selected warehouse',
            409,
          )
        }
      }
      const completeLineIds = new Set(
        allocations
          .filter((allocation) => (
            allocatedByLine.get(allocation.line_id) === numberValue(allocation.line_quantity)
          ))
          .map((allocation) => allocation.line_id),
      )
      if (
        allocations.length < 1
        || completeLineIds.size !== Number(order.line_count)
      ) {
        throw new OperationsRequestError(
          'OPERATIONS_ALLOCATION_INCOMPLETE',
          'Every order line must remain fully allocated before shipment confirmation',
          409,
        )
      }

      const providerCommitmentRevalidation =
        await revalidateProviderCommitmentsForPlan(
          client,
          {
            organizationId,
            planId: plan.id,
          },
        )

      const packagingConsumption =
        await consumePackagingMaterialClaimsForPlan(client, {
          organizationId,
          planId: plan.id,
          cartonizationEvidenceId: plan.cartonization_evidence_id,
          actorEmail,
        })

      const shipments: Array<IdRow & {
        shipped_at: Date
        package_id: string
        package_global_id: string
        label_id: string
        label_global_id: string
        tracking_number: string
        carrier: string
        service_code: string
        environment: 'mock' | 'sandbox' | 'production'
        quoted_carrier_cost_minor: number
        one_off_carrier_group_global_id: string | null
      }> = []
      for (const packageRow of packageResult.rows) {
        const packageLabel = labelResult.rows.find(
          (item) => item.package_id === packageRow.id,
        )!
        const oneOffAllocatedCost = nativeOneOffAuthority
          ?.allocatedCostByPackageId.get(packageRow.id)
        if (nativeOneOffAuthority && oneOffAllocatedCost === undefined) {
          throw new OperationsRequestError(
            'OPERATIONS_ONE_OFF_GROUP_PARTIAL',
            'The one-off carrier group is missing a deterministic package cost allocation',
            409,
          )
        }
        const shipmentResult = await client.query<IdRow & { shipped_at: Date }>(
          `INSERT INTO operations_shipments (
             organization_id, order_id, plan_id, package_id, label_id, status,
             tracking_number, shipped_at, quoted_carrier_cost_minor, confirmed_by,
             one_off_carrier_group_attempt_id
           ) VALUES (
             $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 'confirmed',
             $6, now(), $7, $8, $9::uuid
           )
           RETURNING id::text, global_id, shipped_at`,
          [
            organizationId,
            order.id,
            plan.id,
            packageRow.id,
            packageLabel.id,
            packageLabel.tracking_number,
            nativeOneOffAuthority
              ? oneOffAllocatedCost
              : sandboxE2eAuthorizationGlobalId
                ? 0
                : packageLabel.internal_cost_minor,
            actorEmail,
            nativeOneOffAuthority?.groupAttemptId || null,
          ],
        )
        shipments.push({
          ...shipmentResult.rows[0],
          package_id: packageRow.id,
          package_global_id: packageRow.global_id,
          label_id: packageLabel.id,
          label_global_id: packageLabel.global_id,
          tracking_number: packageLabel.tracking_number,
          carrier: packageLabel.carrier,
          service_code: packageLabel.service_code,
          environment: packageLabel.environment,
          quoted_carrier_cost_minor: nativeOneOffAuthority
            ? oneOffAllocatedCost!
            : sandboxE2eAuthorizationGlobalId
              ? 0
              : Number(packageLabel.internal_cost_minor),
          one_off_carrier_group_global_id:
            nativeOneOffAuthority?.groupAttemptGlobalId || null,
        })
      }
      const shipment = shipments[0]
      const shippedAt = shipment.shipped_at.toISOString()

      let localInventoryConsumptionCount = 0
      let providerCommitmentConsumptionCount = 0
      for (const allocation of allocations) {
        if (allocation.source_authority === 'shopify') {
          await consumeProviderCommitment(client, {
            organizationId,
            reservation: {
              id: allocation.reservation_id,
              global_id: allocation.reservation_global_id,
            },
          })
          providerCommitmentConsumptionCount += 1
          continue
        }
        await consumeReservedInventory(client, {
          organizationId,
          order,
          position: {
            id: allocation.position_id,
            global_id: allocation.position_global_id,
            warehouse_id: allocation.position_warehouse_id,
            warehouse_global_id: allocation.position_warehouse_global_id,
            warehouse_name: allocation.position_warehouse_name,
            location_id: allocation.position_location_id,
            on_hand_quantity: allocation.on_hand_quantity,
            reserved_quantity: allocation.reserved_quantity,
            source_authority: allocation.source_authority,
          },
          reservation: {
            id: allocation.reservation_id,
            global_id: allocation.reservation_global_id,
          },
          quantity: numberValue(allocation.allocation_quantity),
          actorEmail,
        })
        localInventoryConsumptionCount += 1
      }

      const packageContentResult = await client.query<{
        package_id: string
        external_line_id: string
        product_global_id: string
        product_name: string
        channel_sku: string
        quantity: string
      }>(
        `SELECT content.package_id::text, source_line.external_line_id,
                product.reference_code AS product_global_id,
                product.name AS product_name, source_line.channel_sku,
                content.quantity::text
         FROM operations_package_contents content
         JOIN operations_current_order_lines source_line
           ON source_line.organization_id = content.organization_id
          AND source_line.id = content.order_line_id
         JOIN crm_products product
           ON product.pipeline_id = source_line.pipeline_id
          AND product.id = source_line.product_id
         WHERE content.organization_id = $1::uuid
           AND content.plan_id = $2::uuid
         ORDER BY content.package_id, source_line.created_at, source_line.id`,
        [organizationId, plan.id],
      )
      const artifactContexts: Array<{
        artifact: IdRow
        shipment: typeof shipments[number]
        storageReference: string
        renderedPackingSlip: ReturnType<typeof renderPackingSlip>
      }> = []
      for (const packageShipment of shipments) {
        const packingSnapshot = {
          orderGlobalId: order.global_id,
          orderNumber: order.order_number,
          customerName: order.customer_name,
          customerGlobalId: order.customer_global_id,
          shipmentGlobalId: packageShipment.global_id,
          trackingNumber: packageShipment.tracking_number,
          carrier: packageShipment.carrier,
          serviceCode: packageShipment.service_code,
          shippedAt: packageShipment.shipped_at.toISOString(),
          oneOffCarrierGroupGlobalId:
            packageShipment.one_off_carrier_group_global_id,
          quotedCarrierCostMinor:
            packageShipment.quoted_carrier_cost_minor,
          shipTo: address(order.ship_to),
          lines: packageContentResult.rows
            .filter((line) => line.package_id === packageShipment.package_id)
            .map((line) => ({
              productGlobalId: line.product_global_id,
              productName: line.product_name,
              channelSku: line.channel_sku,
              quantity: numberValue(line.quantity),
            })),
        }
        if (packingSnapshot.lines.length < 1) {
          throw new OperationsRequestError(
            'OPERATIONS_PACKAGE_CONTENTS_INCOMPLETE',
            'Every shipment package requires exact contents before confirmation',
            409,
          )
        }
        const renderedPackingSlip = renderPackingSlip(packingSnapshot)
        const storageReference = (
          `clawpilot-document:${packageShipment.global_id}:packing-slip:${renderedPackingSlip.contentSha256}`
        )
        const artifactResult = await client.query<IdRow>(
          `INSERT INTO operations_print_artifacts (
             organization_id, source_order_id, source_shipment_id, source_package_id,
             document_type, format, media_size, content_sha256,
             byte_length, storage_reference, created_by
           ) VALUES (
             $1::uuid, $2::uuid, $3::uuid, $4::uuid,
             'packing_slip', 'PDF', 'letter', $5, $6, $7, $8
           )
           RETURNING id::text, global_id`,
          [
            organizationId, order.id, packageShipment.id,
            packageShipment.package_id, renderedPackingSlip.contentSha256,
            renderedPackingSlip.byteLength, storageReference, actorEmail,
          ],
        )
        const artifact = artifactResult.rows[0]
        await client.query(
          `INSERT INTO operations_print_artifact_payloads (
             artifact_id, organization_id, mime_type, filename, payload,
             template_version, render_snapshot
           ) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::jsonb)`,
          [
            artifact.id, organizationId, renderedPackingSlip.mimeType,
            renderedPackingSlip.filename, renderedPackingSlip.payload,
            PACKING_SLIP_TEMPLATE_VERSION, JSON.stringify(packingSnapshot),
          ],
        )
        await client.query(
          `INSERT INTO operations_tracking_observations (
             organization_id, shipment_id, status, provider, location,
             observed_at, source, raw_snapshot, idempotency_key, actor_email
           ) VALUES (
             $1::uuid, $2::uuid, 'confirmed', $3, NULL,
             $4::timestamptz, 'shipment_confirmation', $5::jsonb, $6, $7
           )`,
          [
            organizationId, packageShipment.id, packageShipment.carrier,
            packageShipment.shipped_at.toISOString(), JSON.stringify({
              shipmentGlobalId: packageShipment.global_id,
              labelGlobalId: packageShipment.label_global_id,
              trackingNumber: packageShipment.tracking_number,
              environment: packageShipment.environment,
              oneOffCarrierGroupGlobalId:
                packageShipment.one_off_carrier_group_global_id,
              quotedCarrierCostMinor:
                packageShipment.quoted_carrier_cost_minor,
              sandboxE2eAuthorizationGlobalId,
            }), `${packageShipment.global_id}:tracking:confirmed`, actorEmail,
          ],
        )
        artifactContexts.push({
          artifact, shipment: packageShipment, storageReference,
          renderedPackingSlip,
        })
      }
      const artifact = artifactContexts[0].artifact
      const renderedPackingSlip = artifactContexts[0].renderedPackingSlip
      const storageReference = artifactContexts[0].storageReference

      const shippedLineQuantities = new Map<string, number>()
      for (const line of packageContentResult.rows) {
        const quantity = numberValue(line.quantity)
        if (
          order.source_provider === 'shopify'
          && (!Number.isSafeInteger(quantity) || quantity <= 0)
        ) {
          throw new OperationsRequestError(
            'OPERATIONS_SHOPIFY_FULFILLMENT_LINE_INVALID',
            'Shopify fulfillment requires positive whole-unit packaged quantities',
            409,
          )
        }
        shippedLineQuantities.set(
          line.external_line_id,
          (shippedLineQuantities.get(line.external_line_id) || 0) + quantity,
        )
      }
      const shippedLines = [...shippedLineQuantities]
        .map(([externalLineId, quantity]) => ({ externalLineId, quantity }))
        .sort((left, right) => left.externalLineId.localeCompare(right.externalLineId))

      const exportSnapshot = {
        orderGlobalId: order.global_id,
        shipmentGlobalId: shipment.global_id,
        externalOrderId: order.external_order_id,
        trackingNumber: shipment.tracking_number,
        trackingNumbers: shipments.map((item) => item.tracking_number),
        carrier: shipment.carrier,
        serviceCode: shipment.service_code,
        shippedAt,
        sandboxE2eAuthorizationGlobalId,
        oneOffCarrierGroupGlobalId:
          nativeOneOffAuthority?.groupAttemptGlobalId || null,
        oneOffSelectedAmountMinor:
          nativeOneOffAuthority?.selectedAmountMinor ?? null,
        oneOffSelectedCurrency: nativeOneOffAuthority?.currency || null,
        customerNotification: resolvedCustomerNotification,
        ...(order.source_provider === 'shopify'
          ? {
              providerWriteProtocol: 'shopify-fulfillment-attempt-v2',
              shippedLines,
            }
          : order.source_provider === 'faire'
            ? {
                providerWriteProtocol:
                  FAIRE_FULFILLMENT_PROVIDER_WRITE_PROTOCOL,
                packages: shipments.map((item) => ({
                  packageReference: item.package_global_id,
                  carrier: item.carrier,
                  trackingCode: item.tracking_number,
                  makerCost: {
                    amountMinor: item.quoted_carrier_cost_minor,
                    currency: order.currency,
                  },
                })),
              }
            : {}),
      }
      const initialExportState = 'queued'
      const exportResult = await client.query<IdRow>(
        `INSERT INTO operations_commerce_fulfillment_exports (
           organization_id, order_id, shipment_id, provider,
           external_order_id, state, payload_snapshot, idempotency_key,
           completed_at
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, $4, $5,
           $6, $7::jsonb, $8, NULL
         )
         RETURNING id::text, global_id`,
        [
          organizationId,
          order.id,
          shipment.id,
          order.source_provider,
          order.external_order_id,
          initialExportState,
          JSON.stringify(exportSnapshot),
          `${shipment.global_id}:commerce-fulfillment`,
        ],
      )
      const fulfillmentExport = exportResult.rows[0]

      const updatedPackage = await client.query(
        `UPDATE operations_packages
         SET status = 'shipped'
         WHERE organization_id = $1::uuid
           AND plan_id = $2::uuid
           AND status = 'labeled'
         RETURNING id`,
        [organizationId, plan.id],
      )
      if (updatedPackage.rowCount !== packageResult.rows.length) {
        throw new OperationsRequestError(
          'OPERATIONS_PACKAGE_CHANGED',
          'The package changed before shipment confirmation. Refresh and try again.',
          409,
        )
      }
      const fulfilledPlan = await client.query(
        `UPDATE operations_fulfillment_plans
         SET status = 'fulfilled', updated_at = now()
         WHERE organization_id = $1::uuid
           AND id = $2::uuid
           AND status = 'released'
         RETURNING id`,
        [organizationId, plan.id],
      )
      if (fulfilledPlan.rowCount !== 1) {
        throw new OperationsRequestError(
          'OPERATIONS_FULFILLMENT_PLAN_CHANGED',
          'The fulfillment plan changed before shipment confirmation',
          409,
        )
      }
      const updatedOrder = await client.query<OrderIdentityRow>(
        `UPDATE operations_orders
         SET status = 'shipped', updated_by = $4, updated_at = now(),
             row_version = row_version + 1
         WHERE organization_id = $1::uuid
           AND id = $2::uuid
           AND status = 'packed'
           AND row_version = $3
         RETURNING id::text, global_id, status, row_version::text`,
        [organizationId, order.id, input.expectedRowVersion, actorEmail],
      )
      const shippedOrder = updatedOrder.rows[0]
      if (!shippedOrder || shippedOrder.row_version === undefined) {
        throw new OperationsRequestError(
          'OPERATIONS_ORDER_VERSION_CONFLICT',
          'This order changed before shipment could be confirmed. Refresh and try again.',
          409,
        )
      }
      if (sandboxE2eAuthorizationGlobalId) {
        await consumeSandboxCommerceE2eAuthorization(client, {
          organizationId,
          authorizationGlobalId: sandboxE2eAuthorizationGlobalId,
          orderGlobalId,
          actorEmail,
        })
      }

      await appendDomainEvent(client, {
        organizationId,
        aggregateType: 'operations.order',
        aggregateId: order.id,
        aggregateGlobalId: order.global_id,
        eventType: 'operations.shipment.confirmed',
        actorEmail,
        correlationId: command.receipt.correlation_id,
        idempotencyKey: `${shipment.global_id}:confirmed`,
        payload: {
          shipmentGlobalId: shipment.global_id,
          shipmentGlobalIds: shipments.map((item) => item.global_id),
          labelGlobalId: shipment.label_global_id,
          labelGlobalIds: shipments.map((item) => item.label_global_id),
          trackingNumber: shipment.tracking_number,
          trackingNumbers: shipments.map((item) => item.tracking_number),
          carrier: shipment.carrier,
          serviceCode: shipment.service_code,
          labelEnvironment: shipment.environment,
          oneOffCarrierGroupGlobalId:
            nativeOneOffAuthority?.groupAttemptGlobalId || null,
          oneOffSelectedAmountMinor:
            nativeOneOffAuthority?.selectedAmountMinor ?? null,
          oneOffShipmentAllocations: shipments.map((item) => ({
            packageGlobalId: item.package_global_id,
            shipmentGlobalId: item.global_id,
            quotedCarrierCostMinor: item.quoted_carrier_cost_minor,
          })),
          sandboxE2eAuthorizationGlobalId,
          packingSlipArtifactGlobalId: artifact.global_id,
          packingSlipArtifactGlobalIds: artifactContexts.map(
            (item) => item.artifact.global_id,
          ),
          commerceExportGlobalId: fulfillmentExport.global_id,
          customerNotification: resolvedCustomerNotification,
          providerCommitmentsRevalidated:
            providerCommitmentRevalidation.count,
          providerCommitmentInventorySyncRunGlobalIds:
            providerCommitmentRevalidation
              .latestInventorySyncRunGlobalIds,
          packagingMaterialClaimsConsumed:
            packagingConsumption.claimCount,
          packagingMaterialQuantityConsumed:
            packagingConsumption.quantity,
          reason,
        },
      })
      await appendDomainEvent(client, {
        organizationId,
        aggregateType: 'operations.order',
        aggregateId: order.id,
        aggregateGlobalId: order.global_id,
        eventType: 'operations.inventory.consumed',
        actorEmail,
        correlationId: command.receipt.correlation_id,
        idempotencyKey: `${shipment.global_id}:inventory-consumed`,
        payload: {
          shipmentGlobalId: shipment.global_id,
          shipmentGlobalIds: shipments.map((item) => item.global_id),
          oneOffCarrierGroupGlobalId:
            nativeOneOffAuthority?.groupAttemptGlobalId || null,
          allocations: allocations.map((allocation) => ({
            inventoryPositionGlobalId: allocation.position_global_id,
            productGlobalId: allocation.product_global_id,
            quantity: numberValue(allocation.allocation_quantity),
            sourceAuthority: allocation.source_authority,
          })),
          localInventoryConsumptionCount,
          providerCommitmentConsumptionCount,
          providerCommitmentsRevalidated:
            providerCommitmentRevalidation.count,
          providerCommitmentInventorySyncRunGlobalIds:
            providerCommitmentRevalidation
              .latestInventorySyncRunGlobalIds,
          packagingMaterialClaimsConsumed:
            packagingConsumption.claimCount,
          packagingMaterialQuantityConsumed:
            packagingConsumption.quantity,
        },
      })
      await appendDomainEvent(client, {
        organizationId,
        aggregateType: 'operations.order',
        aggregateId: order.id,
        aggregateGlobalId: order.global_id,
        eventType: 'operations.commerce_fulfillment.queued',
        actorEmail,
        correlationId: command.receipt.correlation_id,
        idempotencyKey: `${fulfillmentExport.global_id}:${initialExportState}`,
        payload: exportSnapshot,
      })
      await recordAuditEvent({
        actor: actorEmail,
        eventType: 'operations.order.shipment_confirmed',
        aggregateType: 'operations.order',
        aggregateId: order.global_id,
        subject: `Confirmed shipment for ${order.global_id}`,
        organizationId,
        eventKey: `operations:order-shipment-confirmed:${command.receipt.id}`,
        payload: {
          previousStatus: 'packed',
          status: 'shipped',
          previousRowVersion: input.expectedRowVersion,
          rowVersion: Number(shippedOrder.row_version),
          shipmentGlobalId: shipment.global_id,
          shipmentGlobalIds: shipments.map((item) => item.global_id),
          labelGlobalId: shipment.label_global_id,
          labelGlobalIds: shipments.map((item) => item.label_global_id),
          labelEnvironment: shipment.environment,
          oneOffCarrierGroupGlobalId:
            nativeOneOffAuthority?.groupAttemptGlobalId || null,
          oneOffSelectedAmountMinor:
            nativeOneOffAuthority?.selectedAmountMinor ?? null,
          oneOffShipmentAllocations: shipments.map((item) => ({
            packageGlobalId: item.package_global_id,
            shipmentGlobalId: item.global_id,
            quotedCarrierCostMinor: item.quoted_carrier_cost_minor,
          })),
          trackingNumber: shipment.tracking_number,
          trackingNumbers: shipments.map((item) => item.tracking_number),
          sandboxE2eAuthorizationGlobalId,
          packingSlipArtifactGlobalId: artifact.global_id,
          packingSlipArtifactGlobalIds: artifactContexts.map(
            (item) => item.artifact.global_id,
          ),
          commerceExportGlobalId: fulfillmentExport.global_id,
          customerNotification: resolvedCustomerNotification,
          providerCommitmentsRevalidated:
            providerCommitmentRevalidation.count,
          providerCommitmentInventorySyncRunGlobalIds:
            providerCommitmentRevalidation
              .latestInventorySyncRunGlobalIds,
          packagingMaterialClaimsConsumed:
            packagingConsumption.claimCount,
          packagingMaterialQuantityConsumed:
            packagingConsumption.quantity,
          reason,
        },
      }, client)

      const result: OperationsShipmentCommandResult = {
        orderGlobalId: shippedOrder.global_id,
        orderStatus: 'shipped',
        rowVersion: Number(shippedOrder.row_version),
        shipmentGlobalId: shipment.global_id,
        trackingNumber: shipment.tracking_number,
        packingSlipArtifactGlobalId: artifact.global_id,
        commerceExportGlobalId: fulfillmentExport.global_id,
        commerceExportState: 'failed',
        customerNotification: resolvedCustomerNotification,
        replayed: false,
        printJobGlobalId: null,
        printWarning: 'Shipment committed; print and commerce post-processing are pending.',
      }
      await completeCommandReceipt(client, command.receipt.id, order.global_id, result)

      return {
        result,
        warehouseId: plan.warehouse_id,
        storageReference,
        renderedPackingSlip,
      }
    })
    committed = true

    let printJobGlobalId: string | null = null
    let printWarning: string | null = null
    try {
      const printJob = await enqueueOperationsPrintJobInPostgres({
        organizationId,
        actorEmail,
        idempotencyKey: `${context.result.shipmentGlobalId}:packing-slip-print`,
        warehouseId: context.warehouseId,
        preferredPrinterGlobalId,
        document: {
          type: 'packing_slip',
          format: 'PDF',
          media: 'letter',
          contentSha256: context.renderedPackingSlip.contentSha256,
          byteLength: context.renderedPackingSlip.byteLength,
          storageReference: context.storageReference,
          sourceOrderGlobalId: context.result.orderGlobalId,
          sourceShipmentGlobalId: context.result.shipmentGlobalId,
        },
      })
      const printResult = printJob as unknown as {
        globalId?: string
        printJobGlobalId?: string | null
        printWarning?: string | null
      }
      printJobGlobalId = (
        typeof printResult.globalId === 'string'
          ? printResult.globalId
          : typeof printResult.printJobGlobalId === 'string'
            ? printResult.printJobGlobalId
            : null
      )
      printWarning = typeof printResult.printWarning === 'string'
        ? printResult.printWarning
        : null
    } catch (error) {
      printWarning = error instanceof Error
        ? `Packing slip is available, but automatic printing was not queued: ${error.message}`
        : 'Packing slip is available, but automatic printing was not queued.'
    }

    const commerceExport =
      await executeOperationsCommerceFulfillmentExportFromPostgres({
        organizationId,
        actorEmail,
        commerceExportGlobalId: context.result.commerceExportGlobalId,
        reason: 'Automatic post-shipment fulfillment export',
        auditEventKey:
          `operations:commerce-fulfillment:${context.result.commerceExportGlobalId}:initial`,
      })

    const result: OperationsShipmentCommandResult = {
      ...context.result,
      commerceExportState: commerceExport.state,
      customerNotification: commerceExport.customerNotification,
      printJobGlobalId,
      printWarning,
    }
    await query(
      `UPDATE operations_command_receipts
       SET result_payload = $2::jsonb, updated_at = now()
       WHERE id = $1::uuid AND status = 'succeeded'`,
      [command.receipt.id, JSON.stringify(result)],
    )
    return result
  } catch (error) {
    if (!committed) {
      await failCommandReceipt(command.receipt.id, error)
    }
    throw error
  }
}
