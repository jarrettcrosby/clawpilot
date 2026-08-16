import { createHash } from 'node:crypto'
import type { PoolClient } from 'pg'
import { recordAuditEvent } from '@/lib/auditWriter'
import {
  isClawPilotCommerceCapabilityImplemented,
} from '@/lib/integrations/commerceCapabilities'
import {
  acquireTransactionAdvisoryLock,
  query,
  withTransaction,
} from '@/lib/persistence/postgres'
import type {
  CommerceActiveContinuation,
} from '@/lib/operations/commerceActiveSelection'

export type CommerceActiveProvider = 'shopify' | 'faire'
export type CommerceActiveActorRole = 'owner' | 'admin'

export const COMMERCE_ACTIVE_WRITE_CAPABILITY_SCOPES = {
  shopify: {
    catalog_publishing: ['write_products', 'write_publications'],
    inventory_export: ['write_inventory', 'read_locations'],
    inventory_transfer_synchronization: ['write_inventory_transfers'],
    inventory_shipment_synchronization: [
      'write_inventory_shipments',
      'read_inventory_shipments_received_items',
      'write_inventory_shipments_received_items',
    ],
    location_administration: ['write_locations'],
    customer_export: ['write_customers'],
    order_creation: ['write_orders'],
    order_update: ['write_orders'],
    order_edit: ['write_order_edits'],
    draft_order_synchronization: ['write_draft_orders'],
    refund_export: ['write_orders'],
    fulfillment_export: ['write_merchant_managed_fulfillment_orders'],
    third_party_fulfillment_orchestration: [
      'write_third_party_fulfillment_orders',
    ],
    fulfillment_service: [
      'write_assigned_fulfillment_orders',
      'write_fulfillments',
    ],
    tracking_export: ['write_merchant_managed_fulfillment_orders'],
    shipping_rate_callbacks: ['write_shipping'],
    return_export: ['write_returns'],
  },
  faire: {
    catalog_publishing: ['WRITE_PRODUCTS'],
    inventory_export: ['WRITE_INVENTORIES'],
    order_update: [
      'READ_BRAND',
      'READ_ORDERS',
      'READ_SHIPMENTS',
      'WRITE_ORDERS',
    ],
    fulfillment_export: [
      'READ_BRAND',
      'READ_ORDERS',
      'READ_SHIPMENTS',
      'WRITE_ORDERS',
    ],
    tracking_export: [
      'READ_BRAND',
      'READ_ORDERS',
      'READ_SHIPMENTS',
      'WRITE_ORDERS',
    ],
  },
} as const

const FAIRE_FULFILLMENT_WRITE_CAPABILITIES = new Set<
  CommerceActiveWriteCapability
>(['order_update', 'fulfillment_export', 'tracking_export'])

type ShopifyActiveWriteCapability =
  keyof typeof COMMERCE_ACTIVE_WRITE_CAPABILITY_SCOPES.shopify
type FaireActiveWriteCapability =
  keyof typeof COMMERCE_ACTIVE_WRITE_CAPABILITY_SCOPES.faire
export type CommerceActiveWriteCapability =
  | ShopifyActiveWriteCapability
  | FaireActiveWriteCapability

export const COMMERCE_ACTIVE_CONFIRMATION_STATEMENT_VERSION =
  'commerce-active-transition-v1' as const
export const COMMERCE_ACTIVE_AUTHORIZATION_TTL_SECONDS = 300 as const

type AccountRow = {
  id: string
  global_id: string
  provider: CommerceActiveProvider
  environment: 'sandbox' | 'production' | 'mock'
  external_account_id: string | null
  status: 'active' | 'disabled' | 'error'
  configuration: Record<string, unknown>
  commerce_credential_generation: number
  credential_external_account_id: string | null
  credential_version: number | null
  auth_mode: string | null
  verification_status: 'unverified' | 'verified' | 'failed' | null
}

type PreparationRow = {
  id: string
  global_id: string
  organization_id: string
  cohort: CommerceActiveCohortAccount[]
  cohort_hash: string
  expected_activation_state: 'shadow'
  expected_activation_revision: number
  target_activation_state: 'active'
  target_activation_revision: number
  idempotency_key: string
  request_hash: string
  prepared_by: string
  prepared_role: CommerceActiveActorRole
  prepared_at: string | Date
}

type AuthorizationRow = {
  id: string
  global_id: string
  organization_id: string
  preparation_id: string
  preparation_global_id?: string
  cohort_hash: string
  confirmation_statement_version:
    typeof COMMERCE_ACTIVE_CONFIRMATION_STATEMENT_VERSION
  confirmation_hash: string
  idempotency_key: string
  request_hash: string
  authorized_by: string
  authorized_role: CommerceActiveActorRole
  authorized_at: string | Date
  expires_at: string | Date
}

type TransitionRow = {
  id: string
  global_id: string
  organization_id: string
  preparation_id: string
  preparation_global_id?: string
  authorization_id: string
  authorization_global_id?: string
  cohort_hash: string
  from_activation_state: 'shadow'
  from_activation_revision: number
  to_activation_state: 'active'
  to_activation_revision: number
  account_count: number
  capability_count: number
  idempotency_key: string
  request_hash: string
  reason: string | null
  activated_by: string
  activated_role: CommerceActiveActorRole
  activated_at: string | Date
}

export type CommerceActiveCohortAccount = {
  accountId: string
  accountGlobalId: string
  provider: CommerceActiveProvider
  environment: 'sandbox' | 'production'
  externalAccountId: string
  credentialGeneration: number
  authMode: string
  priorAccountStatus: 'active' | 'disabled'
  targetAccountStatus: 'active'
  grantedScopes: string[]
  grantedScopeDigest: string
  writeCapabilities: CommerceActiveWriteCapability[]
  capabilityDigest: string
}

export type CommerceActiveTransitionPreparation = {
  preparationGlobalId: string
  cohortHash: string
  expectedActivationState: 'shadow'
  expectedActivationRevision: number
  targetActivationState: 'active'
  targetActivationRevision: number
  accounts: CommerceActiveCohortAccount[]
  preparedBy: string
  preparedRole: CommerceActiveActorRole
  preparedAt: string
  replayed: boolean
}

export type CommerceActiveTransitionAuthorization = {
  authorizationGlobalId: string
  preparationGlobalId: string
  cohortHash: string
  confirmationStatementVersion:
    typeof COMMERCE_ACTIVE_CONFIRMATION_STATEMENT_VERSION
  authorizedBy: string
  authorizedRole: CommerceActiveActorRole
  authorizedAt: string
  expiresAt: string
  replayed: boolean
}

export type CommerceActiveTransition = {
  transitionGlobalId: string
  preparationGlobalId: string
  authorizationGlobalId: string
  cohortHash: string
  fromActivationState: 'shadow'
  fromActivationRevision: number
  state: 'active'
  revision: number
  accountCount: number
  capabilityCount: number
  reason: string | null
  activatedBy: string
  activatedRole: CommerceActiveActorRole
  activatedAt: string
  replayed: boolean
}

export type CommerceActiveCapabilityClaim = {
  transitionGlobalId: string
  authorizationGlobalId: string
  preparationGlobalId: string
  cohortHash: string
  activationRevision: number
  accountGlobalId: string
  provider: CommerceActiveProvider
  environment: 'sandbox' | 'production'
  externalAccountId: string
  credentialGeneration: number
  grantedScopeDigest: string
  capability: CommerceActiveWriteCapability
  capabilityDigest: string
  authorizedBy: string
  authorizedRole: CommerceActiveActorRole
  activatedAt: string
}

export type PrepareCommerceActiveTransitionInput = {
  organizationId: unknown
  actorEmail: unknown
  expectedActivationState: 'shadow'
  expectedActivationRevision: unknown
  selectedAccounts: unknown
  idempotencyKey: unknown
}

export type PrepareCommerceActiveTransitionResult =
  CommerceActiveTransitionPreparation

export type AuthorizeCommerceActiveTransitionInput = {
  organizationId: unknown
  actorEmail: unknown
  preparationGlobalId: unknown
  expectedCohortHash: unknown
  idempotencyKey: unknown
}

export type AuthorizeCommerceActiveTransitionResult =
  CommerceActiveTransitionAuthorization

export type ConsumeCommerceActiveTransitionInput = {
  organizationId: unknown
  actorEmail: unknown
  authorizationGlobalId: unknown
  expectedCohortHash: unknown
  idempotencyKey: unknown
  reason?: unknown
}

export type ConsumeCommerceActiveTransitionResult =
  CommerceActiveTransition

export class CommerceActiveTransitionPersistenceError extends Error {
  code: string
  status: number

  constructor(code: string, message: string, status = 409) {
    super(message)
    this.name = 'CommerceActiveTransitionPersistenceError'
    this.code = code
    this.status = status
  }
}

const UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
const ACCOUNT_GLOBAL_ID = /^gia(?:[0-9]{7}|[0-9a-v]{12})$/
const PREPARATION_GLOBAL_ID = /^gcap(?:[0-9]{7}|[0-9a-v]{12})$/
const AUTHORIZATION_GLOBAL_ID = /^gcaa(?:[0-9]{7}|[0-9a-v]{12})$/
const SHA256 = /^[a-f0-9]{64}$/
const SAFE_KEY = /^[^\u0000-\u001f\u007f]{1,255}$/
const SAFE_SCOPE = /^[A-Za-z][A-Za-z0-9_]{0,127}$/

function fail(code: string, message: string, status = 409): never {
  throw new CommerceActiveTransitionPersistenceError(code, message, status)
}

function iso(value: string | Date) {
  return new Date(value).toISOString()
}

function actorEmail(value: unknown) {
  const normalized = String(value || '').trim().toLowerCase()
  if (
    !normalized
    || normalized.length > 320
    || /[\u0000-\u001f\u007f]/.test(normalized)
  ) {
    fail(
      'COMMERCE_ACTIVE_ACTOR_REQUIRED',
      'A signed-in owner or administrator is required',
      401,
    )
  }
  return normalized
}

function organizationId(value: unknown) {
  const normalized = String(value || '').trim().toLowerCase()
  if (!UUID.test(normalized)) {
    fail(
      'COMMERCE_ACTIVE_ORGANIZATION_INVALID',
      'Active workspace organization is invalid',
      400,
    )
  }
  return normalized
}

function idempotencyKey(value: unknown) {
  const normalized = String(value || '').trim()
  if (!SAFE_KEY.test(normalized)) {
    fail(
      'COMMERCE_ACTIVE_IDEMPOTENCY_KEY_INVALID',
      'A valid idempotency key is required',
      400,
    )
  }
  return normalized
}

function expectedRevision(value: unknown) {
  const normalized = Number(value)
  if (!Number.isSafeInteger(normalized) || normalized < 1) {
    fail(
      'COMMERCE_ACTIVE_REVISION_INVALID',
      'Expected Shadow activation revision is invalid',
      400,
    )
  }
  return normalized
}

function exactHash(value: unknown, label: string) {
  const normalized = String(value || '').trim().toLowerCase()
  if (!SHA256.test(normalized)) {
    fail(
      'COMMERCE_ACTIVE_HASH_INVALID',
      `${label} is invalid`,
      400,
    )
  }
  return normalized
}

function canonicalJson(value: unknown): string {
  if (value === null) return 'null'
  if (
    typeof value === 'string'
    || typeof value === 'boolean'
    || typeof value === 'number'
  ) {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      fail(
        'COMMERCE_ACTIVE_EVIDENCE_INVALID',
        'Commerce Active evidence cannot contain a non-finite number',
        400,
      )
    }
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`
  }
  if (!value || typeof value !== 'object') {
    fail(
      'COMMERCE_ACTIVE_EVIDENCE_INVALID',
      'Commerce Active evidence must be valid JSON',
      400,
    )
  }
  const source = value as Record<string, unknown>
  return `{${Object.keys(source).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(source[key])}`
  )).join(',')}}`
}

export function commerceActiveTransitionEvidenceHash(value: unknown) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

function hashToken(value: string) {
  return `${Buffer.byteLength(value, 'utf8')}:${value}`
}

function listDigest(domain: string, values: readonly string[]) {
  const normalized = [...new Set(values)].sort()
  return createHash('sha256')
    .update(hashToken(domain) + normalized.map(hashToken).join(''))
    .digest('hex')
}

function codePointOrder(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0
}

export function commerceActiveGrantedScopeDigest(scopes: readonly string[]) {
  return listDigest('commerce-active-scopes-v1', scopes)
}

export function commerceActiveCapabilityDigest(
  capabilities: readonly CommerceActiveWriteCapability[],
) {
  return listDigest('commerce-active-capabilities-v1', capabilities)
}

export function commerceActiveCohortHash(input: {
  organizationId: string
  expectedActivationState: 'shadow'
  expectedActivationRevision: number
  targetActivationState: 'active'
  targetActivationRevision: number
  accounts: readonly CommerceActiveCohortAccount[]
}) {
  const accounts = [...input.accounts].sort((left, right) => codePointOrder(
    left.accountGlobalId,
    right.accountGlobalId,
  ))
  const memberEvidence = accounts.map((account) => [
    account.accountId,
    account.accountGlobalId,
    account.provider,
    account.environment,
    account.externalAccountId,
    String(account.credentialGeneration),
    account.authMode,
    account.priorAccountStatus,
    account.targetAccountStatus,
    account.grantedScopeDigest,
    account.capabilityDigest,
  ].map(hashToken).join('')).join('')
  return createHash('sha256').update(
    [
      'commerce-active-cohort-v1',
      input.organizationId,
      input.expectedActivationState,
      String(input.expectedActivationRevision),
      input.targetActivationState,
      String(input.targetActivationRevision),
    ].map(hashToken).join('') + memberEvidence,
  ).digest('hex')
}

function normalizedGrantedScopes(value: unknown) {
  if (value === null || value === undefined) return []
  if (
    !Array.isArray(value)
    || value.length > 128
    || !value.every(
      (scope) => typeof scope === 'string' && SAFE_SCOPE.test(scope),
    )
  ) {
    fail(
      'COMMERCE_ACTIVE_SCOPE_EVIDENCE_INVALID',
      'Provider-reported granted scopes are invalid',
    )
  }
  return [...new Set(value)].sort()
}

function providerCapabilityScopes(
  provider: CommerceActiveProvider,
  capability: CommerceActiveWriteCapability,
): readonly string[] | null {
  const providerCapabilities =
    COMMERCE_ACTIVE_WRITE_CAPABILITY_SCOPES[provider] as Partial<
      Record<CommerceActiveWriteCapability, readonly string[]>
    >
  return providerCapabilities[capability] || null
}

function implementedProviderCapabilityScopes(
  provider: CommerceActiveProvider,
  capability: CommerceActiveWriteCapability,
) {
  const requiredScopes = providerCapabilityScopes(provider, capability)
  if (!requiredScopes) {
    fail(
      'COMMERCE_ACTIVE_CAPABILITY_UNSUPPORTED',
      `${provider} does not support the selected ${capability} write capability`,
    )
  }
  if (!isClawPilotCommerceCapabilityImplemented(provider, capability)) {
    fail(
      'COMMERCE_ACTIVE_CAPABILITY_NOT_IMPLEMENTED',
      `${provider} supports ${capability}, but ClawPilot has not implemented its provider-write effect`,
    )
  }
  return requiredScopes
}

function requireImplementedCohort(
  cohort: readonly CommerceActiveCohortAccount[],
) {
  for (const account of cohort) {
    for (const capability of account.writeCapabilities) {
      implementedProviderCapabilityScopes(account.provider, capability)
    }
  }
}

function requestsFaireFulfillmentWrite(
  account: Pick<CommerceActiveCohortAccount, 'provider' | 'writeCapabilities'>,
) {
  return account.provider === 'faire'
    && account.writeCapabilities.some(
      (capability) => FAIRE_FULFILLMENT_WRITE_CAPABILITIES.has(capability),
    )
}

export function isCommerceActiveWriteCapability(
  provider: CommerceActiveProvider,
  value: unknown,
): value is CommerceActiveWriteCapability {
  return typeof value === 'string'
    && providerCapabilityScopes(
      provider,
      value as CommerceActiveWriteCapability,
    ) !== null
}

function normalizeRequestedSelection(value: unknown) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 8) {
    fail(
      'COMMERCE_ACTIVE_COHORT_INVALID',
      'Select between one and eight commerce accounts',
      400,
    )
  }
  const selected = value.map((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      fail(
        'COMMERCE_ACTIVE_COHORT_INVALID',
        'Selected commerce account evidence is invalid',
        400,
      )
    }
    const source = raw as Record<string, unknown>
    const accountGlobalId = String(source.accountGlobalId || '').trim()
    if (!ACCOUNT_GLOBAL_ID.test(accountGlobalId)) {
      fail(
        'COMMERCE_ACTIVE_ACCOUNT_INVALID',
        'Selected commerce account is invalid',
        400,
      )
    }
    if (
      !Array.isArray(source.capabilities)
      || source.capabilities.length < 1
      || source.capabilities.length > 32
      || !source.capabilities.every(
        (capability) => (
          typeof capability === 'string'
          && /^[a-z][a-z0-9_]{0,127}$/.test(capability)
        ),
      )
    ) {
      fail(
        'COMMERCE_ACTIVE_CAPABILITIES_INVALID',
        `Select at least one valid write capability for ${accountGlobalId}`,
        400,
      )
    }
    return {
      accountGlobalId,
      capabilities: [...new Set(source.capabilities)].sort() as
        CommerceActiveWriteCapability[],
    }
  }).sort((left, right) => codePointOrder(
    left.accountGlobalId,
    right.accountGlobalId,
  ))
  if (
    new Set(selected.map((entry) => entry.accountGlobalId)).size
    !== selected.length
  ) {
    fail(
      'COMMERCE_ACTIVE_ACCOUNT_DUPLICATE',
      'A commerce account can appear only once in an Active cohort',
      400,
    )
  }
  return selected
}

async function requireActorRole(
  client: PoolClient,
  input: {
    organizationId: string
    actorEmail: string
    lock?: boolean
  },
): Promise<CommerceActiveActorRole> {
  const result = await client.query<{
    role: string
    status: string
  }>(
    `SELECT membership.role, membership.status
     FROM app_user_organization_memberships membership
     WHERE membership.organization_id = $1::uuid
       AND membership.user_email = $2
     ${input.lock ? 'FOR SHARE' : ''}`,
    [input.organizationId, input.actorEmail],
  )
  const membership = result.rows[0]
  if (
    membership?.status !== 'active'
    || !['owner', 'admin'].includes(membership.role)
  ) {
    fail(
      'COMMERCE_ACTIVE_AUTHORIZATION_REQUIRED',
      'Commerce Active transition requires an active owner or administrator',
      403,
    )
  }
  return membership.role as CommerceActiveActorRole
}

function preparation(row: PreparationRow, replayed: boolean):
CommerceActiveTransitionPreparation {
  return {
    preparationGlobalId: row.global_id,
    cohortHash: row.cohort_hash,
    expectedActivationState: row.expected_activation_state,
    expectedActivationRevision: Number(row.expected_activation_revision),
    targetActivationState: row.target_activation_state,
    targetActivationRevision: Number(row.target_activation_revision),
    accounts: row.cohort,
    preparedBy: row.prepared_by,
    preparedRole: row.prepared_role,
    preparedAt: iso(row.prepared_at),
    replayed,
  }
}

function authorization(row: AuthorizationRow, replayed: boolean):
CommerceActiveTransitionAuthorization {
  return {
    authorizationGlobalId: row.global_id,
    preparationGlobalId: String(row.preparation_global_id || ''),
    cohortHash: row.cohort_hash,
    confirmationStatementVersion: row.confirmation_statement_version,
    authorizedBy: row.authorized_by,
    authorizedRole: row.authorized_role,
    authorizedAt: iso(row.authorized_at),
    expiresAt: iso(row.expires_at),
    replayed,
  }
}

function transition(row: TransitionRow, replayed: boolean):
CommerceActiveTransition {
  return {
    transitionGlobalId: row.global_id,
    preparationGlobalId: String(row.preparation_global_id || ''),
    authorizationGlobalId: String(row.authorization_global_id || ''),
    cohortHash: row.cohort_hash,
    fromActivationState: row.from_activation_state,
    fromActivationRevision: Number(row.from_activation_revision),
    state: row.to_activation_state,
    revision: Number(row.to_activation_revision),
    accountCount: Number(row.account_count),
    capabilityCount: Number(row.capability_count),
    reason: row.reason,
    activatedBy: row.activated_by,
    activatedRole: row.activated_role,
    activatedAt: iso(row.activated_at),
    replayed,
  }
}

const PREPARATION_SELECT = `
  SELECT
    prepared.id::text,
    prepared.global_id,
    prepared.organization_id::text,
    prepared.cohort,
    prepared.cohort_hash,
    prepared.expected_activation_state,
    prepared.expected_activation_revision,
    prepared.target_activation_state,
    prepared.target_activation_revision,
    prepared.idempotency_key,
    prepared.request_hash,
    prepared.prepared_by,
    prepared.prepared_role,
    prepared.prepared_at
  FROM operations_commerce_active_transition_preparations prepared`

const AUTHORIZATION_SELECT = `
  SELECT
    authorized.id::text,
    authorized.global_id,
    authorized.organization_id::text,
    authorized.preparation_id::text,
    prepared.global_id AS preparation_global_id,
    authorized.cohort_hash,
    authorized.confirmation_statement_version,
    authorized.confirmation_hash,
    authorized.idempotency_key,
    authorized.request_hash,
    authorized.authorized_by,
    authorized.authorized_role,
    authorized.authorized_at,
    authorized.expires_at
  FROM operations_commerce_active_transition_authorizations authorized
  JOIN operations_commerce_active_transition_preparations prepared
    ON prepared.organization_id = authorized.organization_id
   AND prepared.id = authorized.preparation_id`

const TRANSITION_SELECT = `
  SELECT
    activated.id::text,
    activated.global_id,
    activated.organization_id::text,
    activated.preparation_id::text,
    prepared.global_id AS preparation_global_id,
    activated.authorization_id::text,
    authorized.global_id AS authorization_global_id,
    activated.cohort_hash,
    activated.from_activation_state,
    activated.from_activation_revision,
    activated.to_activation_state,
    activated.to_activation_revision,
    activated.account_count,
    activated.capability_count,
    activated.idempotency_key,
    activated.request_hash,
    activated.reason,
    activated.activated_by,
    activated.activated_role,
    activated.activated_at
  FROM operations_commerce_active_transitions activated
  JOIN operations_commerce_active_transition_preparations prepared
    ON prepared.organization_id = activated.organization_id
   AND prepared.id = activated.preparation_id
  JOIN operations_commerce_active_transition_authorizations authorized
    ON authorized.organization_id = activated.organization_id
   AND authorized.id = activated.authorization_id`

export async function prepareCommerceActiveTransitionInPostgres(
  input: PrepareCommerceActiveTransitionInput,
): Promise<PrepareCommerceActiveTransitionResult> {
  const scopedOrganizationId = organizationId(input.organizationId)
  const preparedBy = actorEmail(input.actorEmail)
  if (input.expectedActivationState !== 'shadow') {
    fail(
      'COMMERCE_ACTIVE_SHADOW_REQUIRED',
      'Commerce Active transition must be prepared from Shadow mode',
      400,
    )
  }
  const activationRevision = expectedRevision(
    input.expectedActivationRevision,
  )
  const selected = normalizeRequestedSelection(input.selectedAccounts)
  const key = idempotencyKey(input.idempotencyKey)
  const requestHash = commerceActiveTransitionEvidenceHash({
    schema: 'commerce-active-preparation-request-v1',
    organizationId: scopedOrganizationId,
    expectedActivationState: 'shadow',
    expectedActivationRevision: activationRevision,
    selectedAccounts: selected,
  })

  return withTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(
      client,
      `commerce-active-transition:${scopedOrganizationId}`,
    )
    const role = await requireActorRole(client, {
      organizationId: scopedOrganizationId,
      actorEmail: preparedBy,
      lock: true,
    })
    const activation = await client.query<{
      state: string
      revision: number
    }>(
      `SELECT activation.state, activation.revision
       FROM operations_activation_scopes activation
       WHERE activation.organization_id = $1::uuid
       FOR UPDATE`,
      [scopedOrganizationId],
    )
    if (
      activation.rows[0]?.state !== 'shadow'
      || Number(activation.rows[0]?.revision) !== activationRevision
    ) {
      fail(
        'COMMERCE_ACTIVE_ACTIVATION_DRIFT',
        'Operations activation changed after the Active workflow loaded',
      )
    }

    const accountRows = await client.query<AccountRow>(
      `SELECT
         account.id::text,
         account.global_id,
         account.provider,
         account.environment,
         account.external_account_id,
         account.status,
         account.configuration,
         account.commerce_credential_generation,
         credential.external_account_id AS credential_external_account_id,
         credential.credential_version,
         credential.auth_mode,
         credential.verification_status
       FROM operations_integration_accounts account
       JOIN operations_commerce_credentials credential
         ON credential.organization_id = account.organization_id
        AND credential.integration_account_id = account.id
       WHERE account.organization_id = $1::uuid
         AND account.global_id = ANY($2::text[])
         AND account.integration_type = 'commerce'
         AND account.provider IN ('shopify', 'faire')
       ORDER BY account.global_id
       FOR SHARE OF account, credential`,
      [
        scopedOrganizationId,
        selected.map((entry) => entry.accountGlobalId),
      ],
    )
    if (accountRows.rowCount !== selected.length) {
      fail(
        'COMMERCE_ACTIVE_ACCOUNT_NOT_FOUND',
        'Every selected Shopify or Faire account must belong to the active workspace',
        404,
      )
    }
    const selectedByGlobalId = new Map(
      selected.map((entry) => [entry.accountGlobalId, entry]),
    )
    const accounts = accountRows.rows.map((account) => {
      const requested = selectedByGlobalId.get(account.global_id)
      if (!requested) {
        fail(
          'COMMERCE_ACTIVE_TENANT_MISMATCH',
          'Selected commerce account crossed the active workspace boundary',
          403,
        )
      }
      if (
        !['sandbox', 'production'].includes(account.environment)
        || !['active', 'disabled'].includes(account.status)
        || !account.external_account_id
        || account.external_account_id
          !== account.credential_external_account_id
        || !account.auth_mode
        || account.verification_status !== 'verified'
        || !Number.isSafeInteger(account.commerce_credential_generation)
        || account.commerce_credential_generation < 1
        || account.commerce_credential_generation
          !== Number(account.credential_version)
      ) {
        fail(
          'COMMERCE_ACTIVE_ACCOUNT_NOT_VERIFIED',
          `${account.global_id} must retain one exact verified credential and provider identity`,
        )
      }
      const grantedScopes = normalizedGrantedScopes(
        account.configuration?.grantedScopes,
      )
      for (const capability of requested.capabilities) {
        const requiredScopes = implementedProviderCapabilityScopes(
          account.provider,
          capability,
        )
        const missing = requiredScopes.filter(
          (scope) => !grantedScopes.includes(scope),
        )
        if (missing.length) {
          fail(
            'COMMERCE_ACTIVE_SCOPE_MISSING',
            `${account.global_id} is missing provider-reported scope${missing.length === 1 ? '' : 's'} ${missing.join(', ')} for ${capability}`,
          )
        }
      }
      return {
        accountId: account.id,
        accountGlobalId: account.global_id,
        provider: account.provider,
        environment: account.environment as 'sandbox' | 'production',
        externalAccountId: account.external_account_id,
        credentialGeneration: account.commerce_credential_generation,
        authMode: account.auth_mode,
        priorAccountStatus: account.status as 'active' | 'disabled',
        targetAccountStatus: 'active' as const,
        grantedScopes,
        grantedScopeDigest: commerceActiveGrantedScopeDigest(grantedScopes),
        writeCapabilities: requested.capabilities,
        capabilityDigest: commerceActiveCapabilityDigest(
          requested.capabilities,
        ),
      }
    }).sort((left, right) => codePointOrder(
      left.accountGlobalId,
      right.accountGlobalId,
    ))
    for (const account of accounts.filter(requestsFaireFulfillmentWrite)) {
      const scopeEvidence = await client.query<{ current: boolean }>(
        `SELECT operations_faire_fulfillment_scope_evidence_is_current(
           $1::uuid, $2::uuid, $3
         ) AS current`,
        [
          scopedOrganizationId,
          account.accountId,
          account.credentialGeneration,
        ],
      )
      if (scopeEvidence.rows[0]?.current !== true) {
        fail(
          'COMMERCE_ACTIVE_FAIRE_SCOPE_EVIDENCE_REQUIRED',
          'Faire fulfillment requires provider-verifiable OAuth grant evidence for READ_BRAND, READ_ORDERS, READ_SHIPMENTS, and WRITE_ORDERS; requested scopes do not qualify',
          403,
        )
      }
    }
    const cohortHash = commerceActiveCohortHash({
      organizationId: scopedOrganizationId,
      expectedActivationState: 'shadow',
      expectedActivationRevision: activationRevision,
      targetActivationState: 'active',
      targetActivationRevision: activationRevision + 1,
      accounts,
    })
    const databasePreflight = await client.query<{
      cohort_valid: boolean
      cohort_hash: string
      matches_current: boolean
    }>(
      `SELECT
         operations_commerce_active_cohort_json_valid($2::jsonb) AS cohort_valid,
         operations_commerce_active_cohort_hash(
           $1::uuid, 'shadow', $3, 'active', $4, $2::jsonb
         ) AS cohort_hash,
         operations_commerce_active_cohort_matches_current(
           $1::uuid, $2::jsonb, 'shadow', $3, 'priorAccountStatus'
         ) AS matches_current`,
      [
        scopedOrganizationId,
        JSON.stringify(accounts),
        activationRevision,
        activationRevision + 1,
      ],
    )
    const databaseEvidence = databasePreflight.rows[0]
    if (!databaseEvidence?.cohort_valid) {
      fail(
        'COMMERCE_ACTIVE_COHORT_SCHEMA_MISMATCH',
        'The exact provider-write cohort does not satisfy the database evidence schema',
      )
    }
    if (databaseEvidence.cohort_hash !== cohortHash) {
      fail(
        'COMMERCE_ACTIVE_COHORT_HASH_MISMATCH',
        'The application and database disagree on the exact provider-write cohort hash',
      )
    }
    if (!databaseEvidence.matches_current) {
      fail(
        'COMMERCE_ACTIVE_ACCOUNT_EVIDENCE_DRIFT',
        'The selected commerce account or credential evidence changed during Active review preparation',
      )
    }
    const inserted = await client.query<PreparationRow>(
      `INSERT INTO
         operations_commerce_active_transition_preparations (
           organization_id,
           cohort,
           cohort_hash,
           expected_activation_state,
           expected_activation_revision,
           target_activation_state,
           target_activation_revision,
           idempotency_key,
           request_hash,
           prepared_by,
           prepared_role
         ) VALUES (
           $1::uuid,
           $2::jsonb,
           $3,
           'shadow',
           $4,
           'active',
           $5,
           $6,
           $7,
           $8,
           $9
         )
         ON CONFLICT (organization_id, idempotency_key) DO NOTHING
         RETURNING *`,
      [
        scopedOrganizationId,
        JSON.stringify(accounts),
        cohortHash,
        activationRevision,
        activationRevision + 1,
        key,
        requestHash,
        preparedBy,
        role,
      ],
    )
    let row = inserted.rows[0]
    const replayed = !row
    if (!row) {
      row = (
        await client.query<PreparationRow>(
          `${PREPARATION_SELECT}
           WHERE prepared.organization_id = $1::uuid
             AND prepared.idempotency_key = $2
           LIMIT 1`,
          [scopedOrganizationId, key],
        )
      ).rows[0]
      if (
        !row
        || row.request_hash !== requestHash
        || row.cohort_hash !== cohortHash
        || row.prepared_by !== preparedBy
        || row.prepared_role !== role
      ) {
        fail(
          'COMMERCE_ACTIVE_PREPARATION_IDEMPOTENCY_CONFLICT',
          'Preparation idempotency key was used for a different Active cohort',
        )
      }
    }
    if (!replayed) {
      await recordAuditEvent({
        actor: preparedBy,
        eventType: 'operations.commerce.active_transition.prepared',
        aggregateType:
          'operations.commerce_active_transition_preparation',
        aggregateId: row.global_id,
        subject: cohortHash,
        organizationId: scopedOrganizationId,
        eventKey: `operations:commerce-active-preparation:${row.global_id}`,
        payload: {
          cohortHash,
          accountGlobalIds: accounts.map(
            (account) => account.accountGlobalId,
          ),
          capabilityCount: accounts.reduce(
            (total, account) => total + account.writeCapabilities.length,
            0,
          ),
          providerWrites: 0,
          credentialDecryptions: 0,
          providerRequests: 0,
          expectedActivationState: 'shadow',
          expectedActivationRevision: activationRevision,
        },
      }, client)
    }
    return preparation(row, replayed)
  })
}

export async function authorizeCommerceActiveTransitionInPostgres(
  input: AuthorizeCommerceActiveTransitionInput,
): Promise<AuthorizeCommerceActiveTransitionResult> {
  const scopedOrganizationId = organizationId(input.organizationId)
  const authorizedBy = actorEmail(input.actorEmail)
  const preparationGlobalId = String(
    input.preparationGlobalId || '',
  ).trim()
  if (!PREPARATION_GLOBAL_ID.test(preparationGlobalId)) {
    fail(
      'COMMERCE_ACTIVE_PREPARATION_INVALID',
      'Commerce Active preparation is invalid',
      400,
    )
  }
  const cohortHash = exactHash(
    input.expectedCohortHash,
    'Expected Active cohort hash',
  )
  const key = idempotencyKey(input.idempotencyKey)

  return withTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(
      client,
      `commerce-active-transition:${scopedOrganizationId}`,
    )
    const role = await requireActorRole(client, {
      organizationId: scopedOrganizationId,
      actorEmail: authorizedBy,
      lock: true,
    })
    const prepared = (
      await client.query<PreparationRow>(
        `${PREPARATION_SELECT}
         WHERE prepared.organization_id = $1::uuid
           AND prepared.global_id = $2
         LIMIT 1
         FOR SHARE OF prepared`,
        [scopedOrganizationId, preparationGlobalId],
      )
    ).rows[0]
    if (!prepared) {
      fail(
        'COMMERCE_ACTIVE_PREPARATION_NOT_FOUND',
        'Commerce Active preparation was not found in the active workspace',
        404,
      )
    }
    if (prepared.cohort_hash !== cohortHash) {
      fail(
        'COMMERCE_ACTIVE_COHORT_DRIFT',
        'Commerce Active cohort changed after it was reviewed',
      )
    }
    requireImplementedCohort(prepared.cohort)
    const confirmationHash = createHash('sha256').update(
      [
        COMMERCE_ACTIVE_CONFIRMATION_STATEMENT_VERSION,
        cohortHash,
        authorizedBy,
        role,
      ].map(hashToken).join(''),
    ).digest('hex')
    const requestHash = commerceActiveTransitionEvidenceHash({
      schema: 'commerce-active-authorization-request-v1',
      organizationId: scopedOrganizationId,
      preparationGlobalId,
      cohortHash,
      confirmationStatementVersion:
        COMMERCE_ACTIVE_CONFIRMATION_STATEMENT_VERSION,
      authorizedBy,
      authorizedRole: role,
    })
    const existing = (
      await client.query<AuthorizationRow>(
        `${AUTHORIZATION_SELECT}
         WHERE authorized.organization_id = $1::uuid
           AND authorized.idempotency_key = $2
         LIMIT 1`,
        [scopedOrganizationId, key],
      )
    ).rows[0]
    if (existing) {
      if (
        existing.request_hash !== requestHash
        || existing.preparation_id !== prepared.id
        || existing.cohort_hash !== cohortHash
        || existing.confirmation_hash !== confirmationHash
        || existing.authorized_by !== authorizedBy
        || existing.authorized_role !== role
      ) {
        fail(
          'COMMERCE_ACTIVE_AUTHORIZATION_IDEMPOTENCY_CONFLICT',
          'Authorization idempotency key was used for a different Active cohort',
        )
      }
      return authorization(existing, true)
    }
    const inserted = await client.query<AuthorizationRow>(
      `INSERT INTO
         operations_commerce_active_transition_authorizations (
           organization_id,
           preparation_id,
           cohort_hash,
           confirmation_statement_version,
           confirmation_hash,
           idempotency_key,
           request_hash,
           authorized_by,
           authorized_role,
           expires_at
         ) VALUES (
           $1::uuid,
           $2::uuid,
           $3,
           $4,
           $5,
           $6,
           $7,
           $8,
           $9,
           now() + interval '5 minutes'
         )
         ON CONFLICT (organization_id, idempotency_key) DO NOTHING
         RETURNING *`,
      [
        scopedOrganizationId,
        prepared.id,
        cohortHash,
        COMMERCE_ACTIVE_CONFIRMATION_STATEMENT_VERSION,
        confirmationHash,
        key,
        requestHash,
        authorizedBy,
        role,
      ],
    )
    let row = inserted.rows[0]
    const replayed = !row
    if (!row) {
      row = (
        await client.query<AuthorizationRow>(
          `${AUTHORIZATION_SELECT}
           WHERE authorized.organization_id = $1::uuid
             AND authorized.idempotency_key = $2
           LIMIT 1`,
          [scopedOrganizationId, key],
        )
      ).rows[0]
      if (
        !row
        || row.request_hash !== requestHash
        || row.preparation_id !== prepared.id
        || row.cohort_hash !== cohortHash
        || row.confirmation_hash !== confirmationHash
        || row.authorized_by !== authorizedBy
        || row.authorized_role !== role
      ) {
        fail(
          'COMMERCE_ACTIVE_AUTHORIZATION_IDEMPOTENCY_CONFLICT',
          'Authorization idempotency key was used for a different Active cohort',
        )
      }
    } else {
      row.preparation_global_id = preparationGlobalId
    }
    if (!replayed) {
      await recordAuditEvent({
        actor: authorizedBy,
        eventType: 'operations.commerce.active_transition.authorized',
        aggregateType:
          'operations.commerce_active_transition_authorization',
        aggregateId: row.global_id,
        subject: cohortHash,
        organizationId: scopedOrganizationId,
        eventKey: `operations:commerce-active-authorization:${row.global_id}`,
        payload: {
          preparationGlobalId,
          cohortHash,
          confirmationStatementVersion:
            COMMERCE_ACTIVE_CONFIRMATION_STATEMENT_VERSION,
          expectedActivationState: 'shadow',
          expectedActivationRevision:
            prepared.expected_activation_revision,
          targetActivationState: 'active',
          targetActivationRevision: prepared.target_activation_revision,
        },
      }, client)
    }
    return authorization(row, replayed)
  })
}

type RegisteredShopifyCarrierServiceRebinding = {
  id: string
  globalId: string
  accountId: string
  accountGlobalId: string
  serviceGid: string
  credentialGeneration: number
  activationRevision: number
  callbackTokenVersion: number
  rowVersion: number
}

const SHOPIFY_CARRIER_SERVICE_GID =
  /^gid:\/\/shopify\/DeliveryCarrierService\/[0-9]+$/

/**
 * Freeze every existing Shopify CarrierService configuration before the
 * global activation revision changes. The three advisory-lock domains match
 * the ordinary config, provider-authorization/name, and provider-finalization
 * writers. New config creation is separately serialized by the global
 * commerce-active advisory lock in shopifyCheckoutRating.ts.
 */
async function lockShopifyCarrierServiceConfigurationWriters(
  client: PoolClient,
  organizationId: string,
) {
  const identities = await client.query<{
    id: string
    account_global_id: string
  }>(
    `SELECT config.id::text, account.global_id AS account_global_id
     FROM operations_shopify_carrier_service_configs config
     JOIN operations_integration_accounts account
       ON account.organization_id = config.organization_id
      AND account.id = config.integration_account_id
     WHERE config.organization_id = $1::uuid
     ORDER BY config.global_id`,
    [organizationId],
  )
  for (const identity of identities.rows) {
    await acquireTransactionAdvisoryLock(
      client,
      `shopify-carrier-service-authorization:${organizationId}:${identity.id}`,
    )
    await acquireTransactionAdvisoryLock(
      client,
      `shopify-carrier-service-config:${organizationId}:${identity.account_global_id}`,
    )
    await acquireTransactionAdvisoryLock(
      client,
      `shopify-carrier-service-config-mutation:${organizationId}:${identity.account_global_id}`,
    )
  }
}

async function registeredShopifyCarrierServiceRebindings(
  client: PoolClient,
  input: {
    organizationId: string
    cohort: readonly CommerceActiveCohortAccount[]
    expectedActivationRevision: number
  },
): Promise<RegisteredShopifyCarrierServiceRebinding[]> {
  const rows = await client.query<{
    id: string
    global_id: string
    integration_account_id: string
    account_global_id: string
    service_gid: string | null
    credential_generation: number
    activation_revision: number
    callback_token_version: number
    row_version: string
    unsafe_authorization_exists: boolean
    production_callback_ready: boolean
  }>(
    `SELECT
       config.id::text,
       config.global_id,
       config.integration_account_id::text,
       account.global_id AS account_global_id,
       config.service_gid,
       config.credential_generation,
       config.activation_revision,
       config.callback_token_version,
       config.row_version::text,
       EXISTS (
         SELECT 1
         FROM operations_shopify_carrier_service_mutation_authorizations
           authorized_mutation
         LEFT JOIN operations_shopify_carrier_service_mutation_attempts attempt
           ON attempt.organization_id = authorized_mutation.organization_id
          AND attempt.authorization_id = authorized_mutation.id
         LEFT JOIN operations_shopify_carrier_service_mutation_outcomes outcome
           ON outcome.organization_id = attempt.organization_id
          AND outcome.attempt_id = attempt.id
         LEFT JOIN operations_shopify_carrier_service_mutation_resolutions
           resolution
           ON resolution.organization_id = attempt.organization_id
          AND resolution.attempt_id = attempt.id
         WHERE authorized_mutation.organization_id = config.organization_id
           AND authorized_mutation.config_id = config.id
           AND authorized_mutation.config_row_version = config.row_version
           AND (
             (
               outcome.outcome = 'failed'
               AND outcome.provider_write_count = 0
             )
             OR resolution.disposition = 'confirmed_not_applied'
             OR (
               attempt.id IS NULL
               AND authorized_mutation.expires_at <= now()
             )
           ) IS NOT TRUE
       ) AS unsafe_authorization_exists,
       operations_shopify_carrier_service_config_environment_is_ready(
         config.organization_id,
         config.id,
         'production'
       ) AS production_callback_ready
     FROM operations_shopify_carrier_service_configs config
     JOIN operations_integration_accounts account
       ON account.organization_id = config.organization_id
      AND account.id = config.integration_account_id
     WHERE config.organization_id = $1::uuid
       AND config.registration_state = 'registered'
     ORDER BY config.global_id
     FOR UPDATE OF config`,
    [input.organizationId],
  )
  const callbackClaims = input.cohort.filter(
    (account) => (
      account.provider === 'shopify'
      && account.writeCapabilities.includes('shipping_rate_callbacks')
    ),
  )
  const callbackClaimByAccountId = new Map(
    callbackClaims.map((account) => [account.accountId, account]),
  )
  const matchedCallbackAccountIds = new Set<string>()
  const rebindings = rows.rows.map((row) => {
    const account = callbackClaimByAccountId.get(
      row.integration_account_id,
    )
    if (
      !account
      || account.accountGlobalId !== row.account_global_id
      || account.credentialGeneration !== row.credential_generation
      || matchedCallbackAccountIds.has(row.integration_account_id)
    ) {
      fail(
        'COMMERCE_ACTIVE_SHOPIFY_CALLBACK_AUTHORITY_MISSING',
        'Every registered Shopify CarrierService must be included with shipping-rate callback authority before Operations becomes Active',
      )
    }
    matchedCallbackAccountIds.add(row.integration_account_id)
    if (
      row.activation_revision !== input.expectedActivationRevision
      || !row.service_gid
      || !SHOPIFY_CARRIER_SERVICE_GID.test(row.service_gid)
      || row.production_callback_ready !== true
    ) {
      fail(
        'COMMERCE_ACTIVE_SHOPIFY_CALLBACK_CONFIG_STALE',
        'A registered Shopify CarrierService does not have an exact ready LIVE carrier-account set at the Shadow activation revision',
      )
    }
    if (row.unsafe_authorization_exists) {
      fail(
        'COMMERCE_ACTIVE_SHOPIFY_CALLBACK_MUTATION_UNRESOLVED',
        'Resolve the current Shopify CarrierService provider mutation before Operations becomes Active',
      )
    }
    return {
      id: row.id,
      globalId: row.global_id,
      accountId: row.integration_account_id,
      accountGlobalId: row.account_global_id,
      serviceGid: row.service_gid,
      credentialGeneration: row.credential_generation,
      activationRevision: row.activation_revision,
      callbackTokenVersion: row.callback_token_version,
      rowVersion: Number(row.row_version),
    }
  })
  if (
    callbackClaims.some(
      (account) => !matchedCallbackAccountIds.has(account.accountId),
    )
  ) {
    fail(
      'COMMERCE_ACTIVE_SHOPIFY_CALLBACK_CONFIG_MISSING',
      'Every Shopify shipping-rate callback claim requires exactly one registered CarrierService before Operations becomes Active',
    )
  }
  return rebindings
}

async function applyRegisteredShopifyCarrierServiceRebindings(
  client: PoolClient,
  input: {
    organizationId: string
    actorEmail: string
    targetActivationRevision: number
    rebindings: readonly RegisteredShopifyCarrierServiceRebinding[]
  },
) {
  const applied: Array<RegisteredShopifyCarrierServiceRebinding & {
    priorRowVersion: number
  }> = []
  for (const rebinding of input.rebindings) {
    const updated = await client.query<{
      activation_revision: number
      row_version: string
    }>(
      `UPDATE operations_shopify_carrier_service_configs
       SET activation_revision = $3,
           row_version = row_version + 1,
           updated_by = $4,
           updated_at = now()
       WHERE organization_id = $1::uuid
         AND id = $2::uuid
         AND registration_state = 'registered'
         AND service_gid = $5
         AND credential_generation = $6
         AND activation_revision = $7
         AND callback_token_version = $8
         AND row_version = $9::bigint
       RETURNING
         activation_revision,
         row_version::text`,
      [
        input.organizationId,
        rebinding.id,
        input.targetActivationRevision,
        input.actorEmail,
        rebinding.serviceGid,
        rebinding.credentialGeneration,
        rebinding.activationRevision,
        rebinding.callbackTokenVersion,
        rebinding.rowVersion,
      ],
    )
    // The readiness function is STABLE and reads this table. PostgreSQL can
    // evaluate it from the UPDATE command's pre-update snapshot when it is
    // included in RETURNING, which falsely reports drift after a valid rebind.
    // A separate command advances the command counter and observes the exact
    // row written above while the surrounding transaction remains locked.
    const readiness = await client.query<{ callback_ready: boolean }>(
      `SELECT operations_shopify_carrier_service_config_is_ready(
         $1::uuid,
         $2::uuid
       ) AS callback_ready`,
      [input.organizationId, rebinding.id],
    )
    if (
      Number(updated.rows[0]?.activation_revision)
        !== input.targetActivationRevision
      || Number(updated.rows[0]?.row_version) !== rebinding.rowVersion + 1
      || readiness.rows[0]?.callback_ready !== true
    ) {
      fail(
        'COMMERCE_ACTIVE_SHOPIFY_CALLBACK_CONFIG_DRIFT',
        'A registered Shopify CarrierService changed during Active transition',
      )
    }
    applied.push({
      ...rebinding,
      priorRowVersion: rebinding.rowVersion,
      activationRevision: input.targetActivationRevision,
      rowVersion: rebinding.rowVersion + 1,
    })
  }
  return applied
}

export async function consumeCommerceActiveTransitionAuthorizationInPostgres(
  input: ConsumeCommerceActiveTransitionInput,
): Promise<ConsumeCommerceActiveTransitionResult> {
  const scopedOrganizationId = organizationId(input.organizationId)
  const activatedBy = actorEmail(input.actorEmail)
  const authorizationGlobalId = String(
    input.authorizationGlobalId || '',
  ).trim()
  if (!AUTHORIZATION_GLOBAL_ID.test(authorizationGlobalId)) {
    fail(
      'COMMERCE_ACTIVE_AUTHORIZATION_INVALID',
      'Commerce Active authorization is invalid',
      400,
    )
  }
  const cohortHash = exactHash(
    input.expectedCohortHash,
    'Expected Active cohort hash',
  )
  const key = idempotencyKey(input.idempotencyKey)
  const reason = input.reason === undefined || input.reason === null
    ? null
    : String(input.reason).trim()
  if (
    reason !== null
    && (
      reason.length < 1
      || reason.length > 500
      || /[\u0000-\u001f\u007f]/.test(reason)
    )
  ) {
    fail(
      'COMMERCE_ACTIVE_REASON_INVALID',
      'Commerce Active transition reason is invalid',
      400,
    )
  }
  const requestHash = commerceActiveTransitionEvidenceHash({
    schema: 'commerce-active-consumption-request-v1',
    organizationId: scopedOrganizationId,
    authorizationGlobalId,
    cohortHash,
    activatedBy,
    reason,
  })

  return withTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(
      client,
      `commerce-active-transition:${scopedOrganizationId}`,
    )
    const existing = (
      await client.query<TransitionRow>(
        `${TRANSITION_SELECT}
         WHERE activated.organization_id = $1::uuid
           AND (
             authorized.global_id = $2
             OR activated.idempotency_key = $3
           )
         ORDER BY activated.activated_at DESC
         LIMIT 1`,
        [scopedOrganizationId, authorizationGlobalId, key],
      )
    ).rows[0]
    if (existing) {
      if (
        existing.authorization_global_id !== authorizationGlobalId
        || existing.idempotency_key !== key
        || existing.request_hash !== requestHash
        || existing.cohort_hash !== cohortHash
        || existing.activated_by !== activatedBy
        || existing.reason !== reason
      ) {
        fail(
          'COMMERCE_ACTIVE_CONSUMPTION_IDEMPOTENCY_CONFLICT',
          'Active transition authorization or idempotency key was already consumed differently',
        )
      }
      return transition(existing, true)
    }

    const authorized = (
      await client.query<AuthorizationRow & {
        cohort: CommerceActiveCohortAccount[]
        expected_activation_state: 'shadow'
        expected_activation_revision: number
        target_activation_state: 'active'
        target_activation_revision: number
        authorization_current: boolean
      }>(
        `SELECT
           authorized.id::text,
           authorized.global_id,
           authorized.organization_id::text,
           authorized.preparation_id::text,
           prepared.global_id AS preparation_global_id,
           authorized.cohort_hash,
           authorized.confirmation_statement_version,
           authorized.confirmation_hash,
           authorized.idempotency_key,
           authorized.request_hash,
           authorized.authorized_by,
           authorized.authorized_role,
           authorized.authorized_at,
           authorized.expires_at,
           prepared.cohort,
           prepared.expected_activation_state,
           prepared.expected_activation_revision,
           prepared.target_activation_state,
           prepared.target_activation_revision,
           (authorized.expires_at > now()) AS authorization_current
         FROM operations_commerce_active_transition_authorizations authorized
         JOIN operations_commerce_active_transition_preparations prepared
           ON prepared.organization_id = authorized.organization_id
          AND prepared.id = authorized.preparation_id
         WHERE authorized.organization_id = $1::uuid
           AND authorized.global_id = $2
         LIMIT 1
         FOR SHARE OF authorized, prepared`,
        [scopedOrganizationId, authorizationGlobalId],
      )
    ).rows[0]
    if (!authorized) {
      fail(
        'COMMERCE_ACTIVE_AUTHORIZATION_NOT_FOUND',
        'Commerce Active authorization was not found in the active workspace',
        404,
      )
    }
    if (
      authorized.cohort_hash !== cohortHash
      || authorized.authorized_by !== activatedBy
    ) {
      fail(
        'COMMERCE_ACTIVE_AUTHORIZATION_MISMATCH',
        'Commerce Active authorization does not match this actor or cohort',
        403,
      )
    }
    if (!authorized.authorization_current) {
      fail(
        'COMMERCE_ACTIVE_AUTHORIZATION_EXPIRED',
        'Commerce Active authorization expired before it was consumed',
      )
    }
    requireImplementedCohort(authorized.cohort)
    const role = await requireActorRole(client, {
      organizationId: scopedOrganizationId,
      actorEmail: activatedBy,
      lock: true,
    })
    if (role !== authorized.authorized_role) {
      fail(
        'COMMERCE_ACTIVE_AUTHORIZATION_DRIFT',
        'Authorizing workspace role changed before activation',
      )
    }
    await lockShopifyCarrierServiceConfigurationWriters(
      client,
      scopedOrganizationId,
    )
    const accountIds = authorized.cohort.map(
      (account) => account.accountId,
    )
    const lockedAccounts = await client.query(
      `SELECT account.id
       FROM operations_integration_accounts account
       JOIN operations_commerce_credentials credential
         ON credential.organization_id = account.organization_id
        AND credential.integration_account_id = account.id
       WHERE account.organization_id = $1::uuid
         AND account.id = ANY($2::uuid[])
       ORDER BY account.id
       FOR UPDATE OF account, credential`,
      [scopedOrganizationId, accountIds],
    )
    if (lockedAccounts.rowCount !== accountIds.length) {
      fail(
        'COMMERCE_ACTIVE_ACCOUNT_DRIFT',
        'A selected commerce account or credential no longer exists',
      )
    }
    const activation = await client.query<{
      state: string
      revision: number
    }>(
      `SELECT activation.state, activation.revision
       FROM operations_activation_scopes activation
       WHERE activation.organization_id = $1::uuid
       FOR UPDATE`,
      [scopedOrganizationId],
    )
    if (
      activation.rows[0]?.state
        !== authorized.expected_activation_state
      || Number(activation.rows[0]?.revision)
        !== Number(authorized.expected_activation_revision)
    ) {
      fail(
        'COMMERCE_ACTIVE_ACTIVATION_DRIFT',
        'Operations activation changed before authorization consumption',
      )
    }
    const current = await client.query<{ current: boolean }>(
      `SELECT operations_commerce_active_preparation_is_current(
         $1::uuid,
         $2::uuid,
         'shadow'
       ) AS current`,
      [scopedOrganizationId, authorized.preparation_id],
    )
    if (current.rows[0]?.current !== true) {
      fail(
        'COMMERCE_ACTIVE_COHORT_DRIFT',
        'Commerce account identity, credential, scopes, or capabilities changed before activation',
      )
    }
    const carrierServiceRebindings =
      await registeredShopifyCarrierServiceRebindings(client, {
        organizationId: scopedOrganizationId,
        cohort: authorized.cohort,
        expectedActivationRevision:
          authorized.expected_activation_revision,
      })

    const accountUpdate = await client.query(
      `UPDATE operations_integration_accounts account
       SET status = 'active',
           updated_by = $3,
           updated_at = CASE
             WHEN account.status = 'active' THEN account.updated_at
             ELSE now()
           END
       FROM jsonb_array_elements($2::jsonb) AS cohort(member)
       WHERE account.organization_id = $1::uuid
         AND account.id = (cohort.member->>'accountId')::uuid
         AND account.global_id = cohort.member->>'accountGlobalId'
         AND account.status = cohort.member->>'priorAccountStatus'
         AND account.commerce_credential_generation =
           (cohort.member->>'credentialGeneration')::integer
       RETURNING account.id`,
      [
        scopedOrganizationId,
        JSON.stringify(authorized.cohort),
        activatedBy,
      ],
    )
    if (accountUpdate.rowCount !== authorized.cohort.length) {
      fail(
        'COMMERCE_ACTIVE_ACCOUNT_DRIFT',
        'Selected commerce accounts changed during activation',
      )
    }
    const transitionReason = reason
      || `Authorized commerce provider-write cohort ${cohortHash.slice(0, 12)}`
    const activationUpdate = await client.query<{
      state: 'active'
      revision: number
    }>(
      `UPDATE operations_activation_scopes
       SET state = 'active',
           revision = revision + 1,
           reason = $4,
           updated_by = $5,
           updated_at = now()
       WHERE organization_id = $1::uuid
         AND state = $2
         AND revision = $3
       RETURNING state, revision`,
      [
        scopedOrganizationId,
        authorized.expected_activation_state,
        authorized.expected_activation_revision,
        transitionReason,
        activatedBy,
      ],
    )
    if (
      activationUpdate.rows[0]?.state !== 'active'
      || Number(activationUpdate.rows[0]?.revision)
        !== Number(authorized.target_activation_revision)
    ) {
      fail(
        'COMMERCE_ACTIVE_ACTIVATION_DRIFT',
        'Operations Shadow state changed during activation',
      )
    }
    const reboundCarrierServices =
      await applyRegisteredShopifyCarrierServiceRebindings(client, {
        organizationId: scopedOrganizationId,
        actorEmail: activatedBy,
        targetActivationRevision:
          authorized.target_activation_revision,
        rebindings: carrierServiceRebindings,
      })
    const capabilityCount = authorized.cohort.reduce(
      (total, account) => total + account.writeCapabilities.length,
      0,
    )
    const inserted = await client.query<TransitionRow>(
      `INSERT INTO operations_commerce_active_transitions (
         organization_id,
         preparation_id,
         authorization_id,
         cohort_hash,
         from_activation_state,
         from_activation_revision,
         to_activation_state,
         to_activation_revision,
         account_count,
         capability_count,
         idempotency_key,
         request_hash,
         reason,
         activated_by,
         activated_role
       ) VALUES (
         $1::uuid,
         $2::uuid,
         $3::uuid,
         $4,
         $5,
         $6,
         $7,
         $8,
         $9,
         $10,
         $11,
         $12,
         $13,
         $14,
         $15
       )
       RETURNING *`,
      [
        scopedOrganizationId,
        authorized.preparation_id,
        authorized.id,
        cohortHash,
        authorized.expected_activation_state,
        authorized.expected_activation_revision,
        authorized.target_activation_state,
        authorized.target_activation_revision,
        authorized.cohort.length,
        capabilityCount,
        key,
        requestHash,
        reason,
        activatedBy,
        role,
      ],
    )
    const row = inserted.rows[0]
    row.preparation_global_id = authorized.preparation_global_id
    row.authorization_global_id = authorizationGlobalId
    await recordAuditEvent({
      actor: activatedBy,
      eventType: 'operations.commerce.active_transition.consumed',
      aggregateType: 'operations.commerce_active_transition',
      aggregateId: row.global_id,
      subject: cohortHash,
      organizationId: scopedOrganizationId,
      eventKey: `operations:commerce-active-transition:${row.global_id}`,
      payload: {
        preparationGlobalId: authorized.preparation_global_id,
        authorizationGlobalId,
        cohortHash,
        fromActivationState: authorized.expected_activation_state,
        fromActivationRevision: authorized.expected_activation_revision,
        state: authorized.target_activation_state,
        revision: authorized.target_activation_revision,
        accountGlobalIds: authorized.cohort.map(
          (account) => account.accountGlobalId,
        ),
        capabilityCount,
        carrierServiceRebindings: reboundCarrierServices.map(
          (rebound) => ({
            configGlobalId: rebound.globalId,
            accountGlobalId: rebound.accountGlobalId,
            serviceGid: rebound.serviceGid,
            fromActivationRevision:
              authorized.expected_activation_revision,
            activationRevision: rebound.activationRevision,
            fromRowVersion: rebound.priorRowVersion,
            rowVersion: rebound.rowVersion,
            callbackTokenVersionRetained:
              rebound.callbackTokenVersion,
            providerWrites: 0,
            callbackTokenRotations: 0,
          }),
        ),
      },
    }, client)
    for (const rebound of reboundCarrierServices) {
      await recordAuditEvent({
        actor: activatedBy,
        eventType:
          'operations.shopify_carrier_service.activation_revision_rebound',
        aggregateType: 'operations.shopify_carrier_service_config',
        aggregateId: rebound.globalId,
        subject: rebound.accountGlobalId,
        organizationId: scopedOrganizationId,
        eventKey:
          `operations:shopify-carrier-service:${rebound.globalId}:`
          + `active-revision:${rebound.activationRevision}`,
        payload: {
          transitionGlobalId: row.global_id,
          authorizationGlobalId,
          accountGlobalId: rebound.accountGlobalId,
          serviceGid: rebound.serviceGid,
          fromActivationRevision:
            authorized.expected_activation_revision,
          activationRevision: rebound.activationRevision,
          fromRowVersion: rebound.priorRowVersion,
          rowVersion: rebound.rowVersion,
          callbackTokenVersionRetained: rebound.callbackTokenVersion,
          providerWrites: 0,
          callbackTokenRotations: 0,
        },
      }, client)
    }
    return transition(row, false)
  })
}

export async function readCommerceActiveContinuationInPostgres(input: {
  organizationId: unknown
}): Promise<CommerceActiveContinuation | null> {
  const scopedOrganizationId = organizationId(input.organizationId)
  const result = await query<{
    source_transition_global_id: string
    source_activation_revision: number
    shadow_activation_revision: number
    cohort: unknown
  }>(
    `SELECT
       activated.global_id AS source_transition_global_id,
       activated.to_activation_revision AS source_activation_revision,
       activation.revision AS shadow_activation_revision,
       prepared.cohort
     FROM operations_activation_scopes activation
     JOIN operations_commerce_active_transitions activated
       ON activated.organization_id = activation.organization_id
      AND activated.to_activation_state = 'active'
      AND activated.to_activation_revision = activation.revision - 1
     JOIN operations_commerce_active_transition_preparations prepared
       ON prepared.organization_id = activated.organization_id
      AND prepared.id = activated.preparation_id
     WHERE activation.organization_id = $1::uuid
       AND activation.state = 'shadow'
       AND activated.from_activation_state = 'shadow'
     ORDER BY activated.activated_at DESC, activated.id DESC
     LIMIT 1`,
    [scopedOrganizationId],
  )
  const row = result.rows[0]
  if (!row) return null
  const sourceActivationRevision = Number(row.source_activation_revision)
  const shadowActivationRevision = Number(row.shadow_activation_revision)
  if (
    !row.source_transition_global_id
    || !Number.isSafeInteger(sourceActivationRevision)
    || sourceActivationRevision < 1
    || !Number.isSafeInteger(shadowActivationRevision)
    || shadowActivationRevision !== sourceActivationRevision + 1
    || !Array.isArray(row.cohort)
  ) {
    fail(
      'COMMERCE_ACTIVE_CONTINUATION_INVALID',
      'The prior Commerce Active continuation evidence is invalid',
    )
  }
  const shopifyAccounts = row.cohort.flatMap((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      fail(
        'COMMERCE_ACTIVE_CONTINUATION_INVALID',
        'The prior Commerce Active cohort is invalid',
      )
    }
    const member = raw as Record<string, unknown>
    if (member.provider !== 'shopify') return []
    if (
      typeof member.accountGlobalId !== 'string'
      || !ACCOUNT_GLOBAL_ID.test(member.accountGlobalId)
      || !Array.isArray(member.writeCapabilities)
      || member.writeCapabilities.length < 1
      || !member.writeCapabilities.every(
        (capability) => isCommerceActiveWriteCapability(
          'shopify',
          capability,
        ),
      )
    ) {
      fail(
        'COMMERCE_ACTIVE_CONTINUATION_INVALID',
        'The prior Shopify Active authority is invalid',
      )
    }
    return [{
      accountGlobalId: member.accountGlobalId,
      writeCapabilities: [...new Set(member.writeCapabilities)] as
        CommerceActiveContinuation['shopifyAccounts'][number]['writeCapabilities'],
    }]
  }).sort((left, right) => codePointOrder(
    left.accountGlobalId,
    right.accountGlobalId,
  ))
  return {
    sourceTransitionGlobalId: row.source_transition_global_id,
    sourceActivationRevision,
    shadowActivationRevision,
    shopifyAccounts,
  }
}

export async function requireCurrentFaireFulfillmentScopeEvidenceInPostgres(
  input: {
    organizationId: unknown
    accountGlobalId: unknown
  },
): Promise<void> {
  const scopedOrganizationId = organizationId(input.organizationId)
  const accountGlobalId = String(input.accountGlobalId || '').trim()
  if (!ACCOUNT_GLOBAL_ID.test(accountGlobalId)) {
    fail(
      'COMMERCE_ACTIVE_ACCOUNT_INVALID',
      'Commerce account is invalid',
      400,
    )
  }
  const result = await query<{ current: boolean }>(
    `SELECT COALESCE((
       SELECT operations_faire_fulfillment_scope_evidence_is_current(
         account.organization_id,
         account.id,
         account.commerce_credential_generation
       )
       FROM operations_integration_accounts account
       WHERE account.organization_id = $1::uuid
         AND account.global_id = $2
         AND account.integration_type = 'commerce'
         AND account.provider = 'faire'
     ), false) AS current`,
    [scopedOrganizationId, accountGlobalId],
  )
  if (result.rows[0]?.current !== true) {
    fail(
      'COMMERCE_ACTIVE_FAIRE_SCOPE_EVIDENCE_REQUIRED',
      'Faire fulfillment requires current provider-verifiable OAuth grant evidence; requested scopes do not authorize provider writes',
      403,
    )
  }
}

export async function readCommerceActiveCapabilityClaimInPostgres(input: {
  organizationId: unknown
  accountGlobalId: unknown
  capability: unknown
  expectedActivationRevision?: unknown
}): Promise<CommerceActiveCapabilityClaim | null> {
  const scopedOrganizationId = organizationId(input.organizationId)
  const accountGlobalId = String(input.accountGlobalId || '').trim()
  if (!ACCOUNT_GLOBAL_ID.test(accountGlobalId)) {
    fail(
      'COMMERCE_ACTIVE_ACCOUNT_INVALID',
      'Commerce account is invalid',
      400,
    )
  }
  const capability = String(input.capability || '').trim()
  if (!/^[a-z][a-z0-9_]{0,127}$/.test(capability)) {
    fail(
      'COMMERCE_ACTIVE_CAPABILITY_INVALID',
      'Commerce write capability is invalid',
      400,
    )
  }
  const revision = input.expectedActivationRevision === undefined
    ? null
    : expectedRevision(input.expectedActivationRevision)
  const result = await query<{
    transition_global_id: string
    authorization_global_id: string
    preparation_global_id: string
    cohort_hash: string
    activation_revision: number
    member: CommerceActiveCohortAccount
    authorized_by: string
    authorized_role: CommerceActiveActorRole
    activated_at: string | Date
  }>(
    `SELECT
       activated.global_id AS transition_global_id,
       authorized.global_id AS authorization_global_id,
       prepared.global_id AS preparation_global_id,
       activated.cohort_hash,
       activated.to_activation_revision AS activation_revision,
       cohort.member,
       authorized.authorized_by,
       authorized.authorized_role,
       activated.activated_at
     FROM operations_commerce_active_transitions activated
     JOIN operations_commerce_active_transition_authorizations authorized
       ON authorized.organization_id = activated.organization_id
      AND authorized.id = activated.authorization_id
     JOIN operations_commerce_active_transition_preparations prepared
       ON prepared.organization_id = activated.organization_id
      AND prepared.id = activated.preparation_id
     CROSS JOIN LATERAL jsonb_array_elements(
       prepared.cohort
     ) AS cohort(member)
     WHERE activated.organization_id = $1::uuid
       AND cohort.member->>'accountGlobalId' = $2
       AND cohort.member->'writeCapabilities' ? $3
       AND (
         $4::integer IS NULL
         OR activated.to_activation_revision = $4
       )
       AND operations_commerce_active_capability_claim_is_current(
         activated.organization_id,
         activated.id,
         $2,
         $3
       )
     ORDER BY activated.activated_at DESC, activated.id DESC
     LIMIT 1`,
    [scopedOrganizationId, accountGlobalId, capability, revision],
  )
  const row = result.rows[0]
  if (!row) return null
  if (
    !isCommerceActiveWriteCapability(row.member.provider, capability)
    || !isClawPilotCommerceCapabilityImplemented(
      row.member.provider,
      capability as CommerceActiveWriteCapability,
    )
  ) {
    return null
  }
  return {
    transitionGlobalId: row.transition_global_id,
    authorizationGlobalId: row.authorization_global_id,
    preparationGlobalId: row.preparation_global_id,
    cohortHash: row.cohort_hash,
    activationRevision: Number(row.activation_revision),
    accountGlobalId: row.member.accountGlobalId,
    provider: row.member.provider,
    environment: row.member.environment,
    externalAccountId: row.member.externalAccountId,
    credentialGeneration: Number(row.member.credentialGeneration),
    grantedScopeDigest: row.member.grantedScopeDigest,
    capability: capability as CommerceActiveWriteCapability,
    capabilityDigest: row.member.capabilityDigest,
    authorizedBy: row.authorized_by,
    authorizedRole: row.authorized_role,
    activatedAt: iso(row.activated_at),
  }
}

export async function requireCommerceActiveCapabilityClaimInPostgres(input: {
  organizationId: unknown
  accountGlobalId: unknown
  capability: unknown
  expectedActivationRevision?: unknown
}): Promise<CommerceActiveCapabilityClaim> {
  const claim = await readCommerceActiveCapabilityClaimInPostgres(input)
  if (!claim) {
    fail(
      'COMMERCE_ACTIVE_CAPABILITY_NOT_AUTHORIZED',
      'No current exact Commerce Active capability claim is available',
      403,
    )
  }
  return claim
}
