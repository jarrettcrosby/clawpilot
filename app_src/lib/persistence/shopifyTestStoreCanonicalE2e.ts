import { createHash } from 'node:crypto'
import type { PoolClient } from 'pg'
import { recordAuditEvent } from '@/lib/auditWriter'
import {
  shopifyOrderManagementAccountAllowed,
} from '@/lib/integrations/shopifyOrderManagementRuntime'
import {
  SHOPIFY_TEST_STORE_CANONICAL_E2E_CONFIRMATION,
  SHOPIFY_TEST_STORE_CANONICAL_E2E_CONFIRMATION_VERSION,
  SHOPIFY_TEST_STORE_CANONICAL_E2E_PROOF_VERSION,
  SHOPIFY_TEST_STORE_FULFILLMENT_CONFIRMATION,
  SHOPIFY_TEST_STORE_FULFILLMENT_CONFIRMATION_VERSION,
} from '@/lib/operations/shopifyTestStoreCanonicalE2e'
import { query, withTransaction } from '@/lib/persistence/postgres'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const ORDER_GLOBAL_ID = /^gor(?:[0-9]{7}|[0-9a-v]{12})$/
const AUTHORIZATION_GLOBAL_ID = /^gsea(?:[0-9]{7}|[0-9a-v]{12})$/
const ACCOUNT_GLOBAL_ID = /^gia(?:[0-9]{7}|[0-9a-v]{12})$/
const CANDIDATE_GLOBAL_ID = /^gcoc(?:[0-9]{7}|[0-9a-v]{12})$/
const SHOPIFY_ORDER_GID = /^gid:\/\/shopify\/Order\/[1-9][0-9]*$/
const SHOPIFY_SHOP_GID = /^gid:\/\/shopify\/Shop\/[1-9][0-9]*$/
const SHA256 = /^[a-f0-9]{64}$/
const SAFE_KEY = /^[^\u0000-\u001f\u007f]{1,255}$/

export class ShopifyTestStoreCanonicalE2ePersistenceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 409,
  ) {
    super(message)
    this.name = 'ShopifyTestStoreCanonicalE2ePersistenceError'
  }
}

function fail(code: string, message: string, status = 409): never {
  throw new ShopifyTestStoreCanonicalE2ePersistenceError(code, message, status)
}

function organizationId(value: unknown) {
  const normalized = String(value || '').trim().toLowerCase()
  if (!UUID.test(normalized)) {
    fail('SHOPIFY_TEST_E2E_ORGANIZATION_INVALID', 'Organization is invalid', 400)
  }
  return normalized
}

function actorEmail(value: unknown) {
  const normalized = String(value || '').trim().toLowerCase()
  if (!normalized || normalized.length > 320 || !normalized.includes('@')) {
    fail('SHOPIFY_TEST_E2E_ACTOR_INVALID', 'A signed-in actor is required', 401)
  }
  return normalized
}

function reference(value: unknown, pattern: RegExp, code: string, label: string) {
  const normalized = String(value || '').trim()
  if (!pattern.test(normalized)) fail(code, `${label} is invalid`, 400)
  return normalized
}

function exactVersion(value: unknown, label: string) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    fail('SHOPIFY_TEST_E2E_VERSION_INVALID', `${label} is invalid`, 400)
  }
  return parsed
}

function reason(value: unknown) {
  const normalized = String(value || '').trim()
  if (
    normalized.length < 8
    || normalized.length > 500
    || /[\u0000-\u001f\u007f]/.test(normalized)
  ) {
    fail(
      'SHOPIFY_TEST_E2E_REASON_INVALID',
      'An 8-500 character authorization reason is required',
      400,
    )
  }
  return normalized
}

function idempotencyKey(value: unknown) {
  const normalized = String(value || '').trim()
  if (!SAFE_KEY.test(normalized)) {
    fail(
      'SHOPIFY_TEST_E2E_IDEMPOTENCY_KEY_INVALID',
      'A valid idempotency key is required',
      400,
    )
  }
  return normalized
}

function timestamp(value: unknown, label: string) {
  const normalized = String(value || '').trim()
  const parsed = new Date(normalized)
  if (!normalized || !Number.isFinite(parsed.getTime())) {
    fail('SHOPIFY_TEST_E2E_PROOF_INVALID', `${label} is invalid`, 400)
  }
  return parsed.toISOString()
}

function hash(value: unknown, label: string) {
  const normalized = String(value || '').trim().toLowerCase()
  if (!SHA256.test(normalized)) {
    fail('SHOPIFY_TEST_E2E_PROOF_INVALID', `${label} is invalid`, 400)
  }
  return normalized
}

export type ShopifyTestStoreCanonicalE2eTarget = {
  organizationId: string
  activationRevision: number
  order: {
    id: string
    globalId: string
    rowVersion: number
    externalOrderId: string
    status: 'imported' | 'planned' | 'released' | 'picking' | 'packed'
  }
  account: {
    id: string
    globalId: string
    externalAccountId: string
    credentialGeneration: number
  }
  candidate: {
    id: string
    globalId: string
    rowVersion: number
    sourceRevision: string
    sourceHash: string
  }
}

type TargetRow = {
  activation_revision: number
  order_id: string
  order_global_id: string
  order_row_version: string
  order_status: string
  external_order_id: string
  account_id: string
  account_global_id: string
  account_external_account_id: string | null
  account_provider: string
  account_environment: string
  account_status: string
  account_credential_generation: number
  credential_version: number | null
  credential_external_account_id: string | null
  credential_verification_status: string | null
  candidate_id: string
  candidate_global_id: string
  candidate_row_version: string
  candidate_source_revision: string
  candidate_source_hash: string
  candidate_workflow_state: string
  candidate_test_order: boolean
  plan_count: string
  current_plan_lineage_count: string
  shipment_export_count: string
  production_label_count: string
}

const TARGET_SELECT = `SELECT
  COALESCE((
    SELECT activation.revision
    FROM operations_activation_scopes activation
    WHERE activation.organization_id = source_order.organization_id
  ), 1) AS activation_revision,
  source_order.id::text AS order_id,
  source_order.global_id AS order_global_id,
  source_order.row_version::text AS order_row_version,
  source_order.status AS order_status,
  source_order.external_order_id,
  account.id::text AS account_id,
  account.global_id AS account_global_id,
  account.external_account_id AS account_external_account_id,
  account.provider AS account_provider,
  account.environment AS account_environment,
  account.status AS account_status,
  account.commerce_credential_generation AS account_credential_generation,
  credential.credential_version,
  credential.external_account_id AS credential_external_account_id,
  credential.verification_status AS credential_verification_status,
  candidate.id::text AS candidate_id,
  candidate.global_id AS candidate_global_id,
  candidate.row_version::text AS candidate_row_version,
  candidate.source_revision AS candidate_source_revision,
  candidate.source_hash AS candidate_source_hash,
  candidate.workflow_state AS candidate_workflow_state,
  candidate.test_order AS candidate_test_order,
  (SELECT count(*) FROM operations_fulfillment_plans plan
   WHERE plan.organization_id = source_order.organization_id
     AND plan.order_id = source_order.id)::text AS plan_count,
  (SELECT count(*)
   FROM operations_fulfillment_plans plan
   JOIN operations_cartonization_rate_evidence cartonization
     ON cartonization.organization_id = plan.organization_id
    AND cartonization.id = plan.cartonization_evidence_id
   WHERE plan.organization_id = source_order.organization_id
     AND plan.order_id = source_order.id
     AND cartonization.order_candidate_id = candidate.id
     AND cartonization.candidate_source_hash = candidate.source_hash
     AND cartonization.evidence_mode = 'operational'
     AND cartonization.status IN ('succeeded', 'partial')
     AND cartonization.sealed_at IS NOT NULL
     AND plan.status = CASE
       WHEN source_order.status = 'planned' THEN 'planned'
       ELSE 'released'
     END)::text AS current_plan_lineage_count,
  (
    (SELECT count(*) FROM operations_shipments shipment
     WHERE shipment.organization_id = source_order.organization_id
       AND shipment.order_id = source_order.id)
    + (SELECT count(*) FROM operations_commerce_fulfillment_exports export
       WHERE export.organization_id = source_order.organization_id
         AND export.order_id = source_order.id)
  )::text AS shipment_export_count,
  (SELECT count(*)
   FROM operations_labels label
   JOIN operations_packages package
     ON package.organization_id = label.organization_id
    AND package.id = label.package_id
   JOIN operations_fulfillment_plans plan
     ON plan.organization_id = package.organization_id
    AND plan.id = package.plan_id
   WHERE plan.organization_id = source_order.organization_id
     AND plan.order_id = source_order.id
     AND label.environment <> 'sandbox')::text AS production_label_count
FROM operations_orders source_order
JOIN operations_integration_accounts account
  ON account.organization_id = source_order.organization_id
 AND account.id = source_order.integration_account_id
LEFT JOIN operations_commerce_credentials credential
  ON credential.organization_id = account.organization_id
 AND credential.integration_account_id = account.id
JOIN operations_commerce_order_candidates candidate
  ON candidate.organization_id = source_order.organization_id
 AND candidate.integration_account_id = account.id
 AND candidate.canonical_order_id = source_order.id`

function mapAndRequireEligibleTarget(
  row: TargetRow | undefined,
  expectedRowVersion: number,
): ShopifyTestStoreCanonicalE2eTarget {
  if (!row) {
    fail(
      'SHOPIFY_TEST_E2E_ORDER_NOT_FOUND',
      'The exact Shopify order was not found',
      404,
    )
  }
  if (Number(row.order_row_version) !== expectedRowVersion) {
    fail(
      'SHOPIFY_TEST_E2E_ORDER_STALE',
      'The Shopify order changed; refresh before authorizing this test',
    )
  }
  const resumableStatuses = [
    'imported',
    'planned',
    'released',
    'picking',
    'packed',
  ] as const
  if (
    !resumableStatuses.includes(
      row.order_status as (typeof resumableStatuses)[number],
    )
    || row.account_provider !== 'shopify'
    || row.account_environment !== 'sandbox'
    || row.account_status !== 'active'
    || row.candidate_workflow_state !== 'promoted'
    || row.candidate_test_order !== true
    || Number(row.shipment_export_count) !== 0
    || Number(row.production_label_count) !== 0
  ) {
    fail(
      'SHOPIFY_TEST_E2E_ORDER_INELIGIBLE',
      'Authorization requires one exact unfulfilled Shopify sandbox test-order candidate with no production effects',
    )
  }
  const resumed = row.order_status !== 'imported'
  if (
    (!resumed && Number(row.plan_count) !== 0)
    || (
      resumed
      && (
        Number(row.plan_count) !== 1
        || Number(row.current_plan_lineage_count) !== 1
      )
    )
  ) {
    fail(
      'SHOPIFY_TEST_E2E_RESUME_LINEAGE_INVALID',
      'The exact local plan lineage is missing, ambiguous, or changed; this test cannot be resumed',
    )
  }
  if (
    !ACCOUNT_GLOBAL_ID.test(row.account_global_id)
    || !SHOPIFY_SHOP_GID.test(row.account_external_account_id || '')
    || !SHOPIFY_ORDER_GID.test(row.external_order_id)
    || !CANDIDATE_GLOBAL_ID.test(row.candidate_global_id)
    || !SHA256.test(row.candidate_source_hash)
    || !row.candidate_source_revision
    || row.account_credential_generation < 1
    || row.credential_version !== row.account_credential_generation
    || row.credential_external_account_id !== row.account_external_account_id
    || row.credential_verification_status !== 'verified'
  ) {
    fail(
      'SHOPIFY_TEST_E2E_CONTEXT_INVALID',
      'The exact Shopify sandbox account, credential, order, and candidate evidence is incomplete',
    )
  }
  if (!shopifyOrderManagementAccountAllowed(row.account_global_id)) {
    fail(
      'SHOPIFY_TEST_E2E_ACCOUNT_NOT_ALLOWLISTED',
      'This Shopify sandbox account is not enabled for exact test-order writes',
      403,
    )
  }
  return {
    organizationId: '',
    activationRevision: row.activation_revision,
    order: {
      id: row.order_id,
      globalId: row.order_global_id,
      rowVersion: Number(row.order_row_version),
      externalOrderId: row.external_order_id,
      status: row.order_status as ShopifyTestStoreCanonicalE2eTarget['order']['status'],
    },
    account: {
      id: row.account_id,
      globalId: row.account_global_id,
      externalAccountId: row.account_external_account_id!,
      credentialGeneration: row.account_credential_generation,
    },
    candidate: {
      id: row.candidate_id,
      globalId: row.candidate_global_id,
      rowVersion: Number(row.candidate_row_version),
      sourceRevision: row.candidate_source_revision,
      sourceHash: row.candidate_source_hash,
    },
  }
}

export async function readShopifyTestStoreCanonicalE2eTargetFromPostgres(input: {
  organizationId: unknown
  orderGlobalId: unknown
  expectedOrderRowVersion: unknown
}): Promise<ShopifyTestStoreCanonicalE2eTarget> {
  const scopedOrganizationId = organizationId(input.organizationId)
  const orderGlobalId = reference(
    input.orderGlobalId,
    ORDER_GLOBAL_ID,
    'SHOPIFY_TEST_E2E_ORDER_INVALID',
    'Operations order',
  )
  const expectedOrderRowVersion = exactVersion(
    input.expectedOrderRowVersion,
    'Expected order row version',
  )
  const result = await query<TargetRow>(
    `${TARGET_SELECT}
     WHERE source_order.organization_id = $1::uuid
       AND source_order.global_id = $2
     LIMIT 2`,
    [scopedOrganizationId, orderGlobalId],
  )
  if (result.rows.length !== 1) {
    fail(
      'SHOPIFY_TEST_E2E_CONTEXT_AMBIGUOUS',
      'The exact promoted Shopify candidate is unavailable or ambiguous',
    )
  }
  const target = mapAndRequireEligibleTarget(
    result.rows[0],
    expectedOrderRowVersion,
  )
  return { ...target, organizationId: scopedOrganizationId }
}

export type ShopifyTestStoreCanonicalE2eProviderProof = {
  version: typeof SHOPIFY_TEST_STORE_CANONICAL_E2E_PROOF_VERSION
  activationRevision: number
  accountGlobalId: string
  externalAccountId: string
  credentialGeneration: number
  orderGlobalId: string
  orderRowVersion: number
  externalOrderId: string
  candidateGlobalId: string
  candidateRowVersion: number
  candidateSourceRevision: string
  candidateSourceHash: string
  providerOrderUpdatedAt: string
  providerVerifiedAt: string
  test: true
}

function normalizeProof(
  value: ShopifyTestStoreCanonicalE2eProviderProof,
): ShopifyTestStoreCanonicalE2eProviderProof {
  if (value?.version !== SHOPIFY_TEST_STORE_CANONICAL_E2E_PROOF_VERSION) {
    fail('SHOPIFY_TEST_E2E_PROOF_INVALID', 'Shopify test-order proof version is invalid', 400)
  }
  if (value.test !== true) {
    fail(
      'SHOPIFY_TEST_E2E_PROVIDER_TEST_REQUIRED',
      'Shopify did not positively identify this order as a test order',
      422,
    )
  }
  return {
    version: SHOPIFY_TEST_STORE_CANONICAL_E2E_PROOF_VERSION,
    activationRevision: exactVersion(
      value.activationRevision,
      'Activation revision',
    ),
    accountGlobalId: reference(
      value.accountGlobalId,
      ACCOUNT_GLOBAL_ID,
      'SHOPIFY_TEST_E2E_PROOF_INVALID',
      'Shopify account',
    ),
    externalAccountId: reference(
      value.externalAccountId,
      SHOPIFY_SHOP_GID,
      'SHOPIFY_TEST_E2E_PROOF_INVALID',
      'Shopify shop',
    ),
    credentialGeneration: exactVersion(
      value.credentialGeneration,
      'Credential generation',
    ),
    orderGlobalId: reference(
      value.orderGlobalId,
      ORDER_GLOBAL_ID,
      'SHOPIFY_TEST_E2E_PROOF_INVALID',
      'Operations order',
    ),
    orderRowVersion: exactVersion(value.orderRowVersion, 'Order row version'),
    externalOrderId: reference(
      value.externalOrderId,
      SHOPIFY_ORDER_GID,
      'SHOPIFY_TEST_E2E_PROOF_INVALID',
      'Shopify order',
    ),
    candidateGlobalId: reference(
      value.candidateGlobalId,
      CANDIDATE_GLOBAL_ID,
      'SHOPIFY_TEST_E2E_PROOF_INVALID',
      'Order candidate',
    ),
    candidateRowVersion: exactVersion(
      value.candidateRowVersion,
      'Candidate row version',
    ),
    candidateSourceRevision: String(value.candidateSourceRevision || '').trim(),
    candidateSourceHash: hash(value.candidateSourceHash, 'Candidate source hash'),
    providerOrderUpdatedAt: timestamp(
      value.providerOrderUpdatedAt,
      'Shopify order update time',
    ),
    providerVerifiedAt: timestamp(
      value.providerVerifiedAt,
      'Shopify verification time',
    ),
    test: true,
  }
}

export function shopifyTestStoreCanonicalE2eProofHash(
  value: ShopifyTestStoreCanonicalE2eProviderProof,
) {
  const {
    activationRevision: legacyActivationRevision,
    ...authority
  } = normalizeProof(value)
  void legacyActivationRevision
  return createHash('sha256')
    .update(JSON.stringify(authority))
    .digest('hex')
}

export type ShopifyTestStoreCanonicalE2eAuthorization = {
  authorizationGlobalId: string
  orderGlobalId: string
  externalOrderId: string
  state: 'active' | 'consumed' | 'revoked' | 'expired'
  authorizedAt: string
  expiresAt: string
  authorityKind: 'shopify_test_store_canonical'
  accountGlobalId: string
  candidateGlobalId: string
  providerProofHash: string
  fulfillmentConfirmedAt: string | null
  replayed: boolean
}

type AuthorizationResultRow = {
  id: string
  global_id: string
  external_order_id: string
  state: ShopifyTestStoreCanonicalE2eAuthorization['state']
  authorized_at: Date | string
  expires_at: Date | string
  account_global_id: string
  order_candidate_global_id: string
  provider_proof_hash: string
  fulfillment_confirmed_at: Date | string | null
  authorized_by?: string
  reason?: string
  activation_revision?: number
  initial_order_row_version?: string
  order_candidate_row_version?: string
  order_candidate_source_revision?: string
  order_candidate_source_hash?: string
  credential_generation?: number
  authorization_idempotency_key?: string
  authorization_request_hash?: string
}

function mapAuthorization(
  row: AuthorizationResultRow,
  orderGlobalId: string,
  replayed = false,
): ShopifyTestStoreCanonicalE2eAuthorization {
  return {
    authorizationGlobalId: row.global_id,
    orderGlobalId,
    externalOrderId: row.external_order_id,
    state: row.state,
    authorizedAt: new Date(row.authorized_at).toISOString(),
    expiresAt: new Date(row.expires_at).toISOString(),
    authorityKind: 'shopify_test_store_canonical',
    accountGlobalId: row.account_global_id,
    candidateGlobalId: row.order_candidate_global_id,
    providerProofHash: row.provider_proof_hash,
    fulfillmentConfirmedAt: row.fulfillment_confirmed_at
      ? new Date(row.fulfillment_confirmed_at).toISOString()
      : null,
    replayed,
  }
}

export async function persistShopifyTestStoreCanonicalE2eAuthorizationInPostgres(
  input: {
    organizationId: unknown
    actorEmail: unknown
    idempotencyKey: unknown
    confirmationStatement: unknown
    reason: unknown
    lifetimeMinutes?: unknown
    proof: ShopifyTestStoreCanonicalE2eProviderProof
  },
): Promise<ShopifyTestStoreCanonicalE2eAuthorization> {
  const scopedOrganizationId = organizationId(input.organizationId)
  const actor = actorEmail(input.actorEmail)
  const key = idempotencyKey(input.idempotencyKey)
  if (input.confirmationStatement !== SHOPIFY_TEST_STORE_CANONICAL_E2E_CONFIRMATION) {
    fail(
      'SHOPIFY_TEST_E2E_CONFIRMATION_REQUIRED',
      'The exact Shopify test-store authorization confirmation is required',
      400,
    )
  }
  const authorizationReason = reason(input.reason)
  const lifetimeMinutes = input.lifetimeMinutes === undefined
    ? 120
    : Number(input.lifetimeMinutes)
  if (
    !Number.isSafeInteger(lifetimeMinutes)
    || lifetimeMinutes < 5
    || lifetimeMinutes > 240
  ) {
    fail(
      'SHOPIFY_TEST_E2E_LIFETIME_INVALID',
      'Authorization lifetime must be 5-240 minutes',
      400,
    )
  }
  const proof = normalizeProof(input.proof)
  const proofHash = shopifyTestStoreCanonicalE2eProofHash(proof)
  const requestHash = createHash('sha256').update(JSON.stringify({
    schema: 'shopify-test-store-canonical-e2e-authorization-request-v1',
    organizationId: scopedOrganizationId,
    actorEmail: actor,
    confirmationStatementVersion:
      SHOPIFY_TEST_STORE_CANONICAL_E2E_CONFIRMATION_VERSION,
    reason: authorizationReason,
    lifetimeMinutes,
    accountGlobalId: proof.accountGlobalId,
    externalAccountId: proof.externalAccountId,
    credentialGeneration: proof.credentialGeneration,
    orderGlobalId: proof.orderGlobalId,
    orderRowVersion: proof.orderRowVersion,
    externalOrderId: proof.externalOrderId,
    candidateGlobalId: proof.candidateGlobalId,
    candidateRowVersion: proof.candidateRowVersion,
    candidateSourceRevision: proof.candidateSourceRevision,
    candidateSourceHash: proof.candidateSourceHash,
    providerProofVersion: proof.version,
    providerOrderUpdatedAt: proof.providerOrderUpdatedAt,
    providerTest: proof.test,
  })).digest('hex')
  if (!shopifyOrderManagementAccountAllowed(proof.accountGlobalId)) {
    fail(
      'SHOPIFY_TEST_E2E_ACCOUNT_NOT_ALLOWLISTED',
      'This Shopify sandbox account is not enabled for exact test-order writes',
      403,
    )
  }
  return withTransaction(async (client) => {
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
      [`shopify-test-store-canonical-e2e:${scopedOrganizationId}`],
    )
    const locked = await client.query<TargetRow>(
      `${TARGET_SELECT}
       WHERE source_order.organization_id = $1::uuid
         AND source_order.global_id = $2
       LIMIT 2
       FOR UPDATE OF source_order, account, candidate`,
      [scopedOrganizationId, proof.orderGlobalId],
    )
    if (locked.rows.length !== 1) {
      fail(
        'SHOPIFY_TEST_E2E_CONTEXT_AMBIGUOUS',
        'The exact promoted Shopify candidate is unavailable or ambiguous',
      )
    }
    const target = mapAndRequireEligibleTarget(
      locked.rows[0],
      proof.orderRowVersion,
    )
    if (
      target.account.globalId !== proof.accountGlobalId
      || target.account.externalAccountId !== proof.externalAccountId
      || target.account.credentialGeneration !== proof.credentialGeneration
      || target.order.externalOrderId !== proof.externalOrderId
      || target.candidate.globalId !== proof.candidateGlobalId
      || target.candidate.rowVersion !== proof.candidateRowVersion
      || target.candidate.sourceRevision !== proof.candidateSourceRevision
      || target.candidate.sourceHash !== proof.candidateSourceHash
    ) {
      fail(
        'SHOPIFY_TEST_E2E_PROOF_STALE',
        'The Shopify account, order, credential, or promoted candidate changed after verification',
      )
    }
    const verifiedAt = Date.parse(proof.providerVerifiedAt)
    const proofClaimedAt = Date.now()
    if (
      !Number.isFinite(verifiedAt)
      || verifiedAt < proofClaimedAt - 5 * 60_000
      || verifiedAt > proofClaimedAt + 60_000
      || Date.parse(proof.providerOrderUpdatedAt) > verifiedAt
    ) {
      fail(
        'SHOPIFY_TEST_E2E_PROOF_STALE',
        'Shopify test-order verification is no longer fresh',
      )
    }
    await client.query(
      `UPDATE operations_sandbox_commerce_e2e_authorizations
       SET state = CASE
         WHEN expires_at <= now() THEN 'expired'
         ELSE 'revoked'
       END
       WHERE organization_id = $1::uuid
         AND state = 'active'
         AND confirmation_statement_version = $2
         AND (
           expires_at <= now()
           OR NOT operations_shopify_test_store_e2e_is_current(
             organization_id, id, order_id
           )
         )`,
      [
        scopedOrganizationId,
        SHOPIFY_TEST_STORE_CANONICAL_E2E_CONFIRMATION_VERSION,
      ],
    )
    const keyedReplay = await client.query<AuthorizationResultRow & {
      order_global_id: string
    }>(
      `SELECT auth.id::text, auth.global_id, auth.external_order_id,
              auth.state, auth.authorized_at, auth.expires_at,
              source_order.global_id AS order_global_id,
              evidence.account_global_id,
              evidence.order_candidate_global_id,
              evidence.provider_proof_hash,
              evidence.authorization_idempotency_key,
              evidence.authorization_request_hash,
              confirmation.confirmed_at AS fulfillment_confirmed_at
       FROM operations_shopify_test_store_e2e_evidence evidence
       JOIN operations_sandbox_commerce_e2e_authorizations auth
         ON auth.organization_id = evidence.organization_id
        AND auth.id = evidence.authorization_id
        AND auth.confirmation_hash = evidence.confirmation_hash
       JOIN operations_orders source_order
         ON source_order.organization_id = auth.organization_id
        AND source_order.id = auth.order_id
       LEFT JOIN operations_shopify_test_store_e2e_fulfillment_confirmations
         confirmation
         ON confirmation.organization_id = auth.organization_id
        AND confirmation.authorization_id = auth.id
       WHERE evidence.organization_id = $1::uuid
         AND evidence.authorization_idempotency_key = $2
         AND auth.confirmation_statement_version = $3
       LIMIT 2
       FOR SHARE OF auth, evidence`,
      [
        scopedOrganizationId,
        key,
        SHOPIFY_TEST_STORE_CANONICAL_E2E_CONFIRMATION_VERSION,
      ],
    )
    if (keyedReplay.rows.length > 1) {
      fail(
        'SHOPIFY_TEST_E2E_IDEMPOTENCY_CONFLICT',
        'The authorization idempotency key is ambiguous',
      )
    }
    if (keyedReplay.rows[0]) {
      if (
        keyedReplay.rows[0].authorization_request_hash !== requestHash
        || keyedReplay.rows[0].order_global_id !== target.order.globalId
      ) {
        fail(
          'SHOPIFY_TEST_E2E_IDEMPOTENCY_CONFLICT',
          'The authorization idempotency key was already used for a different exact request',
        )
      }
      return mapAuthorization(
        keyedReplay.rows[0],
        keyedReplay.rows[0].order_global_id,
        true,
      )
    }
    const existing = await client.query<AuthorizationResultRow & {
      order_global_id: string
    }>(
      `SELECT auth.id::text, auth.global_id, auth.external_order_id,
              auth.state, auth.authorized_at, auth.expires_at,
              active_order.global_id AS order_global_id,
              evidence.account_global_id,
              evidence.order_candidate_global_id,
              evidence.provider_proof_hash,
              auth.authorized_by, auth.reason,
              evidence.activation_revision,
              evidence.initial_order_row_version::text,
              evidence.order_candidate_row_version::text,
              evidence.order_candidate_source_revision,
              evidence.order_candidate_source_hash,
              evidence.credential_generation,
              confirmation.confirmed_at AS fulfillment_confirmed_at
       FROM operations_sandbox_commerce_e2e_authorizations auth
       LEFT JOIN operations_shopify_test_store_e2e_evidence evidence
         ON evidence.organization_id = auth.organization_id
        AND evidence.authorization_id = auth.id
       LEFT JOIN operations_shopify_test_store_e2e_fulfillment_confirmations
         confirmation
         ON confirmation.organization_id = auth.organization_id
        AND confirmation.authorization_id = auth.id
       JOIN operations_orders active_order
         ON active_order.organization_id = auth.organization_id
        AND active_order.id = auth.order_id
       WHERE auth.organization_id = $1::uuid
         AND auth.state = 'active'
         AND auth.expires_at > now()
         AND auth.confirmation_statement_version = $2
       FOR UPDATE OF auth`,
      [
        scopedOrganizationId,
        SHOPIFY_TEST_STORE_CANONICAL_E2E_CONFIRMATION_VERSION,
      ],
    )
    if (existing.rows[0]) {
      fail(
        'SHOPIFY_TEST_E2E_AUTHORIZATION_ALREADY_ACTIVE',
        'A different exact Shopify test order or authorization is already active in this workspace',
      )
    }
    if (target.order.status !== 'imported') {
      const resume = await client.query<{
        authorized_by: string
        account_global_id: string
        external_account_id: string
        credential_generation: number
        activation_revision: number
        order_global_id: string
        external_order_id: string
        initial_order_row_version: string
        order_candidate_global_id: string
        order_candidate_row_version: string
        order_candidate_source_revision: string
        order_candidate_source_hash: string
        provider_order_updated_at: Date | string
        provider_test: boolean
      }>(
        `SELECT auth.authorized_by,
                evidence.account_global_id, evidence.external_account_id,
                evidence.credential_generation, evidence.activation_revision,
                evidence.order_global_id, evidence.external_order_id,
                evidence.initial_order_row_version::text,
                evidence.order_candidate_global_id,
                evidence.order_candidate_row_version::text,
                evidence.order_candidate_source_revision,
                evidence.order_candidate_source_hash,
                evidence.provider_order_updated_at, evidence.provider_test
         FROM operations_sandbox_commerce_e2e_authorizations auth
         JOIN operations_shopify_test_store_e2e_evidence evidence
           ON evidence.organization_id = auth.organization_id
          AND evidence.authorization_id = auth.id
          AND evidence.confirmation_hash = auth.confirmation_hash
         WHERE auth.organization_id = $1::uuid
           AND auth.order_id = $2::uuid
           AND auth.state IN ('expired', 'revoked')
           AND auth.confirmation_statement_version = $3
         ORDER BY auth.authorized_at DESC, auth.id DESC
         LIMIT 1
         FOR SHARE OF auth, evidence`,
        [
          scopedOrganizationId,
          target.order.id,
          SHOPIFY_TEST_STORE_CANONICAL_E2E_CONFIRMATION_VERSION,
        ],
      )
      const previous = resume.rows[0]
      if (
        !previous
        || previous.authorized_by !== actor
        || previous.account_global_id !== proof.accountGlobalId
        || previous.external_account_id !== proof.externalAccountId
        || previous.credential_generation !== proof.credentialGeneration
        || previous.order_global_id !== proof.orderGlobalId
        || previous.external_order_id !== proof.externalOrderId
        || Number(previous.initial_order_row_version) > proof.orderRowVersion
        || previous.order_candidate_global_id !== proof.candidateGlobalId
        || Number(previous.order_candidate_row_version)
          !== proof.candidateRowVersion
        || previous.order_candidate_source_revision
          !== proof.candidateSourceRevision
        || previous.order_candidate_source_hash !== proof.candidateSourceHash
        || new Date(previous.provider_order_updated_at).toISOString()
          !== proof.providerOrderUpdatedAt
        || previous.provider_test !== true
      ) {
        fail(
          'SHOPIFY_TEST_E2E_RESUME_AUTHORITY_INVALID',
          'A progressed test order can be resumed only from the same actor-bound expired authority, provider order, account, credential, candidate, and local plan lineage',
          403,
        )
      }
    }
    const confirmationHash = createHash('sha256').update(JSON.stringify({
      version: SHOPIFY_TEST_STORE_CANONICAL_E2E_CONFIRMATION_VERSION,
      statement: SHOPIFY_TEST_STORE_CANONICAL_E2E_CONFIRMATION,
      organizationId: scopedOrganizationId,
      orderGlobalId: target.order.globalId,
      externalOrderId: target.order.externalOrderId,
      actorEmail: actor,
      reason: authorizationReason,
      proofHash,
    })).digest('hex')
    const inserted = await client.query<AuthorizationResultRow>(
      `WITH created AS (
         INSERT INTO operations_sandbox_commerce_e2e_authorizations (
           organization_id, order_id, external_order_id,
           confirmation_statement_version, confirmation_hash, reason,
           authorized_by, expires_at
         ) VALUES (
           $1::uuid, $2::uuid, $3,
           $4, $5, $6, $7,
           now() + ($8::integer * interval '1 minute')
         )
         RETURNING *
       ), evidence AS (
         INSERT INTO operations_shopify_test_store_e2e_evidence (
           authorization_id, organization_id, confirmation_hash,
           integration_account_id, account_global_id, external_account_id,
           credential_generation, activation_revision,
           order_id, order_global_id,
           external_order_id, initial_order_row_version,
           order_candidate_id, order_candidate_global_id,
           order_candidate_row_version, order_candidate_source_revision,
           order_candidate_source_hash, provider_proof_version,
           provider_proof_hash, provider_order_updated_at,
           provider_verified_at, provider_test,
           authorization_idempotency_key, authorization_request_hash,
           created_by
         )
         SELECT created.id, created.organization_id,
                created.confirmation_hash, $9::uuid, $10, $11,
                $12::integer, $13::integer,
                created.order_id, $14, created.external_order_id,
                $15::bigint, $16::uuid, $17, $18::bigint, $19, $20,
                $21, $22, $23::timestamptz, $24::timestamptz, true,
                $25, $26, $7
         FROM created
         RETURNING authorization_id, account_global_id,
                   order_candidate_global_id, provider_proof_hash
       )
       SELECT created.id::text, created.global_id,
              created.external_order_id, created.state,
              created.authorized_at, created.expires_at,
              evidence.account_global_id,
              evidence.order_candidate_global_id,
              evidence.provider_proof_hash,
              NULL::timestamptz AS fulfillment_confirmed_at
       FROM created
       JOIN evidence ON evidence.authorization_id = created.id`,
      [
        scopedOrganizationId,
        target.order.id,
        target.order.externalOrderId,
        SHOPIFY_TEST_STORE_CANONICAL_E2E_CONFIRMATION_VERSION,
        confirmationHash,
        authorizationReason,
        actor,
        lifetimeMinutes,
        target.account.id,
        target.account.globalId,
        target.account.externalAccountId,
        target.account.credentialGeneration,
        target.activationRevision,
        target.order.globalId,
        target.order.rowVersion,
        target.candidate.id,
        target.candidate.globalId,
        target.candidate.rowVersion,
        target.candidate.sourceRevision,
        target.candidate.sourceHash,
        SHOPIFY_TEST_STORE_CANONICAL_E2E_PROOF_VERSION,
        proofHash,
        proof.providerOrderUpdatedAt,
        proof.providerVerifiedAt,
        key,
        requestHash,
      ],
    )
    const authorization = inserted.rows[0]
    await recordAuditEvent({
      actor,
      eventType: 'operations.shopify_test_store_e2e.authorized',
      aggregateType: 'operations.order',
      aggregateId: target.order.globalId,
      subject: authorization.global_id,
      organizationId: scopedOrganizationId,
      eventKey:
        `operations:shopify-test-store-e2e-authorized:${authorization.global_id}`,
      payload: {
        authorizationGlobalId: authorization.global_id,
        accountGlobalId: target.account.globalId,
        credentialGeneration: target.account.credentialGeneration,
        externalOrderId: target.order.externalOrderId,
        initialOrderRowVersion: target.order.rowVersion,
        candidateGlobalId: target.candidate.globalId,
        candidateRowVersion: target.candidate.rowVersion,
        candidateSourceHash: target.candidate.sourceHash,
        providerProofHash: proofHash,
        providerTest: true,
        providerVerifiedAt: proof.providerVerifiedAt,
        authorizationIdempotencyKey: key,
        authorizationRequestHash: requestHash,
        expiresAt: new Date(authorization.expires_at).toISOString(),
        legacyActivationRevisionAtAuthorization: target.activationRevision,
        productionPostageAuthorized: false,
        notifyCustomerAuthorized: false,
      },
    }, client)
    return mapAuthorization(authorization, target.order.globalId)
  })
}

type CurrentAuthorityRow = {
  id: string
  global_id: string
  organization_id: string
  order_id: string
  order_global_id: string
  order_status: string
  order_row_version: string
  external_order_id: string
  state: 'active' | 'consumed' | 'revoked' | 'expired'
  authorized_by: string
  expires_at: Date | string
  account_global_id: string | null
  order_candidate_global_id: string | null
  provider_proof_hash: string | null
  current: boolean
  fulfillment_confirmed_at: Date | string | null
}

export async function requireActiveShopifyTestStoreCanonicalE2eAuthorization(
  client: PoolClient,
  input: {
    organizationId: unknown
    authorizationGlobalId: unknown
    orderGlobalId: unknown
    actorEmail: unknown
    expectedOrderRowVersion: unknown
    expectedOrderStatus?: string | readonly string[]
    requireFulfillmentConfirmation?: boolean
  },
) {
  const scopedOrganizationId = organizationId(input.organizationId)
  const authorizationGlobalId = reference(
    input.authorizationGlobalId,
    AUTHORIZATION_GLOBAL_ID,
    'SHOPIFY_TEST_E2E_AUTHORIZATION_INVALID',
    'Shopify test E2E authorization',
  )
  const orderGlobalId = reference(
    input.orderGlobalId,
    ORDER_GLOBAL_ID,
    'SHOPIFY_TEST_E2E_ORDER_INVALID',
    'Operations order',
  )
  const actor = actorEmail(input.actorEmail)
  const expectedOrderRowVersion = exactVersion(
    input.expectedOrderRowVersion,
    'Expected order row version',
  )
  const result = await client.query<CurrentAuthorityRow>(
    `SELECT auth.id::text, auth.global_id,
            auth.organization_id::text, auth.order_id::text,
            source_order.global_id AS order_global_id,
            source_order.status AS order_status,
            source_order.row_version::text AS order_row_version,
            auth.external_order_id, auth.state, auth.authorized_by,
            auth.expires_at, evidence.account_global_id,
            evidence.order_candidate_global_id,
            evidence.provider_proof_hash,
            operations_shopify_test_store_e2e_is_current(
              auth.organization_id, auth.id, auth.order_id
            ) AS current,
            confirmation.confirmed_at AS fulfillment_confirmed_at
     FROM operations_sandbox_commerce_e2e_authorizations auth
     JOIN operations_orders source_order
       ON source_order.organization_id = auth.organization_id
      AND source_order.id = auth.order_id
     LEFT JOIN operations_shopify_test_store_e2e_evidence evidence
       ON evidence.organization_id = auth.organization_id
      AND evidence.authorization_id = auth.id
     LEFT JOIN operations_shopify_test_store_e2e_fulfillment_confirmations
       confirmation
       ON confirmation.organization_id = auth.organization_id
      AND confirmation.authorization_id = auth.id
     WHERE auth.organization_id = $1::uuid
       AND auth.global_id = $2
       AND source_order.global_id = $3
     FOR UPDATE OF auth, source_order`,
    [scopedOrganizationId, authorizationGlobalId, orderGlobalId],
  )
  const row = result.rows[0]
  if (!row || row.authorized_by !== actor || !row.account_global_id) {
    fail(
      'SHOPIFY_TEST_E2E_AUTHORIZATION_REQUIRED',
      'Exact actor-bound Shopify test-store E2E authorization is required',
      403,
    )
  }
  if (
    row.state !== 'active'
    || Date.parse(new Date(row.expires_at).toISOString()) <= Date.now()
  ) {
    fail(
      row.state === 'revoked'
        ? 'SHOPIFY_TEST_E2E_AUTHORIZATION_REVOKED'
        : 'SHOPIFY_TEST_E2E_AUTHORIZATION_EXPIRED',
      'Shopify test-store E2E authorization is no longer active',
      403,
    )
  }
  if (!row.current || !shopifyOrderManagementAccountAllowed(row.account_global_id)) {
    fail(
      'SHOPIFY_TEST_E2E_AUTHORIZATION_STALE',
      'Shopify test-store E2E authority no longer matches the exact account, credential, order, or candidate source',
      403,
    )
  }
  if (Number(row.order_row_version) !== expectedOrderRowVersion) {
    fail(
      'SHOPIFY_TEST_E2E_ORDER_STALE',
      'The authorized order changed; refresh before continuing the exact test',
    )
  }
  const expectedStatuses = input.expectedOrderStatus === undefined
    ? []
    : Array.isArray(input.expectedOrderStatus)
      ? input.expectedOrderStatus
      : [input.expectedOrderStatus]
  if (expectedStatuses.length && !expectedStatuses.includes(row.order_status)) {
    fail(
      'SHOPIFY_TEST_E2E_STAGE_INVALID',
      `The exact Shopify test order cannot continue from ${row.order_status}`,
    )
  }
  if (input.requireFulfillmentConfirmation && !row.fulfillment_confirmed_at) {
    fail(
      'SHOPIFY_TEST_E2E_FULFILLMENT_CONFIRMATION_REQUIRED',
      'A second explicit owner/admin fulfillment confirmation is required before fulfillmentCreate',
      403,
    )
  }
  return row
}

export async function assertActiveShopifyTestStoreCanonicalE2eAuthorizationInPostgres(
  input: {
    organizationId: unknown
    authorizationGlobalId: unknown
    orderGlobalId: unknown
    actorEmail: unknown
    expectedOrderRowVersion: unknown
    expectedOrderStatus?: string | readonly string[]
  },
) {
  return withTransaction((client) => (
    requireActiveShopifyTestStoreCanonicalE2eAuthorization(client, input)
  ))
}

export async function assertShopifyTestStoreCanonicalPlanningEvidenceAccessInPostgres(
  input: {
    organizationId: unknown
    actorEmail: unknown
    accountGlobalId: unknown
    candidateGlobalId: unknown
    expectedCandidateRowVersion: unknown
    authorizationGlobalId?: unknown
  },
) {
  const scopedOrganizationId = organizationId(input.organizationId)
  const accountGlobalId = reference(
    input.accountGlobalId,
    ACCOUNT_GLOBAL_ID,
    'SHOPIFY_TEST_E2E_ACCOUNT_INVALID',
    'Shopify account',
  )
  const candidateGlobalId = reference(
    input.candidateGlobalId,
    CANDIDATE_GLOBAL_ID,
    'SHOPIFY_TEST_E2E_CANDIDATE_INVALID',
    'Shopify order candidate',
  )
  const expectedCandidateRowVersion = exactVersion(
    input.expectedCandidateRowVersion,
    'Expected candidate row version',
  )
  const authorizationGlobalId = String(
    input.authorizationGlobalId || '',
  ).trim()
  return withTransaction(async (client) => {
    const context = await client.query<{
      order_global_id: string
      order_row_version: string
      order_status: string
    }>(
      `SELECT source_order.global_id AS order_global_id,
              source_order.row_version::text AS order_row_version,
              source_order.status AS order_status
       FROM operations_integration_accounts account
       JOIN operations_commerce_order_candidates candidate
         ON candidate.organization_id = account.organization_id
        AND candidate.integration_account_id = account.id
       JOIN operations_orders source_order
         ON source_order.organization_id = candidate.organization_id
        AND source_order.id = candidate.canonical_order_id
       WHERE account.organization_id = $1::uuid
         AND account.global_id = $2
         AND account.provider = 'shopify'
         AND candidate.global_id = $3
         AND candidate.row_version = $4::bigint
         AND candidate.workflow_state = 'promoted'
         AND ($5::boolean = false OR candidate.test_order = true)
         AND source_order.source_provider = 'shopify'
       LIMIT 2`,
      [
        scopedOrganizationId,
        accountGlobalId,
        candidateGlobalId,
        expectedCandidateRowVersion,
        Boolean(authorizationGlobalId),
      ],
    )
    if (context.rows.length !== 1) {
      fail(
        'SHOPIFY_TEST_E2E_CONTEXT_AMBIGUOUS',
        authorizationGlobalId
          ? 'The exact promoted Shopify test-order candidate is unavailable or changed'
          : 'The exact promoted Shopify candidate is unavailable or changed',
      )
    }
    const row = context.rows[0]
    if (!authorizationGlobalId) {
      return { authorityKind: 'ordinary' as const }
    }
    await requireActiveShopifyTestStoreCanonicalE2eAuthorization(client, {
      organizationId: scopedOrganizationId,
      actorEmail: input.actorEmail,
      authorizationGlobalId,
      orderGlobalId: row.order_global_id,
      expectedOrderRowVersion: Number(row.order_row_version),
      expectedOrderStatus: 'imported',
    })
    return {
      authorityKind: 'shopify_test_store_canonical' as const,
      orderGlobalId: row.order_global_id,
    }
  })
}

export async function confirmShopifyTestStoreCanonicalE2eFulfillmentInPostgres(
  input: {
    organizationId: unknown
    actorEmail: unknown
    idempotencyKey: unknown
    authorizationGlobalId: unknown
    orderGlobalId: unknown
    expectedOrderRowVersion: unknown
    confirmationStatement: unknown
    reason: unknown
  },
) {
  const scopedOrganizationId = organizationId(input.organizationId)
  const actor = actorEmail(input.actorEmail)
  const key = idempotencyKey(input.idempotencyKey)
  if (input.confirmationStatement !== SHOPIFY_TEST_STORE_FULFILLMENT_CONFIRMATION) {
    fail(
      'SHOPIFY_TEST_E2E_FULFILLMENT_CONFIRMATION_REQUIRED',
      'The exact Shopify fulfillment confirmation is required',
      400,
    )
  }
  const confirmationReason = reason(input.reason)
  return withTransaction(async (client) => {
    const authority = await requireActiveShopifyTestStoreCanonicalE2eAuthorization(
      client,
      {
        ...input,
        expectedOrderStatus: 'packed',
      },
    )
    const labelResult = await client.query<{
      package_global_id: string
      label_global_id: string | null
      label_environment: string | null
      tracking_number: string | null
      package_status: string
    }>(
      `SELECT package.global_id AS package_global_id,
              label.global_id AS label_global_id,
              label.environment AS label_environment,
              label.tracking_number AS tracking_number,
              package.status AS package_status
       FROM operations_fulfillment_plans plan
       JOIN operations_packages package
         ON package.organization_id = plan.organization_id
        AND package.plan_id = plan.id
       LEFT JOIN LATERAL (
         SELECT candidate.global_id, candidate.environment,
                candidate.tracking_number
         FROM operations_labels candidate
         WHERE candidate.organization_id = package.organization_id
           AND candidate.package_id = package.id
           AND candidate.status = 'created'
         ORDER BY candidate.created_at DESC, candidate.id DESC
         LIMIT 1
       ) label ON true
       WHERE plan.organization_id = $1::uuid
         AND plan.order_id = $2::uuid
         AND plan.status = 'released'
       ORDER BY package.package_number, package.id
       FOR SHARE OF plan, package`,
      [scopedOrganizationId, authority.order_id],
    )
    if (
      labelResult.rows.length < 1
      || labelResult.rows.some((row) => (
        row.package_status !== 'labeled'
        || !row.label_global_id
        || row.label_environment !== 'sandbox'
      ))
    ) {
      fail(
        'SHOPIFY_TEST_E2E_SANDBOX_LABELS_REQUIRED',
        'Every exact package requires one active sandbox label before Shopify fulfillment confirmation',
      )
    }
    const existingEffects = await client.query<{ effect_count: string }>(
      `SELECT (
         (SELECT count(*) FROM operations_shipments shipment
          WHERE shipment.organization_id = $1::uuid
            AND shipment.order_id = $2::uuid)
         + (SELECT count(*) FROM operations_commerce_fulfillment_exports export
            WHERE export.organization_id = $1::uuid
              AND export.order_id = $2::uuid)
       )::text AS effect_count`,
      [scopedOrganizationId, authority.order_id],
    )
    if (Number(existingEffects.rows[0]?.effect_count || 0) !== 0) {
      fail(
        'SHOPIFY_TEST_E2E_FULFILLMENT_ALREADY_STARTED',
        'Shipment or Shopify fulfillment evidence already exists for this order',
      )
    }
    const labelGlobalIds = labelResult.rows.map((row) => row.label_global_id!)
    const labelEvidence = labelResult.rows.map((row) => ({
      packageGlobalId: row.package_global_id,
      labelGlobalId: row.label_global_id!,
      trackingNumber: row.tracking_number!,
    }))
    if (labelEvidence.some((item) => !item.trackingNumber)) {
      fail(
        'SHOPIFY_TEST_E2E_SANDBOX_LABELS_REQUIRED',
        'Every exact sandbox label requires tracking evidence',
      )
    }
    const confirmationHash = createHash('sha256').update(JSON.stringify({
      version: SHOPIFY_TEST_STORE_FULFILLMENT_CONFIRMATION_VERSION,
      statement: SHOPIFY_TEST_STORE_FULFILLMENT_CONFIRMATION,
      authorizationGlobalId: authority.global_id,
      orderGlobalId: authority.order_global_id,
      orderRowVersion: Number(authority.order_row_version),
      providerProofHash: authority.provider_proof_hash,
      labelEvidence,
      actorEmail: actor,
      reason: confirmationReason,
      notifyCustomer: false,
    })).digest('hex')
    const requestHash = createHash('sha256').update(JSON.stringify({
      schema: 'shopify-test-store-fulfillment-confirmation-request-v1',
      organizationId: scopedOrganizationId,
      authorizationGlobalId: authority.global_id,
      orderGlobalId: authority.order_global_id,
      confirmationHash,
    })).digest('hex')
    const inserted = await client.query<{
      confirmation_hash: string
      confirmed_at: Date | string
      label_evidence_hash: string
      idempotency_key: string
      request_hash: string
    }>(
      `INSERT INTO operations_shopify_test_store_e2e_fulfillment_confirmations (
         authorization_id, organization_id, order_id,
         confirmation_statement_version, confirmation_hash,
         label_evidence, label_evidence_hash,
         idempotency_key, request_hash, reason,
         confirmed_by
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4, $5,
         $6::jsonb,
         encode(digest(convert_to($6::jsonb::text, 'UTF8'), 'sha256'), 'hex'),
         $7, $8, $9, $10
       )
       ON CONFLICT DO NOTHING
       RETURNING confirmation_hash, confirmed_at, label_evidence_hash,
                 idempotency_key, request_hash`,
      [
        authority.id,
        scopedOrganizationId,
        authority.order_id,
        SHOPIFY_TEST_STORE_FULFILLMENT_CONFIRMATION_VERSION,
        confirmationHash,
        JSON.stringify(labelEvidence),
        key,
        requestHash,
        confirmationReason,
        actor,
      ],
    )
    let confirmation = inserted.rows[0]
    let replayed = false
    if (!confirmation) {
      const existing = await client.query<{
        confirmation_hash: string
        confirmed_at: Date | string
        confirmed_by: string
        label_evidence_hash: string
        authorization_id: string
        idempotency_key: string
        request_hash: string
      }>(
        `SELECT confirmation_hash, confirmed_at, confirmed_by,
                label_evidence_hash, authorization_id::text,
                idempotency_key, request_hash
         FROM operations_shopify_test_store_e2e_fulfillment_confirmations
         WHERE organization_id = $1::uuid
           AND (
             authorization_id = $2::uuid
             OR idempotency_key = $3
           )
         ORDER BY authorization_id = $2::uuid DESC
         LIMIT 2`,
        [scopedOrganizationId, authority.id, key],
      )
      if (
        existing.rows.length === 1
        && existing.rows[0]?.idempotency_key === key
        && existing.rows[0]?.request_hash !== requestHash
      ) {
        fail(
          'SHOPIFY_TEST_E2E_FULFILLMENT_IDEMPOTENCY_CONFLICT',
          'The fulfillment-confirmation idempotency key was already used for a different exact request',
        )
      }
      if (
        existing.rows.length !== 1
        || existing.rows[0]?.authorization_id !== authority.id
        || existing.rows[0]?.idempotency_key !== key
        || existing.rows[0]?.request_hash !== requestHash
        || existing.rows[0]?.confirmation_hash !== confirmationHash
        || existing.rows[0]?.confirmed_by !== actor
      ) {
        fail(
          'SHOPIFY_TEST_E2E_FULFILLMENT_CONFIRMATION_CONFLICT',
          'A different fulfillment confirmation already exists for this authorization',
        )
      }
      confirmation = existing.rows[0]
      replayed = true
    }
    await recordAuditEvent({
      actor,
      eventType: 'operations.shopify_test_store_e2e.fulfillment_confirmed',
      aggregateType: 'operations.order',
      aggregateId: authority.order_global_id,
      subject: authority.global_id,
      organizationId: scopedOrganizationId,
      eventKey:
        `operations:shopify-test-store-e2e-fulfillment:${authority.global_id}`,
      payload: {
        authorizationGlobalId: authority.global_id,
        providerProofHash: authority.provider_proof_hash,
        labelGlobalIds,
        labelEvidenceHash: confirmation.label_evidence_hash,
        idempotencyKey: key,
        requestHash,
        notifyCustomer: false,
        reason: confirmationReason,
      },
    }, client)
    return {
      authorizationGlobalId: authority.global_id,
      orderGlobalId: authority.order_global_id,
      confirmationHash,
      labelEvidenceHash: confirmation.label_evidence_hash,
      confirmedAt: new Date(confirmation.confirmed_at).toISOString(),
      notifyCustomer: false as const,
      replayed,
    }
  })
}

export async function requireExactShopifyTestStoreConfirmedLabelSnapshot(
  client: PoolClient,
  input: {
    organizationId: unknown
    authorizationGlobalId: unknown
    orderId: unknown
    labels: Array<{
      packageGlobalId: string
      labelGlobalId: string
      trackingNumber: string
      environment: string
    }>
  },
) {
  const scopedOrganizationId = organizationId(input.organizationId)
  const authorizationGlobalId = reference(
    input.authorizationGlobalId,
    AUTHORIZATION_GLOBAL_ID,
    'SHOPIFY_TEST_E2E_AUTHORIZATION_INVALID',
    'Shopify test E2E authorization',
  )
  const orderId = String(input.orderId || '').trim().toLowerCase()
  if (!UUID.test(orderId)) {
    fail('SHOPIFY_TEST_E2E_ORDER_INVALID', 'Operations order is invalid', 400)
  }
  const confirmation = await client.query<{
    label_evidence: unknown
  }>(
    `SELECT confirmation.label_evidence
     FROM operations_shopify_test_store_e2e_fulfillment_confirmations
       confirmation
     JOIN operations_sandbox_commerce_e2e_authorizations auth
       ON auth.organization_id = confirmation.organization_id
      AND auth.id = confirmation.authorization_id
      AND auth.order_id = confirmation.order_id
     WHERE confirmation.organization_id = $1::uuid
       AND auth.global_id = $2
       AND confirmation.order_id = $3::uuid
       AND confirmation.label_evidence_hash = encode(
         digest(
           convert_to(confirmation.label_evidence::text, 'UTF8'),
           'sha256'
         ),
         'hex'
       )
     FOR SHARE OF confirmation`,
    [scopedOrganizationId, authorizationGlobalId, orderId],
  )
  const persisted = confirmation.rows[0]?.label_evidence
  const normalizedPersisted = Array.isArray(persisted)
    ? persisted.map((item) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return null
        const evidence = item as Record<string, unknown>
        return {
          packageGlobalId: String(evidence.packageGlobalId || ''),
          labelGlobalId: String(evidence.labelGlobalId || ''),
          trackingNumber: String(evidence.trackingNumber || ''),
        }
      })
    : []
  const actual = input.labels.map((item) => ({
    packageGlobalId: String(item.packageGlobalId || ''),
    labelGlobalId: String(item.labelGlobalId || ''),
    trackingNumber: String(item.trackingNumber || ''),
  }))
  const orderEvidence = (left: typeof actual[number], right: typeof actual[number]) => (
    left.packageGlobalId.localeCompare(right.packageGlobalId)
    || left.labelGlobalId.localeCompare(right.labelGlobalId)
    || left.trackingNumber.localeCompare(right.trackingNumber)
  )
  const persistedEvidence = normalizedPersisted.filter(
    (item): item is Exclude<typeof item, null> => item !== null,
  )
  if (
    !confirmation.rows[0]
    || persistedEvidence.length !== normalizedPersisted.length
    || input.labels.some((item) => item.environment !== 'sandbox')
    || JSON.stringify(persistedEvidence.sort(orderEvidence))
      !== JSON.stringify(actual.sort(orderEvidence))
  ) {
    fail(
      'SHOPIFY_TEST_E2E_CONFIRMED_LABEL_EVIDENCE_CHANGED',
      'The current package, sandbox label, or tracking evidence changed after explicit fulfillment confirmation; no shipment was created',
      409,
    )
  }
  return { labelCount: actual.length }
}

export async function requireShopifyTestStoreFulfillmentWriteClaimInPostgres(
  input: {
    organizationId: unknown
    accountGlobalId: unknown
    externalOrderId: unknown
    authorizationGlobalId: unknown
    commerceExportGlobalId: unknown
  },
) {
  const scopedOrganizationId = organizationId(input.organizationId)
  const accountGlobalId = reference(
    input.accountGlobalId,
    ACCOUNT_GLOBAL_ID,
    'SHOPIFY_TEST_E2E_ACCOUNT_INVALID',
    'Shopify account',
  )
  const authorizationGlobalId = reference(
    input.authorizationGlobalId,
    AUTHORIZATION_GLOBAL_ID,
    'SHOPIFY_TEST_E2E_AUTHORIZATION_INVALID',
    'Shopify test E2E authorization',
  )
  const externalOrderId = reference(
    input.externalOrderId,
    SHOPIFY_ORDER_GID,
    'SHOPIFY_TEST_E2E_ORDER_INVALID',
    'Shopify order',
  )
  const commerceExportGlobalId = reference(
    input.commerceExportGlobalId,
    /^gfe(?:[0-9]{7}|[0-9a-v]{12})$/,
    'SHOPIFY_TEST_E2E_EXPORT_INVALID',
    'Commerce fulfillment export',
  )
  if (!shopifyOrderManagementAccountAllowed(accountGlobalId)) {
    fail(
      'SHOPIFY_TEST_E2E_ACCOUNT_NOT_ALLOWLISTED',
      'This Shopify sandbox account is not enabled for exact test-order writes',
      403,
    )
  }
  const result = await query<{
    credential_generation: number
    external_account_id: string
    authorized_by: string
    confirmed_by: string
  }>(
    `SELECT evidence.credential_generation, evidence.external_account_id,
            auth.authorized_by, confirmation.confirmed_by
     FROM operations_sandbox_commerce_e2e_authorizations auth
     JOIN operations_shopify_test_store_e2e_evidence evidence
       ON evidence.organization_id = auth.organization_id
      AND evidence.authorization_id = auth.id
      AND evidence.confirmation_hash = auth.confirmation_hash
     JOIN operations_shopify_test_store_e2e_fulfillment_confirmations
       confirmation
       ON confirmation.organization_id = auth.organization_id
      AND confirmation.authorization_id = auth.id
      AND confirmation.order_id = auth.order_id
     JOIN operations_orders source_order
       ON source_order.organization_id = auth.organization_id
      AND source_order.id = auth.order_id
     JOIN operations_integration_accounts account
       ON account.organization_id = evidence.organization_id
      AND account.id = evidence.integration_account_id
     JOIN operations_commerce_credentials credential
       ON credential.organization_id = account.organization_id
      AND credential.integration_account_id = account.id
     JOIN operations_commerce_order_candidates candidate
       ON candidate.organization_id = evidence.organization_id
      AND candidate.id = evidence.order_candidate_id
     JOIN operations_commerce_fulfillment_exports export
       ON export.organization_id = auth.organization_id
      AND export.order_id = auth.order_id
      AND export.global_id = $5
     WHERE auth.organization_id = $1::uuid
       AND auth.global_id = $2
       AND auth.state = 'consumed'
       AND auth.consumed_by = auth.authorized_by
       AND auth.confirmation_statement_version = 'shopify-test-store-canonical-e2e-v1'
       AND confirmation.confirmed_by = auth.authorized_by
       AND source_order.status = 'shipped'
       AND source_order.source_provider = 'shopify'
       AND source_order.external_order_id = $3
       AND account.global_id = $4
       AND account.environment = 'sandbox'
       AND account.status = 'active'
       AND account.commerce_credential_generation =
             evidence.credential_generation
       AND credential.credential_version = evidence.credential_generation
       AND credential.external_account_id = evidence.external_account_id
       AND credential.verification_status = 'verified'
       AND candidate.integration_account_id = account.id
       AND candidate.canonical_order_id = source_order.id
       AND candidate.workflow_state = 'promoted'
       AND candidate.test_order = true
       AND candidate.global_id = evidence.order_candidate_global_id
       AND candidate.row_version = evidence.order_candidate_row_version
       AND candidate.source_revision = evidence.order_candidate_source_revision
       AND candidate.source_hash = evidence.order_candidate_source_hash
       AND evidence.provider_test = true
       AND export.provider = 'shopify'
       AND export.external_order_id = $3
       AND export.state = 'processing'
       AND export.payload_snapshot->>'sandboxE2eAuthorizationGlobalId' = $2
       AND export.payload_snapshot->>'sandboxE2eAuthorityKind'
             = 'shopify_test_store_canonical'
       AND export.payload_snapshot->'customerNotification'->>'notifyCustomer'
             = 'false'
       AND confirmation.label_evidence_hash = encode(
         digest(
           convert_to(confirmation.label_evidence::text, 'UTF8'),
           'sha256'
         ),
         'hex'
       )
       AND jsonb_array_length(confirmation.label_evidence) = (
         SELECT count(*)
         FROM operations_shipments exact_shipment
         WHERE exact_shipment.organization_id = auth.organization_id
           AND exact_shipment.order_id = auth.order_id
       )
       AND NOT EXISTS (
         SELECT 1
         FROM jsonb_array_elements(confirmation.label_evidence) item
         WHERE NOT EXISTS (
           SELECT 1
           FROM operations_shipments exact_shipment
           JOIN operations_labels exact_label
             ON exact_label.organization_id = exact_shipment.organization_id
            AND exact_label.id = exact_shipment.label_id
           JOIN operations_packages exact_package
             ON exact_package.organization_id = exact_shipment.organization_id
            AND exact_package.id = exact_shipment.package_id
           WHERE exact_shipment.organization_id = auth.organization_id
             AND exact_shipment.order_id = auth.order_id
             AND exact_label.global_id = item->>'labelGlobalId'
             AND exact_label.status = 'created'
             AND exact_label.environment = 'sandbox'
             AND exact_label.tracking_number = item->>'trackingNumber'
             AND exact_package.global_id = item->>'packageGlobalId'
             AND exact_shipment.tracking_number = item->>'trackingNumber'
         )
       )
       AND (
         SELECT array_agg(tracking.value ORDER BY tracking.value)
         FROM jsonb_array_elements_text(
           export.payload_snapshot->'trackingNumbers'
         ) tracking(value)
       ) = (
         SELECT array_agg(item->>'trackingNumber' ORDER BY item->>'trackingNumber')
         FROM jsonb_array_elements(confirmation.label_evidence) item
       )
     LIMIT 1`,
    [
      scopedOrganizationId,
      authorizationGlobalId,
      externalOrderId,
      accountGlobalId,
      commerceExportGlobalId,
    ],
  )
  const claim = result.rows[0]
  if (!claim) {
    fail(
      'SHOPIFY_TEST_E2E_FULFILLMENT_CLAIM_INVALID',
      'No exact consumed Shopify test-store fulfillment claim matches this export',
      403,
    )
  }
  return {
    authorityKind: 'shopify_test_store_canonical' as const,
    credentialGeneration: claim.credential_generation,
    externalAccountId: claim.external_account_id,
    authorizedBy: claim.authorized_by,
    notifyCustomer: false as const,
  }
}
