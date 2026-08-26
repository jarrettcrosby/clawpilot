#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()
const requireFromApp = createRequire(new URL('../app_src/package.json', import.meta.url))
const { Pool } = requireFromApp('pg')
const expectedMigrations = new Map([
  ['0329_career_site_submissions.sql', '57025eaa8a87a1b2b78b97bd700b633355c8f2bc56308923abf6c4210efd8045'],
  ['0330_career_site_mail_outbox.sql', '2812f40dd0d8e11529021276e37eac963a303ab60016c862b3425457d144915d'],
])
const expectedCatalogChecksum = '30019d0ed5517100279548d01924571b1c6d30326e81dfaffbd88105687fdecf'
const tableNames = [
  'career_site_submissions',
  'career_site_submission_outbox',
  'career_site_mail_outbox',
]
const expectedColumns = new Map([
  ['career_site_submissions', [
    'id', 'external_submission_id', 'source_app', 'owner_email',
    'workspace_organization_id', 'form_type', 'requester_name', 'requester_email',
    'requester_organization', 'interest', 'message', 'network_interest', 'role_fit',
    'newsletter_consent', 'resume_variant', 'source_url', 'payload_hash', 'created_at',
    'updated_at',
  ]],
  ['career_site_submission_outbox', [
    'id', 'submission_id', 'status', 'attempts', 'requeue_count', 'last_requeued_at',
    'last_requeued_by', 'last_requeue_reason', 'last_error', 'available_at', 'locked_at',
    'lock_token', 'processed_at', 'created_at', 'updated_at',
  ]],
  ['career_site_mail_outbox', [
    'id', 'idempotency_key', 'source_app', 'owner_email', 'workspace_organization_id',
    'message_type', 'payload_ciphertext', 'payload_iv', 'payload_tag', 'payload_key_id',
    'payload_encryption_version', 'payload_purged_at', 'payload_hash', 'rfc_message_id',
    'status', 'attempts', 'draft_creation_started_at', 'draft_id',
    'provider_message_id', 'requeue_count',
    'last_requeued_at', 'last_requeued_by', 'last_requeue_reason', 'last_error',
    'available_at', 'locked_at', 'lock_token', 'delivered_at', 'created_at', 'updated_at',
  ]],
])

function fail(message) {
  throw new Error(`career-site migration verification failed: ${message}`)
}

for (const [filename, expectedChecksum] of expectedMigrations) {
  const source = readFileSync(resolve(root, 'db/migrations', filename), 'utf8')
  const actualChecksum = createHash('sha256').update(source).digest('hex')
  if (actualChecksum !== expectedChecksum) fail(`local checksum mismatch for ${filename}`)
}

const databaseUrl = String(
  process.env.CAREER_SITE_MIGRATION_DATABASE_URL || process.env.DATABASE_URL || '',
).trim()
if (!databaseUrl) fail('CAREER_SITE_MIGRATION_DATABASE_URL or DATABASE_URL is required')
const sslMode = String(process.env.PGSSLMODE || process.env.DATABASE_SSL || '').toLowerCase()
const pool = new Pool({
  connectionString: databaseUrl,
  ssl: sslMode === 'require' || sslMode === 'true' ? { rejectUnauthorized: false } : undefined,
  connectionTimeoutMillis: 5000,
  query_timeout: 30_000,
  max: 1,
})

try {
  const mode = process.argv[2] || '--post-apply'
  if (mode !== '--pre-apply' && mode !== '--post-apply') {
    fail('usage: npm run career-site:migrations:verify -- --pre-apply|--post-apply')
  }
  if (mode === '--pre-apply') {
    const absence = await pool.query(
      `SELECT
         (SELECT count(*)::integer FROM schema_migrations WHERE filename = ANY($1::text[])) AS ledger_count,
         ARRAY[
           to_regclass('public.career_site_submissions')::text,
           to_regclass('public.career_site_submission_outbox')::text,
           to_regclass('public.career_site_mail_outbox')::text
         ] AS tables`,
      [[...expectedMigrations.keys()]],
    )
    const row = absence.rows[0]
    if (row?.ledger_count !== 0 || (row?.tables || []).some(Boolean)) {
      fail('pre-apply requires absent 0329/0330 ledger rows and absent career-site tables')
    }
    console.log('Career-site migration pre-apply absence verified for 0329/0330 and all three tables')
    process.exitCode = 0
  } else {
  const migrationRows = await pool.query(
    `SELECT filename, checksum FROM schema_migrations
     WHERE filename = ANY($1::text[]) ORDER BY filename`,
    [[...expectedMigrations.keys()]],
  )
  if (migrationRows.rows.length !== expectedMigrations.size) fail('0329/0330 are not both recorded')
  for (const row of migrationRows.rows) {
    if (row.checksum !== expectedMigrations.get(row.filename)) {
      fail(`database checksum mismatch for ${row.filename}`)
    }
  }

  const columns = await pool.query(
    `SELECT table_name, column_name, ordinal_position
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = ANY($1::text[])
     ORDER BY table_name, ordinal_position`,
    [[...expectedColumns.keys()]],
  )
  for (const [table, expected] of expectedColumns) {
    const actual = columns.rows
      .filter((row) => row.table_name === table)
      .map((row) => row.column_name)
    try {
      assert.deepEqual(actual, expected)
    } catch {
      fail(`exact column catalog mismatch for ${table}`)
    }
  }

  const constraints = await pool.query(
    `SELECT conrelid::regclass::text AS table_name, conname, pg_get_constraintdef(oid) AS definition
     FROM pg_constraint
     WHERE conrelid IN (
       'career_site_submissions'::regclass,
       'career_site_submission_outbox'::regclass,
       'career_site_mail_outbox'::regclass
     )`,
  )
  const constraintNames = new Set(constraints.rows.map((row) => row.conname))
  for (const name of [
    'career_site_submissions_owner_membership_fkey',
    'career_site_mail_outbox_owner_membership_fkey',
    'career_site_mail_outbox_payload_encryption_valid',
    'career_site_mail_outbox_payload_lifecycle_valid',
    'career_site_mail_outbox_requeue_count_valid',
    'career_site_mail_outbox_requeue_audit_valid',
  ]) {
    if (!constraintNames.has(name)) fail(`required constraint ${name} is absent`)
  }
  const plaintextPayload = columns.rows.some((row) => (
    row.table_name === 'career_site_mail_outbox' && row.column_name === 'payload'
  ))
  if (plaintextPayload) fail('plaintext career-site mail payload column is present')
  const catalogColumns = await pool.query(
    `SELECT table_name, column_name, ordinal_position, data_type, udt_name,
       is_nullable, column_default, character_maximum_length
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = ANY($1::text[])
     ORDER BY table_name, ordinal_position`,
    [tableNames],
  )
  const catalogConstraints = await pool.query(
    `SELECT conrelid::regclass::text AS table_name, conname, contype,
       pg_get_constraintdef(oid, true) AS definition
     FROM pg_constraint
     WHERE conrelid = ANY($1::regclass[])
     ORDER BY conrelid::regclass::text, conname`,
    [tableNames],
  )
  const catalogIndexes = await pool.query(
    `SELECT tablename AS table_name, indexname, indexdef
     FROM pg_indexes
     WHERE schemaname = 'public' AND tablename = ANY($1::text[])
     ORDER BY tablename, indexname`,
    [tableNames],
  )
  const catalog = JSON.stringify({
    columns: catalogColumns.rows,
    constraints: catalogConstraints.rows,
    indexes: catalogIndexes.rows,
  })
  const catalogChecksum = createHash('sha256').update(catalog).digest('hex')
  if (catalogChecksum !== expectedCatalogChecksum) {
    fail(`exact catalog checksum mismatch (actual ${catalogChecksum})`)
  }
  console.log('Career-site migrations 0329/0330 and exact post-apply catalog verified')
  }
} finally {
  await pool.end()
}
