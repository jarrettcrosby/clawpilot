const NONTRANSACTIONAL_DIRECTIVE = '-- clawpilot:migration-mode=nontransactional'
const STATEMENT_BREAK = '-- clawpilot:migration-statement-break'

function parseNontransactionalStatements(file, sql) {
  if (!sql.trimStart().startsWith(NONTRANSACTIONAL_DIRECTIVE)) return null

  const statements = sql
    .split(STATEMENT_BREAK)
    .map((statement) => statement.trim())
    .filter(Boolean)

  if (statements.length === 0) {
    throw new Error(`Nontransactional migration ${file} has no statements`)
  }

  for (const statement of statements) {
    const executable = statement
      .replace(/^\s*--.*$/gmu, '')
      .trim()
      .replace(/;\s*$/u, '')

    if (!executable || executable.includes(';')) {
      throw new Error(
        `Nontransactional migration ${file} must separate every SQL statement with ${STATEMENT_BREAK}`,
      )
    }
    if (/\b(?:BEGIN|COMMIT|ROLLBACK)\b/iu.test(executable)) {
      throw new Error(
        `Nontransactional migration ${file} cannot control transactions`,
      )
    }
  }

  return statements
}

async function recordMigration(client, file, checksum) {
  await client.query(
    'ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum text',
  )
  await client.query(
    `INSERT INTO schema_migrations (filename, checksum)
     VALUES ($1, $2)`,
    [file, checksum],
  )
}

export async function applyMigrationSqlForTest(
  client,
  file,
  sql,
  options = {},
) {
  const checksum = options.checksum || null
  const nontransactionalStatements = parseNontransactionalStatements(file, sql)
  if (nontransactionalStatements) {
    for (const statement of nontransactionalStatements) {
      await client.query(statement)
    }
    if (checksum) {
      await client.query('BEGIN')
      try {
        await recordMigration(client, file, checksum)
        await client.query('COMMIT')
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined)
        throw new Error(`Migration ${file} could not be recorded`, {
          cause: error,
        })
      }
    }
    return
  }

  await client.query('BEGIN')
  try {
    await client.query(sql)
    if (checksum) await recordMigration(client, file, checksum)
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw new Error(`Migration ${file} failed`, { cause: error })
  }
}
