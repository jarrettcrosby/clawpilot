#!/usr/bin/env node
// Read-only Railway preflight for a separately migrated database. This tool
// cannot create roles, grant privileges, apply migrations, or change the fence.
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { readdirSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const requireFromApp = createRequire(new URL('../app_src/package.json', import.meta.url))
const migrationDirectory = new URL('../db/migrations/', import.meta.url)
const rolePattern = /^[a-z_][a-z0-9_]{0,62}$/u

export function splitPostgresCustody(env) {
  const mode = env.CLAWPILOT_POSTGRES_CUSTODY ?? ''
  const runtime = env.CLAWPILOT_POSTGRES_RUNTIME_ROLE ?? ''
  const operator = env.CLAWPILOT_POSTGRES_OPERATOR_ROLE ?? ''
  if (!mode && !runtime && !operator) return null
  if (mode !== 'split-v1' || !rolePattern.test(runtime) || !rolePattern.test(operator) || runtime === operator) {
    throw new Error('postgres_custody_invalid_configuration')
  }
  if ((env.INTEGRATION_CREDENTIAL_ATTESTATION_MODE || 'strict') !== 'strict') {
    throw new Error('postgres_custody_requires_strict_credential_attestation')
  }
  return { runtime, operator }
}

export function readExpectedMigrations() {
  return new Map(readdirSync(migrationDirectory).filter((name) => /^\d+_.+\.sql$/u.test(name)).sort().map((filename) => [
    filename,
    createHash('sha256').update(readFileSync(new URL(filename, migrationDirectory))).digest('hex'),
  ]))
}

// Inspect the private fence through catalogs, without giving runtime USAGE.
// The operator still verifies full coverage() immediately before maintenance.
const custodySql = `
  SELECT
    current_user = $1 AND session_user = $1 AND runtime.rolcanlogin
      AND NOT (runtime.rolsuper OR runtime.rolcreaterole OR runtime.rolcreatedb
        OR runtime.rolreplication OR runtime.rolbypassrls)
      AND NOT EXISTS (SELECT FROM pg_catalog.pg_auth_members m WHERE m.member = runtime.oid)
      AND NOT pg_catalog.pg_has_role(runtime.oid, operator.oid, 'MEMBER')
      AND NOT pg_catalog.pg_has_role(runtime.oid, db.datdba, 'USAGE')
      AND NOT pg_catalog.has_database_privilege(db.oid, 'CREATE')
      AND NOT pg_catalog.has_schema_privilege('public', 'CREATE') AS restricted_login,
    ledger.relowner = operator.oid AND ledger.relkind = 'r'
      AND pg_catalog.has_table_privilege(ledger.oid, 'SELECT')
      AND NOT pg_catalog.has_any_column_privilege(ledger.oid, 'SELECT WITH GRANT OPTION')
      AND NOT pg_catalog.has_table_privilege(ledger.oid, 'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
      AND NOT pg_catalog.has_any_column_privilege(ledger.oid, 'INSERT, UPDATE, REFERENCES') AS ledger_read_only,
    fence_schema.nspowner = operator.oid AND fence.relowner = operator.oid AND fence.relkind = 'r'
      AND NOT pg_catalog.has_schema_privilege(fence_schema.oid, 'USAGE, CREATE')
      AND NOT pg_catalog.has_table_privilege(fence.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
      AND NOT pg_catalog.has_any_column_privilege(fence.oid, 'SELECT, INSERT, UPDATE, REFERENCES')
      AND NOT EXISTS (
        SELECT FROM pg_catalog.pg_proc f WHERE f.pronamespace = fence_schema.oid
        AND (f.proowner <> operator.oid OR pg_catalog.has_function_privilege(f.oid, 'EXECUTE'))
      ) AS private_fence,
    EXISTS (SELECT FROM pg_catalog.pg_trigger t
      JOIN pg_catalog.pg_proc f ON f.oid = t.tgfoid
      WHERE t.tgrelid = 'public.crm_interactions'::pg_catalog.regclass
        AND t.tgname = 'clawpilot_crm_fence_write' AND t.tgenabled = 'A'
        AND NOT t.tgisinternal AND t.tgqual IS NULL AND t.tgtype = 62
        AND f.pronamespace = fence_schema.oid AND f.proname = 'check_relation'
        AND f.pronargs = 0 AND f.prosecdef)
      AND NOT EXISTS (SELECT FROM pg_catalog.pg_trigger t
        JOIN pg_catalog.pg_proc f ON f.oid = t.tgfoid
        JOIN pg_catalog.pg_class guarded ON guarded.oid = t.tgrelid
        WHERE f.pronamespace = fence_schema.oid AND NOT t.tgisinternal
          AND (pg_catalog.pg_has_role(runtime.oid, guarded.relowner, 'USAGE')
            OR pg_catalog.has_table_privilege(guarded.oid, 'TRIGGER'))
      ) AS guarded_tables
  FROM pg_catalog.pg_roles runtime
  CROSS JOIN pg_catalog.pg_roles operator
  JOIN pg_catalog.pg_namespace fence_schema ON fence_schema.nspname = 'clawpilot_crm_maintenance'
  JOIN pg_catalog.pg_class fence ON fence.relnamespace = fence_schema.oid AND fence.relname = 'write_fence'
  JOIN pg_catalog.pg_class ledger ON ledger.oid = pg_catalog.to_regclass('public.schema_migrations')
  JOIN pg_catalog.pg_database db ON db.datname = pg_catalog.current_database()
  WHERE runtime.rolname = $1 AND operator.rolname = $2 AND operator.rolcanlogin
`

export async function verifySplitPostgresCustody(client, roles, expected = readExpectedMigrations()) {
  if (!expected.has('0418_crm_maintenance_write_fence.sql')) throw new Error('postgres_custody_incomplete_source')
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
  try {
    await client.query("SET LOCAL statement_timeout = '8s'; SET LOCAL lock_timeout = '1s'; SET LOCAL search_path = pg_catalog")
    const { rows } = await client.query(custodySql, [roles.runtime, roles.operator])
    const [scope] = rows
    if (rows.length !== 1 || scope.restricted_login !== true || scope.ledger_read_only !== true
      || scope.private_fence !== true || scope.guarded_tables !== true) {
      throw new Error('postgres_custody_unverified')
    }
    const ledger = await client.query('SELECT filename, checksum FROM public.schema_migrations LIMIT $1', [expected.size + 1])
    const names = new Set(ledger.rows.map(({ filename }) => filename))
    if (ledger.rows.length !== expected.size || names.size !== expected.size
      || ledger.rows.some(({ filename, checksum }) => !expected.has(filename) || expected.get(filename) !== checksum)) {
      throw new Error('postgres_custody_migration_ledger_mismatch')
    }
  } finally {
    await client.query('ROLLBACK')
  }
}

async function main() {
  let client
  try {
    const roles = splitPostgresCustody(process.env)
    if (!roles) throw new Error('postgres_custody_split_mode_required')
    if (!process.env.DATABASE_URL) throw new Error('postgres_custody_database_url_required')
    const { Client } = requireFromApp('pg')
    const sslMode = String(process.env.PGSSLMODE || process.env.DATABASE_SSL || '').toLowerCase()
    client = new Client({
      connectionString: process.env.DATABASE_URL,
      ssl: sslMode === 'require' || sslMode === 'true' ? { rejectUnauthorized: false } : undefined,
      connectionTimeoutMillis: 5000,
      query_timeout: 10000,
      application_name: 'clawpilot-postgres-custody',
    })
    await client.connect()
    await verifySplitPostgresCustody(client, roles)
    console.log('Split PostgreSQL login and exact migration ledger verified read-only')
  } catch (error) {
    const message = /^(?:postgres_custody_[a-z_]+)$/u.test(error?.message ?? '') ? error.message : 'postgres_custody_readback_failed'
    console.error(`PostgreSQL custody held: ${message}`)
    process.exitCode = 1
  } finally {
    await client?.end().catch(() => undefined)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
