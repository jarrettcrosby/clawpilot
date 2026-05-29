export type StorageDriver = 'file' | 'postgres'

export function getStorageDriver(): StorageDriver {
  const requested = String(process.env.CLAWPILOT_STORAGE || 'file').toLowerCase().trim()
  if (requested === 'postgres' && process.env.DATABASE_URL) return 'postgres'
  return 'file'
}

export function isPostgresStorageEnabled(): boolean {
  return getStorageDriver() === 'postgres'
}

export function shouldFallbackToFileOnDatabaseError(): boolean {
  return String(process.env.CLAWPILOT_DB_FALLBACK_TO_FILE || 'true').toLowerCase() !== 'false'
}

