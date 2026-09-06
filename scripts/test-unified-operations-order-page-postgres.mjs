#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import {
  applyMigration,
  command,
  loadTypeScriptModule,
  migrations,
  waitForPostgres,
} from './test-commerce-order-revisions-postgres.mjs'

const root = process.cwd()
const requireFromApp = createRequire(
  new URL('../app_src/package.json', import.meta.url),
)
const { Pool } = requireFromApp('pg')

class OperationsRequestError extends Error {
  constructor(code, message, status = 400) {
    super(message)
    this.code = code
    this.status = status
  }
}

function sourceCursor(row, total) {
  return Buffer.from(JSON.stringify({ v: 1, id: row.id, total }), 'utf8')
    .toString('base64url')
}

function decodeSourceCursor(value) {
  if (!value) return null
  return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
}

function sourceSortValue(row, sort) {
  if (sort === 'updated' || sort === 'order_date') {
    return row.updated_at.toISOString()
  }
  if (sort === 'order_number') return row.order_number
  return row.customer_name.toLowerCase()
}

function compareText(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'))
}

function compareRows(unifiedDomain, left, right, sort, direction) {
  const primary = unifiedDomain.compareUnifiedOperationsOrderSortValues({
    left: sourceSortValue(left, sort),
    right: sourceSortValue(right, sort),
    sort,
    direction,
    leftProvider: left.provider,
    rightProvider: right.provider,
  })
  if (primary) return primary
  if (left.source !== right.source) return left.source === 'canonical' ? -1 : 1
  return compareText(left.id, right.id)
}

function resultSetRevision(rows, sort) {
  if (!rows.length) return 'd41d8cd98f00b204e9800998ecf8427e'
  const evidence = [...rows]
    .sort((left, right) => compareText(
      `${left.source}:${left.id}`,
      `${right.source}:${right.id}`,
    ))
    .map((row) => [
      row.source,
      row.id,
      row.provider,
      row.order_number,
      row.customer_name,
      sourceSortValue(row, sort),
    ])
  return createHash('md5').update(JSON.stringify(evidence)).digest('hex')
}

function sourceReader(table, kind, hooks, unifiedDomain) {
  return async (input) => {
    const selectedIds = input.selectedIds === undefined
      ? null
      : [...input.selectedIds]
    hooks.reads.push({
      source: kind,
      cursor: input.cursor || null,
      offset: input.offset,
      pageSize: input.pageSize,
      selectedIds,
    })
    assert.ok(input.queryClient, 'Unified reads must supply one snapshot client')
    assert.equal(
      Boolean(input.cursor && input.offset !== undefined),
      false,
      'A source read must not combine cursor and offset',
    )
    const result = await input.queryClient.query(
      `SELECT id::text, global_id, integration_account_global_id,
              external_order_id, order_number, customer_name, updated_at,
              provider
       FROM ${table}
       WHERE organization_id = $1::uuid
         AND ($2::uuid[] IS NULL OR id = ANY($2::uuid[]))`,
      [input.organizationId, selectedIds],
    )
    const allRows = result.rows.map((item) => ({ ...item, source: kind }))
      .sort((left, right) => compareRows(
        unifiedDomain,
        left,
        right,
        input.sort,
        input.direction,
      ))
    const decoded = decodeSourceCursor(input.cursor)
    const cursorIndex = decoded
      ? allRows.findIndex((item) => item.id === decoded.id)
      : -1
    const remaining = decoded
      ? cursorIndex < 0 ? allRows : allRows.slice(cursorIndex + 1)
      : allRows.slice(input.offset || 0)
    const selected = remaining.slice(0, input.pageSize)
    const hasNext = remaining.length > input.pageSize
    const total = allRows.length
    const evidence = selected.map((item) => ({
      rowCursor: sourceCursor(item, total),
      sortValue: sourceSortValue(item, input.sort),
      providerIdentity: {
        integrationAccountGlobalId: item.integration_account_global_id,
        externalOrderId: item.external_order_id,
      },
      provider: item.provider,
    }))
    const nextCursor = hasNext && selected.length
      ? sourceCursor(selected.at(-1), total)
      : null
    return {
      orders: selected.map((item) => kind === 'canonical'
        ? {
            globalId: item.global_id,
            orderNumber: item.order_number,
            customerName: item.customer_name,
            updatedAt: item.updated_at.toISOString(),
          }
        : {
            candidateGlobalId: item.global_id,
            orderNumber: item.order_number,
            customer: { name: item.customer_name },
            updatedAt: item.updated_at.toISOString(),
          }),
      page: {
        total,
        returned: selected.length,
        pageSize: input.pageSize,
        nextCursor,
        complete: nextCursor === null,
        truncated: nextCursor !== null,
      },
      internal: {
        rowCursors: evidence.map((item) => item.rowCursor),
        sortValues: evidence.map((item) => item.sortValue),
        providerIdentities: evidence.map((item) => item.providerIdentity),
        sourceEvidence: evidence,
        resultSetRevision: resultSetRevision(allRows, input.sort),
        databaseIds: selected.map((item) => item.id),
      },
    }
  }
}

function indexReader(hooks, unifiedDomain) {
  return async (input) => {
    hooks.reads.push({
      source: 'index',
      page: input.page,
      pageSize: input.pageSize,
    })
    const result = await input.client.query(
      `SELECT 'canonical'::text AS source, id::text, global_id,
              integration_account_global_id, external_order_id, order_number,
              customer_name, updated_at, provider
       FROM unified_test_canonical
       WHERE organization_id = $1::uuid
       UNION ALL
       SELECT 'imported'::text AS source, id::text, global_id,
              integration_account_global_id, external_order_id, order_number,
              customer_name, updated_at, provider
       FROM unified_test_imported
       WHERE organization_id = $1::uuid`,
      [input.organizationId],
    )
    if (hooks.afterIndexRead) {
      const hook = hooks.afterIndexRead
      hooks.afterIndexRead = null
      await hook()
    }
    const search = input.search.toLowerCase()
    const matching = result.rows
      .filter((item) => !input.provider || item.provider === input.provider)
      .filter((item) => !input.updatedAfter
        || item.updated_at.getTime() > Date.parse(input.updatedAfter))
      .filter((item) => !search || [
        item.global_id,
        item.external_order_id,
        item.order_number,
        item.customer_name,
        item.provider,
      ].some((value) => String(value).toLowerCase().includes(search)))
      .sort((left, right) => compareRows(
        unifiedDomain,
        left,
        right,
        input.sort,
        input.direction,
      ))
    const total = matching.length
    const requestedOffset = (input.page - 1) * input.pageSize
    const offset = total === 0
      ? 0
      : Math.min(
        requestedOffset,
        Math.floor((total - 1) / input.pageSize) * input.pageSize,
      )
    return {
      total,
      offset,
      revision: resultSetRevision(matching, input.sort),
      entries: matching.slice(offset, offset + input.pageSize).map((item) => ({
        source: item.source,
        rowId: item.id,
        provider: item.provider,
        integrationAccountGlobalId: item.integration_account_global_id,
        externalOrderId: item.external_order_id,
      })),
    }
  }
}

function inertModuleProxy() {
  const inert = () => undefined
  let proxy
  proxy = new Proxy(inert, {
    apply() {
      return undefined
    },
    construct() {
      return {}
    },
    get(_target, property) {
      if (property === 'prototype') return {}
      return proxy
    },
  })
  return proxy
}

function productionOrderSqlHelpers(orderListQuery) {
  const source = readFileSync(
    resolve(root, 'app_src/lib/persistence/operations.ts'),
    'utf8',
  )
  const inert = inertModuleProxy()
  const mocks = Object.fromEntries(
    [...source.matchAll(/from\s+['"]([^'"]+)['"]/gu)]
      .map((match) => match[1])
      .filter((specifier) => (
        specifier !== 'pg' && !specifier.startsWith('node:')
      ))
      .map((specifier) => [specifier, inert]),
  )
  mocks['@/lib/operations/orderListQuery'] = orderListQuery
  const operations = loadTypeScriptModule(
    'app_src/lib/persistence/operations.ts',
    mocks,
  )
  for (const exportName of [
    'externallyFulfilledOrderSql',
    'latestExternalReconciliationTrackingSql',
    'latestProviderTrackingSql',
  ]) {
    assert.equal(
      typeof operations[exportName],
      'function',
      `Production Operations SQL helper ${exportName} must be exported`,
    )
  }
  return {
    externallyFulfilledOrderSql: operations.externallyFulfilledOrderSql,
    latestExternalReconciliationTrackingSql:
      operations.latestExternalReconciliationTrackingSql,
    latestProviderTrackingSql: operations.latestProviderTrackingSql,
  }
}

function productionIndexReader() {
  const orderListQuery = loadTypeScriptModule(
    'app_src/lib/operations/orderListQuery.ts',
  )
  const unifiedDomain = loadTypeScriptModule(
    'app_src/lib/operations/unifiedOrderPage.ts',
    { '@/lib/operations/orderListQuery': orderListQuery },
  )
  const indexModule = loadTypeScriptModule(
    'app_src/lib/persistence/unifiedOperationsOrderIndex.ts',
    {
      '@/lib/operations/orderListQuery': orderListQuery,
      '@/lib/operations/unifiedOrderPage': unifiedDomain,
      './operations': productionOrderSqlHelpers(orderListQuery),
    },
  )
  assert.equal(
    typeof indexModule.readUnifiedOperationsOrderIndexPage,
    'function',
    'Production unified Operations order index reader must be exported',
  )
  return indexModule.readUnifiedOperationsOrderIndexPage
}

function unifiedPersistence(pool, hooks, productionIndexOverride = null) {
  const orderListQuery = loadTypeScriptModule(
    'app_src/lib/operations/orderListQuery.ts',
  )
  const unifiedDomain = loadTypeScriptModule(
    'app_src/lib/operations/unifiedOrderPage.ts',
    { '@/lib/operations/orderListQuery': orderListQuery },
  )
  return loadTypeScriptModule(
    'app_src/lib/persistence/unifiedOperationsOrderPage.ts',
    {
      '@/lib/operations/orderListQuery': orderListQuery,
      '@/lib/operations/unifiedOrderPage': unifiedDomain,
      './commerceOrderWorkbench': {
        readCommerceOrderWorkbenchPageFromPostgres:
          sourceReader(
            'unified_test_imported',
            'imported',
            hooks,
            unifiedDomain,
          ),
      },
      './operations': {
        OperationsRequestError,
        readOperationsOrderPageFromPostgres:
          sourceReader(
            'unified_test_canonical',
            'canonical',
            hooks,
            unifiedDomain,
          ),
      },
      './postgres': {
        getPostgresPool: () => pool,
        normalizePostgresPersistenceError: (error) => error,
      },
      './unifiedOperationsOrderIndex': {
        readUnifiedOperationsOrderIndexPage:
          productionIndexOverride || indexReader(hooks, unifiedDomain),
      },
    },
  )
}

async function resetFixture(pool, organizationId, rows) {
  await pool.query('TRUNCATE unified_test_canonical, unified_test_imported')
  for (const source of ['canonical', 'imported']) {
    const selected = rows.filter((item) => item.source === source)
    if (!selected.length) continue
    await pool.query(
      `INSERT INTO unified_test_${source} (
         id, organization_id, global_id, integration_account_global_id,
         external_order_id, order_number, customer_name, updated_at, provider
       )
       SELECT data.id::uuid, $1::uuid, data.global_id,
              data.integration_account_global_id, data.external_order_id,
              data.order_number, data.customer_name,
              data.updated_at::timestamptz, data.provider
       FROM jsonb_to_recordset($2::jsonb) AS data(
         id text,
         global_id text,
         integration_account_global_id text,
         external_order_id text,
         order_number text,
         customer_name text,
         updated_at text,
         provider text
       )`,
      [organizationId, JSON.stringify(selected.map((item) => ({
        id: item.id,
        global_id: item.globalId,
        integration_account_global_id: item.accountGlobalId,
        external_order_id: item.externalOrderId,
        order_number: item.orderNumber,
        customer_name: item.customerName,
        updated_at: item.updatedAt,
        provider: item.provider,
      })))],
    )
  }
}

function row(source, suffix, updatedAt, extra = {}) {
  return {
    source,
    id: randomUUID(),
    globalId: source === 'canonical' ? `gor${suffix}` : `gcoc${suffix}`,
    accountGlobalId: 'gia0009901',
    externalOrderId: `provider-${suffix}`,
    orderNumber: `ORDER-${suffix}`,
    customerName: `Customer ${suffix}`,
    updatedAt,
    provider: source === 'canonical' ? 'shopify' : 'faire',
    ...extra,
  }
}

async function expectSnapshotConflict(action) {
  let observed = null
  try {
    await action()
  } catch (error) {
    observed = error
  }
  assert.ok(observed, 'Expected a snapshot conflict')
  assert.equal(observed.code, 'OPERATIONS_ORDER_PAGE_SNAPSHOT_CHANGED')
  assert.equal(observed.status, 409)
  assert.match(observed.message, /restart from page one/iu)
}

async function moveImportedToCanonical(pool, organizationId, moving) {
  await pool.query('BEGIN')
  try {
    await pool.query(
      `INSERT INTO unified_test_canonical
       SELECT * FROM unified_test_imported
       WHERE organization_id = $1::uuid AND id = $2::uuid`,
      [organizationId, moving.id],
    )
    await pool.query(
      `UPDATE unified_test_canonical SET global_id = $3
       WHERE organization_id = $1::uuid AND id = $2::uuid`,
      [organizationId, moving.id, `gor${moving.globalId.slice(4)}`],
    )
    await pool.query(
      `DELETE FROM unified_test_imported
       WHERE organization_id = $1::uuid AND id = $2::uuid`,
      [organizationId, moving.id],
    )
    await pool.query('COMMIT')
  } catch (error) {
    await pool.query('ROLLBACK')
    throw error
  }
}

function productionFixture() {
  return {
    organizationId: randomUUID(),
    pipelineId: randomUUID(),
    customerId: randomUUID(),
    shopifyAccountId: randomUUID(),
    faireAccountId: randomUUID(),
    shopifyRunId: randomUUID(),
    faireRunId: randomUUID(),
    canonicalOrderId: randomUUID(),
    shopifyAccountGlobalId: 'gia0999101',
    faireAccountGlobalId: 'gia0999102',
    shopifyRunGlobalId: 'gcir0999101',
    faireRunGlobalId: 'gcir0999102',
    canonicalOrderGlobalId: 'gor0999101',
    canonicalExternalOrderId: 'shopify-order-10000',
    candidates: [
      {
        id: randomUUID(),
        globalId: 'gcoc0999101',
        account: 'shopify',
        externalOrderId: 'shopify-order-9999',
        orderNumber: '#9999',
        providerCreatedAt: '2026-09-01T14:00:00.000Z',
        providerUpdatedAt: '2026-09-01T14:30:00.000Z',
        fulfillment: 'unfulfilled',
      },
      {
        id: randomUUID(),
        globalId: 'gcoc0999102',
        account: 'shopify',
        externalOrderId: 'shopify-order-10000',
        orderNumber: '#10000',
        providerCreatedAt: '2026-09-01T15:00:00.000Z',
        providerUpdatedAt: '2026-09-01T15:30:00.000Z',
        fulfillment: 'unfulfilled',
      },
      {
        id: randomUUID(),
        globalId: 'gcoc0999103',
        account: 'faire',
        externalOrderId: 'faire-order-10a',
        orderNumber: 'B2B-10A',
        providerCreatedAt: '2026-09-01T12:00:00.000Z',
        providerUpdatedAt: '2026-09-01T12:30:00.000Z',
        fulfillment: 'fulfilled',
      },
      {
        id: randomUUID(),
        globalId: 'gcoc0999104',
        account: 'faire',
        externalOrderId: 'faire-order-2a',
        orderNumber: 'B2B-2A',
        providerCreatedAt: '2026-09-01T13:00:00.000Z',
        providerUpdatedAt: '2026-09-01T13:30:00.000Z',
        fulfillment: 'unfulfilled',
      },
    ],
  }
}

async function seedProductionIndexFixture(client) {
  const fixture = productionFixture()
  const actorEmail = 'unified-order-index-postgres@clawpilot.com'
  await client.query('SET session_replication_role = replica')
  try {
    await client.query(
      `INSERT INTO workspace_organizations (
         id, name, organization_type, reference_code
       ) VALUES ($1::uuid, 'Unified order index', 'member', 'ga0999101')`,
      [fixture.organizationId],
    )
    await client.query(
      `INSERT INTO pipeline_spaces (
         id, name, owner_email, is_default, workspace_organization_id
       ) VALUES (
         $1::uuid, 'Unified order index', $2, true, $3::uuid
       )`,
      [fixture.pipelineId, actorEmail, fixture.organizationId],
    )
    await client.query(
      `INSERT INTO crm_organizations (
         id, pipeline_id, reference_code, source_key, identity_key, name,
         relationship_type, source_payload, source_hash, created_by, updated_by
       ) VALUES (
         $1::uuid, $2::uuid, 'ga0999102', 'unified-index-customer',
         'customer:unified-index', 'Unified Index Customer', 'customer',
         '{}'::jsonb, $3, $4, $4
       )`,
      [fixture.customerId, fixture.pipelineId, 'c'.repeat(64), actorEmail],
    )
    await client.query(
      `INSERT INTO operations_integration_accounts (
         id, global_id, organization_id, provider, integration_type,
         environment, display_name, status, configuration,
         external_account_id, commerce_credential_generation,
         created_by, updated_by
       ) VALUES
         ($1::uuid, $2, $3::uuid, 'shopify', 'commerce', 'sandbox',
          'Unified Shopify', 'active', '{}'::jsonb, 'shopify-test', 1, $4, $4),
         ($5::uuid, $6, $3::uuid, 'faire', 'commerce', 'production',
          'Unified Faire', 'active', '{}'::jsonb, 'faire-test', 1, $4, $4)`,
      [
        fixture.shopifyAccountId,
        fixture.shopifyAccountGlobalId,
        fixture.organizationId,
        actorEmail,
        fixture.faireAccountId,
        fixture.faireAccountGlobalId,
      ],
    )
    for (const account of [
      {
        id: fixture.shopifyAccountId,
        globalId: fixture.shopifyRunGlobalId,
        provider: 'shopify',
        runId: fixture.shopifyRunId,
      },
      {
        id: fixture.faireAccountId,
        globalId: fixture.faireRunGlobalId,
        provider: 'faire',
        runId: fixture.faireRunId,
      },
    ]) {
      await client.query(
        `INSERT INTO operations_commerce_intake_runs (
           id, global_id, organization_id, integration_account_id, pipeline_id,
           provider, resource, credential_version, provider_api_version,
           normalizer_version, idempotency_key, request_hash, window_end,
           workflow_state, records_seen, records_staged, created_by, updated_by,
           expires_at
         ) VALUES (
           $1::uuid, $2, $3::uuid, $4::uuid, $5::uuid,
           $6, 'orders', 1, 'production-index-test-v1',
           'production-index-test-v1', $7, $8, '2026-09-01T16:00:00Z',
           'held', 2, 2, $9, $9, now() + interval '7 days'
         )`,
        [
          account.runId,
          account.globalId,
          fixture.organizationId,
          account.id,
          fixture.pipelineId,
          account.provider,
          `production-index-${account.provider}`,
          account.provider === 'shopify' ? 'a'.repeat(64) : 'b'.repeat(64),
          actorEmail,
        ],
      )
    }
    await client.query(
      `INSERT INTO operations_orders (
         id, global_id, organization_id, pipeline_id, customer_id,
         integration_account_id, source_provider, external_order_id,
         order_number, status, currency, merchandise_total_minor, ship_to,
         source_payload, created_by, updated_by, imported_at, created_at,
         updated_at
       ) VALUES (
         $1::uuid, $2, $3::uuid, $4::uuid, $5::uuid, $6::uuid,
         'shopify', $7, '#10000', 'imported', 'USD', 1000, '{}'::jsonb,
         '{}'::jsonb, $8, $8, '2026-09-01T15:00:00Z',
         '2026-09-01T15:00:00Z', '2026-09-01T15:30:00Z'
       )`,
      [
        fixture.canonicalOrderId,
        fixture.canonicalOrderGlobalId,
        fixture.organizationId,
        fixture.pipelineId,
        fixture.customerId,
        fixture.shopifyAccountId,
        fixture.canonicalExternalOrderId,
        actorEmail,
      ],
    )
    for (const [index, candidate] of fixture.candidates.entries()) {
      const accountId = candidate.account === 'shopify'
        ? fixture.shopifyAccountId
        : fixture.faireAccountId
      const runId = candidate.account === 'shopify'
        ? fixture.shopifyRunId
        : fixture.faireRunId
      await client.query(
        `INSERT INTO operations_commerce_order_candidates (
           id, global_id, organization_id, integration_account_id, pipeline_id,
           run_id, provider, external_order_id, order_number_snapshot,
           provider_order_status_raw, provider_financial_status_raw,
           provider_fulfillment_status_raw, provider_return_status_raw,
           normalized_order_status, normalized_payment_status,
           normalized_fulfillment_status, normalized_return_status,
           requires_shipping, currency_code, subtotal_minor, discount_minor,
           brand_discount_minor, shipping_minor, tax_minor,
           other_adjustment_minor, total_minor, party_snapshot_state,
           customer_resolution_state, ship_to_snapshot_state,
           ship_to_snapshot_source, delivery_resolution_state,
           provider_created_at, provider_updated_at, observed_at,
           source_revision, source_hash, provider_api_version,
           normalizer_version, workflow_state, blocking_codes, row_version,
           created_by, updated_by, expires_at
         ) VALUES (
           $1::uuid, $2, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7, $8, $9,
           'OPEN', 'PAID', $10, 'NONE', 'open', 'paid', $11, 'none', true,
           'USD', 1000, 0, 0, 0, 0, 0, 1000, 'missing', 'unresolved',
           'missing', 'none', 'unresolved', $12::timestamptz,
           $13::timestamptz, $13::timestamptz, $14, $15,
           'production-index-test-v1', 'production-index-test-v1', 'held',
           '{}'::text[], 0, $16, $16, now() + interval '7 days'
         )`,
        [
          candidate.id,
          candidate.globalId,
          fixture.organizationId,
          accountId,
          fixture.pipelineId,
          runId,
          candidate.account,
          candidate.externalOrderId,
          candidate.orderNumber,
          candidate.fulfillment.toUpperCase(),
          candidate.fulfillment,
          candidate.providerCreatedAt,
          candidate.providerUpdatedAt,
          `production-index-candidate-${index}`,
          String(index + 1).repeat(64),
          actorEmail,
        ],
      )
    }
    const tracked = fixture.candidates.find((candidate) => (
      candidate.externalOrderId === 'faire-order-2a'
    ))
    assert.ok(tracked)
    await client.query(
      `INSERT INTO operations_commerce_order_event_observations (
         id, global_id, organization_id, integration_account_id,
         observation_id, provider, external_order_id, external_event_id,
         external_subject_id, event_hash, event_kind, event_status,
         attribution_source, tracking_carrier, tracking_number,
         sensitive_evidence_expires_at, occurred_at, observed_at
       ) VALUES (
         $1::uuid, 'gcoe0999101', $2::uuid, $3::uuid, $4::uuid, 'faire', $5,
         'faire-tracking-event-2a', 'faire-shipment-2a', $6,
         'tracking_updated', 'in_transit', 'provider_system', 'UPS',
         '1ZPRODUCTIONINDEX2A', now() + interval '7 days', now(), now()
       )`,
      [
        randomUUID(),
        fixture.organizationId,
        fixture.faireAccountId,
        randomUUID(),
        tracked.externalOrderId,
        'e'.repeat(64),
      ],
    )
  } finally {
    await client.query('SET session_replication_role = origin')
  }
  return fixture
}

async function seedProductionScaleRows(client, fixture, rowCount) {
  await client.query('SET session_replication_role = replica')
  try {
    await client.query(
      `INSERT INTO operations_orders (
         id, global_id, organization_id, pipeline_id, customer_id,
         integration_account_id, source_provider, external_order_id,
         order_number, status, currency, merchandise_total_minor, ship_to,
         source_payload, created_by, updated_by, imported_at, created_at,
         updated_at
       )
       SELECT gen_random_uuid(),
              'gor' || lpad((1000000 + generated.sequence)::text, 7, '0'),
              $1::uuid, $2::uuid, $3::uuid, $4::uuid, 'shopify',
              'bulk-shopify-order-' || generated.sequence::text,
              '#' || (20000 + generated.sequence)::text,
              'imported', 'USD', 1000, '{}'::jsonb, '{}'::jsonb,
              'unified-order-index-postgres@clawpilot.com',
              'unified-order-index-postgres@clawpilot.com',
              now() - generated.sequence * interval '1 second',
              now() - generated.sequence * interval '1 second',
              now() - generated.sequence * interval '1 second'
       FROM generate_series(1, $5::integer) generated(sequence)`,
      [
        fixture.organizationId,
        fixture.pipelineId,
        fixture.customerId,
        fixture.shopifyAccountId,
        rowCount,
      ],
    )
  } finally {
    await client.query('SET session_replication_role = origin')
  }
}

async function seedProductionOrderEventHistory(client, fixture, revisionsPerOrder) {
  await client.query('SET session_replication_role = replica')
  try {
    await client.query(
      `WITH history AS (
         SELECT source_order.id AS order_id,
                source_order.external_order_id,
                generated.revision,
                row_number() OVER (
                  ORDER BY source_order.id, generated.revision
                ) AS sequence
         FROM operations_orders source_order
         CROSS JOIN generate_series(1, $3::integer) generated(revision)
         WHERE source_order.organization_id = $1::uuid
           AND source_order.external_order_id LIKE 'bulk-shopify-order-%'
       )
       INSERT INTO operations_commerce_order_event_observations (
         id, global_id, organization_id, integration_account_id,
         observation_id, order_id, provider, external_order_id,
         external_event_id, external_subject_id, event_hash, event_kind,
         event_status, attribution_source, sensitive_evidence_expires_at,
         occurred_at, observed_at, created_at
       )
       SELECT gen_random_uuid(),
              'gcoe' || lpad((2000000 + history.sequence)::text, 7, '0'),
              $1::uuid, $2::uuid, gen_random_uuid(), history.order_id,
              'shopify', history.external_order_id,
              'bulk-event-' || history.sequence::text,
              'bulk-subject-' || history.revision::text,
              md5(history.external_order_id || ':' || history.revision::text)
                || md5(history.revision::text || ':' || history.external_order_id),
              'order_updated', 'open', 'provider_system',
              now() + interval '30 days',
              now() - ($3::integer - history.revision) * interval '1 minute',
              now() - ($3::integer - history.revision) * interval '1 minute',
              now() - ($3::integer - history.revision) * interval '1 minute'
       FROM history`,
      [
        fixture.organizationId,
        fixture.shopifyAccountId,
        revisionsPerOrder,
      ],
    )
  } finally {
    await client.query('SET session_replication_role = origin')
  }
}

async function withReadOnlyJitDisabledTransaction(client, action) {
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
  try {
    await client.query('SET LOCAL jit = off')
    const setting = await client.query("SELECT current_setting('jit') AS jit")
    assert.equal(setting.rows[0]?.jit, 'off')
    const result = await action()
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  }
}

async function verifyProductionIndex(databaseUrl) {
  const pool = new Pool({ connectionString: databaseUrl, max: 2 })
  const client = await pool.connect()
  try {
    const defaultJitSetting = (
      await client.query("SELECT current_setting('jit') AS jit")
    ).rows[0]?.jit
    const fixture = await seedProductionIndexFixture(client)
    const readIndex = productionIndexReader()
    const capturedQueries = []
    const explainedPlans = []
    const instrumentedClient = {
      async query(text, values) {
        capturedQueries.push({ text, values })
        return client.query(text, values)
      },
    }
    const baseInput = {
      client: instrumentedClient,
      organizationId: fixture.organizationId,
      search: '',
      status: null,
      sort: 'order_number',
      direction: 'desc',
      provider: null,
      tracking: null,
      updatedAfter: null,
      page: 1,
      pageSize: 2,
    }
    const readAndExplain = async (input) => {
      const captureIndex = capturedQueries.length
      const result = await readIndex(input)
      assert.equal(
        capturedQueries.length,
        captureIndex + 1,
        'Production index reader must execute exactly one database query',
      )
      assert.ok(
        result.entries.length <= input.pageSize,
        'Production index response must remain bounded by requested page size',
      )
      const captured = capturedQueries[captureIndex]
      assert.ok(captured, 'Production index SQL must execute exactly once')
      assert.match(captured.text, /WITH canonical_context AS MATERIALIZED/u)
      assert.match(captured.text, /row_number\(\) OVER/u)
      const explained = await client.query(
        `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${captured.text}`,
        captured.values,
      )
      const planDocument = explained.rows[0]?.['QUERY PLAN']?.[0]
      assert.ok(planDocument?.Plan, 'Production index SQL must produce a plan')
      assert.equal(Number.isFinite(planDocument['Execution Time']), true)
      assert.equal(
        Object.hasOwn(planDocument, 'JIT'),
        false,
        'Production page plan must not include PostgreSQL JIT compilation',
      )
      explainedPlans.push(planDocument)
      return result
    }

    await withReadOnlyJitDisabledTransaction(client, async () => {
      const firstPage = await readAndExplain(baseInput)
      assert.equal(firstPage.total, 4)
      assert.equal(firstPage.offset, 0)
      assert.deepEqual(
        firstPage.entries.map((entry) => entry.externalOrderId),
        ['shopify-order-10000', 'shopify-order-9999'],
        'Canonical identity must suppress the duplicate staged provider row',
      )

      const secondPage = await readAndExplain({ ...baseInput, page: 2 })
      assert.equal(secondPage.total, 4)
      assert.equal(secondPage.offset, 2)
      assert.deepEqual(
        secondPage.entries.map((entry) => entry.externalOrderId),
        ['faire-order-2a', 'faire-order-10a'],
        'Faire identities must retain deterministic provider-local ordering',
      )

      const trackedFaire = await readAndExplain({
        ...baseInput,
        search: '1ZPRODUCTIONINDEX2A',
        provider: 'faire',
        tracking: 'present',
        pageSize: 10,
      })
      assert.equal(trackedFaire.total, 1)
      assert.deepEqual(
        trackedFaire.entries.map((entry) => entry.externalOrderId),
        ['faire-order-2a'],
      )

      const externallyFulfilled = await readIndex({
        ...baseInput,
        status: 'fulfilled_externally',
        sort: 'order_date',
        direction: 'asc',
        pageSize: 10,
      })
      assert.equal(externallyFulfilled.total, 1)
      assert.deepEqual(
        externallyFulfilled.entries.map((entry) => entry.externalOrderId),
        ['faire-order-10a'],
      )

      const recent = await readIndex({
        ...baseInput,
        sort: 'order_date',
        updatedAfter: '2026-09-01T13:00:00.000Z',
        pageSize: 10,
      })
      assert.equal(recent.total, 3)
      assert.equal(
        new Set(recent.entries.map((entry) => entry.externalOrderId)).size,
        3,
      )
    })
    const directReadJitAfterCommit = (
      await client.query("SELECT current_setting('jit') AS jit")
    ).rows[0]?.jit
    assert.equal(directReadJitAfterCommit, defaultJitSetting)

    const syntheticRows = [
      {
        source: 'canonical',
        id: fixture.canonicalOrderId,
        globalId: fixture.canonicalOrderGlobalId,
        accountGlobalId: fixture.shopifyAccountGlobalId,
        externalOrderId: fixture.canonicalExternalOrderId,
        orderNumber: '#10000',
        customerName: 'Unified Index Customer',
        updatedAt: '2026-09-01T15:30:00.000Z',
        provider: 'shopify',
      },
      ...fixture.candidates.map((candidate) => ({
        source: 'imported',
        id: candidate.id,
        globalId: candidate.globalId,
        accountGlobalId: candidate.account === 'shopify'
          ? fixture.shopifyAccountGlobalId
          : fixture.faireAccountGlobalId,
        externalOrderId: candidate.externalOrderId,
        orderNumber: candidate.orderNumber,
        customerName: `Imported ${candidate.orderNumber}`,
        updatedAt: candidate.providerUpdatedAt,
        provider: candidate.account,
      })),
    ]
    await resetFixture(pool, fixture.organizationId, syntheticRows)
    const serviceHooks = { afterIndexRead: null, reads: [] }
    const serviceJitSettings = []
    const productionPersistence = unifiedPersistence(
      pool,
      serviceHooks,
      async (input) => {
        serviceHooks.reads.push({ source: 'index' })
        const setting = await input.client.query(
          "SELECT current_setting('jit') AS jit",
        )
        serviceJitSettings.push(setting.rows[0]?.jit)
        return readIndex(input)
      },
    )
    const servicePage = await productionPersistence
      .readUnifiedOperationsOrderPageFromPostgres({
        organizationId: fixture.organizationId,
        sort: 'order_number',
        direction: 'desc',
        pageSize: 2,
        page: 1,
      })
    assert.equal(servicePage.rows.length, 2)
    assert.deepEqual(serviceJitSettings, ['off'])
    assert.deepEqual(serviceHooks.reads.map((read) => read.source), [
      'index',
      'canonical',
      'imported',
    ])
    assert.ok(serviceHooks.reads.slice(1).every((read) => (
      read.selectedIds?.length <= 2 && Number(read.offset) === 0
    )))
    const serviceJitAfterCommit = (
      await pool.query("SELECT current_setting('jit') AS jit")
    ).rows[0]?.jit
    assert.equal(serviceJitAfterCommit, defaultJitSetting)

    await seedProductionScaleRows(client, fixture, 8_400)
    await seedProductionOrderEventHistory(client, fixture, 8)
    await withReadOnlyJitDisabledTransaction(client, async () => {
      const scaledPage = await readAndExplain({
        ...baseInput,
        sort: 'customer',
        direction: 'asc',
        page: 80,
        pageSize: 50,
      })
      assert.equal(scaledPage.total, 8_404)
      assert.equal(scaledPage.offset, 3_950)
      assert.equal(scaledPage.entries.length, 50)
      const scaledQuery = capturedQueries.at(-1)?.text || ''
      assert.doesNotMatch(
        scaledQuery,
        /operations_commerce_order_event_observations/u,
        'Order-date, order-number, and customer pages without evidence filters must not scan provider event history',
      )
      assert.doesNotMatch(
        scaledQuery,
        /operations_commerce_order_revision_(?:observations|reads)/u,
        'Ordinary numbered pages must not scan canonical revision history',
      )
      assert.doesNotMatch(
        scaledQuery,
        /string_agg/u,
        'Snapshot evidence must not concatenate the full result set',
      )
      assert.match(
        scaledQuery,
        /bit_xor\(\s*hashtextextended/u,
        'Snapshot evidence must use bounded streaming aggregates',
      )
      const scaledPlan = explainedPlans.at(-1)
      assert.ok(scaledPlan)
      assert.ok(
        scaledPlan['Execution Time'] < 1_500,
        `Expected non-JIT index execution below 1500ms; observed ${scaledPlan['Execution Time']}ms`,
      )
    })
  } finally {
    client.release()
    await pool.end()
  }
}

async function verify(databaseUrl) {
  const pool = new Pool({ connectionString: databaseUrl, max: 4 })
  const organizationId = randomUUID()
  const hooks = { afterIndexRead: null, reads: [] }
  const persistence = unifiedPersistence(pool, hooks)
  const baseInput = {
    organizationId,
    sort: 'updated',
    direction: 'desc',
    pageSize: 2,
  }
  try {
    const rows = [
      row('imported', '000000000001', '2026-09-01T13:00:00.000Z'),
      row('canonical', '000000000001', '2026-09-01T12:00:00.000Z', {
        externalOrderId: 'provider-canonical-1',
      }),
      row('imported', '000000000002', '2026-09-01T11:00:00.000Z'),
      row('canonical', '000000000002', '2026-09-01T10:00:00.000Z', {
        externalOrderId: 'provider-canonical-2',
      }),
      row('imported', '000000000003', '2026-09-01T09:00:00.000Z'),
    ]
    await resetFixture(pool, organizationId, rows)

    const cursorPage1 = await persistence
      .readUnifiedOperationsOrderPageFromPostgres(baseInput)
    const cursorPage2 = await persistence
      .readUnifiedOperationsOrderPageFromPostgres({
        ...baseInput,
        cursor: cursorPage1.page.nextCursor,
      })
    assert.equal(cursorPage1.page.total, 5)
    assert.equal(cursorPage1.page.snapshot, null)
    assert.equal(cursorPage2.rows.length, 2)
    assert.equal(new Set([
      ...cursorPage1.rows,
      ...cursorPage2.rows,
    ].map((item) => item.key)).size, 4)

    const directPage1 = await persistence
      .readUnifiedOperationsOrderPageFromPostgres({ ...baseInput, page: 1 })
    assert.equal(typeof directPage1.page.snapshot, 'string')
    assert.equal(directPage1.page.nextCursor, null)
    assert.equal(directPage1.page.complete, false)
    hooks.reads.length = 0
    const directPage2 = await persistence
      .readUnifiedOperationsOrderPageFromPostgres({
        ...baseInput,
        page: 2,
        snapshot: directPage1.page.snapshot,
      })
    assert.equal(directPage2.page.offset, 2)
    assert.deepEqual(Array.from(directPage2.rows, (item) => item.key), [
      `imported:${rows[2].globalId}`,
      `canonical:${rows[3].globalId}`,
    ])
    assert.deepEqual(hooks.reads.map((read) => read.source), [
      'index',
      'canonical',
      'imported',
    ])
    assert.ok(hooks.reads.slice(1).every((read) => (
      read.selectedIds?.length === 1 && Number(read.offset) === 0
    )))

    const clampedPage = await persistence
      .readUnifiedOperationsOrderPageFromPostgres({
        ...baseInput,
        page: Number.MAX_SAFE_INTEGER,
      })
    assert.equal(clampedPage.page.offset, 4)
    assert.deepEqual(Array.from(clampedPage.rows, (item) => item.key), [
      `imported:${rows[4].globalId}`,
    ])
    await assert.rejects(
      persistence.readUnifiedOperationsOrderPageFromPostgres({
        ...baseInput,
        page: 2,
        cursor: cursorPage1.page.nextCursor,
      }),
      (error) => (
        error?.code === 'OPERATIONS_UNIFIED_ORDER_PAGE_CURSOR_CONFLICT'
        && error?.status === 400
      ),
    )
    await assert.rejects(
      persistence.readUnifiedOperationsOrderPageFromPostgres({
        ...baseInput,
        page: 0,
      }),
      (error) => (
        error?.code === 'OPERATIONS_UNIFIED_ORDER_PAGE_INVALID'
        && error?.status === 400
      ),
    )

    const transactionRows = [
      row('canonical', '000000000050', '2026-09-01T18:00:00.000Z'),
      row('imported', '000000000051', '2026-09-01T17:00:00.000Z'),
      row('imported', '000000000052', '2026-09-01T16:00:00.000Z'),
      row('imported', '000000000053', '2026-09-01T15:00:00.000Z'),
    ]
    await resetFixture(pool, organizationId, transactionRows)
    const transactionMoving = transactionRows[2]
    hooks.afterIndexRead = () => moveImportedToCanonical(
      pool,
      organizationId,
      transactionMoving,
    )
    const transactionPage = await persistence
      .readUnifiedOperationsOrderPageFromPostgres({
        ...baseInput,
        page: 2,
      })
    assert.equal(transactionPage.page.total, 4)
    assert.deepEqual(Array.from(transactionPage.rows, (item) => item.key), [
      `imported:${transactionMoving.globalId}`,
      `imported:${transactionRows[3].globalId}`,
    ])

    await resetFixture(pool, organizationId, [])
    const emptyPage = await persistence
      .readUnifiedOperationsOrderPageFromPostgres({
        ...baseInput,
        page: Number.MAX_SAFE_INTEGER,
      })
    assert.equal(emptyPage.page.total, 0)
    assert.equal(emptyPage.page.offset, 0)
    assert.deepEqual(Array.from(emptyPage.rows), [])

    const naturalRows = [
      row('canonical', '000000000061', '2026-09-01T14:00:00.000Z', {
        provider: 'shopify',
        orderNumber: '#9999',
      }),
      row('imported', '000000000062', '2026-09-01T14:00:00.000Z', {
        provider: 'shopify',
        orderNumber: '#10000',
      }),
      row('canonical', '000000000063', '2026-09-01T14:00:00.000Z', {
        provider: 'faire',
        orderNumber: 'B2B-10A',
      }),
      row('imported', '000000000064', '2026-09-01T14:00:00.000Z', {
        provider: 'faire',
        orderNumber: 'B2B-2A',
      }),
    ]
    await resetFixture(pool, organizationId, naturalRows)
    const naturalPage = await persistence
      .readUnifiedOperationsOrderPageFromPostgres({
        organizationId,
        sort: 'order_number',
        direction: 'desc',
        pageSize: 10,
        page: 1,
      })
    assert.deepEqual(naturalPage.rows.map((item) => item.order.orderNumber), [
      '#10000',
      '#9999',
      'B2B-2A',
      'B2B-10A',
    ])

    const driftRows = [
      row('imported', '000000000070', '2026-09-01T18:00:00.000Z'),
      row('imported', '000000000071', '2026-09-01T17:00:00.000Z'),
      row('imported', '000000000072', '2026-09-01T16:00:00.000Z'),
    ]
    await resetFixture(pool, organizationId, driftRows)
    const beforePromotion = await persistence
      .readUnifiedOperationsOrderPageFromPostgres({
        ...baseInput,
        pageSize: 1,
        page: 1,
      })
    await moveImportedToCanonical(pool, organizationId, driftRows[1])
    await expectSnapshotConflict(() => (
      persistence.readUnifiedOperationsOrderPageFromPostgres({
        ...baseInput,
        pageSize: 1,
        page: 2,
        snapshot: beforePromotion.page.snapshot,
      })
    ))

    const churnRows = [
      row('canonical', '000000000080', '2026-09-01T21:00:00.000Z'),
      row('canonical', '000000000081', '2026-09-01T20:00:00.000Z'),
    ]
    await resetFixture(pool, organizationId, churnRows)
    const beforeChurn = await persistence
      .readUnifiedOperationsOrderPageFromPostgres({
        ...baseInput,
        pageSize: 1,
        page: 1,
      })
    await pool.query(
      `UPDATE unified_test_canonical
       SET updated_at = '2026-09-01T22:00:00.000Z'::timestamptz
       WHERE organization_id = $1::uuid AND id = $2::uuid`,
      [organizationId, churnRows[1].id],
    )
    await expectSnapshotConflict(() => (
      persistence.readUnifiedOperationsOrderPageFromPostgres({
        ...baseInput,
        pageSize: 1,
        page: 2,
        snapshot: beforeChurn.page.snapshot,
      })
    ))

    const largeRows = Array.from({ length: 8_400 }, (_unused, index) => {
      const suffix = String(index).padStart(12, '0')
      return row(
        index % 2 === 0 ? 'canonical' : 'imported',
        suffix,
        '2026-09-01T12:00:00.000Z',
        { customerName: `Customer ${String(index).padStart(6, '0')}` },
      )
    })
    await resetFixture(pool, organizationId, largeRows)
    hooks.reads.length = 0
    const largePage = await persistence
      .readUnifiedOperationsOrderPageFromPostgres({
        organizationId,
        sort: 'customer',
        direction: 'asc',
        pageSize: 50,
        page: 80,
      })
    assert.equal(largePage.page.total, 8_400)
    assert.equal(largePage.rows.length, 50)
    assert.equal(hooks.reads.length, 3)
    assert.deepEqual(hooks.reads.map((read) => read.source), [
      'index',
      'canonical',
      'imported',
    ])
    assert.ok(hooks.reads.slice(1).every((read) => (
      Array.isArray(read.selectedIds)
      && read.selectedIds.length <= 50
      && Number(read.offset) === 0
    )))
  } finally {
    await pool.end()
  }
}

async function main() {
  command('docker', ['info'], { timeout: 30_000 })
  const container = (
    `clawpilot-unified-order-page-${process.pid}-${randomUUID().slice(0, 8)}`
  )
  try {
    command('docker', [
      'run', '--rm', '-d', '--name', container,
      '-e', 'POSTGRES_PASSWORD=unified_order_page',
      '-e', 'POSTGRES_DB=unified_order_page',
      '-p', '127.0.0.1::5432',
      process.env.CLAWPILOT_DISPOSABLE_POSTGRES_IMAGE
        || 'pgvector/pgvector:pg16',
    ], { timeout: 180_000 })
    const portOutput = command('docker', ['port', container, '5432/tcp'])
    const port = Number(portOutput.match(/:(\d+)\s*$/u)?.[1])
    assert.ok(port > 0, `Unable to resolve PostgreSQL port: ${portOutput}`)
    const databaseUrl = (
      'postgresql://postgres:unified_order_page@127.0.0.1:'
      + `${port}/unified_order_page`
    )
    await waitForPostgres(databaseUrl)
    const setup = new Pool({ connectionString: databaseUrl, max: 1 })
    const setupClient = await setup.connect()
    try {
      for (const file of migrations()) {
        await applyMigration(setupClient, file)
      }
      await setupClient.query(
        `CREATE TABLE unified_test_canonical (
           id uuid PRIMARY KEY,
           organization_id uuid NOT NULL,
           global_id text NOT NULL,
           integration_account_global_id text NOT NULL,
           external_order_id text NOT NULL,
           order_number text NOT NULL,
           customer_name text NOT NULL,
           updated_at timestamptz NOT NULL,
           provider text NOT NULL
         );
         CREATE TABLE unified_test_imported (
           LIKE unified_test_canonical INCLUDING ALL
         )`,
      )
    } finally {
      setupClient.release()
      await setup.end()
    }
    await verifyProductionIndex(databaseUrl)
    await verify(databaseUrl)
  } finally {
    spawnSync('docker', ['stop', '-t', '1', container], {
      cwd: root,
      encoding: 'utf8',
      timeout: 20_000,
    })
  }
  console.log(
    'Unified operations order page disposable-PostgreSQL acceptance passed',
  )
}

if (resolve(process.argv[1] || '') === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(error)
    process.exit(1)
  })
}
