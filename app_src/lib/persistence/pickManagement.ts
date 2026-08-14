import type { QueryResultRow } from 'pg'
import {
  pickAssignmentFingerprint,
  type OperationsCompletedPickHistory,
  type OperationsCurrentPickAssignment,
  type OperationsEligiblePicker,
  type OperationsPickAssignmentPerson,
  type OperationsPickManagementWorkspace,
} from '@/lib/operations/pickManagement'
import { query } from '@/lib/persistence/postgres'
import { permissionsForRole, type AppUserRole } from '@/lib/users'

type CurrentPickRow = QueryResultRow & {
  order_id: string
  order_global_id: string
  order_number: string
  row_version: string
  order_status: 'released'
  order_updated_at: Date
  plan_global_id: string
  wave_global_id: string
  warehouse_name: string
  pick_task_global_id: string
  pick_status: string
  quantity: string
  picked_quantity: string | null
  assigned_to: string | null
  assigned_display_name: string | null
  assigned_at: Date | null
  picked_at: Date | null
  current_scan_evidence: boolean
  current_count_evidence: boolean
  package_started: boolean
  label_started: boolean
  shipment_started: boolean
  handoff_exception_global_id: string | null
  intervention_exception_global_id: string | null
}

type PickManagementSection = 'all' | 'current' | 'history'

type CurrentPageCursor = {
  kind: 'current'
  updatedAt: string
  orderId: string
}

type HistoryPageCursor = {
  kind: 'history'
  completedAt: string
  orderGlobalId: string
  planGlobalId: string
  waveGlobalId: string
  pickerEmail: string
}

export const PICK_MANAGEMENT_PAGE_SIZE = 100

type CompletedPickRow = QueryResultRow & {
  order_global_id: string
  order_number: string
  order_status: string
  plan_global_id: string
  wave_global_id: string
  picker_email: string
  picker_display_name: string | null
  task_count: string
  unit_count: string
  assigned_at: Date
  completed_at: Date
}

type PickerRow = QueryResultRow & {
  email: string
  display_name: string | null
  role: AppUserRole
  permissions: unknown
}

export const PICK_MANAGEMENT_CURRENT_QUERY = `
  WITH latest_plan AS (
    SELECT DISTINCT ON (plan.organization_id, plan.order_id)
           plan.organization_id, plan.order_id, plan.id, plan.global_id,
           plan.status, plan.version_number
    FROM operations_fulfillment_plans plan
    WHERE plan.organization_id = $1::uuid
    ORDER BY plan.organization_id, plan.order_id,
             plan.version_number DESC, plan.id DESC
  ), active_orders AS (
    SELECT orders.organization_id, orders.id
    FROM operations_orders orders
    JOIN latest_plan plan
      ON plan.organization_id = orders.organization_id
     AND plan.order_id = orders.id
     AND plan.status = 'released'
    WHERE orders.organization_id = $1::uuid
      AND orders.status = 'released'
      AND orders.archived_at IS NULL
      AND EXISTS (
        SELECT 1
        FROM operations_pick_tasks pick
        WHERE pick.organization_id = plan.organization_id
          AND pick.plan_id = plan.id
      )
      AND (
        $2::timestamptz IS NULL
        OR orders.updated_at < $2::timestamptz
        OR (
          orders.updated_at = $2::timestamptz
          AND orders.id < $3::uuid
        )
      )
    ORDER BY orders.updated_at DESC, orders.id DESC
    LIMIT $4
  )
  SELECT orders.id::text AS order_id,
         orders.global_id AS order_global_id,
         orders.order_number,
         orders.row_version::text,
         orders.status AS order_status,
         orders.updated_at AS order_updated_at,
         plan.global_id AS plan_global_id,
         wave.global_id AS wave_global_id,
         warehouse.name AS warehouse_name,
         pick.global_id AS pick_task_global_id,
         pick.status AS pick_status,
         pick.quantity::text,
         pick.picked_quantity::text,
         lower(pick.assigned_to) AS assigned_to,
         assigned_user.display_name AS assigned_display_name,
         pick.assigned_at,
         pick.picked_at,
         EXISTS (
           SELECT 1
           FROM operations_wearable_pick_scan_evidence scan
           WHERE scan.organization_id = pick.organization_id
             AND scan.order_id = orders.id
             AND scan.pick_task_id = pick.id
             AND scan.order_row_version = orders.row_version
         ) AS current_scan_evidence,
         EXISTS (
           SELECT 1
           FROM operations_wearable_pick_count_evidence count_evidence
           WHERE count_evidence.organization_id = pick.organization_id
             AND count_evidence.order_id = orders.id
             AND count_evidence.pick_task_id = pick.id
             AND count_evidence.order_row_version = orders.row_version
         ) AS current_count_evidence,
         EXISTS (
           SELECT 1
           FROM operations_packages package
           WHERE package.organization_id = plan.organization_id
             AND package.plan_id = plan.id
             AND (package.status <> 'planned' OR package.packed_at IS NOT NULL)
         ) AS package_started,
         (
           EXISTS (
             SELECT 1
             FROM operations_labels label
             JOIN operations_packages package
               ON package.organization_id = label.organization_id
              AND package.id = label.package_id
             WHERE label.organization_id = plan.organization_id
               AND package.plan_id = plan.id
           )
           OR EXISTS (
             SELECT 1
             FROM operations_label_attempts attempt
             WHERE attempt.organization_id = orders.organization_id
               AND attempt.order_id = orders.id
           )
         ) AS label_started,
         EXISTS (
           SELECT 1
           FROM operations_shipments shipment
           WHERE shipment.organization_id = orders.organization_id
             AND shipment.order_id = orders.id
         ) AS shipment_started,
         handoff.global_id AS handoff_exception_global_id,
         intervention.global_id AS intervention_exception_global_id
  FROM active_orders active_order
  JOIN operations_orders orders
    ON orders.organization_id = active_order.organization_id
   AND orders.id = active_order.id
  JOIN latest_plan plan
    ON plan.organization_id = orders.organization_id
   AND plan.order_id = orders.id
   AND plan.status = 'released'
  JOIN operations_pick_tasks pick
    ON pick.organization_id = plan.organization_id
   AND pick.plan_id = plan.id
  JOIN operations_waves wave
    ON wave.organization_id = pick.organization_id
   AND wave.id = pick.wave_id
  JOIN operations_warehouses warehouse
    ON warehouse.organization_id = wave.organization_id
   AND warehouse.id = wave.warehouse_id
  LEFT JOIN app_users assigned_user
    ON lower(assigned_user.email) = lower(pick.assigned_to)
  LEFT JOIN LATERAL (
    SELECT exception.global_id
    FROM operations_exceptions exception
    WHERE exception.organization_id = orders.organization_id
      AND exception.order_id = orders.id
      AND exception.exception_type = 'picker_handoff_requested'
      AND exception.status IN ('open', 'acknowledged')
    ORDER BY exception.created_at DESC, exception.id DESC
    LIMIT 1
  ) handoff ON true
  LEFT JOIN LATERAL (
    SELECT exception.global_id
    FROM operations_exceptions exception
    WHERE exception.organization_id = orders.organization_id
      AND exception.order_id = orders.id
      AND exception.exception_type = 'manager_pick_intervention'
      AND exception.status IN ('open', 'acknowledged')
    ORDER BY exception.created_at DESC, exception.id DESC
    LIMIT 1
  ) intervention ON true
  ORDER BY orders.updated_at DESC, orders.id DESC,
           pick.sequence_number, pick.id
`

export const PICK_MANAGEMENT_HISTORY_QUERY = `
  WITH latest_plan AS (
    SELECT DISTINCT ON (plan.organization_id, plan.order_id)
           plan.organization_id, plan.order_id, plan.id, plan.global_id
    FROM operations_fulfillment_plans plan
    WHERE plan.organization_id = $1::uuid
    ORDER BY plan.organization_id, plan.order_id,
             plan.version_number DESC, plan.id DESC
  ), history_groups AS (
    SELECT orders.global_id AS order_global_id,
           orders.order_number,
           orders.status AS order_status,
           plan.global_id AS plan_global_id,
           wave.global_id AS wave_global_id,
           lower(pick.assigned_to) AS picker_email,
           picker.display_name AS picker_display_name,
           count(*)::text AS task_count,
           sum(pick.picked_quantity)::text AS unit_count,
           min(COALESCE(pick.assigned_at, pick.created_at)) AS assigned_at,
           max(pick.picked_at) AS completed_at
    FROM operations_pick_tasks pick
    JOIN latest_plan plan
      ON plan.organization_id = pick.organization_id
     AND plan.id = pick.plan_id
    JOIN operations_waves wave
      ON wave.organization_id = pick.organization_id
     AND wave.id = pick.wave_id
    JOIN operations_orders orders
      ON orders.organization_id = plan.organization_id
     AND orders.id = plan.order_id
    LEFT JOIN app_users picker
      ON lower(picker.email) = lower(pick.assigned_to)
    WHERE pick.organization_id = $1::uuid
      AND pick.status = 'picked'
      AND pick.assigned_to IS NOT NULL
      AND pick.picked_quantity IS NOT NULL
      AND pick.picked_at IS NOT NULL
    GROUP BY orders.global_id, orders.order_number, orders.status,
             plan.global_id, wave.global_id,
             lower(pick.assigned_to), picker.display_name
  )
  SELECT *
  FROM history_groups
  WHERE (
    $2::timestamptz IS NULL
    OR (
      completed_at, order_global_id, plan_global_id,
      wave_global_id, picker_email
    ) < (
      $2::timestamptz, $3::text, $4::text, $5::text, $6::text
    )
  )
  ORDER BY completed_at DESC, order_global_id DESC,
           plan_global_id DESC, wave_global_id DESC, picker_email DESC
  LIMIT $7
`

export const PICK_MANAGEMENT_ELIGIBLE_PICKERS_QUERY = `
  SELECT membership.user_email AS email,
         app_user.display_name,
         membership.role,
         membership.permissions
  FROM app_user_organization_memberships membership
  JOIN app_users app_user ON app_user.email = membership.user_email
  WHERE membership.organization_id = $1::uuid
    AND membership.status = 'active'
    AND app_user.status = 'active'
  ORDER BY lower(COALESCE(app_user.display_name, membership.user_email)),
           membership.user_email
`

function nonnegativeNumber(value: string | number | null): number {
  const parsed = Number(value || 0)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0
}

function nonnegativeInteger(value: string | number | null): number {
  const parsed = nonnegativeNumber(value)
  return Number.isSafeInteger(parsed) ? parsed : 0
}

function managementBlockedReason(rows: CurrentPickRow[]): string | null {
  if (rows.length > 200) {
    return 'Orders with more than 200 pick tasks require dedicated manager review.'
  }
  if (rows.some((row) => (
    row.pick_status !== 'ready'
    || nonnegativeNumber(row.picked_quantity) !== 0
    || row.picked_at !== null
  ))) {
    return 'Assignment changes stop after any pick task has started.'
  }
  if (rows.some((row) => row.current_scan_evidence)) {
    return 'Current-version scan evidence exists. Use picker handoff or resolve the physical work before changing assignment.'
  }
  if (rows.some((row) => row.current_count_evidence)) {
    return 'Current-version count evidence exists. Resolve the physical work before changing assignment.'
  }
  if (rows.some((row) => row.package_started)) {
    return 'Packing has started for this order.'
  }
  if (rows.some((row) => row.label_started)) {
    return 'Label preparation has started for this order.'
  }
  if (rows.some((row) => row.shipment_started)) {
    return 'Shipment evidence already exists for this order.'
  }
  return null
}

function currentAssignments(rows: CurrentPickRow[]): OperationsCurrentPickAssignment[] {
  const grouped = new Map<string, CurrentPickRow[]>()
  for (const row of rows) {
    const existing = grouped.get(row.order_global_id) || []
    existing.push(row)
    grouped.set(row.order_global_id, existing)
  }

  return [...grouped.values()].map((tasks) => {
    const first = tasks[0]
    const assigned = new Map<string, OperationsPickAssignmentPerson>()
    let unassignedTaskCount = 0
    for (const task of tasks) {
      if (!task.assigned_to) {
        unassignedTaskCount += 1
        continue
      }
      const current = assigned.get(task.assigned_to)
      assigned.set(task.assigned_to, {
        email: task.assigned_to,
        displayName: task.assigned_display_name,
        taskCount: (current?.taskCount || 0) + 1,
      })
    }
    const assignedPickers = [...assigned.values()].sort((left, right) => (
      (left.displayName || left.email).localeCompare(
        right.displayName || right.email,
      )
    ))
    const assignmentState = unassignedTaskCount === tasks.length
      ? 'unassigned' as const
      : unassignedTaskCount === 0 && assignedPickers.length === 1
        ? 'assigned' as const
        : 'mixed' as const
    const assignedTo = assignmentState === 'assigned'
      ? assignedPickers[0].email
      : null
    const assignedAt = tasks
      .map((task) => task.assigned_at?.getTime() || 0)
      .filter((value) => value > 0)
      .sort((left, right) => left - right)[0] || null
    return {
      orderGlobalId: first.order_global_id,
      orderNumber: first.order_number,
      rowVersion: nonnegativeInteger(first.row_version),
      orderStatus: 'released' as const,
      planGlobalId: first.plan_global_id,
      waveGlobalId: first.wave_global_id,
      warehouseName: first.warehouse_name,
      assignmentState,
      assignedTo,
      assignedDisplayName: assignmentState === 'assigned'
        ? assignedPickers[0].displayName
        : null,
      assignedPickers,
      unassignedTaskCount,
      assignmentFingerprint: pickAssignmentFingerprint(tasks.map((task) => ({
        pickTaskGlobalId: task.pick_task_global_id,
        assignedTo: task.assigned_to,
      }))),
      taskCount: tasks.length,
      readyTaskCount: tasks.filter((task) => task.pick_status === 'ready').length,
      pickedTaskCount: tasks.filter((task) => task.pick_status === 'picked').length,
      requiredUnits: tasks.reduce(
        (total, task) => total + nonnegativeNumber(task.quantity),
        0,
      ),
      pickedUnits: tasks.reduce(
        (total, task) => total + nonnegativeNumber(task.picked_quantity),
        0,
      ),
      scanEvidenceTaskCount: tasks.filter(
        (task) => task.current_scan_evidence,
      ).length,
      countEvidenceTaskCount: tasks.filter(
        (task) => task.current_count_evidence,
      ).length,
      assignedAt: assignedAt === null ? null : new Date(assignedAt).toISOString(),
      latestActivityAt: first.order_updated_at.toISOString(),
      handoffExceptionGlobalId: first.handoff_exception_global_id,
      interventionExceptionGlobalId:
        first.intervention_exception_global_id,
      managementBlockedReason: managementBlockedReason(tasks),
    }
  })
}

function completedHistory(rows: CompletedPickRow[]): OperationsCompletedPickHistory[] {
  return rows.map((row) => ({
    orderGlobalId: row.order_global_id,
    orderNumber: row.order_number,
    orderStatus: row.order_status,
    planGlobalId: row.plan_global_id,
    waveGlobalId: row.wave_global_id,
    pickerEmail: row.picker_email,
    pickerDisplayName: row.picker_display_name,
    taskCount: nonnegativeInteger(row.task_count),
    unitCount: nonnegativeNumber(row.unit_count),
    assignedAt: row.assigned_at.toISOString(),
    completedAt: row.completed_at.toISOString(),
  }))
}

function eligiblePickers(rows: PickerRow[]): OperationsEligiblePicker[] {
  return rows.flatMap((row) => {
    const permissions = permissionsForRole(row.role, row.permissions)
    const eligible = row.role === 'owner' || (
      permissions.viewOperations && permissions.executeWarehouse
    )
    return eligible ? [{
      email: row.email.toLowerCase(),
      displayName: row.display_name,
    }] : []
  })
}

function encodePageCursor(
  cursor: CurrentPageCursor | HistoryPageCursor,
): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')
}

function cursorString(
  source: Record<string, unknown>,
  key: string,
): string {
  const value = typeof source[key] === 'string' ? source[key].trim() : ''
  if (!value || value.length > 500) {
    throw new Error('Invalid pick-management cursor')
  }
  return value
}

function cursorTimestamp(
  source: Record<string, unknown>,
  key: string,
): string {
  const value = cursorString(source, key)
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) {
    throw new Error('Invalid pick-management cursor')
  }
  return new Date(timestamp).toISOString()
}

function cursorUuid(
  source: Record<string, unknown>,
  key: string,
): string {
  const value = cursorString(source, key).toLowerCase()
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(value)) {
    throw new Error('Invalid pick-management cursor')
  }
  return value
}

function decodePageCursor(
  value: string | null | undefined,
  kind: 'current',
): CurrentPageCursor | null
function decodePageCursor(
  value: string | null | undefined,
  kind: 'history',
): HistoryPageCursor | null
function decodePageCursor(
  value: string | null | undefined,
  kind: 'current' | 'history',
): CurrentPageCursor | HistoryPageCursor | null {
  const normalized = String(value || '').trim()
  if (!normalized) return null
  if (normalized.length > 2_048) {
    throw new Error('Invalid pick-management cursor')
  }
  let source: Record<string, unknown>
  try {
    const parsed = JSON.parse(
      Buffer.from(normalized, 'base64url').toString('utf8'),
    ) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Invalid cursor payload')
    }
    source = parsed as Record<string, unknown>
  } catch {
    throw new Error('Invalid pick-management cursor')
  }
  if (source.kind !== kind) {
    throw new Error('Invalid pick-management cursor')
  }
  if (kind === 'current') {
    return {
      kind,
      updatedAt: cursorTimestamp(source, 'updatedAt'),
      orderId: cursorUuid(source, 'orderId'),
    }
  }
  return {
    kind,
    completedAt: cursorTimestamp(source, 'completedAt'),
    orderGlobalId: cursorString(source, 'orderGlobalId'),
    planGlobalId: cursorString(source, 'planGlobalId'),
    waveGlobalId: cursorString(source, 'waveGlobalId'),
    pickerEmail: cursorString(source, 'pickerEmail').toLowerCase(),
  }
}

function emptyPageInfo() {
  return { hasMore: false, nextCursor: null }
}

export async function readOperationsPickManagementFromPostgres(input: {
  organizationId: string
  section?: PickManagementSection
  currentCursor?: string | null
  historyCursor?: string | null
}): Promise<OperationsPickManagementWorkspace> {
  const organizationId = String(input.organizationId || '').trim()
  if (!organizationId) throw new Error('Pick management organization is required')
  const section = input.section || 'all'
  if (!['all', 'current', 'history'].includes(section)) {
    throw new Error('Invalid pick-management section')
  }
  const includeCurrent = section === 'all' || section === 'current'
  const includeHistory = section === 'all' || section === 'history'
  const currentCursor = includeCurrent
    ? decodePageCursor(input.currentCursor, 'current')
    : null
  const historyCursor = includeHistory
    ? decodePageCursor(input.historyCursor, 'history')
    : null
  const pageLimit = PICK_MANAGEMENT_PAGE_SIZE + 1
  const [currentRows, historyRows, pickerResult] = await Promise.all([
    includeCurrent
      ? query<CurrentPickRow>(PICK_MANAGEMENT_CURRENT_QUERY, [
        organizationId,
        currentCursor?.updatedAt || null,
        currentCursor?.orderId || null,
        pageLimit,
      ]).then((result) => result.rows)
      : Promise.resolve([] as CurrentPickRow[]),
    includeHistory
      ? query<CompletedPickRow>(PICK_MANAGEMENT_HISTORY_QUERY, [
        organizationId,
        historyCursor?.completedAt || null,
        historyCursor?.orderGlobalId || null,
        historyCursor?.planGlobalId || null,
        historyCursor?.waveGlobalId || null,
        historyCursor?.pickerEmail || null,
        pageLimit,
      ]).then((result) => result.rows)
      : Promise.resolve([] as CompletedPickRow[]),
    query<PickerRow>(PICK_MANAGEMENT_ELIGIBLE_PICKERS_QUERY, [organizationId]),
  ])
  const allCurrent = currentAssignments(currentRows)
  const current = allCurrent.slice(0, PICK_MANAGEMENT_PAGE_SIZE)
  const currentHasMore = includeCurrent
    && allCurrent.length > PICK_MANAGEMENT_PAGE_SIZE
  const lastCurrent = current.at(-1)
  const lastCurrentRow = lastCurrent
    ? currentRows.find((row) => (
      row.order_global_id === lastCurrent.orderGlobalId
    ))
    : undefined
  const allHistory = completedHistory(historyRows)
  const history = allHistory.slice(0, PICK_MANAGEMENT_PAGE_SIZE)
  const historyHasMore = includeHistory
    && allHistory.length > PICK_MANAGEMENT_PAGE_SIZE
  const lastHistory = history.at(-1)
  return {
    generatedAt: new Date().toISOString(),
    current,
    history,
    eligiblePickers: eligiblePickers(pickerResult.rows),
    pagination: {
      current: currentHasMore && lastCurrent && lastCurrentRow ? {
        hasMore: true,
        nextCursor: encodePageCursor({
          kind: 'current',
          updatedAt: lastCurrent.latestActivityAt,
          orderId: lastCurrentRow.order_id,
        }),
      } : emptyPageInfo(),
      history: historyHasMore && lastHistory ? {
        hasMore: true,
        nextCursor: encodePageCursor({
          kind: 'history',
          completedAt: lastHistory.completedAt,
          orderGlobalId: lastHistory.orderGlobalId,
          planGlobalId: lastHistory.planGlobalId,
          waveGlobalId: lastHistory.waveGlobalId,
          pickerEmail: lastHistory.pickerEmail,
        }),
      } : emptyPageInfo(),
    },
  }
}
