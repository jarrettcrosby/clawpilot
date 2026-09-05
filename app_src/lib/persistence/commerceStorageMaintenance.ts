import { query } from '@/lib/persistence/postgres'

const COMMERCE_STORAGE_GUARD_MIGRATION =
  '0352_operations_commerce_storage_bloat_guard_online.sql'
const COMMERCE_STORAGE_MAINTENANCE_LEASE_LOST =
  'COMMERCE_STORAGE_MAINTENANCE_LEASE_LOST'
const LEVEL_PURGE_PASSES_PER_LEASE = 12
const SNAPSHOT_PURGE_PASSES_PER_LEASE = 4
const ALIAS_PURGE_PASSES_PER_LEASE = 4
const LEGACY_CAPTURE_PASSES_PER_LEASE = 4

function boundedLimit(value: number | undefined, fallback: number, max: number) {
  const parsed = Number(value ?? fallback)
  return Number.isSafeInteger(parsed)
    ? Math.max(1, Math.min(parsed, max))
    : fallback
}

type StorageMetric = Readonly<{ rows: number; bytes: number }>

export type CommerceStorageMaintenanceResult = Readonly<{
  schemaAvailable: boolean
  executed: boolean
  status:
    | 'completed'
    | 'not_due'
    | 'migration_pending'
    | 'failed'
    | 'lease_lost'
  errorCode: string | null
  intakePayloads: StorageMetric
  legacyInventoryCaptures: StorageMetric
  inventorySnapshotPayloads: StorageMetric
  inventoryObservationAliases: StorageMetric
  inventoryLevels: StorageMetric
}>

function emptyResult(input: Pick<
  CommerceStorageMaintenanceResult,
  'schemaAvailable' | 'executed' | 'status' | 'errorCode'
>): CommerceStorageMaintenanceResult {
  return Object.freeze({
    ...input,
    intakePayloads: { rows: 0, bytes: 0 },
    legacyInventoryCaptures: { rows: 0, bytes: 0 },
    inventorySnapshotPayloads: { rows: 0, bytes: 0 },
    inventoryObservationAliases: { rows: 0, bytes: 0 },
    inventoryLevels: { rows: 0, bytes: 0 },
  })
}

function maintenanceErrorCode(error: unknown) {
  const supplied = error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code || '')
    : ''
  const normalized = supplied.replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 120)
  return normalized || 'COMMERCE_STORAGE_MAINTENANCE_FAILED'
}

export function commerceStorageMaintenanceFailureResult(
  error: unknown,
): CommerceStorageMaintenanceResult {
  return emptyResult({
    schemaAvailable: false,
    executed: false,
    status: 'failed',
    errorCode: maintenanceErrorCode(error),
  })
}

async function sumBoundedPurge(input: {
  passes: number
  limit: number
  run: () => Promise<StorageMetric>
  afterPass: () => Promise<void>
}) {
  let rows = 0
  let bytes = 0
  for (let pass = 0; pass < input.passes; pass += 1) {
    const current = await input.run()
    rows += current.rows
    bytes += current.bytes
    await input.afterPass()
    if (current.rows < input.limit) break
  }
  return { rows, bytes }
}

async function completeMaintenanceLease(input: {
  leaseToken: string
  result: Record<string, unknown>
  errorCode: string | null
}) {
  const result = await query<{ completed: boolean }>(
    `SELECT complete_operations_commerce_storage_maintenance(
       $1::uuid, $2::jsonb, $3
     ) AS completed`,
    [input.leaseToken, JSON.stringify(input.result), input.errorCode],
  )
  return result.rows[0]?.completed === true
}

async function renewMaintenanceLease(leaseToken: string) {
  const result = await query<{ renewed: boolean }>(
    `SELECT renew_operations_commerce_storage_maintenance(
       $1::uuid, 120
     ) AS renewed`,
    [leaseToken],
  )
  if (result.rows[0]?.renewed !== true) {
    const error = new Error(
      'Commerce storage maintenance authority expired during a purge pass',
    ) as Error & { code?: string }
    error.code = COMMERCE_STORAGE_MAINTENANCE_LEASE_LOST
    throw error
  }
}

/**
 * Offers one bounded storage-maintenance lease. The persisted cadence makes
 * frequent worker calls cheap and single-flight. All failures are returned as
 * telemetry, never thrown into commerce job claiming or provider processing.
 * Twelve 10,000-row level passes exceed the inventory worker's strict maximum
 * of ten 10,000-level jobs per cycle while every SQL transaction stays bounded.
 */
export async function maintainCommerceStorageInPostgres(input: {
  intakeLimit?: number
  legacyCaptureLimit?: number
  inventorySnapshotLimit?: number
  inventoryAliasLimit?: number
  inventoryLevelLimit?: number
  workerId?: string
} = {}): Promise<CommerceStorageMaintenanceResult> {
  const intakeLimit = boundedLimit(input.intakeLimit, 1000, 5000)
  const legacyCaptureLimit = boundedLimit(
    input.legacyCaptureLimit,
    25,
    250,
  )
  const inventorySnapshotLimit = boundedLimit(
    input.inventorySnapshotLimit,
    250,
    1000,
  )
  const inventoryAliasLimit = boundedLimit(
    input.inventoryAliasLimit,
    5000,
    5000,
  )
  const inventoryLevelLimit = boundedLimit(
    input.inventoryLevelLimit,
    10000,
    10000,
  )
  let leaseToken: string | null = null
  try {
    const readiness = await query<{ migration_applied: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM schema_migrations WHERE filename = $1
       ) AS migration_applied`,
      [COMMERCE_STORAGE_GUARD_MIGRATION],
    )
    if (readiness.rows[0]?.migration_applied !== true) {
      return emptyResult({
        schemaAvailable: false,
        executed: false,
        status: 'migration_pending',
        errorCode: null,
      })
    }
    const claim = await query<{ lease_token: string | null }>(
      `SELECT claim_operations_commerce_storage_maintenance(
         $1, 10, 120
       )::text AS lease_token`,
      [input.workerId || `commerce-storage:${process.pid}`],
    )
    leaseToken = claim.rows[0]?.lease_token || null
    if (!leaseToken) {
      return emptyResult({
        schemaAvailable: true,
        executed: false,
        status: 'not_due',
        errorCode: null,
      })
    }
    const renewLease = () => renewMaintenanceLease(leaseToken as string)

    const intake = await sumBoundedPurge({
      passes: 1,
      limit: intakeLimit,
      afterPass: renewLease,
      run: async () => {
        const result = await query<{
          purged_rows: number
          purged_bytes: string
        }>(
          `SELECT purged_rows, purged_bytes::text
           FROM purge_operations_commerce_intake_read_payloads($1)`,
          [intakeLimit],
        )
        return {
          rows: Number(result.rows[0]?.purged_rows || 0),
          bytes: Number(result.rows[0]?.purged_bytes || 0),
        }
      },
    })
    const capture = await sumBoundedPurge({
      passes: LEGACY_CAPTURE_PASSES_PER_LEASE,
      limit: legacyCaptureLimit,
      afterPass: renewLease,
      run: async () => {
        const result = await query<{
          converted_rows: number
          converted_bytes: string
        }>(
          `SELECT converted_rows, converted_bytes::text
           FROM convert_operations_commerce_inventory_legacy_captures($1)`,
          [legacyCaptureLimit],
        )
        return {
          rows: Number(result.rows[0]?.converted_rows || 0),
          bytes: Number(result.rows[0]?.converted_bytes || 0),
        }
      },
    })
    const snapshot = await sumBoundedPurge({
      passes: SNAPSHOT_PURGE_PASSES_PER_LEASE,
      limit: inventorySnapshotLimit,
      afterPass: renewLease,
      run: async () => {
        const result = await query<{
          purged_rows: number
          purged_bytes: string
        }>(
          `SELECT purged_rows, purged_bytes::text
           FROM purge_operations_commerce_inventory_snapshot_payloads($1)`,
          [inventorySnapshotLimit],
        )
        return {
          rows: Number(result.rows[0]?.purged_rows || 0),
          bytes: Number(result.rows[0]?.purged_bytes || 0),
        }
      },
    })
    const aliases = await sumBoundedPurge({
      passes: ALIAS_PURGE_PASSES_PER_LEASE,
      limit: inventoryAliasLimit,
      afterPass: renewLease,
      run: async () => {
        const result = await query<{
          purged_rows: number
          purged_bytes: string
        }>(
          `SELECT purged_rows, purged_bytes::text
           FROM purge_operations_commerce_inventory_observation_aliases($1)`,
          [inventoryAliasLimit],
        )
        return {
          rows: Number(result.rows[0]?.purged_rows || 0),
          bytes: Number(result.rows[0]?.purged_bytes || 0),
        }
      },
    })
    const inventory = await sumBoundedPurge({
      passes: LEVEL_PURGE_PASSES_PER_LEASE,
      limit: inventoryLevelLimit,
      afterPass: renewLease,
      run: async () => {
        const result = await query<{
          purged_rows: number
          purged_bytes: string
        }>(
          `SELECT purged_rows, purged_bytes::text
           FROM purge_operations_commerce_inventory_level_evidence($1)`,
          [inventoryLevelLimit],
        )
        return {
          rows: Number(result.rows[0]?.purged_rows || 0),
          bytes: Number(result.rows[0]?.purged_bytes || 0),
        }
      },
    })
    const completed: CommerceStorageMaintenanceResult = Object.freeze({
      schemaAvailable: true,
      executed: true,
      status: 'completed',
      errorCode: null,
      intakePayloads: intake,
      legacyInventoryCaptures: capture,
      inventorySnapshotPayloads: snapshot,
      inventoryObservationAliases: aliases,
      inventoryLevels: inventory,
    })
    const leaseCompleted = await completeMaintenanceLease({
      leaseToken,
      result: completed,
      errorCode: null,
    })
    if (!leaseCompleted) {
      return Object.freeze({
        ...completed,
        status: 'lease_lost',
        errorCode: COMMERCE_STORAGE_MAINTENANCE_LEASE_LOST,
      })
    }
    return completed
  } catch (error) {
    const errorCode = maintenanceErrorCode(error)
    let completionAccepted = false
    if (leaseToken) {
      completionAccepted = await completeMaintenanceLease({
        leaseToken,
        result: { status: 'failed', errorCode },
        errorCode,
      }).catch(() => false)
    }
    if (
      leaseToken
      && (
        errorCode === COMMERCE_STORAGE_MAINTENANCE_LEASE_LOST
        || !completionAccepted
      )
    ) {
      return emptyResult({
        schemaAvailable: true,
        executed: true,
        status: 'lease_lost',
        errorCode: COMMERCE_STORAGE_MAINTENANCE_LEASE_LOST,
      })
    }
    return Object.freeze({
      ...commerceStorageMaintenanceFailureResult(error),
      schemaAvailable: Boolean(leaseToken),
      executed: Boolean(leaseToken),
    })
  }
}

export async function readCommerceStorageBloatHealthFromPostgres() {
  const readiness = await query<{ migration_applied: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM schema_migrations WHERE filename = $1
     ) AS migration_applied`,
    [COMMERCE_STORAGE_GUARD_MIGRATION],
  )
  if (readiness.rows[0]?.migration_applied !== true) {
    return { schemaAvailable: false }
  }
  const result = await query<{
    next_run_at: string
    lease_owner: string | null
    lease_expires_at: string | null
    lease_active: boolean
    lease_expired: boolean
    last_started_at: string | null
    last_completed_at: string | null
    last_failed_at: string | null
    last_error_code: string | null
    last_result: Record<string, unknown>
    row_version: string
  }>(
    `SELECT next_run_at::text, lease_owner, lease_expires_at::text,
            lease_token IS NOT NULL
              AND lease_expires_at > clock_timestamp() AS lease_active,
            lease_token IS NOT NULL
              AND lease_expires_at <= clock_timestamp() AS lease_expired,
            last_started_at::text, last_completed_at::text,
            last_failed_at::text, last_error_code, last_result,
            row_version::text
     FROM operations_commerce_storage_maintenance_lanes
     WHERE lane_name = 'commerce-storage'`,
  )
  const lane = result.rows[0]
  return {
    schemaAvailable: true,
    diagnosticsMode: 'persisted-maintenance',
    storageMaintenance: lane ? {
      nextRunAt: lane.next_run_at,
      leaseOwner: lane.lease_owner,
      leaseExpiresAt: lane.lease_expires_at,
      leaseActive: lane.lease_active,
      leaseExpired: lane.lease_expired,
      lastStartedAt: lane.last_started_at,
      lastCompletedAt: lane.last_completed_at,
      lastFailedAt: lane.last_failed_at,
      lastErrorCode: lane.last_error_code,
      lastResult: lane.last_result || {},
      rowVersion: Number(lane.row_version || 0),
    } : null,
  }
}
