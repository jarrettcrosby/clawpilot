import type { PoolClient } from 'pg'
import {
  normalizeCommerceAccountGlobalId,
  normalizeCommerceOrganizationId,
} from '@/lib/integrations/commerceCredentialCrypto'
import { getPostgresPool } from '@/lib/persistence/postgres'

const CANDIDATE_GLOBAL_ID = /^gcoc(?:[0-9]{7}|[0-9a-v]{12})$/
const WAREHOUSE_GLOBAL_ID = /^gwh(?:[0-9]{7}|[0-9a-v]{12})$/
const SHOPIFY_ORDER_GID = /^gid:\/\/shopify\/Order\/[1-9][0-9]*$/
const SHOPIFY_LINE_ITEM_GID = /^gid:\/\/shopify\/LineItem\/[1-9][0-9]*$/
const SHOPIFY_LOCATION_GID = /^gid:\/\/shopify\/Location\/[1-9][0-9]*$/

export type ShopifyOrderPlanningAuthorityTarget = {
  organizationId: string
  accountGlobalId: string
  candidate: {
    globalId: string
    rowVersion: number
    sourceHash: string
  }
  warehouse: {
    globalId: string
    locationMappingGlobalId: string
    locationMappingRowVersion: number
    shopifyLocationId: string
  }
  externalOrderId: string
  lines: Array<{
    candidateLineGlobalId: string
    canonicalLineGlobalId: string
    externalLineId: string
    quantity: number
  }>
}

export class ShopifyOrderPlanningAuthorityPersistenceError extends Error {
  constructor(
    message: string,
    readonly status = 409,
    readonly code = 'SHOPIFY_ORDER_PLANNING_CONTEXT_INVALID',
  ) {
    super(message)
    this.name = 'ShopifyOrderPlanningAuthorityPersistenceError'
  }
}

export async function readOperationalOrderPlanningProviderFromPostgres(input: {
  organizationId: string
  accountGlobalId: string
  candidateGlobalId: string
  expectedCandidateRowVersion: number
}): Promise<'shopify' | 'faire'> {
  const result = await getPostgresPool().query<{
    provider: 'shopify' | 'faire'
    row_version: string
    workflow_state: string
    canonical_order_id: string | null
  }>(
    `SELECT account.provider, candidate.row_version::text,
       candidate.workflow_state, candidate.canonical_order_id::text
     FROM operations_integration_accounts account
     JOIN operations_commerce_order_candidates candidate
       ON candidate.organization_id = account.organization_id
      AND candidate.integration_account_id = account.id
     WHERE account.organization_id = $1::uuid
       AND account.global_id = $2
       AND account.integration_type = 'commerce'
       AND account.provider IN ('shopify', 'faire')
       AND candidate.global_id = $3
     LIMIT 1`,
    [input.organizationId, input.accountGlobalId, input.candidateGlobalId],
  )
  const row = result.rows[0]
  if (!row) {
    fail(
      'The exact operational commerce order context is unavailable',
      409,
      'SHOPIFY_ORDER_PLANNING_CONTEXT_UNAVAILABLE',
    )
  }
  if (exactInteger(row.row_version, 'Candidate row version')
      !== input.expectedCandidateRowVersion) {
    fail(
      'The commerce order candidate changed; refresh before rating',
      409,
      'SHOPIFY_ORDER_PLANNING_CANDIDATE_STALE',
    )
  }
  if (row.workflow_state !== 'promoted' || !row.canonical_order_id) {
    fail(
      'Only an exact promoted commerce order can use operational rating',
      422,
      'SHOPIFY_ORDER_PLANNING_CANDIDATE_NOT_PROMOTED',
    )
  }
  return row.provider
}

function fail(message: string, status = 409, code?: string): never {
  throw new ShopifyOrderPlanningAuthorityPersistenceError(
    message,
    status,
    code || 'SHOPIFY_ORDER_PLANNING_CONTEXT_INVALID',
  )
}

function exactReference(value: unknown, pattern: RegExp, label: string) {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (!pattern.test(normalized)) {
    fail(`${label} is invalid`, 400, 'SHOPIFY_ORDER_PLANNING_INPUT_INVALID')
  }
  return normalized
}

function exactInteger(value: unknown, label: string, minimum = 0) {
  const normalized = typeof value === 'string' ? value : String(value)
  if (!/^(?:0|[1-9][0-9]*)(?:\.0+)?$/.test(normalized)) {
    fail(
      `${label} must be an exact whole number`,
      500,
      'SHOPIFY_ORDER_PLANNING_CONTEXT_CORRUPT',
    )
  }
  const parsed = Number(normalized)
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    fail(
      `${label} is outside the supported range`,
      500,
      'SHOPIFY_ORDER_PLANNING_CONTEXT_CORRUPT',
    )
  }
  return parsed
}

function normalizeInput(input: {
  organizationId: unknown
  accountGlobalId: unknown
  candidateGlobalId: unknown
  expectedCandidateRowVersion: unknown
  warehouseGlobalId: unknown
}) {
  const expectedCandidateRowVersion = Number(input.expectedCandidateRowVersion)
  if (!Number.isSafeInteger(expectedCandidateRowVersion) || expectedCandidateRowVersion < 0) {
    fail(
      'Expected candidate row version is invalid',
      400,
      'SHOPIFY_ORDER_PLANNING_INPUT_INVALID',
    )
  }
  return {
    organizationId: normalizeCommerceOrganizationId(input.organizationId),
    accountGlobalId: normalizeCommerceAccountGlobalId(input.accountGlobalId),
    candidateGlobalId: exactReference(
      input.candidateGlobalId,
      CANDIDATE_GLOBAL_ID,
      'Commerce order candidate',
    ),
    expectedCandidateRowVersion,
    warehouseGlobalId: exactReference(
      input.warehouseGlobalId,
      WAREHOUSE_GLOBAL_ID,
      'Warehouse',
    ),
  }
}

type ContextRow = {
  account_global_id: string
  candidate_global_id: string
  candidate_row_version: string
  candidate_source_hash: string
  external_order_id: string
  candidate_workflow_state: string
  canonical_order_id: string | null
  warehouse_global_id: string
  location_mapping_global_id: string | null
  location_mapping_row_version: string | null
  external_location_id: string | null
}

type LineRow = {
  candidate_line_global_id: string
  canonical_line_global_id: string | null
  candidate_external_line_id: string
  canonical_external_line_id: string | null
  candidate_unfulfilled_quantity: string
  canonical_quantity: string | null
}

async function readTarget(
  client: PoolClient,
  input: ReturnType<typeof normalizeInput>,
): Promise<ShopifyOrderPlanningAuthorityTarget> {
  const contextResult = await client.query<ContextRow>(
    `SELECT
       account.global_id AS account_global_id,
       candidate.global_id AS candidate_global_id,
       candidate.row_version::text AS candidate_row_version,
       candidate.source_hash AS candidate_source_hash,
       candidate.external_order_id,
       candidate.workflow_state AS candidate_workflow_state,
       candidate.canonical_order_id::text,
       warehouse.global_id AS warehouse_global_id,
       mapping.global_id AS location_mapping_global_id,
       mapping.row_version::text AS location_mapping_row_version,
       mapping.external_location_id
     FROM operations_integration_accounts account
     JOIN operations_commerce_order_candidates candidate
       ON candidate.organization_id = account.organization_id
      AND candidate.integration_account_id = account.id
     JOIN operations_warehouses warehouse
       ON warehouse.organization_id = account.organization_id
     LEFT JOIN operations_commerce_inventory_location_mappings mapping
       ON mapping.organization_id = account.organization_id
      AND mapping.integration_account_id = account.id
      AND mapping.warehouse_id = warehouse.id
      AND mapping.active = true
     WHERE account.organization_id = $1::uuid
       AND account.global_id = $2
       AND account.integration_type = 'commerce'
       AND account.provider = 'shopify'
       AND account.status = 'active'
       AND candidate.global_id = $3
       AND warehouse.global_id = $4
       AND warehouse.status = 'active'
     LIMIT 2`,
    [
      input.organizationId,
      input.accountGlobalId,
      input.candidateGlobalId,
      input.warehouseGlobalId,
    ],
  )
  if (contextResult.rows.length !== 1) {
    fail(
      'The exact active Shopify order, account, and warehouse context is unavailable',
      409,
      'SHOPIFY_ORDER_PLANNING_CONTEXT_UNAVAILABLE',
    )
  }
  const row = contextResult.rows[0]
  const candidateRowVersion = exactInteger(
    row.candidate_row_version,
    'Candidate row version',
  )
  if (candidateRowVersion !== input.expectedCandidateRowVersion) {
    fail(
      'The Shopify order candidate changed; refresh before rating',
      409,
      'SHOPIFY_ORDER_PLANNING_CANDIDATE_STALE',
    )
  }
  if (row.candidate_workflow_state !== 'promoted' || !row.canonical_order_id) {
    fail(
      'Only an exact promoted Shopify order can use operational rating',
      422,
      'SHOPIFY_ORDER_PLANNING_CANDIDATE_NOT_PROMOTED',
    )
  }
  if (
    !row.location_mapping_global_id
    || row.location_mapping_row_version === null
    || !row.external_location_id
    || !SHOPIFY_LOCATION_GID.test(row.external_location_id)
  ) {
    fail(
      'The selected warehouse has no current exact Shopify location mapping',
      409,
      'SHOPIFY_ORDER_PLANNING_LOCATION_MAPPING_REQUIRED',
    )
  }
  if (!SHOPIFY_ORDER_GID.test(row.external_order_id)) {
    fail(
      'The promoted order has an invalid Shopify order identity',
      500,
      'SHOPIFY_ORDER_PLANNING_CONTEXT_CORRUPT',
    )
  }

  const linesResult = await client.query<LineRow>(
    `SELECT
       candidate_line.global_id AS candidate_line_global_id,
       canonical_line.global_id AS canonical_line_global_id,
       candidate_line.external_line_id AS candidate_external_line_id,
       canonical_line.external_line_id AS canonical_external_line_id,
       candidate_line.unfulfilled_quantity::text
         AS candidate_unfulfilled_quantity,
       canonical_line.quantity::text AS canonical_quantity
     FROM operations_commerce_order_candidate_lines candidate_line
     LEFT JOIN operations_order_lines canonical_line
       ON canonical_line.organization_id = candidate_line.organization_id
      AND canonical_line.id = candidate_line.canonical_order_line_id
      AND canonical_line.order_id = $4::uuid
     WHERE candidate_line.organization_id = $1::uuid
       AND candidate_line.integration_account_id = (
         SELECT id
         FROM operations_integration_accounts
         WHERE organization_id = $1::uuid
           AND global_id = $2
         LIMIT 1
       )
       AND candidate_line.order_candidate_id = (
         SELECT id
         FROM operations_commerce_order_candidates
         WHERE organization_id = $1::uuid
           AND global_id = $3
         LIMIT 1
       )
       AND candidate_line.requires_shipping = true
       AND candidate_line.unfulfilled_quantity > 0
     ORDER BY candidate_line.external_line_id, candidate_line.global_id`,
    [
      input.organizationId,
      input.accountGlobalId,
      input.candidateGlobalId,
      row.canonical_order_id,
    ],
  )
  if (linesResult.rows.length < 1 || linesResult.rows.length > 250) {
    fail(
      'The promoted Shopify order has no bounded canonical shipping-line set to rate',
      422,
      'SHOPIFY_ORDER_PLANNING_LINES_REQUIRED',
    )
  }
  const externalLineIds = new Set<string>()
  const lines = linesResult.rows.map((line) => {
    const candidateQuantity = exactInteger(
      line.candidate_unfulfilled_quantity,
      `${line.candidate_line_global_id} candidate quantity`,
      1,
    )
    if (
      !line.canonical_line_global_id
      || !line.canonical_external_line_id
      || line.canonical_quantity === null
      || line.canonical_external_line_id !== line.candidate_external_line_id
    ) {
      fail(
        'The promoted Shopify candidate no longer has exact canonical line lineage',
        409,
        'SHOPIFY_ORDER_PLANNING_CANONICAL_LINES_INVALID',
      )
    }
    const canonicalQuantity = exactInteger(
      line.canonical_quantity,
      `${line.canonical_line_global_id} canonical quantity`,
      1,
    )
    if (
      candidateQuantity !== canonicalQuantity
      || !SHOPIFY_LINE_ITEM_GID.test(line.candidate_external_line_id)
      || externalLineIds.has(line.candidate_external_line_id)
    ) {
      fail(
        'The promoted Shopify candidate and canonical order lines do not match exactly',
        409,
        'SHOPIFY_ORDER_PLANNING_CANONICAL_LINES_INVALID',
      )
    }
    externalLineIds.add(line.candidate_external_line_id)
    return {
      candidateLineGlobalId: line.candidate_line_global_id,
      canonicalLineGlobalId: line.canonical_line_global_id,
      externalLineId: line.candidate_external_line_id,
      quantity: canonicalQuantity,
    }
  })
  return {
    organizationId: input.organizationId,
    accountGlobalId: row.account_global_id,
    candidate: {
      globalId: row.candidate_global_id,
      rowVersion: candidateRowVersion,
      sourceHash: row.candidate_source_hash,
    },
    warehouse: {
      globalId: row.warehouse_global_id,
      locationMappingGlobalId: row.location_mapping_global_id,
      locationMappingRowVersion: exactInteger(
        row.location_mapping_row_version,
        'Shopify location mapping row version',
      ),
      shopifyLocationId: row.external_location_id,
    },
    externalOrderId: row.external_order_id,
    lines,
  }
}

export async function readShopifyOrderPlanningAuthorityTargetFromPostgres(
  rawInput: {
    organizationId: unknown
    accountGlobalId: unknown
    candidateGlobalId: unknown
    expectedCandidateRowVersion: unknown
    warehouseGlobalId: unknown
  },
): Promise<ShopifyOrderPlanningAuthorityTarget> {
  const input = normalizeInput(rawInput)
  const client = await getPostgresPool().connect()
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    const target = await readTarget(client, input)
    await client.query('COMMIT')
    return target
  } catch (error) {
    try {
      await client.query('ROLLBACK')
    } catch {
      // Preserve the exact context failure.
    }
    throw error
  } finally {
    client.release()
  }
}
