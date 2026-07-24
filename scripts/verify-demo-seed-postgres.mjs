#!/usr/bin/env node
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'

const requireFromApp = createRequire(new URL('../app_src/package.json', import.meta.url))
const { Client } = requireFromApp('pg')

const sourceUrl = String(process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL || '')
if (!sourceUrl) throw new Error('DATABASE_PUBLIC_URL or DATABASE_URL is required')

const databaseName = `clawpilot_demo_account_test_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`
const adminUrl = new URL(sourceUrl)
const testUrl = new URL(sourceUrl)
testUrl.pathname = `/${databaseName}`
const external = Boolean(process.env.DATABASE_PUBLIC_URL)
function adminClient() {
  return new Client({
    connectionString: adminUrl.toString(),
    ssl: external ? { rejectUnauthorized: false } : undefined,
    connectionTimeoutMillis: 5000,
  })
}

function run(script, extraEnv = {}) {
  const result = spawnSync(process.execPath, [script], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATABASE_URL: testUrl.toString(),
      PGSSLMODE: external ? 'require' : process.env.PGSSLMODE,
      ...extraEnv,
    },
    encoding: 'utf8',
  })
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  if (result.status !== 0) throw new Error(`${script} exited with status ${result.status ?? 'unknown'}`)
}

function runExpectingFailure(script, expectedMessage, extraEnv = {}) {
  const result = spawnSync(process.execPath, [script], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATABASE_URL: testUrl.toString(),
      PGSSLMODE: external ? 'require' : process.env.PGSSLMODE,
      ...extraEnv,
    },
    encoding: 'utf8',
  })
  const output = `${result.stdout || ''}\n${result.stderr || ''}`
  if (result.status === 0) throw new Error(`${script} unexpectedly succeeded`)
  if (!output.includes(expectedMessage)) {
    throw new Error(`${script} failed without expected message: ${expectedMessage}\n${output}`)
  }
}

function testClient() {
  return new Client({
    connectionString: testUrl.toString(),
    ssl: external ? { rejectUnauthorized: false } : undefined,
    connectionTimeoutMillis: 5000,
  })
}

async function injectImmutableDemoEvidence() {
  const client = testClient()
  await client.connect()
  try {
    await client.query('BEGIN')
    const active = await client.query(
      `SELECT id::text
       FROM pipeline_spaces
       WHERE workspace_organization_id = '10000000-0000-4000-8000-000000000001'::uuid
         AND is_default = true
         AND reference_access_disabled = false
       LIMIT 1`,
    )
    const pipelineId = active.rows[0]?.id
    if (!pipelineId) throw new Error('active demo pipeline was not seeded')
    const contacts = await client.query(
      `SELECT id::text, reference_code, suitecrm_id
       FROM crm_contacts
       WHERE pipeline_id = $1::uuid
       ORDER BY id
       LIMIT 2`,
      [pipelineId],
    )
    if (contacts.rowCount !== 2) throw new Error('demo contacts were not seeded')
    const outbox = await client.query(
      `INSERT INTO sync_outbox (
         aggregate_type, aggregate_id, operation, target_system, payload, status,
         attempts, processed_at, idempotency_key, created_at, available_at, updated_at
       ) VALUES
       ('crm_contacts', $2, 'upsert_record', 'suitecrm',
         jsonb_build_object('pipelineId', $1::text), 'succeeded', 1, now(),
         'demo-quarantine-test:survivor', now(), now(), now()),
       ('crm_contacts', $3, 'delete_record', 'suitecrm',
         jsonb_build_object('pipelineId', $1::text), 'dead', 8, now(),
         'demo-quarantine-test:duplicate', now(), now(), now())
       RETURNING id::text`,
      [pipelineId, contacts.rows[0].id, contacts.rows[1].id],
    )
    await client.query(
      `INSERT INTO crm_contact_source_aliases (
         pipeline_id, source_key, contact_id, alias_kind, source_payload, created_by
       ) VALUES (
         $1::uuid, 'demo-quarantine-test:source', $2::uuid, 'source',
         '{"synthetic":true}'::jsonb, 'demo-system@clawpilot.example'
       )`,
      [pipelineId, contacts.rows[0].id],
    )
    await client.query(
      `INSERT INTO crm_reference_aliases (
         alias_code, canonical_code, reason, created_by
       ) VALUES (
         $1, $2, 'Disposable demo quarantine acceptance alias',
         'demo-system@clawpilot.example'
       )`,
      [contacts.rows[1].reference_code, contacts.rows[0].reference_code],
    )
    await client.query(
      `INSERT INTO crm_contact_merges (
         pipeline_id, survivor_contact_id, duplicate_contact_id,
         survivor_reference_code, duplicate_reference_code,
         survivor_suitecrm_id, duplicate_suitecrm_id,
         duplicate_snapshot, rewired_counts,
         survivor_outbox_id, duplicate_delete_outbox_id,
         merged_by, reason
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4, $5,
         $6, $7, '{"synthetic":true}'::jsonb, '{}'::jsonb,
         $8::uuid, $9::uuid,
         'demo-system@clawpilot.example', 'Disposable demo quarantine acceptance evidence'
       )`,
      [
        pipelineId,
        contacts.rows[0].id,
        contacts.rows[1].id,
        contacts.rows[0].reference_code,
        contacts.rows[1].reference_code,
        contacts.rows[0].suitecrm_id,
        contacts.rows[1].suitecrm_id,
        outbox.rows[0].id,
        outbox.rows[1].id,
      ],
    )
    await client.query(
      `INSERT INTO sync_outbox (
         aggregate_type, aggregate_id, operation, target_system, payload, status,
         attempts, idempotency_key, locked_at, lock_token, created_at, available_at, updated_at
       ) VALUES (
         'crm_contacts', $2, 'upsert_record', 'suitecrm',
         jsonb_build_object('pipelineId', $1::text), 'processing', 1,
         'demo-quarantine-test:processing', now(), 'demo-quarantine-test-lease',
         now(), now(), now()
       )`,
      [pipelineId, contacts.rows[0].id],
    )
    await client.query(
      `UPDATE crm_contacts
       SET email = 'contaminated@example.com', updated_at = now()
       WHERE pipeline_id = $1::uuid AND id = $2::uuid`,
      [pipelineId, contacts.rows[0].id],
    )
    await client.query(
      `INSERT INTO short_links (
         owner_email, organization_root_id, source_app, slug, destination_url, title, tags
       ) VALUES (
         'demo-system@clawpilot.example',
         '10000000-0000-4000-8000-000000000001'::uuid,
         'clawpilot-crm', $1, 'https://aiapp.eigenracing.com/crm/' || $2,
         'Disposable contaminated demo reference', ARRAY['crm', 'email', $2]::text[]
       )
       ON CONFLICT (slug) DO UPDATE SET
         disabled_at = NULL,
         deleted_at = NULL,
         destination_url = EXCLUDED.destination_url,
         tags = EXCLUDED.tags,
         updated_at = now()`,
      [`mail-${contacts.rows[1].reference_code}`, contacts.rows[1].reference_code],
    )
    await client.query('COMMIT')
    return {
      pipelineId,
      referenceCode: contacts.rows[1].reference_code,
      shortLinkSlug: `mail-${contacts.rows[1].reference_code}`,
    }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    await client.end()
  }
}

async function releaseProcessingEvidence() {
  const client = testClient()
  await client.connect()
  try {
    await client.query(
      `UPDATE sync_outbox
       SET status = 'queued', locked_at = NULL, lock_token = NULL, updated_at = now()
       WHERE idempotency_key = 'demo-quarantine-test:processing'`,
    )
  } finally {
    await client.end()
  }
}

async function verifyQuarantine(evidence) {
  const client = testClient()
  await client.connect()
  try {
    let membershipBlocked = false
    try {
      await client.query(
        `INSERT INTO pipeline_space_members (
           pipeline_id, user_email, access_role, shared_by
         ) VALUES (
           $1::uuid, 'demo-system@clawpilot.example', 'viewer',
           'demo-system@clawpilot.example'
         )`,
        [evidence.pipelineId],
      )
    } catch (error) {
      membershipBlocked = error?.code === '23514'
    }
    if (!membershipBlocked) {
      throw new Error('database allowed a membership on a quarantined demo pipeline')
    }
    let preferenceBlocked = false
    try {
      await client.query(
        `UPDATE app_user_workspace_preferences
         SET default_pipeline_id = $1::uuid
         WHERE user_email = 'demo-system@clawpilot.example'
           AND workspace_organization_id =
             '10000000-0000-4000-8000-000000000001'::uuid`,
        [evidence.pipelineId],
      )
    } catch (error) {
      preferenceBlocked = error?.code === '23514'
    }
    if (!preferenceBlocked) {
      throw new Error('database allowed a workspace default on a quarantined demo pipeline')
    }
    await client.query(
      `UPDATE short_links
       SET disabled_at = NULL, updated_at = now()
       WHERE slug = $1`,
      [evidence.shortLinkSlug],
    )
    const result = await client.query(
      `SELECT
         (SELECT reference_access_disabled
          FROM pipeline_spaces WHERE id = $1::uuid) AS legacy_reference_disabled,
         (SELECT disabled_at IS NOT NULL
          FROM short_links WHERE slug = $2) AS legacy_short_link_disabled,
         (SELECT count(*)::integer
          FROM sync_outbox
          WHERE idempotency_key IN (
            'demo-quarantine-test:survivor',
            'demo-quarantine-test:duplicate',
            'demo-quarantine-test:processing'
          )) AS preserved_outbox_rows,
         (SELECT status
          FROM sync_outbox
          WHERE idempotency_key = 'demo-quarantine-test:processing') AS processing_evidence_status,
         (SELECT id::text
          FROM pipeline_spaces
          WHERE workspace_organization_id = '10000000-0000-4000-8000-000000000001'::uuid
            AND is_default = true
            AND reference_access_disabled = false
          LIMIT 1) AS active_pipeline_id`,
      [evidence.pipelineId, evidence.shortLinkSlug],
    )
    const row = result.rows[0]
    if (row.legacy_reference_disabled !== true
      || row.legacy_short_link_disabled !== true
      || row.preserved_outbox_rows !== 3
      || row.processing_evidence_status !== 'dead'
      || !row.active_pipeline_id
      || row.active_pipeline_id === evidence.pipelineId) {
      throw new Error(`demo quarantine verification failed: ${JSON.stringify(row || {})}`)
    }
    return row.active_pipeline_id
  } finally {
    await client.end()
  }
}

let created = false
try {
  const setup = adminClient()
  await setup.connect()
  const stale = await setup.query(
    `SELECT datname FROM pg_database WHERE datname LIKE 'clawpilot_demo_account_test_%'`,
  )
  const staleCutoff = Date.now() - (2 * 60 * 60 * 1000)
  for (const row of stale.rows) {
    const match = /^clawpilot_demo_account_test_([0-9]+)_[0-9a-f]+$/.exec(row.datname)
    if (match && Number(match[1]) < staleCutoff) {
      await setup.query(`DROP DATABASE IF EXISTS ${row.datname} WITH (FORCE)`)
    }
  }
  await setup.query(`CREATE DATABASE ${databaseName}`)
  created = true
  await setup.end()
  run('scripts/db-migrate.mjs')
  run('scripts/seed-demo-environment.mjs')
  run('scripts/verify-demo-environment.mjs')
  const immutableEvidence = await injectImmutableDemoEvidence()
  run('scripts/seed-demo-environment.mjs')
  run('scripts/verify-demo-environment.mjs')
  runExpectingFailure(
    'scripts/seed-demo-environment.mjs',
    'active SuiteCRM work',
    { DEMO_QUARANTINE_ROTATION_ENABLED: 'true' },
  )
  await releaseProcessingEvidence()
  run('scripts/seed-demo-environment.mjs', { DEMO_QUARANTINE_ROTATION_ENABLED: 'true' })
  run('scripts/verify-demo-environment.mjs', { DEMO_QUARANTINE_ROTATION_ENABLED: 'true' })
  const firstReplacementPipelineId = await verifyQuarantine(immutableEvidence)
  run('scripts/seed-demo-environment.mjs', { DEMO_QUARANTINE_ROTATION_ENABLED: 'true' })
  run('scripts/verify-demo-environment.mjs', { DEMO_QUARANTINE_ROTATION_ENABLED: 'true' })
  const secondReplacementPipelineId = await verifyQuarantine(immutableEvidence)
  if (firstReplacementPipelineId === secondReplacementPipelineId) {
    throw new Error('demo rotation did not replace a mutable pipeline after quarantining the preferred pipeline id')
  }
  console.log('demo account Postgres seed acceptance passed')
} finally {
  if (created) {
    const cleanup = adminClient()
    await cleanup.connect().catch(() => undefined)
    if (cleanup.readyForQuery) {
      await cleanup.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`).catch(() => undefined)
    }
    await cleanup.end().catch(() => undefined)
  }
}
