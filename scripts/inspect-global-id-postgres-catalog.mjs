import { createRequire } from 'node:module'

const requireFromApp = createRequire(new URL('../app_src/package.json', import.meta.url))
const pg = requireFromApp('pg')

const connectionString = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL
if (!connectionString) throw new Error('DATABASE_PUBLIC_URL or DATABASE_URL is required')

const client = new pg.Client({
  connectionString,
  ssl: connectionString.includes('localhost') || connectionString.includes('127.0.0.1')
    ? undefined
    : { rejectUnauthorized: false },
})

await client.connect()
try {
  await client.query('BEGIN READ ONLY')
  const constraints = await client.query(`
    SELECT
      constraint_row.conrelid::regclass::text AS table_name,
      constraint_row.conname AS constraint_name,
      pg_get_constraintdef(constraint_row.oid, true) AS definition
    FROM pg_constraint constraint_row
    WHERE constraint_row.contype = 'c'
      AND position('^g' in pg_get_constraintdef(constraint_row.oid, true)) > 0
      AND position('[0-9]{7}' in pg_get_constraintdef(constraint_row.oid, true)) > 0
      AND position('[0-9a-v]{12}' in pg_get_constraintdef(constraint_row.oid, true)) = 0
    ORDER BY 1, 2
  `)
  const functions = await client.query(`
    SELECT
      namespace.nspname AS schema_name,
      procedure.proname AS function_name,
      pg_get_function_identity_arguments(procedure.oid) AS identity_arguments,
      pg_get_functiondef(procedure.oid) AS definition
    FROM pg_proc procedure
    JOIN pg_namespace namespace ON namespace.oid = procedure.pronamespace
    WHERE namespace.nspname = current_schema()
      AND procedure.prokind = 'f'
      AND position('^g' in pg_get_functiondef(procedure.oid)) > 0
      AND position('[0-9]{7}' in pg_get_functiondef(procedure.oid)) > 0
      AND position('[0-9a-v]{12}' in pg_get_functiondef(procedure.oid)) = 0
    ORDER BY 1, 2, 3
  `)
  const sqlValues = process.argv.includes('--sql-values')
  if (sqlValues) {
    const rows = constraints.rows.map(({ table_name, constraint_name }) => (
      `('${table_name.replaceAll("'", "''")}', '${constraint_name.replaceAll("'", "''")}')`
    ))
    process.stdout.write(`${rows.join(',\n')}\n`)
  } else {
    const namesOnly = process.argv.includes('--names-only')
    process.stdout.write(`${JSON.stringify({
      constraints: namesOnly
        ? constraints.rows.map(({ table_name, constraint_name }) => ({ table_name, constraint_name }))
        : constraints.rows,
      functions: namesOnly
        ? functions.rows.map(({ schema_name, function_name, identity_arguments }) => ({
            schema_name,
            function_name,
            identity_arguments,
          }))
        : functions.rows,
    }, null, 2)}\n`)
  }
  await client.query('ROLLBACK')
} finally {
  await client.end()
}
