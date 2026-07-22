import { createHash, randomUUID } from 'node:crypto'
import type { PoolClient, QueryResultRow } from 'pg'
import { recordAuditEvent } from '@/lib/auditWriter'
import { normalizedCrmIdentityText } from '@/lib/crm/stableId'
import {
  MockCarrierAdapter,
  MockCommerceAdapter,
  MockPrintAdapter,
} from '@/lib/operations/adapters'
import {
  applyFreightPricing,
  assertCurrency,
  assertPositiveQuantity,
  cartonizeSinglePackage,
  DeterministicFulfillmentOptimizer,
  priceContract,
  selectPromiseRate,
} from '@/lib/operations/domain'
import type { OperationsCapabilities } from '@/lib/operations/authorization'
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
  OperationsExceptionListItem,
  OperationsExceptionStatus,
  OperationsExceptionUpdateResult,
  OperationsOrderDetail,
  OperationsOrderListItem,
  OperationsOrderStatus,
  OperationsWorkspace,
  PricingDirective,
} from '@/lib/operations/types'
import { stageCrmRecordWithClient } from '@/lib/persistence/crm'
import {
  acquireTransactionAdvisoryLock,
  query,
  withTransaction,
} from '@/lib/persistence/postgres'

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
type PositionRow = QueryResultRow & {
  id: string
  global_id: string
  warehouse_id: string
  warehouse_global_id: string
  warehouse_name: string
  location_id: string
  on_hand_quantity: string
  reserved_quantity: string
}
type OrderIdentityRow = QueryResultRow & {
  id: string
  global_id: string
  status: OperationsOrderStatus
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
  status: 'processing' | 'succeeded' | 'failed'
  correlation_id: string
  result_global_id: string | null
  attempts: number
  updated_at: Date
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

export class OperationsRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message)
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

function uniqueReferenceRows<T extends { reference_code: string }>(rows: T[]): T[] {
  return [...new Map(rows.map((row) => [row.reference_code, row])).values()]
}

function requireOrganizationId(value: string) {
  const organizationId = String(value || '').trim()
  if (!organizationId) throw new OperationsRequestError('ACTIVE_ORGANIZATION_REQUIRED', 'Select an active organization first', 409)
  return organizationId
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
  await client.query(
    `INSERT INTO operations_external_identifiers (
       organization_id, integration_account_id, entity_type, entity_global_id,
       external_id, status, match_method, match_evidence, last_verified_at
     ) VALUES ($1::uuid, $2::uuid, 'crm.organization', $3, $4,
       'active', $5, $6::jsonb, now())
     ON CONFLICT (organization_id, integration_account_id, entity_type, external_id)
     DO UPDATE SET entity_global_id = EXCLUDED.entity_global_id,
                   status = 'active',
                   match_method = EXCLUDED.match_method,
                   match_evidence = EXCLUDED.match_evidence,
                   last_verified_at = now()`,
    [
      input.organizationId,
      input.integrationAccountId,
      input.customer.globalId,
      input.externalCustomerId,
      input.method,
      JSON.stringify(input.evidence),
    ],
  )
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
  const externalCustomerId = trimmed(input.identity.externalCustomerId, 300)
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
              position.on_hand_quantity::text, position.reserved_quantity::text
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
  await client.query(
    `UPDATE operations_reservations SET status = 'consumed', released_at = now()
     WHERE organization_id = $1::uuid AND id = $2::uuid AND status = 'active'`,
    [input.organizationId, input.reservation.id],
  )
  await client.query(
    `INSERT INTO operations_inventory_ledger (
       organization_id, position_id, event_type, on_hand_delta, reserved_delta,
       on_hand_after, reserved_after, source_global_id, reason, idempotency_key, actor_email
     ) VALUES ($1::uuid, $2::uuid, 'ship', $3, $4, $5, $6,
       $7, 'Shipped mock proof order', $8, $9)`,
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

async function readOrderDetail(organizationId: string, orderGlobalId: string): Promise<OperationsOrderDetail | null> {
  const orderResult = await query<QueryResultRow & {
    id: string
    global_id: string
    order_number: string
    external_order_id: string
    customer_name: string
    customer_global_id: string
    source_provider: string
    status: OperationsOrderStatus
    currency: string
    warehouse_name: string | null
    promised_delivery_at: Date | null
    line_count: string
    exception_count: string
    expected_cost_minor: string | null
    expected_revenue_minor: string | null
    expected_margin_minor: string | null
    tracking_number: string | null
    ship_to: Record<string, unknown>
    updated_at: Date
  }>(
    `SELECT
       orders.id::text, orders.global_id, orders.order_number, orders.external_order_id,
       customer.name AS customer_name, customer.reference_code AS customer_global_id,
       orders.source_provider, orders.status, orders.currency, orders.ship_to,
       plan_warehouse.name AS warehouse_name, orders.promised_delivery_at,
       (SELECT count(*) FROM operations_order_lines line WHERE line.order_id = orders.id)::text AS line_count,
       (SELECT count(*) FROM operations_exceptions exception
        WHERE exception.order_id = orders.id AND exception.status IN ('open', 'acknowledged'))::text AS exception_count,
       plan.estimated_cost_minor::text, plan.estimated_revenue_minor::text, plan.estimated_margin_minor::text,
       shipment.tracking_number, orders.updated_at
     FROM operations_orders orders
     JOIN crm_organizations customer ON customer.id = orders.customer_id AND customer.pipeline_id = orders.pipeline_id
     LEFT JOIN LATERAL (
       SELECT candidate.* FROM operations_fulfillment_plans candidate
       WHERE candidate.order_id = orders.id ORDER BY candidate.version_number DESC LIMIT 1
     ) plan ON true
     LEFT JOIN operations_warehouses plan_warehouse ON plan_warehouse.id = plan.warehouse_id
     LEFT JOIN LATERAL (
       SELECT candidate.tracking_number FROM operations_shipments candidate
       WHERE candidate.order_id = orders.id ORDER BY candidate.shipped_at DESC LIMIT 1
     ) shipment ON true
     WHERE orders.organization_id = $1::uuid AND orders.global_id = $2
     LIMIT 1`,
    [organizationId, orderGlobalId],
  )
  const row = orderResult.rows[0]
  if (!row) return null

  const [lineResult, packageResult, rateResult, billableResult, eventResult] = await Promise.all([
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
              CASE WHEN reservation.status = 'active' THEN reservation.quantity ELSE 0 END::text AS reserved_quantity,
              pick.status AS pick_status
       FROM operations_order_lines line
       JOIN crm_products product ON product.id = line.product_id AND product.pipeline_id = line.pipeline_id
       LEFT JOIN operations_reservations reservation ON reservation.order_line_id = line.id
       LEFT JOIN operations_fulfillment_allocations allocation ON allocation.order_line_id = line.id
       LEFT JOIN operations_pick_tasks pick ON pick.allocation_id = allocation.id
       WHERE line.organization_id = $1::uuid AND line.order_id = $2::uuid
       ORDER BY line.created_at, line.id`,
      [organizationId, row.id],
    ),
    query<QueryResultRow & {
      global_id: string
      package_number: number
      weight_grams: number
      length_mm: number
      width_mm: number
      height_mm: number
      status: string
    }>(
      `SELECT package.global_id, package.package_number, package.weight_grams,
              package.length_mm, package.width_mm, package.height_mm, package.status
       FROM operations_packages package
       JOIN operations_fulfillment_plans plan ON plan.id = package.plan_id
       WHERE package.organization_id = $1::uuid AND plan.order_id = $2::uuid
       ORDER BY package.package_number`,
      [organizationId, row.id],
    ),
    query<QueryResultRow & {
      global_id: string
      carrier: string
      service_name: string
      internal_cost_minor: string
      customer_charge_minor: string
      estimated_delivery_at: Date
      meets_promise: boolean
      selected: boolean
    }>(
      `SELECT rate.global_id, rate.carrier, rate.service_name, rate.internal_cost_minor::text,
              rate.customer_charge_minor::text, rate.estimated_delivery_at,
              rate.meets_promise, rate.selected
       FROM operations_carrier_rates rate
       JOIN operations_fulfillment_plans plan ON plan.id = rate.plan_id
       WHERE rate.organization_id = $1::uuid AND plan.order_id = $2::uuid
       ORDER BY rate.internal_cost_minor, rate.carrier, rate.service_code`,
      [organizationId, row.id],
    ),
    query<QueryResultRow & { global_id: string; event_type: string; amount_minor: string; status: string }>(
      `SELECT global_id, event_type, amount_minor::text, status
       FROM operations_billable_events
       WHERE organization_id = $1::uuid AND order_id = $2::uuid
       ORDER BY occurred_at, id`,
      [organizationId, row.id],
    ),
    query<QueryResultRow & { global_id: string; event_type: string; occurred_at: Date; payload: Record<string, unknown> }>(
      `SELECT global_id, event_type, occurred_at, payload
       FROM operations_domain_events
       WHERE organization_id = $1::uuid AND aggregate_type = 'operations.order' AND aggregate_id = $2::uuid
       ORDER BY occurred_at, id`,
      [organizationId, row.id],
    ),
  ])

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
    })),
    rates: rateResult.rows.map((item) => ({
      globalId: item.global_id,
      carrier: item.carrier,
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
  capabilities: OperationsCapabilities
  search?: string
  status?: string | null
  exceptionStatus?: OperationsExceptionStatus | null
  selectedOrderGlobalId?: string | null
}): Promise<OperationsWorkspace> {
  const organizationId = requireOrganizationId(input.organizationId)
  const activation = await withTransaction((client) => resolveActivation(client, organizationId))
  const values: unknown[] = [organizationId]
  const where = ['orders.organization_id = $1::uuid']
  const exceptionValues: unknown[] = [organizationId]
  const exceptionWhere = ['exception.organization_id = $1::uuid']
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

  const [configuredResult, summaryResult, orderResult, exceptionResult, warehouseResult, customerResult, productResult] = await Promise.all([
    query<QueryResultRow & { configured: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM operations_integration_accounts integration
         WHERE integration.organization_id = $1::uuid AND integration.environment = 'mock'
       ) AND EXISTS (
         SELECT 1 FROM operations_warehouses warehouse WHERE warehouse.organization_id = $1::uuid
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
         (SELECT count(*) FROM operations_orders WHERE organization_id = $1::uuid AND status NOT IN ('shipped', 'cancelled'))::text AS open_orders,
         (SELECT count(*) FROM operations_exceptions WHERE organization_id = $1::uuid AND status IN ('open', 'acknowledged'))::text AS exceptions,
         (SELECT count(*) FROM operations_orders WHERE organization_id = $1::uuid AND status NOT IN ('shipped', 'cancelled') AND promised_delivery_at <= now() + interval '2 days')::text AS due_soon,
         (SELECT count(*) FROM operations_orders WHERE organization_id = $1::uuid AND status = 'shipped' AND updated_at >= date_trunc('day', now()))::text AS shipped_today,
         COALESCE((SELECT sum(reserved_quantity) FROM operations_inventory_positions WHERE organization_id = $1::uuid), 0)::text AS reserved_units,
         COALESCE((SELECT sum(on_hand_quantity - reserved_quantity - damaged_quantity) FROM operations_inventory_positions WHERE organization_id = $1::uuid), 0)::text AS available_units,
         COALESCE((SELECT sum(amount_minor) FROM operations_billable_events WHERE organization_id = $1::uuid AND status = 'unbilled'), 0)::text AS unbilled_minor`,
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
              (SELECT count(*) FROM operations_order_lines line WHERE line.order_id = orders.id)::text AS line_count,
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
    query<QueryResultRow & { id: string; global_id: string; name: string }>(
      `SELECT id::text, global_id, name FROM operations_warehouses
       WHERE organization_id = $1::uuid AND status = 'active' ORDER BY name, id`,
      [organizationId],
    ),
    query<CustomerRow>(
      `SELECT customer.id::text, customer.reference_code, customer.name
       FROM crm_organizations customer
       WHERE customer.pipeline_id = $1::uuid
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
  const selectedGlobalId = input.selectedOrderGlobalId || orders[0]?.globalId || null
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
    selectedOrder: selectedGlobalId ? await readOrderDetail(organizationId, selectedGlobalId) : null,
    warehouses: warehouseResult.rows.map((row) => ({ id: row.id, globalId: row.global_id, name: row.name })),
    catalog: {
      customers: uniqueReferenceRows(customerResult.rows).map((row) => ({ id: row.id, globalId: row.reference_code, name: row.name })),
      products: uniqueReferenceRows(productResult.rows).map((row) => ({ id: row.id, globalId: row.reference_code, name: row.name, sku: row.sku })),
    },
    generatedAt: new Date().toISOString(),
  }
}

export async function updateOperationsActivationInPostgres(input: {
  organizationId: string
  actorEmail: string
  state: OperationsActivationState
  reason?: string | null
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
    const current = await resolveActivation(client, organizationId, true)
    if (input.state === 'active') {
      const providers = await client.query<QueryResultRow & { integration_type: string }>(
        `SELECT DISTINCT integration_type
         FROM operations_integration_accounts
         WHERE organization_id = $1::uuid AND environment = 'production'
           AND status = 'active'
           AND integration_type IN ('commerce', 'carrier', 'printing')`,
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
}): Promise<{ receipt: CommandReceiptRow; completed: boolean }> {
  return withTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(
      client,
      `operations:command-receipt:${input.organizationId}:${input.commandType}:${input.idempotencyKey}`,
    )
    const existing = await client.query<CommandReceiptRow>(
      `SELECT id::text, request_hash, status, correlation_id::text,
              result_global_id, attempts, updated_at
       FROM operations_command_receipts
       WHERE organization_id = $1::uuid AND command_type = $2 AND idempotency_key = $3
       FOR UPDATE`,
      [input.organizationId, input.commandType, input.idempotencyKey],
    )
    const receipt = existing.rows[0]
    if (receipt) {
      if (receipt.request_hash !== input.requestHash) {
        throw new OperationsRequestError(
          'OPERATIONS_IDEMPOTENCY_CONFLICT',
          'This external order ID was already used with different order data',
          409,
        )
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
         RETURNING id::text, request_hash, status, correlation_id::text,
                   result_global_id, attempts, updated_at`,
        [receipt.id, input.actorEmail],
      )
      return { receipt: retried.rows[0], completed: false }
    }
    const created = await client.query<CommandReceiptRow>(
      `INSERT INTO operations_command_receipts (
         organization_id, command_type, idempotency_key, request_hash,
         actor_email, status, correlation_id
       ) VALUES ($1::uuid, $2, $3, $4, $5, 'processing', $6::uuid)
       RETURNING id::text, request_hash, status, correlation_id::text,
                 result_global_id, attempts, updated_at`,
      [
        input.organizationId,
        input.commandType,
        input.idempotencyKey,
        input.requestHash,
        input.actorEmail,
        randomUUID(),
      ],
    )
    return { receipt: created.rows[0], completed: false }
  })
}

async function completeCommandReceipt(
  client: PoolClient,
  receiptId: string,
  resultGlobalId: string,
) {
  await client.query(
    `UPDATE operations_command_receipts
     SET status = 'succeeded', result_global_id = $2,
         error_code = NULL, error_message = NULL,
         completed_at = now(), updated_at = now()
     WHERE id = $1::uuid`,
    [receiptId, resultGlobalId],
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

async function completedProofResult(
  organizationId: string,
  orderGlobalId: string | null,
): Promise<MockOperationsProofResult> {
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
    steps: [...MOCK_PROOF_STEPS],
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
    if (!/^gp\d{7}$/.test(productGlobalId)) {
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
  const canonicalProof: MockOperationsProofInput = {
    customerGlobalId: input.proof.customerGlobalId,
    externalOrderId: input.proof.externalOrderId,
    orderNumber: input.proof.orderNumber,
    lines: proofLines,
    requestedDeliveryAt: input.proof.requestedDeliveryAt,
    shipTo: input.proof.shipTo,
  }

  const command = await prepareCommandReceipt({
    organizationId,
    commandType: 'run_mock_operations_proof',
    idempotencyKey: `mock-commerce:${input.proof.externalOrderId}`,
    requestHash: commandRequestHash(canonicalProof),
    actorEmail,
  })
  if (command.completed) {
    return completedProofResult(organizationId, command.receipt.result_global_id)
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
        return {
          externalLineId: `${input.proof.externalOrderId}:${index + 1}`,
          channelSku: product.sku || product.reference_code,
          description: product.name,
          quantity: proofLine.quantity,
          unitPriceMinor: moneyMinorFromDecimal(product.price),
          weightGrams: 350,
          dimensionsMm: { length: 220, width: 160, height: 90 },
        }
      }),
      sourcePayload: { proof: true, lineCount: proofLines.length },
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
      await completeCommandReceipt(client, command.receipt.id, duplicate.global_id)
      return {
        orderGlobalId: duplicate.global_id,
        orderStatus: duplicate.status,
        duplicate: true,
        trackingNumber: duplicate.tracking_number || null,
        steps: [...MOCK_PROOF_STEPS],
      }
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
      orderLine: IdRow
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
      const orderLineResult = await client.query<IdRow>(
        `INSERT INTO operations_order_lines (
           organization_id, order_id, pipeline_id, product_id, external_line_id,
           channel_sku, description, quantity, unit_price_minor, weight_grams, dimensions_mm
         ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5,
           $6, $7, $8, $9, $10, $11::jsonb)
         RETURNING id::text, global_id`,
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

    const packagePlan = packages[0]
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
    const packedPackage = packageResult.rows[0]
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
           quantity, sequence_number, status, assigned_to
         ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
           $6, $7, 'ready', $8)
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
         tracking_number, shipped_at, actual_carrier_cost_minor, confirmed_by
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
    await completeCommandReceipt(client, command.receipt.id, order.global_id)

    return {
      orderGlobalId: order.global_id,
      orderStatus: 'shipped',
      duplicate: false,
      trackingNumber: labelOutput.trackingNumber,
      steps: [...MOCK_PROOF_STEPS],
    }
    })
  } catch (error) {
    await failCommandReceipt(command.receipt.id, error)
    throw error
  }
}
