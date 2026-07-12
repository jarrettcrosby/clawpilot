export type StorageDriver = 'file' | 'postgres'

export function isHostedRuntime(): boolean {
  return Boolean(
    process.env.RAILWAY_ENVIRONMENT_NAME
    || process.env.RAILWAY_ENVIRONMENT_ID
    || process.env.RAILWAY_PROJECT_ID
    || process.env.RAILWAY_ENVIRONMENT
    || process.env.VERCEL,
  )
}

export function getStorageDriver(): StorageDriver {
  const requested = String(process.env.CLAWPILOT_STORAGE || 'file').toLowerCase().trim()
  if (requested === 'postgres' && process.env.DATABASE_URL) return 'postgres'
  return 'file'
}

export function isPostgresStorageEnabled(): boolean {
  return getStorageDriver() === 'postgres'
}

export function shouldFallbackToFileOnDatabaseError(): boolean {
  const configured = process.env.CLAWPILOT_DB_FALLBACK_TO_FILE
  if (configured !== undefined) return String(configured).toLowerCase() === 'true'
  return !isHostedRuntime()
}

export function isOpenClawExecutionEnabled(): boolean {
  const configured = process.env.CLAWPILOT_EXECUTION_ENABLED
  if (configured !== undefined) return String(configured).toLowerCase() === '1'
  return !isHostedRuntime()
}
