import { createHash } from 'node:crypto'
import type { PoolClient, QueryResult, QueryResultRow } from 'pg'
import { recordAuditEvent } from '@/lib/auditWriter'
import {
  hasEffectiveShopifyScope,
  SHOPIFY_ACCESS_SCOPES,
  type ShopifyAccessScope,
} from '@/lib/integrations/commerceCapabilities'
import {
  acquireTransactionAdvisoryLock,
  query,
  withTransaction,
} from '@/lib/persistence/postgres'

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const ACCOUNT_GLOBAL_ID = /^gia(?:[0-9]{7}|[0-9a-v]{12})$/u
const PROVIDER_ATTEMPT_GLOBAL_ID = /^gxa(?:[0-9]{7}|[0-9a-v]{12})$/u
const FULFILLMENT_EXPORT_GLOBAL_ID = /^gfe(?:[0-9]{7}|[0-9a-v]{12})$/u
const SHA256 = /^[a-f0-9]{64}$/u
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,200}$/u

const FULFILLMENT_PROVIDER_ATTEMPT_CONTRACT = {
  shopify: {
    action: 'shopify.fulfillment.create',
    adapterVersion: 'shopify-fulfillment-writeback-v2',
  },
  faire: {
    action: 'faire.fulfillment.shipments.create',
    adapterVersion: 'faire-fulfillment-writeback-v2',
  },
} as const

export type CommerceProviderWriteMode = 'off' | 'on'
export type CommerceProviderWriteBindingStatus =
  | 'off'
  | 'current'
  | 'unavailable'
  | 'revalidation_required'

export type CommerceProviderWriteBlocker = {
  code:
    | 'COMMERCE_PROVIDER_WRITES_ACCOUNT_UNAVAILABLE'
    | 'COMMERCE_PROVIDER_WRITES_CREDENTIAL_UNAVAILABLE'
    | 'COMMERCE_PROVIDER_WRITES_GRANTED_SCOPES_UNAVAILABLE'
    | 'COMMERCE_PROVIDER_WRITES_WRITE_SCOPE_REQUIRED'
    | 'COMMERCE_PROVIDER_WRITES_FAIRE_OAUTH_REQUIRED'
    | 'COMMERCE_PROVIDER_WRITES_FAIRE_SCOPE_EVIDENCE_REQUIRED'
    | 'COMMERCE_PROVIDER_WRITES_COMMAND_ENFORCEMENT_UNAVAILABLE'
    | 'COMMERCE_PROVIDER_WRITES_BINDING_STALE'
  message: string
}

export type CommerceProviderWriteControl = {
  accountGlobalId: string
  accountDisplayName: string
  provider: 'shopify' | 'faire'
  environment: 'mock' | 'sandbox' | 'production'
  requestedMode: CommerceProviderWriteMode
  rowVersion: number
  effectiveFromDefault: boolean
  bindingStatus: CommerceProviderWriteBindingStatus
  bindingCurrent: boolean
  enableAvailable: boolean
  blocker: CommerceProviderWriteBlocker | null
  boundCredentialGeneration: number | null
  boundGrantedScopeDigest: string | null
  currentCredentialGeneration: number
  currentGrantedScopeDigest: string | null
  changedBy: string | null
  changedRole: 'owner' | 'admin' | 'member' | null
  updatedAt: string | null
  commandEnforcement:
    | 'shopify_order_management'
    | 'shopify_fulfillment'
    | 'shopify_order_management_and_fulfillment'
    | 'faire_fulfillment'
    | 'not_connected'
  providerWritesEffective: boolean
  fulfillmentWritesEffective: boolean
  fulfillmentWritesBlockedReason: string | null
}

export type CommerceProviderWriteAuthority = {
  accountGlobalId: string
  provider: 'shopify' | 'faire'
  environment: 'sandbox' | 'production'
  controlRowVersion: number
  credentialGeneration: number
  grantedScopes: string[]
  grantedScopeDigest: string
}

export type CommerceProviderWriteControlState = {
  organizationId: string
  accounts: CommerceProviderWriteControl[]
}

export type SetCommerceProviderWriteControlResult = {
  control: CommerceProviderWriteControl
  replayed: boolean
}

type TimestampValue = string | Date

type ControlRow = {
  integration_account_id: string
  account_global_id: string
  account_display_name: string
  provider: string
  environment: string
  account_status: string
  external_account_id: string | null
  current_credential_generation: number | string
  current_configuration: Record<string, unknown>
  credential_external_account_id: string | null
  credential_version: number | string | null
  auth_mode: string | null
  verification_status: string | null
  credential_last_error_code: string | null
  faire_scope_evidence_current: boolean
  row_version: number | string
  requested_mode: string
  bound_credential_generation: number | string | null
  bound_granted_scopes: string[] | null
  bound_granted_scope_digest: string | null
  changed_by: string | null
  changed_role: string | null
  created_at: TimestampValue | null
  effective_from_default: boolean
}

type RevisionRow = {
  integration_account_id: string
  row_version: number | string
  requested_mode: string
  bound_credential_generation: number | string | null
  bound_granted_scopes: string[] | null
  bound_granted_scope_digest: string | null
  changed_by: string
  changed_role: string
  request_hash: string
  created_at: TimestampValue
}

type QueryExecutor = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<T>>
}

export class CommerceProviderWriteControlError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 409,
  ) {
    super(message)
    this.name = 'CommerceProviderWriteControlError'
  }
}

function fail(code: string, message: string, status = 409): never {
  throw new CommerceProviderWriteControlError(code, message, status)
}

function organizationId(value: unknown) {
  const normalized = String(value || '').trim().toLowerCase()
  if (!UUID.test(normalized)) {
    fail(
      'COMMERCE_PROVIDER_WRITES_ORGANIZATION_INVALID',
      'Active organization is invalid',
      400,
    )
  }
  return normalized
}

function accountGlobalId(value: unknown) {
  const normalized = String(value || '').trim().toLowerCase()
  if (!ACCOUNT_GLOBAL_ID.test(normalized)) {
    fail(
      'COMMERCE_PROVIDER_WRITES_ACCOUNT_INVALID',
      'Commerce account is invalid',
      400,
    )
  }
  return normalized
}

function providerAttemptGlobalId(value: unknown) {
  const normalized = String(value || '').trim().toLowerCase()
  if (!PROVIDER_ATTEMPT_GLOBAL_ID.test(normalized)) {
    fail(
      'COMMERCE_PROVIDER_WRITES_PROVIDER_ATTEMPT_INVALID',
      'Registered provider attempt is invalid',
      400,
    )
  }
  return normalized
}

function fulfillmentExportGlobalId(value: unknown) {
  const normalized = String(value || '').trim().toLowerCase()
  if (!FULFILLMENT_EXPORT_GLOBAL_ID.test(normalized)) {
    fail(
      'COMMERCE_PROVIDER_WRITES_PROVIDER_ATTEMPT_INVALID',
      'Registered provider attempt commerce export is invalid',
      400,
    )
  }
  return normalized
}

function providerAttemptRequestHash(value: unknown) {
  const normalized = String(value || '').trim().toLowerCase()
  if (!SHA256.test(normalized)) {
    fail(
      'COMMERCE_PROVIDER_WRITES_PROVIDER_ATTEMPT_INVALID',
      'Registered provider attempt request hash is invalid',
      400,
    )
  }
  return normalized
}

function requestedMode(value: unknown): CommerceProviderWriteMode {
  if (value !== 'off' && value !== 'on') {
    fail(
      'COMMERCE_PROVIDER_WRITES_MODE_INVALID',
      'Provider writes mode must be Off or On',
      400,
    )
  }
  return value
}

function expectedRowVersion(value: unknown) {
  if (
    !Number.isSafeInteger(value)
    || Number(value) < 0
    || Number(value) >= Number.MAX_SAFE_INTEGER
  ) {
    fail(
      'COMMERCE_PROVIDER_WRITES_ROW_VERSION_INVALID',
      'Provider writes row version is invalid',
      400,
    )
  }
  return Number(value)
}

function actorEmail(value: unknown) {
  const normalized = String(value || '').trim().toLowerCase()
  if (
    !normalized
    || normalized.length > 320
    || !normalized.includes('@')
    || /[\u0000-\u001f\u007f]/u.test(normalized)
  ) {
    fail(
      'COMMERCE_PROVIDER_WRITES_ACTOR_INVALID',
      'A signed-in operations manager is required',
      401,
    )
  }
  return normalized
}

function actorRole(value: unknown): 'owner' | 'admin' | 'member' {
  if (value !== 'owner' && value !== 'admin' && value !== 'member') {
    fail(
      'COMMERCE_PROVIDER_WRITES_ROLE_FORBIDDEN',
      'Operations-management permission is required',
      403,
    )
  }
  return value
}

function idempotencyKey(value: unknown) {
  if (
    typeof value !== 'string'
    || value !== value.trim()
    || !IDEMPOTENCY_KEY.test(value)
  ) {
    fail(
      'COMMERCE_PROVIDER_WRITES_IDEMPOTENCY_KEY_INVALID',
      'A valid Idempotency-Key header is required',
      400,
    )
  }
  return value
}

function exactInteger(value: unknown) {
  const number = Number(value)
  return Number.isSafeInteger(number) ? number : 0
}

function timestamp(value: TimestampValue | null) {
  if (!value) return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

export function canonicalCommerceGrantedScopes(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 128) {
    return null
  }
  const scopes: string[] = []
  for (const entry of value) {
    if (
      typeof entry !== 'string'
      || entry !== entry.trim()
      || entry.length < 1
      || entry.length > 128
      || /[\u0000-\u001f\u007f]/u.test(entry)
    ) {
      return null
    }
    scopes.push(entry)
  }
  const canonical = [...new Set(scopes)].sort()
  return canonical.length === scopes.length ? canonical : null
}

export function commerceGrantedScopeDigest(scopes: readonly string[]) {
  return createHash('sha256').update(scopes.join('\n'), 'utf8').digest('hex')
}

export function commerceProviderHasWriteScope(
  provider: 'shopify' | 'faire',
  scopes: readonly string[],
) {
  return provider === 'shopify'
    ? scopes.some((scope) => scope.startsWith('write_'))
    : scopes.some((scope) => [
      'WRITE_PRODUCTS',
      'WRITE_INVENTORIES',
      'WRITE_ORDERS',
    ].includes(scope))
}

function provider(value: string): 'shopify' | 'faire' {
  if (value !== 'shopify' && value !== 'faire') {
    fail(
      'COMMERCE_PROVIDER_WRITES_ACCOUNT_INVALID',
      'Commerce account provider is unsupported',
      404,
    )
  }
  return value
}

function environment(
  value: string,
): 'mock' | 'sandbox' | 'production' {
  if (value === 'mock' || value === 'sandbox' || value === 'production') {
    return value
  }
  fail(
    'COMMERCE_PROVIDER_WRITES_ACCOUNT_INVALID',
    'Commerce account environment is invalid',
    500,
  )
}

function enableBlocker(row: ControlRow): CommerceProviderWriteBlocker | null {
  const accountProvider = provider(row.provider)
  if (row.account_status !== 'active') {
    return {
      code: 'COMMERCE_PROVIDER_WRITES_ACCOUNT_UNAVAILABLE',
      message: 'Reconnect or restore this provider account before turning writes on.',
    }
  }
  const credentialCurrent = exactInteger(row.credential_version) > 0
    && exactInteger(row.credential_version)
      === exactInteger(row.current_credential_generation)
    && row.credential_external_account_id !== null
    && row.credential_external_account_id === row.external_account_id
    && row.verification_status === 'verified'
    && row.credential_last_error_code === null
  if (!credentialCurrent) {
    return {
      code: 'COMMERCE_PROVIDER_WRITES_CREDENTIAL_UNAVAILABLE',
      message: 'Test or reconnect the current provider credential before turning writes on.',
    }
  }
  if (
    accountProvider === 'shopify'
    && row.auth_mode !== 'shopify_client_credentials'
  ) {
    return {
      code: 'COMMERCE_PROVIDER_WRITES_CREDENTIAL_UNAVAILABLE',
      message: 'The current Shopify credential cannot be bound for provider writes.',
    }
  }
  if (accountProvider === 'faire' && row.auth_mode !== 'faire_oauth') {
    return {
      code: 'COMMERCE_PROVIDER_WRITES_FAIRE_OAUTH_REQUIRED',
      message: 'Reconnect Faire with Custom App OAuth before turning provider writes on.',
    }
  }
  const scopes = canonicalCommerceGrantedScopes(
    row.current_configuration?.grantedScopes,
  )
  if (!scopes) {
    return {
      code: 'COMMERCE_PROVIDER_WRITES_GRANTED_SCOPES_UNAVAILABLE',
      message: 'Refresh the connection so ClawPilot can verify the current granted scopes.',
    }
  }
  if (!commerceProviderHasWriteScope(accountProvider, scopes)) {
    return {
      code: 'COMMERCE_PROVIDER_WRITES_WRITE_SCOPE_REQUIRED',
      message: 'Approve at least one provider write scope before turning writes on.',
    }
  }
  if (accountProvider === 'faire' && !row.faire_scope_evidence_current) {
    return {
      code: 'COMMERCE_PROVIDER_WRITES_FAIRE_SCOPE_EVIDENCE_REQUIRED',
      message: 'Reconnect Faire so the current OAuth write-scope grant can be verified.',
    }
  }
  return null
}

const SHOPIFY_FULFILLMENT_SCOPES = [
  'read_orders',
  'write_merchant_managed_fulfillment_orders',
] as const
const FAIRE_FULFILLMENT_SCOPES = [
  'READ_BRAND',
  'READ_ORDERS',
  'READ_SHIPMENTS',
  'WRITE_ORDERS',
] as const

function commandEnforcement(
  row: ControlRow,
  scopes: readonly string[] | null,
): CommerceProviderWriteControl['commandEnforcement'] {
  if (!scopes) return 'not_connected'
  if (row.provider === 'shopify') {
    const orderManagement = row.environment === 'sandbox'
      && scopes.includes('write_orders')
    const fulfillment = row.environment !== 'mock'
      && SHOPIFY_FULFILLMENT_SCOPES.every(
        (scope) => hasEffectiveShopifyScope(scopes, scope),
      )
    if (orderManagement && fulfillment) {
      return 'shopify_order_management_and_fulfillment'
    }
    if (orderManagement) return 'shopify_order_management'
    if (fulfillment) return 'shopify_fulfillment'
    return 'not_connected'
  }
  return row.provider === 'faire'
    && row.environment === 'production'
    && FAIRE_FULFILLMENT_SCOPES.every((scope) => scopes.includes(scope))
    ? 'faire_fulfillment'
    : 'not_connected'
}

function commandUnavailableMessage(
  row: ControlRow,
  scopes: readonly string[] | null,
) {
  if (row.provider === 'faire') {
    return row.environment !== 'production'
      ? 'Faire fulfillment writes require a production OAuth connection.'
      : !scopes
        ? 'Refresh the Faire connection so ClawPilot can verify its granted scopes.'
        : 'Faire fulfillment requires READ_BRAND, READ_ORDERS, READ_SHIPMENTS, and WRITE_ORDERS.'
  }
  if (row.environment === 'mock') {
    return 'Provider writes are not connected for mock Shopify accounts.'
  }
  return row.environment === 'sandbox'
    ? 'Approve write_orders for order editing or read_orders plus write_merchant_managed_fulfillment_orders for fulfillment.'
    : 'Approve read_orders and write_merchant_managed_fulfillment_orders before turning Provider writes on.'
}

function fulfillmentWritesUnavailableMessage(
  row: ControlRow,
  scopes: readonly string[] | null,
) {
  if (row.provider === 'faire') {
    return row.environment !== 'production'
      ? 'Reconnect Faire with a production OAuth connection before fulfillment and tracking writes.'
      : !scopes
        ? 'Reconnect Faire so ClawPilot can verify its granted fulfillment scopes.'
        : 'Reconnect Faire and approve READ_BRAND, READ_ORDERS, READ_SHIPMENTS, and WRITE_ORDERS for fulfillment and tracking writes.'
  }
  if (row.environment === 'mock') {
    return 'Connect a sandbox or production Shopify account before fulfillment and tracking writes.'
  }
  return 'Reconnect Shopify and approve write_merchant_managed_fulfillment_orders plus read_orders (or write_orders) for fulfillment and tracking writes.'
}

function mapControl(row: ControlRow): CommerceProviderWriteControl {
  const accountProvider = provider(row.provider)
  const mode: CommerceProviderWriteMode = row.requested_mode === 'on'
    ? 'on'
    : 'off'
  const scopes = canonicalCommerceGrantedScopes(
    row.current_configuration?.grantedScopes,
  )
  const currentDigest = scopes ? commerceGrantedScopeDigest(scopes) : null
  const enforcement = commandEnforcement(row, scopes)
  const commandConnected = enforcement !== 'not_connected'
  const fulfillmentConnected = [
    'shopify_fulfillment',
    'shopify_order_management_and_fulfillment',
    'faire_fulfillment',
  ].includes(enforcement)
  const connectionBlocker = enableBlocker(row)
  const blocker = connectionBlocker || (!commandConnected ? {
    code: 'COMMERCE_PROVIDER_WRITES_COMMAND_ENFORCEMENT_UNAVAILABLE' as const,
    message: commandUnavailableMessage(row, scopes),
  } : null)
  const bindingCurrent = mode === 'on'
    && blocker === null
    && exactInteger(row.bound_credential_generation)
      === exactInteger(row.current_credential_generation)
    && row.bound_granted_scope_digest === currentDigest
    && Array.isArray(row.bound_granted_scopes)
    && JSON.stringify(row.bound_granted_scopes) === JSON.stringify(scopes)
  let bindingStatus: CommerceProviderWriteBindingStatus = 'off'
  let resolvedBlocker = blocker
  if (mode === 'on' && bindingCurrent) {
    bindingStatus = 'current'
    resolvedBlocker = null
  } else if (mode === 'on') {
    bindingStatus = 'revalidation_required'
    resolvedBlocker = {
      code: 'COMMERCE_PROVIDER_WRITES_BINDING_STALE',
      message: blocker?.message
        || 'The credential generation or granted scopes changed. Turn writes Off, then On to bind the current connection.',
    }
  } else if (blocker) {
    bindingStatus = 'unavailable'
  }
  const fulfillmentWritesEffective = fulfillmentConnected && bindingCurrent
  const fulfillmentWritesBlockedReason = fulfillmentWritesEffective
    ? null
    : connectionBlocker
      ? connectionBlocker.message
      : !fulfillmentConnected
        ? fulfillmentWritesUnavailableMessage(row, scopes)
        : mode === 'off'
          ? `Turn Provider writes On for this ${accountProvider === 'faire' ? 'Faire' : 'Shopify'} connection before confirming shipment.`
          : resolvedBlocker?.message
            || 'Turn Provider writes Off, then On again to bind the current connection before confirming shipment.'
  return {
    accountGlobalId: row.account_global_id,
    accountDisplayName: row.account_display_name,
    provider: accountProvider,
    environment: environment(row.environment),
    requestedMode: mode,
    rowVersion: exactInteger(row.row_version),
    effectiveFromDefault: row.effective_from_default,
    bindingStatus,
    bindingCurrent,
    enableAvailable: blocker === null,
    blocker: resolvedBlocker,
    boundCredentialGeneration: row.bound_credential_generation === null
      ? null
      : exactInteger(row.bound_credential_generation),
    boundGrantedScopeDigest: row.bound_granted_scope_digest,
    currentCredentialGeneration: exactInteger(
      row.current_credential_generation,
    ),
    currentGrantedScopeDigest: currentDigest,
    changedBy: row.changed_by,
    changedRole: row.changed_role === 'owner'
      || row.changed_role === 'admin'
      || row.changed_role === 'member'
      ? row.changed_role
      : null,
    updatedAt: timestamp(row.created_at),
    commandEnforcement: enforcement,
    providerWritesEffective: commandConnected && bindingCurrent,
    fulfillmentWritesEffective,
    fulfillmentWritesBlockedReason,
  }
}

const CONTROL_SELECT = `SELECT
  current_control.integration_account_id::text,
  current_control.account_global_id,
  current_control.display_name AS account_display_name,
  current_control.provider,
  current_control.environment,
  current_control.account_status,
  account.external_account_id,
  current_control.current_credential_generation,
  current_control.current_configuration,
  credential.external_account_id AS credential_external_account_id,
  credential.credential_version,
  credential.auth_mode,
  credential.verification_status,
  credential.last_error_code AS credential_last_error_code,
  CASE WHEN current_control.provider = 'faire' THEN EXISTS (
    SELECT 1
    FROM public.operations_faire_provider_write_scope_evidence evidence
    WHERE evidence.organization_id = current_control.organization_id
      AND evidence.integration_account_id =
            current_control.integration_account_id
      AND evidence.credential_generation =
            current_control.current_credential_generation
      AND public.operations_faire_provider_write_scope_evidence_is_current(
        current_control.organization_id,
        evidence.id,
        current_control.integration_account_id,
        current_control.current_credential_generation
      )
  ) ELSE true END AS faire_scope_evidence_current,
  current_control.row_version,
  current_control.requested_mode,
  current_control.bound_credential_generation,
  current_control.bound_granted_scopes,
  current_control.bound_granted_scope_digest,
  current_control.changed_by,
  current_control.changed_role,
  current_control.created_at,
  current_control.effective_from_default
FROM public.operations_commerce_provider_write_control_current current_control
JOIN public.operations_integration_accounts account
  ON account.organization_id = current_control.organization_id
 AND account.id = current_control.integration_account_id
LEFT JOIN public.operations_commerce_credentials credential
  ON credential.organization_id = current_control.organization_id
 AND credential.integration_account_id =
       current_control.integration_account_id
WHERE current_control.organization_id = $1::uuid`

async function readControls(
  executor: QueryExecutor,
  input: { organizationId: string; accountGlobalId?: string },
) {
  const values: unknown[] = [input.organizationId]
  const exactAccount = input.accountGlobalId
    ? ' AND current_control.account_global_id = $2'
    : ''
  if (input.accountGlobalId) values.push(input.accountGlobalId)
  const result = await executor.query<ControlRow>(
    `${CONTROL_SELECT}${exactAccount}
     ORDER BY current_control.provider, current_control.display_name,
              current_control.account_global_id`,
    values,
  )
  return result.rows.map(mapControl)
}

function exactProviderWriteExpectation(value: unknown, label: string) {
  if (value === undefined || value === null) return null
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 1) {
    fail(
      'COMMERCE_PROVIDER_WRITES_AUTHORITY_INVALID',
      `${label} is invalid`,
      400,
    )
  }
  return number
}

function exactScopeDigestExpectation(value: unknown) {
  if (value === undefined || value === null) return null
  const digest = String(value || '').trim().toLowerCase()
  if (!/^[a-f0-9]{64}$/u.test(digest)) {
    fail(
      'COMMERCE_PROVIDER_WRITES_AUTHORITY_INVALID',
      'Provider writes scope digest is invalid',
      400,
    )
  }
  return digest
}

function providerHasRequiredScopes(
  providerName: 'shopify' | 'faire',
  scopes: readonly string[],
  requiredScopes: readonly string[],
) {
  return requiredScopes.every((scope) => (
    providerName === 'shopify'
      ? isShopifyAccessScope(scope)
        && hasEffectiveShopifyScope(scopes, scope)
      : scopes.includes(scope)
  ))
}

function isShopifyAccessScope(value: string): value is ShopifyAccessScope {
  return (SHOPIFY_ACCESS_SCOPES as readonly string[]).includes(value)
}

/**
 * Rechecks the append-only per-account Provider writes decision immediately
 * before a connected mutation. Callers may bind a later step to the exact
 * revision returned here; an Off decision or credential/scope drift fails
 * before credential decryption or provider access.
 */
export async function requireCurrentCommerceProviderWritesInPostgres(input: {
  organizationId: unknown
  accountGlobalId: unknown
  provider: 'shopify' | 'faire'
  requiredScopes: readonly string[]
  expectedControlRowVersion?: unknown
  expectedCredentialGeneration?: unknown
  expectedGrantedScopeDigest?: unknown
  client?: PoolClient
}): Promise<CommerceProviderWriteAuthority> {
  const normalizedOrganizationId = organizationId(input.organizationId)
  const normalizedAccountGlobalId = accountGlobalId(input.accountGlobalId)
  const executor: QueryExecutor = input.client || { query }
  const result = await executor.query<ControlRow>(
    `${CONTROL_SELECT}
     AND current_control.account_global_id = $2
     LIMIT 1`,
    [normalizedOrganizationId, normalizedAccountGlobalId],
  )
  const row = result.rows[0]
  if (!row || row.provider !== input.provider) {
    fail(
      'COMMERCE_PROVIDER_WRITES_ACCOUNT_NOT_FOUND',
      'The exact commerce account is unavailable in the active organization',
      404,
    )
  }
  if (row.requested_mode !== 'on' || exactInteger(row.row_version) < 1) {
    fail(
      'COMMERCE_PROVIDER_WRITES_OFF',
      `Turn Provider writes On for this ${input.provider === 'faire' ? 'Faire' : 'Shopify'} connection before confirming shipment`,
      403,
    )
  }
  const connectionBlocker = enableBlocker(row)
  if (connectionBlocker) {
    fail(connectionBlocker.code, connectionBlocker.message)
  }
  const scopes = canonicalCommerceGrantedScopes(
    row.current_configuration?.grantedScopes,
  )
  const requiredScopes = canonicalCommerceGrantedScopes(input.requiredScopes)
  if (
    !scopes
    || !requiredScopes
    || !providerHasRequiredScopes(input.provider, scopes, requiredScopes)
  ) {
    fail(
      'COMMERCE_PROVIDER_WRITES_REQUIRED_SCOPE_MISSING',
      `The current ${input.provider === 'faire' ? 'Faire' : 'Shopify'} credential is missing a required fulfillment scope`,
      409,
    )
  }
  const currentCredentialGeneration = exactInteger(
    row.current_credential_generation,
  )
  const currentScopeDigest = commerceGrantedScopeDigest(scopes)
  const bindingCurrent = (
    exactInteger(row.bound_credential_generation)
      === currentCredentialGeneration
    && Array.isArray(row.bound_granted_scopes)
    && JSON.stringify(row.bound_granted_scopes) === JSON.stringify(scopes)
    && row.bound_granted_scope_digest === currentScopeDigest
  )
  if (!bindingCurrent) {
    fail(
      'COMMERCE_PROVIDER_WRITES_BINDING_STALE',
      'Provider writes must be turned Off, then On again for the current credential and granted scopes',
      409,
    )
  }
  const expectedControlRowVersion = exactProviderWriteExpectation(
    input.expectedControlRowVersion,
    'Provider writes control revision',
  )
  const expectedCredentialGeneration = exactProviderWriteExpectation(
    input.expectedCredentialGeneration,
    'Provider writes credential generation',
  )
  const expectedGrantedScopeDigest = exactScopeDigestExpectation(
    input.expectedGrantedScopeDigest,
  )
  if (
    (expectedControlRowVersion !== null
      && expectedControlRowVersion !== exactInteger(row.row_version))
    || (expectedCredentialGeneration !== null
      && expectedCredentialGeneration !== currentCredentialGeneration)
    || (expectedGrantedScopeDigest !== null
      && expectedGrantedScopeDigest !== currentScopeDigest)
  ) {
    fail(
      'COMMERCE_PROVIDER_WRITES_AUTHORITY_CHANGED',
      'Provider writes changed after shipment authorization; review and retry from the order',
      409,
    )
  }
  if (row.environment !== 'sandbox' && row.environment !== 'production') {
    fail(
      'COMMERCE_PROVIDER_WRITES_ACCOUNT_UNAVAILABLE',
      'Connected fulfillment writes require a sandbox or production provider account',
      409,
    )
  }
  return {
    accountGlobalId: normalizedAccountGlobalId,
    provider: input.provider,
    environment: row.environment,
    controlRowVersion: exactInteger(row.row_version),
    credentialGeneration: currentCredentialGeneration,
    grantedScopes: scopes,
    grantedScopeDigest: currentScopeDigest,
  }
}

/**
 * Revalidates the exact On authority sealed into an already-registered
 * provider attempt. A later Off decision blocks new attempt registration but
 * does not turn a durable, immutable in-flight attempt into a known-no-call
 * failure. Credential, scope, account, provider, and environment drift still
 * fail before provider access.
 */
export async function requireSealedCommerceProviderWritesInPostgres(input: {
  organizationId: unknown
  accountGlobalId: unknown
  provider: 'shopify' | 'faire'
  environment: 'sandbox' | 'production'
  providerAttemptGlobalId: unknown
  providerAttemptRequestHash: unknown
  commerceExportGlobalId: unknown
  requiredScopes: readonly string[]
  expectedControlRowVersion: unknown
  expectedCredentialGeneration: unknown
  expectedGrantedScopeDigest: unknown
  client?: PoolClient
}): Promise<CommerceProviderWriteAuthority> {
  const normalizedOrganizationId = organizationId(input.organizationId)
  const normalizedAccountGlobalId = accountGlobalId(input.accountGlobalId)
  const normalizedProviderAttemptGlobalId = providerAttemptGlobalId(
    input.providerAttemptGlobalId,
  )
  const normalizedProviderAttemptRequestHash = providerAttemptRequestHash(
    input.providerAttemptRequestHash,
  )
  const normalizedCommerceExportGlobalId = fulfillmentExportGlobalId(
    input.commerceExportGlobalId,
  )
  const controlRowVersion = exactProviderWriteExpectation(
    input.expectedControlRowVersion,
    'Provider writes control revision',
  )
  const credentialGeneration = exactProviderWriteExpectation(
    input.expectedCredentialGeneration,
    'Provider writes credential generation',
  )
  const grantedScopeDigest = exactScopeDigestExpectation(
    input.expectedGrantedScopeDigest,
  )
  if (
    controlRowVersion === null
    || credentialGeneration === null
    || grantedScopeDigest === null
  ) {
    fail(
      'COMMERCE_PROVIDER_WRITES_AUTHORITY_INVALID',
      'A registered provider attempt requires exact sealed Provider writes authority',
      400,
    )
  }
  const executor: QueryExecutor = input.client || { query }
  const attemptContract = FULFILLMENT_PROVIDER_ATTEMPT_CONTRACT[input.provider]
  const sealedAuthority = {
    accountGlobalId: normalizedAccountGlobalId,
    provider: input.provider,
    environment: input.environment,
    controlRowVersion,
    credentialGeneration,
    grantedScopeDigest,
  }
  const attempt = await executor.query<{ global_id: string }>(
    `SELECT provider_attempt.global_id
     FROM public.operations_commerce_provider_attempts provider_attempt
     JOIN public.operations_integration_accounts account
       ON account.organization_id = provider_attempt.organization_id
      AND account.id = provider_attempt.integration_account_id
     JOIN public.operations_commerce_fulfillment_exports fulfillment_export
       ON fulfillment_export.organization_id = provider_attempt.organization_id
      AND fulfillment_export.global_id = provider_attempt.external_object_id
      AND fulfillment_export.provider = account.provider
     WHERE provider_attempt.organization_id = $1::uuid
       AND provider_attempt.global_id = $2
       AND account.global_id = $3
       AND account.provider = $4
       AND account.integration_type = 'commerce'
       AND account.environment = $5
       AND provider_attempt.action = $6
       AND provider_attempt.adapter_version = $7
       AND provider_attempt.external_object_id = $8
       AND provider_attempt.state = 'prepared'
       AND provider_attempt.request_hash = $9
       AND provider_attempt.redacted_request->'providerWriteAuthority'
         = $10::jsonb
     LIMIT 1`,
    [
      normalizedOrganizationId,
      normalizedProviderAttemptGlobalId,
      normalizedAccountGlobalId,
      input.provider,
      input.environment,
      attemptContract.action,
      attemptContract.adapterVersion,
      normalizedCommerceExportGlobalId,
      normalizedProviderAttemptRequestHash,
      JSON.stringify(sealedAuthority),
    ],
  )
  if (attempt.rowCount !== 1) {
    fail(
      'COMMERCE_PROVIDER_WRITES_PROVIDER_ATTEMPT_MISMATCH',
      'No exact prepared provider attempt contains the sealed Provider writes authority',
      409,
    )
  }
  const result = await executor.query<ControlRow>(
    `${CONTROL_SELECT}
     AND current_control.account_global_id = $2
     LIMIT 1`,
    [normalizedOrganizationId, normalizedAccountGlobalId],
  )
  const row = result.rows[0]
  if (
    !row
    || row.provider !== input.provider
    || row.environment !== input.environment
  ) {
    fail(
      'COMMERCE_PROVIDER_WRITES_AUTHORITY_CHANGED',
      'The registered provider attempt no longer matches its exact account, provider, or environment',
      409,
    )
  }
  const connectionBlocker = enableBlocker(row)
  if (connectionBlocker) {
    fail(connectionBlocker.code, connectionBlocker.message)
  }
  const scopes = canonicalCommerceGrantedScopes(
    row.current_configuration?.grantedScopes,
  )
  const requiredScopes = canonicalCommerceGrantedScopes(input.requiredScopes)
  const currentCredentialGeneration = exactInteger(
    row.current_credential_generation,
  )
  const currentScopeDigest = scopes
    ? commerceGrantedScopeDigest(scopes)
    : null
  if (
    !scopes
    || !requiredScopes
    || !providerHasRequiredScopes(input.provider, scopes, requiredScopes)
    || currentCredentialGeneration !== credentialGeneration
    || currentScopeDigest !== grantedScopeDigest
  ) {
    fail(
      'COMMERCE_PROVIDER_WRITES_AUTHORITY_CHANGED',
      'The registered provider attempt credential or granted scopes changed before provider access',
      409,
    )
  }
  const sealed = await executor.query<RevisionRow>(
    `SELECT integration_account_id::text, row_version, requested_mode,
            bound_credential_generation, bound_granted_scopes,
            bound_granted_scope_digest, changed_by, changed_role,
            request_hash, created_at
     FROM public.operations_commerce_provider_write_controls
     WHERE organization_id = $1::uuid
       AND integration_account_id = $2::uuid
       AND provider = $3
       AND row_version = $4
     LIMIT 1`,
    [
      normalizedOrganizationId,
      row.integration_account_id,
      input.provider,
      controlRowVersion,
    ],
  )
  const sealedRow = sealed.rows[0]
  if (
    !sealedRow
    || sealedRow.requested_mode !== 'on'
    || exactInteger(sealedRow.bound_credential_generation)
      !== credentialGeneration
    || !Array.isArray(sealedRow.bound_granted_scopes)
    || JSON.stringify(sealedRow.bound_granted_scopes)
      !== JSON.stringify(scopes)
    || sealedRow.bound_granted_scope_digest !== grantedScopeDigest
  ) {
    fail(
      'COMMERCE_PROVIDER_WRITES_AUTHORITY_CHANGED',
      'The registered provider attempt does not have an exact durable Provider writes On authorization',
      409,
    )
  }
  return {
    accountGlobalId: normalizedAccountGlobalId,
    provider: input.provider,
    environment: input.environment,
    controlRowVersion,
    credentialGeneration,
    grantedScopes: scopes,
    grantedScopeDigest,
  }
}

export async function readCommerceProviderWriteControlsFromPostgres(input: {
  organizationId: unknown
}): Promise<CommerceProviderWriteControlState> {
  const normalizedOrganizationId = organizationId(input.organizationId)
  return {
    organizationId: normalizedOrganizationId,
    accounts: await readControls({ query }, {
      organizationId: normalizedOrganizationId,
    }),
  }
}

function requestHash(input: {
  organizationId: string
  accountGlobalId: string
  mode: CommerceProviderWriteMode
  expectedRowVersion: number
  actorEmail: string
  actorRole: 'owner' | 'admin' | 'member'
}) {
  return createHash('sha256').update(JSON.stringify({
    version: 'commerce-provider-write-control-v1',
    ...input,
  })).digest('hex')
}

async function accountForChange(client: PoolClient, input: {
  organizationId: string
  accountGlobalId: string
}) {
  const rowResult = await client.query<ControlRow>(
    `${CONTROL_SELECT}
     AND current_control.account_global_id = $2
     FOR SHARE OF account`,
    [input.organizationId, input.accountGlobalId],
  )
  const row = rowResult.rows[0]
  if (!row) {
    fail(
      'COMMERCE_PROVIDER_WRITES_ACCOUNT_NOT_FOUND',
      'Commerce account is unavailable in the active organization',
      404,
    )
  }
  return { control: mapControl(row), row }
}

export async function setCommerceProviderWriteControlInPostgres(rawInput: {
  organizationId: unknown
  accountGlobalId: unknown
  mode: unknown
  expectedRowVersion: unknown
  actorEmail: unknown
  actorRole: unknown
  idempotencyKey: unknown
}): Promise<SetCommerceProviderWriteControlResult> {
  const input = {
    organizationId: organizationId(rawInput.organizationId),
    accountGlobalId: accountGlobalId(rawInput.accountGlobalId),
    mode: requestedMode(rawInput.mode),
    expectedRowVersion: expectedRowVersion(rawInput.expectedRowVersion),
    actorEmail: actorEmail(rawInput.actorEmail),
    actorRole: actorRole(rawInput.actorRole),
    idempotencyKey: idempotencyKey(rawInput.idempotencyKey),
  }
  if (input.mode === 'on' && input.actorRole === 'member') {
    fail(
      'COMMERCE_PROVIDER_WRITES_ACTIVATE_REQUIRED',
      'Organization owner or operations-administrator access is required to turn provider writes on',
      403,
    )
  }

  return withTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(
      client,
      `commerce-provider-writes:${input.organizationId}:${input.accountGlobalId}`,
    )
    const { control, row } = await accountForChange(client, input)
    const hash = requestHash(input)
    const replay = await client.query<RevisionRow>(
      `SELECT integration_account_id::text, row_version, requested_mode,
              bound_credential_generation, bound_granted_scopes,
              bound_granted_scope_digest, changed_by, changed_role,
              request_hash, created_at
       FROM public.operations_commerce_provider_write_controls
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid
         AND idempotency_key = $3
       LIMIT 1`,
      [input.organizationId, row.integration_account_id, input.idempotencyKey],
    )
    if (replay.rows[0]) {
      if (replay.rows[0].request_hash !== hash) {
        fail(
          'COMMERCE_PROVIDER_WRITES_IDEMPOTENCY_CONFLICT',
          'Idempotency-Key was already used for a different provider writes change',
        )
      }
      const exactReplay = replay.rows[0]
      return {
        control: mapControl({
          ...row,
          row_version: exactReplay.row_version,
          requested_mode: exactReplay.requested_mode,
          bound_credential_generation:
            exactReplay.bound_credential_generation,
          bound_granted_scopes: exactReplay.bound_granted_scopes,
          bound_granted_scope_digest:
            exactReplay.bound_granted_scope_digest,
          changed_by: exactReplay.changed_by,
          changed_role: exactReplay.changed_role,
          created_at: exactReplay.created_at,
          effective_from_default: false,
        }),
        replayed: true,
      }
    }
    if (control.rowVersion !== input.expectedRowVersion) {
      fail(
        'COMMERCE_PROVIDER_WRITES_ROW_VERSION_CONFLICT',
        'Provider writes changed; refresh and try again',
      )
    }
    if (input.mode === 'on' && !control.enableAvailable) {
      fail(
        control.blocker?.code || 'COMMERCE_PROVIDER_WRITES_UNAVAILABLE',
        control.blocker?.message || 'Provider writes are unavailable for this connection',
      )
    }
    const scopes = input.mode === 'on'
      ? canonicalCommerceGrantedScopes(row.current_configuration?.grantedScopes)
      : null
    if (input.mode === 'on' && !scopes) {
      fail(
        'COMMERCE_PROVIDER_WRITES_GRANTED_SCOPES_UNAVAILABLE',
        'Refresh the connection so ClawPilot can verify the current granted scopes',
      )
    }
    const digest = scopes ? commerceGrantedScopeDigest(scopes) : null
    await client.query(
      `INSERT INTO public.operations_commerce_provider_write_controls (
         organization_id, integration_account_id, provider,
         row_version, expected_row_version, requested_mode,
         bound_credential_generation, bound_granted_scopes,
         bound_granted_scope_digest, changed_by, changed_role,
         idempotency_key, request_hash
       ) VALUES (
         $1::uuid, $2::uuid, $3, $4, $5, $6,
         $7, $8::text[], $9, $10, $11, $12, $13
       )`,
      [
        input.organizationId,
        row.integration_account_id,
        row.provider,
        control.rowVersion + 1,
        control.rowVersion,
        input.mode,
        input.mode === 'on'
          ? exactInteger(row.current_credential_generation)
          : null,
        scopes,
        digest,
        input.actorEmail,
        input.actorRole,
        input.idempotencyKey,
        hash,
      ],
    )
    const [saved] = await readControls(client, input)
    if (!saved || saved.rowVersion !== control.rowVersion + 1) {
      fail(
        'COMMERCE_PROVIDER_WRITES_NOT_RETAINED',
        'Provider writes change was not retained',
        500,
      )
    }
    await recordAuditEvent({
      actor: input.actorEmail,
      organizationId: input.organizationId,
      eventType: input.mode === 'on'
        ? 'commerce.provider_writes.turned_on'
        : 'commerce.provider_writes.turned_off',
      aggregateType: 'operations.commerce_provider_write_control',
      aggregateId: input.accountGlobalId,
      eventKey:
        `commerce-provider-writes:${input.organizationId}:${input.accountGlobalId}:${input.idempotencyKey}`,
      payload: {
        accountGlobalId: input.accountGlobalId,
        provider: saved.provider,
        requestedMode: saved.requestedMode,
        rowVersion: saved.rowVersion,
        expectedRowVersion: control.rowVersion,
        boundCredentialGeneration: saved.boundCredentialGeneration,
        boundGrantedScopeDigest: saved.boundGrantedScopeDigest,
        commandEnforcement: saved.commandEnforcement,
        providerWritesEffective: saved.providerWritesEffective,
      },
    }, client)
    return { control: saved, replayed: false }
  })
}
