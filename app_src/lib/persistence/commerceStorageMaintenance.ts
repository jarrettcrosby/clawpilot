import { query } from '@/lib/persistence/postgres'

const COMMERCE_STORAGE_GUARD_MIGRATION =
  '0351_operations_commerce_storage_bloat_guard.sql'
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
  status: 'completed' | 'not_due' | 'migration_pending' | 'failed'
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
}) {
  let rows = 0
  let bytes = 0
  for (let pass = 0; pass < input.passes; pass += 1) {
    const current = await input.run()
    rows += current.rows
    bytes += current.bytes
    if (current.rows < input.limit) break
  }
  return { rows, bytes }
}

async function completeMaintenanceLease(input: {
  leaseToken: string
  result: Record<string, unknown>
  errorCode: string | null
}) {
  await query(
    `SELECT complete_operations_commerce_storage_maintenance(
       $1::uuid, $2::jsonb, $3
     ) AS completed`,
    [input.leaseToken, JSON.stringify(input.result), input.errorCode],
  )
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

    const intake = await sumBoundedPurge({
      passes: 1,
      limit: intakeLimit,
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
    await completeMaintenanceLease({
      leaseToken,
      result: completed,
      errorCode: null,
    })
    return completed
  } catch (error) {
    const errorCode = maintenanceErrorCode(error)
    if (leaseToken) {
      await completeMaintenanceLease({
        leaseToken,
        result: { status: 'failed', errorCode },
        errorCode,
      }).catch(() => {})
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
  const result = await query<{ health: Record<string, unknown> }>(
    `SELECT operations_commerce_storage_bloat_health(1000) AS health`,
  )
  return {
    schemaAvailable: true,
    ...(result.rows[0]?.health || {}),
  }
}
