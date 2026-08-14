#!/usr/bin/env node

import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import vm from 'node:vm'

const root = process.cwd()
const requireFromApp = createRequire(
  new URL('../app_src/package.json', import.meta.url),
)
const { Pool } = requireFromApp('pg')
const ts = requireFromApp('typescript')

function read(path) {
  return readFileSync(resolve(root, path), 'utf8')
}

function command(file, args, options = {}) {
  return execFileSync(file, args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  })
}

function transpile(path) {
  return ts.transpileModule(read(path), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: path,
  }).outputText
}

function runModule(path, requireModule) {
  const module = { exports: {} }
  vm.runInNewContext(transpile(path), {
    Array,
    Boolean,
    Buffer,
    Date,
    Error,
    Map,
    Math,
    Number,
    Object,
    Promise,
    RegExp,
    Set,
    String,
    console,
    exports: module.exports,
    module,
    require: requireModule,
  }, { filename: path })
  return module.exports
}

function loadPickManagement(client) {
  const domain = runModule(
    'app_src/lib/operations/pickManagement.ts',
    requireFromApp,
  )
  const persistence = runModule(
    'app_src/lib/persistence/pickManagement.ts',
    (specifier) => {
      if (specifier === '@/lib/operations/pickManagement') return domain
      if (specifier === '@/lib/persistence/postgres') {
        return { query: (sql, values) => client.query(sql, values) }
      }
      if (specifier === '@/lib/users') {
        return {
          permissionsForRole(role, permissions) {
            if (role === 'owner') {
              return { viewOperations: true, executeWarehouse: true }
            }
            const explicit = permissions && typeof permissions === 'object'
              ? permissions
              : {}
            return {
              viewOperations: explicit.viewOperations === true,
              executeWarehouse: explicit.executeWarehouse === true,
            }
          },
        }
      }
      return requireFromApp(specifier)
    },
  )
  return { domain, persistence }
}

async function waitForPostgres(databaseUrl) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const pool = new Pool({
      connectionString: databaseUrl,
      connectionTimeoutMillis: 1_000,
      max: 1,
    })
    try {
      await pool.query('SELECT 1')
      await pool.end()
      return
    } catch {
      await pool.end().catch(() => {})
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250))
    }
  }
  throw new Error('Disposable PostgreSQL did not become ready')
}

async function createFixture(client) {
  await client.query(`
    CREATE TABLE app_users (
      email text PRIMARY KEY,
      display_name text,
      status text NOT NULL
    );
    CREATE TABLE app_user_organization_memberships (
      organization_id uuid NOT NULL,
      user_email text NOT NULL,
      role text NOT NULL,
      permissions jsonb,
      status text NOT NULL
    );
    CREATE TABLE operations_orders (
      id uuid PRIMARY KEY,
      organization_id uuid NOT NULL,
      global_id text NOT NULL,
      order_number text NOT NULL,
      row_version bigint NOT NULL,
      status text NOT NULL,
      updated_at timestamptz NOT NULL,
      archived_at timestamptz
    );
    CREATE TABLE operations_fulfillment_plans (
      id uuid PRIMARY KEY,
      organization_id uuid NOT NULL,
      order_id uuid NOT NULL,
      global_id text NOT NULL,
      status text NOT NULL,
      version_number integer NOT NULL
    );
    CREATE TABLE operations_warehouses (
      id uuid PRIMARY KEY,
      organization_id uuid NOT NULL,
      name text NOT NULL
    );
    CREATE TABLE operations_waves (
      id uuid PRIMARY KEY,
      organization_id uuid NOT NULL,
      global_id text NOT NULL,
      status text NOT NULL,
      warehouse_id uuid NOT NULL
    );
    CREATE TABLE operations_pick_tasks (
      id uuid PRIMARY KEY,
      organization_id uuid NOT NULL,
      plan_id uuid NOT NULL,
      wave_id uuid NOT NULL,
      global_id text NOT NULL,
      status text NOT NULL,
      quantity numeric(20,6) NOT NULL,
      picked_quantity numeric(20,6),
      assigned_to text,
      assigned_at timestamptz,
      picked_at timestamptz,
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL,
      sequence_number integer NOT NULL
    );
    CREATE TABLE operations_wearable_pick_scan_evidence (
      organization_id uuid NOT NULL,
      order_id uuid NOT NULL,
      pick_task_id uuid NOT NULL,
      order_row_version bigint NOT NULL
    );
    CREATE TABLE operations_wearable_pick_count_evidence (
      organization_id uuid NOT NULL,
      order_id uuid NOT NULL,
      pick_task_id uuid NOT NULL,
      order_row_version bigint NOT NULL
    );
    CREATE TABLE operations_packages (
      id uuid PRIMARY KEY,
      organization_id uuid NOT NULL,
      plan_id uuid NOT NULL,
      status text NOT NULL,
      packed_at timestamptz
    );
    CREATE TABLE operations_labels (
      id uuid PRIMARY KEY,
      organization_id uuid NOT NULL,
      package_id uuid NOT NULL
    );
    CREATE TABLE operations_label_attempts (
      id uuid PRIMARY KEY,
      organization_id uuid NOT NULL,
      order_id uuid NOT NULL
    );
    CREATE TABLE operations_shipments (
      id uuid PRIMARY KEY,
      organization_id uuid NOT NULL,
      order_id uuid NOT NULL
    );
    CREATE TABLE operations_exceptions (
      id uuid PRIMARY KEY,
      organization_id uuid NOT NULL,
      order_id uuid NOT NULL,
      global_id text NOT NULL,
      exception_type text NOT NULL,
      status text NOT NULL,
      created_at timestamptz NOT NULL
    );
  `)
}

async function seedFixture(client) {
  const ids = {
    organization: '10000000-0000-4000-8000-000000000001',
    activeOrder: '20000000-0000-4000-8000-000000000001',
    unassignedOrder: '20000000-0000-4000-8000-000000000002',
    completedOrder: '20000000-0000-4000-8000-000000000003',
    activePlan: '30000000-0000-4000-8000-000000000001',
    unassignedPlan: '30000000-0000-4000-8000-000000000002',
    completedPlan: '30000000-0000-4000-8000-000000000003',
    supersededCompletedPlan: '30000000-0000-4000-8000-000000000004',
    warehouse: '40000000-0000-4000-8000-000000000001',
    activeWave: '50000000-0000-4000-8000-000000000001',
    unassignedWave: '50000000-0000-4000-8000-000000000002',
    completedWave: '50000000-0000-4000-8000-000000000003',
    supersededCompletedWave: '50000000-0000-4000-8000-000000000004',
    activeTaskOne: '60000000-0000-4000-8000-000000000001',
    activeTaskTwo: '60000000-0000-4000-8000-000000000002',
    unassignedTask: '60000000-0000-4000-8000-000000000003',
    completedTask: '60000000-0000-4000-8000-000000000004',
    supersededCompletedTask: '60000000-0000-4000-8000-000000000005',
  }
  await client.query(
    `INSERT INTO app_users (email, display_name, status) VALUES
       ('picker@example.com', 'Pat Picker', 'active'),
       ('owner@example.com', 'Olivia Owner', 'active'),
       ('viewer@example.com', 'Victor Viewer', 'active'),
       ('inactive@example.com', 'Inactive Picker', 'inactive')`,
  )
  await client.query(
    `INSERT INTO app_user_organization_memberships (
       organization_id, user_email, role, permissions, status
     ) VALUES
       ($1::uuid, 'picker@example.com', 'member',
        '{"viewOperations":true,"executeWarehouse":true}'::jsonb, 'active'),
       ($1::uuid, 'owner@example.com', 'owner', '{}'::jsonb, 'active'),
       ($1::uuid, 'viewer@example.com', 'member',
        '{"viewOperations":true,"executeWarehouse":false}'::jsonb, 'active'),
       ($1::uuid, 'inactive@example.com', 'owner', '{}'::jsonb, 'active')`,
    [ids.organization],
  )
  await client.query(
    `INSERT INTO operations_orders (
       id, organization_id, global_id, order_number, row_version,
       status, updated_at, archived_at
     ) VALUES
       ($1::uuid, $4::uuid, 'gor0000001', '1001', 3,
        'released', '2026-08-12T12:00:00Z', NULL),
       ($2::uuid, $4::uuid, 'gor0000002', '1002', 1,
        'released', '2026-08-12T12:05:00Z', NULL),
       ($3::uuid, $4::uuid, 'gor0000003', '1003', 8,
        'picking', '2026-08-12T11:00:00Z', NULL)`,
    [ids.activeOrder, ids.unassignedOrder, ids.completedOrder, ids.organization],
  )
  await client.query(
    `INSERT INTO operations_fulfillment_plans (
       id, organization_id, order_id, global_id, status, version_number
     ) VALUES
       ($1::uuid, $7::uuid, $4::uuid, 'gfp0000001', 'released', 1),
       ($2::uuid, $7::uuid, $5::uuid, 'gfp0000002', 'released', 1),
       ($3::uuid, $7::uuid, $6::uuid, 'gfp0000003', 'released', 2),
       ($8::uuid, $7::uuid, $6::uuid, 'gfp0000004', 'superseded', 1)`,
    [
      ids.activePlan,
      ids.unassignedPlan,
      ids.completedPlan,
      ids.activeOrder,
      ids.unassignedOrder,
      ids.completedOrder,
      ids.organization,
      ids.supersededCompletedPlan,
    ],
  )
  await client.query(
    `INSERT INTO operations_warehouses (id, organization_id, name)
     VALUES ($1::uuid, $2::uuid, 'Main warehouse')`,
    [ids.warehouse, ids.organization],
  )
  await client.query(
    `INSERT INTO operations_waves (
       id, organization_id, global_id, status, warehouse_id
     ) VALUES
       ($1::uuid, $5::uuid, 'gwv0000001', 'released', $4::uuid),
       ($2::uuid, $5::uuid, 'gwv0000002', 'released', $4::uuid),
       ($3::uuid, $5::uuid, 'gwv0000003', 'completed', $4::uuid),
       ($6::uuid, $5::uuid, 'gwv0000004', 'completed', $4::uuid)`,
    [
      ids.activeWave,
      ids.unassignedWave,
      ids.completedWave,
      ids.warehouse,
      ids.organization,
      ids.supersededCompletedWave,
    ],
  )
  const now = '2026-08-12T12:00:00Z'
  await client.query(
    `INSERT INTO operations_pick_tasks (
       id, organization_id, plan_id, wave_id, global_id, status,
       quantity, picked_quantity, assigned_to, assigned_at, picked_at,
       created_at, updated_at, sequence_number
     ) VALUES
       ($1::uuid, $9::uuid, $5::uuid, $7::uuid, 'gpk0000001', 'ready',
        1.5, NULL, 'picker@example.com', '2026-08-12T11:30:00Z', NULL,
        $10::timestamptz, $10::timestamptz, 1),
       ($2::uuid, $9::uuid, $5::uuid, $7::uuid, 'gpk0000002', 'ready',
        2, NULL, 'picker@example.com', '2026-08-12T11:30:00Z', NULL,
        $10::timestamptz, $10::timestamptz, 2),
       ($3::uuid, $9::uuid, $6::uuid, $8::uuid, 'gpk0000003', 'ready',
        1, NULL, NULL, NULL, NULL,
        $10::timestamptz, $10::timestamptz, 1),
       ($4::uuid, $9::uuid, $11::uuid, $12::uuid, 'gpk0000004', 'picked',
        4, 4, 'picker@example.com', '2026-08-12T09:00:00Z',
        '2026-08-12T10:00:00Z', $10::timestamptz, $10::timestamptz, 1),
       ($13::uuid, $9::uuid, $14::uuid, $15::uuid, 'gpk0000005', 'picked',
        99, 99, 'picker@example.com', '2026-08-11T09:00:00Z',
        '2026-08-11T10:00:00Z', $10::timestamptz, $10::timestamptz, 1)`,
    [
      ids.activeTaskOne,
      ids.activeTaskTwo,
      ids.unassignedTask,
      ids.completedTask,
      ids.activePlan,
      ids.unassignedPlan,
      ids.activeWave,
      ids.unassignedWave,
      ids.organization,
      now,
      ids.completedPlan,
      ids.completedWave,
      ids.supersededCompletedTask,
      ids.supersededCompletedPlan,
      ids.supersededCompletedWave,
    ],
  )
  await client.query(
    `INSERT INTO operations_wearable_pick_scan_evidence (
       organization_id, order_id, pick_task_id, order_row_version
     ) VALUES ($1::uuid, $2::uuid, $3::uuid, 3)`,
    [ids.organization, ids.activeOrder, ids.activeTaskOne],
  )
  await client.query(
    `INSERT INTO operations_wearable_pick_count_evidence (
       organization_id, order_id, pick_task_id, order_row_version
     ) VALUES ($1::uuid, $2::uuid, $3::uuid, 3)`,
    [ids.organization, ids.activeOrder, ids.activeTaskTwo],
  )
  await client.query(
    `INSERT INTO operations_packages (
       id, organization_id, plan_id, status, packed_at
     ) VALUES
       ($1::uuid, $3::uuid, $4::uuid, 'planned', NULL),
       ($2::uuid, $3::uuid, $5::uuid, 'planned', NULL)`,
    [randomUUID(), randomUUID(), ids.organization, ids.activePlan, ids.unassignedPlan],
  )
  await client.query(
    `INSERT INTO operations_exceptions (
       id, organization_id, order_id, global_id,
       exception_type, status, created_at
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, 'gex0000001',
       'picker_handoff_requested', 'open', '2026-08-12T11:45:00Z'
     ), (
       $4::uuid, $2::uuid, $5::uuid, 'gex0000002',
       'manager_pick_intervention', 'open', '2026-08-12T11:50:00Z'
     )`,
    [
      randomUUID(),
      ids.organization,
      ids.activeOrder,
      randomUUID(),
      ids.unassignedOrder,
    ],
  )
  return ids
}

async function seedPaginationFixture(client, ids) {
  const sql = `INSERT INTO operations_orders (
       id, organization_id, global_id, order_number, row_version,
       status, updated_at, archived_at
     )
     SELECT md5('bulk-current-order-' || item)::uuid,
            $1::uuid,
            'gorbulkcurrent' || lpad(item::text, 3, '0'),
            'C' || lpad(item::text, 3, '0'),
            1, 'released',
            '2026-08-13T00:00:00Z'::timestamptz + item * interval '1 second',
            NULL
     FROM generate_series(1, 105) item;

     INSERT INTO operations_fulfillment_plans (
       id, organization_id, order_id, global_id, status, version_number
     )
     SELECT md5('bulk-current-plan-' || item)::uuid,
            $1::uuid,
            md5('bulk-current-order-' || item)::uuid,
            'gfpbulkcurrent' || lpad(item::text, 3, '0'),
            'released', 1
     FROM generate_series(1, 105) item;

     INSERT INTO operations_pick_tasks (
       id, organization_id, plan_id, wave_id, global_id, status,
       quantity, picked_quantity, assigned_to, assigned_at, picked_at,
       created_at, updated_at, sequence_number
     )
     SELECT md5('bulk-current-task-' || item)::uuid,
            $1::uuid,
            md5('bulk-current-plan-' || item)::uuid,
            $2::uuid,
            'gpkbulkcurrent' || lpad(item::text, 3, '0'),
            'ready', 1, NULL, 'picker@example.com',
            '2026-08-13T00:00:00Z'::timestamptz + item * interval '1 second',
            NULL,
            '2026-08-13T00:00:00Z'::timestamptz + item * interval '1 second',
            '2026-08-13T00:00:00Z'::timestamptz + item * interval '1 second',
            1
     FROM generate_series(1, 105) item;

     INSERT INTO operations_orders (
       id, organization_id, global_id, order_number, row_version,
       status, updated_at, archived_at
     )
     SELECT md5('bulk-history-order-' || item)::uuid,
            $1::uuid,
            'gorbulkhistory' || lpad(item::text, 3, '0'),
            'H' || lpad(item::text, 3, '0'),
            2, 'picking',
            '2026-08-13T12:00:00Z'::timestamptz + item * interval '1 second',
            NULL
     FROM generate_series(1, 105) item;

     INSERT INTO operations_fulfillment_plans (
       id, organization_id, order_id, global_id, status, version_number
     )
     SELECT md5('bulk-history-plan-' || item)::uuid,
            $1::uuid,
            md5('bulk-history-order-' || item)::uuid,
            'gfpbulkhistory' || lpad(item::text, 3, '0'),
            'released', 1
     FROM generate_series(1, 105) item;

     INSERT INTO operations_pick_tasks (
       id, organization_id, plan_id, wave_id, global_id, status,
       quantity, picked_quantity, assigned_to, assigned_at, picked_at,
       created_at, updated_at, sequence_number
     )
     SELECT md5('bulk-history-task-' || item)::uuid,
            $1::uuid,
            md5('bulk-history-plan-' || item)::uuid,
            $2::uuid,
            'gpkbulkhistory' || lpad(item::text, 3, '0'),
            'picked', 2, 2, 'picker@example.com',
            '2026-08-13T11:00:00Z'::timestamptz + item * interval '1 second',
            '2026-08-13T12:00:00Z'::timestamptz + item * interval '1 second',
            '2026-08-13T11:00:00Z'::timestamptz + item * interval '1 second',
            '2026-08-13T12:00:00Z'::timestamptz + item * interval '1 second',
            1
     FROM generate_series(1, 105) item`
  for (const statement of sql.split(/;\s*\n\s*\n/u)) {
    const parameterNumbers = [...statement.matchAll(/\$(\d+)/gu)]
      .map((match) => Number(match[1]))
    const parameterCount = Math.max(...parameterNumbers)
    const values = statement.includes("'bulk-history-task-'")
      ? [ids.organization, ids.completedWave]
      : [ids.organization, ids.activeWave]
    await client.query(statement, values.slice(0, parameterCount))
  }
}

async function verifyReadModel(databaseUrl) {
  const pool = new Pool({ connectionString: databaseUrl, max: 4 })
  const client = await pool.connect()
  try {
    await createFixture(client)
    const ids = await seedFixture(client)
    const { domain, persistence } = loadPickManagement(pool)
    const workspace = await persistence.readOperationsPickManagementFromPostgres({
      organizationId: ids.organization,
    })

    assert.equal(workspace.current.length, 2)
    const assigned = workspace.current.find(
      (item) => item.orderGlobalId === 'gor0000001',
    )
    assert.ok(assigned)
    assert.equal(assigned.assignmentState, 'assigned')
    assert.equal(assigned.assignedTo, 'picker@example.com')
    assert.equal(assigned.assignedDisplayName, 'Pat Picker')
    assert.equal(assigned.taskCount, 2)
    assert.equal(assigned.requiredUnits, 3.5)
    assert.equal(assigned.pickedUnits, 0)
    assert.equal(assigned.scanEvidenceTaskCount, 1)
    assert.equal(assigned.countEvidenceTaskCount, 1)
    assert.equal(assigned.handoffExceptionGlobalId, 'gex0000001')
    assert.match(assigned.managementBlockedReason, /scan evidence/u)
    assert.match(assigned.assignmentFingerprint, /^[a-f0-9]{64}$/u)
    assert.equal(
      assigned.assignmentFingerprint,
      domain.pickAssignmentFingerprint([
        { pickTaskGlobalId: 'gpk0000002', assignedTo: 'PICKER@example.com' },
        { pickTaskGlobalId: 'gpk0000001', assignedTo: 'picker@example.com' },
      ]),
      'Assignment fingerprint must be stable across task order and email case',
    )

    const unassigned = workspace.current.find(
      (item) => item.orderGlobalId === 'gor0000002',
    )
    assert.ok(unassigned)
    assert.equal(unassigned.assignmentState, 'unassigned')
    assert.equal(unassigned.unassignedTaskCount, 1)
    assert.equal(unassigned.interventionExceptionGlobalId, 'gex0000002')
    assert.equal(unassigned.managementBlockedReason, null)

    assert.equal(workspace.history.length, 1)
    assert.equal(workspace.history[0].orderGlobalId, 'gor0000003')
    assert.equal(workspace.history[0].pickerEmail, 'picker@example.com')
    assert.equal(workspace.history[0].taskCount, 1)
    assert.equal(workspace.history[0].unitCount, 4)
    assert.equal(workspace.history[0].planGlobalId, 'gfp0000003')
    assert.equal(workspace.history[0].waveGlobalId, 'gwv0000003')
    assert.deepEqual(
      Array.from(workspace.eligiblePickers, (picker) => picker.email),
      ['owner@example.com', 'picker@example.com'],
      'Only active members with Operations view and warehouse execution are eligible',
    )

    await seedPaginationFixture(client, ids)
    const firstPage = await persistence.readOperationsPickManagementFromPostgres({
      organizationId: ids.organization,
    })
    assert.equal(firstPage.current.length, 100)
    assert.equal(firstPage.current[0].orderGlobalId, 'gorbulkcurrent105')
    assert.equal(firstPage.pagination.current.hasMore, true)
    assert.ok(firstPage.pagination.current.nextCursor)
    assert.equal(
      firstPage.current.some((item) => item.orderGlobalId === 'gor0000001'),
      false,
      'Newest active assignments must occupy the first page',
    )
    const olderCurrent = await persistence.readOperationsPickManagementFromPostgres({
      organizationId: ids.organization,
      section: 'current',
      currentCursor: firstPage.pagination.current.nextCursor,
    })
    assert.equal(olderCurrent.current.length, 7)
    assert.equal(olderCurrent.history.length, 0)
    assert.equal(olderCurrent.pagination.current.hasMore, false)
    const allCurrentIds = new Set([
      ...firstPage.current.map((item) => item.orderGlobalId),
      ...olderCurrent.current.map((item) => item.orderGlobalId),
    ])
    assert.equal(allCurrentIds.size, 107)
    assert.ok(allCurrentIds.has('gor0000001'))
    assert.ok(allCurrentIds.has('gor0000002'))

    assert.equal(firstPage.history.length, 100)
    assert.equal(firstPage.history[0].orderGlobalId, 'gorbulkhistory105')
    assert.equal(firstPage.pagination.history.hasMore, true)
    assert.ok(firstPage.pagination.history.nextCursor)
    const olderHistory = await persistence.readOperationsPickManagementFromPostgres({
      organizationId: ids.organization,
      section: 'history',
      historyCursor: firstPage.pagination.history.nextCursor,
    })
    assert.equal(olderHistory.current.length, 0)
    assert.equal(olderHistory.history.length, 6)
    assert.equal(olderHistory.pagination.history.hasMore, false)
    const allHistoryIds = new Set([
      ...firstPage.history.map((item) => item.orderGlobalId),
      ...olderHistory.history.map((item) => item.orderGlobalId),
    ])
    assert.equal(allHistoryIds.size, 106)
    assert.ok(allHistoryIds.has('gor0000003'))

    await assert.rejects(
      persistence.readOperationsPickManagementFromPostgres({
        organizationId: ids.organization,
        section: 'current',
        currentCursor: 'not-a-valid-cursor',
      }),
      /Invalid pick-management cursor/u,
    )
  } finally {
    client.release()
    await pool.end()
  }
}

function verifyStaticContracts() {
  const operations = read('app_src/lib/persistence/operations.ts')
  const commandStart = operations.indexOf(
    'export async function manageOperationsOrderPickAssignmentFromPostgres',
  )
  const commandEnd = operations.indexOf('\ntype PickHandoffTaskRow', commandStart)
  assert.ok(commandStart > 0 && commandEnd > commandStart)
  const managerCommand = operations.slice(commandStart, commandEnd)
  for (const fragment of [
    "commandType: 'manage_operations_order_pick_assignment'",
    'expectedRowVersion',
    'expectedTaskCount',
    'expectedAssignmentFingerprint',
    'acquireTransactionAdvisoryLock',
    'lockManageablePickAssignment',
    "'manager_pick_intervention', 'high', 'open'",
    'durableEvidenceCleared: false',
    'physicalWorkChanged: false',
    'providerWrites: 0',
    'appendDomainEvent',
    'recordAuditEvent',
  ]) {
    assert.ok(managerCommand.includes(fragment), `Manager command is missing ${fragment}`)
  }
  assert.doesNotMatch(
    managerCommand,
    /DELETE\s+FROM\s+operations_wearable_pick_(?:scan|count)_evidence/iu,
    'Manager assignment must never delete wearable evidence',
  )
  assert.doesNotMatch(
    managerCommand,
    /SET\s+(?:status|picked_quantity|picked_at)\s*=/iu,
    'Manager assignment must not rewrite durable pick progress',
  )

  const lockStart = operations.indexOf('async function lockManageablePickAssignment')
  const lockEnd = operations.indexOf('\nconst ACTIVATION_STATES', lockStart)
  const assignmentLock = operations.slice(lockStart, lockEnd)
  for (const fragment of [
    'FOR UPDATE',
    'operations_wearable_pick_scan_evidence',
    'operations_wearable_pick_count_evidence',
    'operations_packages',
    'operations_labels',
    'operations_label_attempts',
    'operations_shipments',
    'OPERATIONS_PICK_ASSIGNMENT_SCAN_EVIDENCE_EXISTS',
    'OPERATIONS_PICK_ASSIGNMENT_COUNT_EVIDENCE_EXISTS',
  ]) {
    assert.ok(assignmentLock.includes(fragment), `Assignment lock is missing ${fragment}`)
  }

  const route = read('app_src/app/api/operations/route.ts')
  for (const fragment of [
    "action === 'manage-pick-assignment'",
    '!capabilities.canManage || !capabilities.canExecute',
    'expectedAssignmentFingerprint',
    'idempotencyKeyValue(req)',
  ]) {
    assert.ok(route.includes(fragment), `Operations route is missing ${fragment}`)
  }
  const readRoute = read('app_src/app/api/operations/pick-management/route.ts')
  assert.ok(readRoute.includes('!capabilities.canView || !capabilities.canManage'))
  assert.ok(readRoute.includes("'Cache-Control': 'private, no-store'"))
  for (const fragment of [
    "searchParams.get('section')",
    "searchParams.get('currentCursor')",
    "searchParams.get('historyCursor')",
    'OPERATIONS_PICK_MANAGEMENT_CURSOR_INVALID',
  ]) {
    assert.ok(readRoute.includes(fragment), `Pick-management route is missing ${fragment}`)
  }

  const panel = read('app_src/components/operations/PickManagementPanel.tsx')
  for (const fragment of [
    "'Idempotency-Key': idempotencyKey",
    "action: 'manage-pick-assignment'",
    'expectedRowVersion: selected.rowVersion',
    'expectedTaskCount: selected.taskCount',
    'expectedAssignmentFingerprint: selected.assignmentFingerprint',
    'Completed picks',
    'never deletes scan/count evidence',
    'Unassigning creates a',
    'load-more-current-pick-assignments',
    'load-more-completed-pick-history',
    "loadMorePage('current')",
    "loadMorePage('history')",
    'appendUniqueBy',
  ]) {
    assert.ok(panel.includes(fragment), `Picking UI is missing ${fragment}`)
  }
  const operationsSection = read(
    'app_src/components/operations/OperationsSection.tsx',
  )
  for (const fragment of [
    '<PickManagementPanel',
    'variant="scrollable"',
    "touchAction: 'pan-x'",
    "overflow: 'auto'",
    "WebkitOverflowScrolling: 'touch'",
  ]) {
    assert.ok(
      operationsSection.includes(fragment),
      `Responsive Operations picking layout is missing ${fragment}`,
    )
  }
  assert.ok(
    read('app_src/app/HomeClient.tsx')
      .includes("'operations/picking': 'picking'"),
  )
}

async function main() {
  verifyStaticContracts()
  command('docker', ['info'], { timeout: 30_000 })
  const container = (
    `clawpilot-pick-management-${process.pid}-${randomUUID().slice(0, 8)}`
  )
  try {
    command('docker', [
      'run', '--rm', '-d', '--name', container,
      '-e', 'POSTGRES_PASSWORD=clawpilot_pick_management',
      '-e', 'POSTGRES_DB=clawpilot_pick_management',
      '-p', '127.0.0.1::5432',
      'postgres:16-alpine',
    ], { timeout: 180_000 })
    const portOutput = command('docker', ['port', container, '5432/tcp'])
    const port = Number(portOutput.match(/:(\d+)\s*$/u)?.[1])
    assert.ok(port > 0, `Unable to resolve PostgreSQL port: ${portOutput}`)
    const databaseUrl = (
      'postgresql://postgres:clawpilot_pick_management@127.0.0.1:'
      + `${port}/clawpilot_pick_management`
    )
    await waitForPostgres(databaseUrl)
    await verifyReadModel(databaseUrl)
  } finally {
    spawnSync('docker', ['stop', '-t', '1', container], {
      cwd: root,
      encoding: 'utf8',
      timeout: 20_000,
    })
  }
  console.log('Operations pick-management acceptance passed')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
