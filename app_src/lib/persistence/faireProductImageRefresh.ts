import type { PoolClient, QueryResultRow } from 'pg'
import {
  FaireProductImageRefreshError,
  type FaireProductImageRefreshTarget,
} from '@/lib/integrations/faireProductImageRefreshTypes'
import {
  reconcileCommerceProductImageSetWithClient,
  type ReconcileCommerceProductImageSetInput,
  type ReconcileCommerceProductImageSetResult,
} from '@/lib/persistence/commerceProductImageImports'
import {
  acquireTransactionAdvisoryLock,
  withTransaction,
} from '@/lib/persistence/postgres'

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const ACCOUNT_GLOBAL_PATTERN = /^gia(?:[0-9]{7}|[0-9a-v]{12})$/
const CHANNEL_GLOBAL_PATTERN = /^gpcs(?:[0-9]{7}|[0-9a-v]{12})$/
const PRODUCT_REFERENCE_PATTERN = /^gp(?:[0-9]{7}|[0-9a-v]{12})$/

type TargetRow = QueryResultRow & {
  organization_id: string
  product_id: string
  product_reference_code: string
  product_name: string
  integration_account_id: string
  integration_account_global_id: string
  credential_generation: string | number
  channel_state_global_id: string
  channel_state_row_version: string | number
  channel_source_revision: string
  external_product_id: string
  external_variant_id: string
  provider_sku: string | null
  conflicting_product_count: string | number
}

function fail(code: string, message: string, status = 400): never {
  throw new FaireProductImageRefreshError(code, message, status)
}

function integer(value: unknown, label: string, minimum = 0) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    fail(
      'FAIRE_PRODUCT_IMAGE_REFRESH_EVIDENCE_INVALID',
      `Stored Faire Product image ${label} is invalid`,
      500,
    )
  }
  return parsed
}

function targetFromRow(row: TargetRow | undefined) {
  if (
    !row
    || !UUID_PATTERN.test(row.organization_id)
    || !UUID_PATTERN.test(row.product_id)
    || !UUID_PATTERN.test(row.integration_account_id)
    || !ACCOUNT_GLOBAL_PATTERN.test(row.integration_account_global_id)
    || !CHANNEL_GLOBAL_PATTERN.test(row.channel_state_global_id)
    || !PRODUCT_REFERENCE_PATTERN.test(row.product_reference_code)
    || !row.product_name
    || !row.channel_source_revision
    || !row.external_product_id
    || !row.external_variant_id
    || !row.provider_sku
  ) {
    fail(
      'FAIRE_PRODUCT_IMAGE_REFRESH_TARGET_NOT_FOUND',
      'The exact mapped Faire Product was not found in the active organization',
      404,
    )
  }
  if (integer(
    row.conflicting_product_count,
    'parent Product mapping count',
  ) !== 0) {
    fail(
      'FAIRE_PRODUCT_IMAGE_REFRESH_TARGET_AMBIGUOUS',
      'This Faire parent Product is mapped to more than one ClawPilot Product',
      409,
    )
  }
  return Object.freeze({
    organizationId: row.organization_id,
    productId: row.product_id,
    productReferenceCode: row.product_reference_code,
    productName: row.product_name,
    integrationAccountId: row.integration_account_id,
    integrationAccountGlobalId: row.integration_account_global_id,
    credentialGeneration: integer(
      row.credential_generation,
      'credential generation',
      1,
    ),
    channelStateGlobalId: row.channel_state_global_id,
    channelStateRowVersion: integer(
      row.channel_state_row_version,
      'channel row version',
    ),
    channelSourceRevision: row.channel_source_revision,
    externalProductId: row.external_product_id,
    externalVariantId: row.external_variant_id,
    providerSku: row.provider_sku,
  }) satisfies FaireProductImageRefreshTarget
}

async function readTargetWithClient(
  client: PoolClient,
  input: {
    organizationId: string
    productId: string
    channelStateGlobalId: string
    lock?: boolean
  },
) {
  const result = await client.query<TargetRow>(
    `SELECT
       account.organization_id::text,
       product.id::text AS product_id,
       product.reference_code AS product_reference_code,
       product.name AS product_name,
       account.id::text AS integration_account_id,
       account.global_id AS integration_account_global_id,
       credential.credential_version::text AS credential_generation,
       channel_state.global_id AS channel_state_global_id,
       channel_state.row_version::text AS channel_state_row_version,
       channel_state.source_revision AS channel_source_revision,
       channel_state.external_product_id,
       channel_state.external_variant_id,
       channel_state.provider_sku,
       (
         SELECT count(*)
         FROM operations_product_channel_states sibling
         WHERE sibling.organization_id = channel_state.organization_id
           AND sibling.integration_account_id =
                 channel_state.integration_account_id
           AND sibling.provider = 'faire'
           AND sibling.external_product_id =
                 channel_state.external_product_id
           AND sibling.product_id IS NOT NULL
           AND sibling.product_id <> channel_state.product_id
       )::text AS conflicting_product_count
     FROM operations_product_channel_states channel_state
     JOIN operations_integration_accounts account
       ON account.organization_id = channel_state.organization_id
      AND account.id = channel_state.integration_account_id
     JOIN operations_commerce_credentials credential
       ON credential.organization_id = account.organization_id
      AND credential.integration_account_id = account.id
     JOIN crm_products product
       ON product.pipeline_id = channel_state.pipeline_id
      AND product.id = channel_state.product_id
     JOIN pipeline_spaces pipeline
       ON pipeline.id = product.pipeline_id
      AND pipeline.workspace_organization_id = account.organization_id
     JOIN operations_product_mappings product_mapping
       ON product_mapping.organization_id = channel_state.organization_id
      AND product_mapping.integration_account_id =
            channel_state.integration_account_id
      AND product_mapping.pipeline_id = channel_state.pipeline_id
      AND product_mapping.id = channel_state.product_mapping_id
      AND product_mapping.product_id = channel_state.product_id
      AND product_mapping.external_product_id =
            channel_state.external_product_id
      AND product_mapping.external_variant_id =
            channel_state.external_variant_id
      AND product_mapping.active = true
     WHERE account.organization_id = $1::uuid
       AND product.id = $2::uuid
       AND channel_state.global_id = $3
       AND channel_state.provider = 'faire'
       AND channel_state.normalized_status = 'active'
       AND channel_state.provider_active = true
       AND account.integration_type = 'commerce'
       AND account.provider = 'faire'
       AND account.status = 'active'
       AND operations_commerce_store_sync_is_running(
         account.organization_id,
         account.id
       )
       AND credential.verification_status = 'verified'
       AND credential.external_account_id = account.external_account_id
       AND credential.credential_version =
             account.commerce_credential_generation
     LIMIT 1${input.lock
      ? ' FOR SHARE OF channel_state, account, credential, product, product_mapping'
      : ''}`,
    [input.organizationId, input.productId, input.channelStateGlobalId],
  )
  return targetFromRow(result.rows[0])
}

export async function readFaireProductImageRefreshTargetInPostgres(input: {
  organizationId: string
  productId: string
  channelStateGlobalId: string
}): Promise<FaireProductImageRefreshTarget> {
  return withTransaction((client) => readTargetWithClient(client, input))
}

function sameTarget(
  left: FaireProductImageRefreshTarget,
  right: FaireProductImageRefreshTarget,
) {
  return left.organizationId === right.organizationId
    && left.productId === right.productId
    && left.productReferenceCode === right.productReferenceCode
    && left.productName === right.productName
    && left.integrationAccountId === right.integrationAccountId
    && left.integrationAccountGlobalId === right.integrationAccountGlobalId
    && left.credentialGeneration === right.credentialGeneration
    && left.channelStateGlobalId === right.channelStateGlobalId
    && left.channelStateRowVersion === right.channelStateRowVersion
    && left.channelSourceRevision === right.channelSourceRevision
    && left.externalProductId === right.externalProductId
    && left.externalVariantId === right.externalVariantId
    && left.providerSku === right.providerSku
}

/**
 * Revalidate the reviewed local mapping and credential fence in the same
 * transaction that records the read-only Faire image observations. The
 * provider read happens before this function and no Faire mutation is
 * possible from this persistence boundary.
 */
export async function reconcileExactFaireProductImageRefreshInPostgres(input: {
  target: FaireProductImageRefreshTarget
  observedAt: Date | string
  productSourceHash: string
  actorEmail: string
  images: ReconcileCommerceProductImageSetInput['images']
}): Promise<ReconcileCommerceProductImageSetResult> {
  return withTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(
      client,
      `faire-product-image-refresh:${input.target.organizationId}:${input.target.channelStateGlobalId}`,
    )
    const current = await readTargetWithClient(client, {
      organizationId: input.target.organizationId,
      productId: input.target.productId,
      channelStateGlobalId: input.target.channelStateGlobalId,
      lock: true,
    })
    if (!sameTarget(current, input.target)) {
      fail(
        'FAIRE_PRODUCT_IMAGE_REFRESH_TARGET_STALE',
        'The selected Faire Product or credential changed during the read-only refresh',
        409,
      )
    }
    return reconcileCommerceProductImageSetWithClient({
      organizationId: current.organizationId,
      integrationAccountId: current.integrationAccountId,
      provider: 'faire',
      credentialGeneration: current.credentialGeneration,
      externalProductId: current.externalProductId,
      productSourceHash: input.productSourceHash,
      productLifecycle: 'active',
      // The exact source reader returns only valid current locators but does
      // not attest that Faire supplied a structurally complete collection.
      // A targeted refresh may add/update images; it must never infer removals.
      imageSetComplete: false,
      observedAt: input.observedAt,
      actorEmail: input.actorEmail,
      images: input.images,
    }, client)
  })
}
