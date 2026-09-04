import { query } from '@/lib/persistence/postgres'

const COMMERCE_STORAGE_GUARD_MIGRATION =
  '0351_operations_commerce_storage_bloat_guard.sql'

function boundedLimit(value: number | undefined, fallback: number, max: number) {
  const parsed = Number(value ?? fallback)
  return Number.isSafeInteger(parsed)
    ? Math.max(1, Math.min(parsed, max))
    : fallback
}

export type CommerceStorageMaintenanceResult = Readonly<{
  schemaAvailable: boolean
  intakePayloads: { rows: number; bytes: number }
  legacyInventoryCaptures: { rows: number; bytes: number }
  inventoryObservationAliases: { rows: number; bytes: number }
  inventoryLevels: { rows: number; bytes: number }
}>

export async function maintainCommerceStorageInPostgres(input: {
  intakeLimit?: number
  legacyCaptureLimit?: number
  inventoryLevelLimit?: number
} = {}): Promise<CommerceStorageMaintenanceResult> {
  const intakeLimit = boundedLimit(input.intakeLimit, 1000, 5000)
  const legacyCaptureLimit = boundedLimit(
    input.legacyCaptureLimit,
    25,
    250,
  )
  const inventoryLevelLimit = boundedLimit(
    input.inventoryLevelLimit,
    10000,
    10000,
  )
  const readiness = await query<{ migration_applied: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM schema_migrations WHERE filename = $1
     ) AS migration_applied`,
    [COMMERCE_STORAGE_GUARD_MIGRATION],
  )
  if (readiness.rows[0]?.migration_applied !== true) {
    return Object.freeze({
      schemaAvailable: false,
      intakePayloads: { rows: 0, bytes: 0 },
      legacyInventoryCaptures: { rows: 0, bytes: 0 },
      inventoryObservationAliases: { rows: 0, bytes: 0 },
      inventoryLevels: { rows: 0, bytes: 0 },
    })
  }
  const intake = await query<{ purged_rows: number; purged_bytes: string }>(
    `SELECT purged_rows, purged_bytes::text
     FROM purge_operations_commerce_intake_read_payloads($1)`,
    [intakeLimit],
  )
  const capture = await query<{
    converted_rows: number
    converted_bytes: string
  }>(
    `SELECT converted_rows, converted_bytes::text
     FROM convert_operations_commerce_inventory_legacy_captures($1)`,
    [legacyCaptureLimit],
  )
  const aliases = await query<{ purged_rows: number; purged_bytes: string }>(
    `SELECT purged_rows, purged_bytes::text
     FROM purge_operations_commerce_inventory_observation_aliases($1)`,
    [intakeLimit],
  )
  const inventory = await query<{
    purged_rows: number
    purged_bytes: string
  }>(
    `SELECT purged_rows, purged_bytes::text
     FROM purge_operations_commerce_inventory_level_evidence($1)`,
    [inventoryLevelLimit],
  )
  return Object.freeze({
    schemaAvailable: true,
    intakePayloads: {
      rows: Number(intake.rows[0]?.purged_rows || 0),
      bytes: Number(intake.rows[0]?.purged_bytes || 0),
    },
    legacyInventoryCaptures: {
      rows: Number(capture.rows[0]?.converted_rows || 0),
      bytes: Number(capture.rows[0]?.converted_bytes || 0),
    },
    inventoryObservationAliases: {
      rows: Number(aliases.rows[0]?.purged_rows || 0),
      bytes: Number(aliases.rows[0]?.purged_bytes || 0),
    },
    inventoryLevels: {
      rows: Number(inventory.rows[0]?.purged_rows || 0),
      bytes: Number(inventory.rows[0]?.purged_bytes || 0),
    },
  })
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
