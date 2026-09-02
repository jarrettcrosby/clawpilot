#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import {
  command,
  loadTypeScriptModule,
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
  if (sort === 'updated') return row.updated_at.toISOString()
  if (sort === 'order_number') return row.order_number.toLowerCase()
  return row.customer_name.toLowerCase()
}

function compareText(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'))
}

function compareSourceRows(left, right, sort, direction) {
  const leftValue = sourceSortValue(left, sort)
  const rightValue = sourceSortValue(right, sort)
  let compared = sort === 'updated'
    ? Date.parse(leftValue) - Date.parse(rightValue)
    : compareText(leftValue, rightValue)
  if (!compared) compared = compareText(left.id, right.id)
  return direction === 'asc' ? compared : -compared
}

function resultSetRevision(rows, sort) {
  if (!rows.length) return 'd41d8cd98f00b204e9800998ecf8427e'
  const evidence = [...rows]
    .sort((left, right) => compareText(left.id, right.id))
    .map((row) => [row.id, sourceSortValue(row, sort)])
  return createHash('md5').update(JSON.stringify(evidence)).digest('hex')
}

function sourceReader(table, kind, hooks) {
  return async (input) => {
    assert.ok(input.queryClient, 'Unified reads must supply one snapshot client')
    const transaction = await input.queryClient.query(
      `SELECT current_setting('transaction_isolation') AS isolation,
              current_setting('transaction_read_only') AS read_only`,
    )
    assert.equal(transaction.rows[0]?.isolation, 'repeatable read')
    assert.equal(transaction.rows[0]?.read_only, 'on')
    const result = await input.queryClient.query(
      `SELECT id::text, global_id, integration_account_global_id,
              external_order_id, order_number, customer_name, updated_at
       FROM ${table}
       WHERE organization_id = $1::uuid`,
      [input.organizationId],
    )
    if (kind === 'canonical' && hooks.afterCanonicalRead) {
      const hook = hooks.afterCanonicalRead
      hooks.afterCanonicalRead = null
      await hook()
    }
    const allRows = result.rows.sort((left, right) => (
      compareSourceRows(left, right, input.sort, input.direction)
    ))
    const decoded = decodeSourceCursor(input.cursor)
    const cursorIndex = decoded
      ? allRows.findIndex((row) => row.id === decoded.id)
      : -1
    const remaining = decoded
      ? cursorIndex < 0 ? allRows : allRows.slice(cursorIndex + 1)
      : allRows
    const selected = remaining.slice(0, input.pageSize)
    const hasNext = remaining.length > input.pageSize
    const total = allRows.length
    const evidence = selected.map((row) => ({
      rowCursor: sourceCursor(row, total),
      sortValue: sourceSortValue(row, input.sort),
      providerIdentity: {
        integrationAccountGlobalId: row.integration_account_global_id,
        externalOrderId: row.external_order_id,
      },
    }))
    const nextCursor = hasNext && selected.length
      ? sourceCursor(selected.at(-1), total)
      : null
    return {
      orders: selected.map((row) => kind === 'canonical'
        ? {
            globalId: row.global_id,
            orderNumber: row.order_number,
            customerName: row.customer_name,
            updatedAt: row.updated_at.toISOString(),
          }
        : {
            candidateGlobalId: row.global_id,
            orderNumber: row.order_number,
            customer: { name: row.customer_name },
            updatedAt: row.updated_at.toISOString(),
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
      },
    }
  }
}

function unifiedPersistence(pool, hooks) {
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
          sourceReader('unified_test_imported', 'imported', hooks),
      },
      './operations': {
        OperationsRequestError,
        readOperationsOrderPageFromPostgres:
          sourceReader('unified_test_canonical', 'canonical', hooks),
      },
      './postgres': {
        getPostgresPool: () => pool,
        normalizePostgresPersistenceError: (error) => error,
      },
    },
  )
}

async function resetFixture(pool, organizationId, rows) {
  await pool.query('TRUNCATE unified_test_canonical, unified_test_imported')
  for (const row of rows) {
    await pool.query(
      `INSERT INTO unified_test_${row.source} (
         id, organization_id, global_id, integration_account_global_id,
         external_order_id, order_number, customer_name, updated_at
       ) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8::timestamptz)`,
      [
        row.id,
        organizationId,
        row.globalId,
        row.accountGlobalId,
        row.externalOrderId,
        row.orderNumber,
        row.customerName,
        row.updatedAt,
      ],
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

async function verify(databaseUrl) {
  const pool = new Pool({ connectionString: databaseUrl, max: 4 })
  const organizationId = randomUUID()
  const hooks = { afterCanonicalRead: null }
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
    const page1 = await persistence.readUnifiedOperationsOrderPageFromPostgres(
      baseInput,
    )
    const page2 = await persistence.readUnifiedOperationsOrderPageFromPostgres({
      ...baseInput,
      cursor: page1.page.nextCursor,
    })
    assert.equal(page1.page.total, 5)
    assert.equal(page1.rows.length, 2)
    assert.equal(page2.rows.length, 2)
    assert.equal(
      new Set([...page1.rows, ...page2.rows].map((item) => item.key)).size,
      4,
      'Partial source consumption must not repeat rows across pages',
    )
    assert.deepEqual(Array.from(page1.rows, (item) => item.kind), [
      'imported',
      'canonical',
    ])

    const equalUpdatedAt = '2026-09-01T14:00:00.000Z'
    await resetFixture(pool, organizationId, [
      row('canonical', '000000000010', equalUpdatedAt, {
        externalOrderId: 'provider-equal-canonical',
      }),
      row('imported', '000000000010', equalUpdatedAt, {
        externalOrderId: 'provider-equal-imported',
      }),
    ])
    const equalPage = await persistence
      .readUnifiedOperationsOrderPageFromPostgres({
        ...baseInput,
        pageSize: 2,
      })
    assert.deepEqual(
      Array.from(equalPage.rows, (item) => item.kind),
      ['imported', 'canonical'],
      'Equal descending keys must retain the deterministic source rank',
    )

    const promoted = row(
      'imported',
      '000000000020',
      '2026-09-01T15:00:00.000Z',
    )
    await resetFixture(pool, organizationId, [promoted])
    hooks.afterCanonicalRead = async () => {
      await pool.query('BEGIN')
      try {
        await pool.query(
          `INSERT INTO unified_test_canonical
           SELECT * FROM unified_test_imported
           WHERE organization_id = $1::uuid AND id = $2::uuid`,
          [organizationId, promoted.id],
        )
        await pool.query(
          `UPDATE unified_test_canonical SET global_id = $3
           WHERE organization_id = $1::uuid AND id = $2::uuid`,
          [organizationId, promoted.id, 'gor000000000020'],
        )
        await pool.query(
          `DELETE FROM unified_test_imported
           WHERE organization_id = $1::uuid AND id = $2::uuid`,
          [organizationId, promoted.id],
        )
        await pool.query('COMMIT')
      } catch (error) {
        await pool.query('ROLLBACK')
        throw error
      }
    }
    const intraReadPromotion = await persistence
      .readUnifiedOperationsOrderPageFromPostgres({
        ...baseInput,
        pageSize: 10,
      })
    assert.equal(intraReadPromotion.page.total, 1)
    assert.equal(intraReadPromotion.rows.length, 1)
    assert.equal(intraReadPromotion.rows[0].order.candidateGlobalId, promoted.globalId)

    const betweenPages = [
      row('imported', '000000000030', '2026-09-01T18:00:00.000Z'),
      row('imported', '000000000031', '2026-09-01T17:00:00.000Z'),
      row('imported', '000000000032', '2026-09-01T16:00:00.000Z'),
    ]
    await resetFixture(pool, organizationId, betweenPages)
    const beforePromotion = await persistence
      .readUnifiedOperationsOrderPageFromPostgres({
        ...baseInput,
        pageSize: 1,
      })
    const moving = betweenPages[1]
    await pool.query(
      `INSERT INTO unified_test_canonical
       SELECT * FROM unified_test_imported
       WHERE organization_id = $1::uuid AND id = $2::uuid`,
      [organizationId, moving.id],
    )
    await pool.query(
      `UPDATE unified_test_canonical SET global_id = $3
       WHERE organization_id = $1::uuid AND id = $2::uuid`,
      [organizationId, moving.id, 'gor000000000031'],
    )
    await pool.query(
      `DELETE FROM unified_test_imported
       WHERE organization_id = $1::uuid AND id = $2::uuid`,
      [organizationId, moving.id],
    )
    await expectSnapshotConflict(() => (
      persistence.readUnifiedOperationsOrderPageFromPostgres({
        ...baseInput,
        pageSize: 1,
        cursor: beforePromotion.page.nextCursor,
      })
    ))

    const churnRows = [
      row('canonical', '000000000040', '2026-09-01T21:00:00.000Z', {
        externalOrderId: 'provider-churn-1',
      }),
      row('canonical', '000000000041', '2026-09-01T20:00:00.000Z', {
        externalOrderId: 'provider-churn-2',
      }),
    ]
    await resetFixture(pool, organizationId, churnRows)
    const beforeChurn = await persistence
      .readUnifiedOperationsOrderPageFromPostgres({
        ...baseInput,
        pageSize: 1,
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
        cursor: beforeChurn.page.nextCursor,
      })
    ))
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
    try {
      await setup.query(
        `CREATE TABLE unified_test_canonical (
           id uuid PRIMARY KEY,
           organization_id uuid NOT NULL,
           global_id text NOT NULL,
           integration_account_global_id text NOT NULL,
           external_order_id text NOT NULL,
           order_number text NOT NULL,
           customer_name text NOT NULL,
           updated_at timestamptz NOT NULL
         );
         CREATE TABLE unified_test_imported (
           LIKE unified_test_canonical INCLUDING ALL
         )`,
      )
    } finally {
      await setup.end()
    }
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
