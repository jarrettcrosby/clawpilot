#!/usr/bin/env node

import crypto from 'node:crypto'
import { createRequire } from 'node:module'

const requireFromApp = createRequire(
  new URL('../app_src/package.json', import.meta.url),
)
const { Pool } = requireFromApp('pg')

const CONFIRMATION_VARIABLE = 'CLAWPILOT_SUITECRM_EMAIL_REPROJECT_CONFIRM'
const ACTOR_VARIABLE = 'CLAWPILOT_SUITECRM_EMAIL_REPROJECT_ACTOR'
const CONFIRMATION_PREFIX = 'suitecrm-email-global-id-repair-v1'
const FAILURE_DETAILS = [
  'SuiteCRM request failed (400): Property global_id_c in Email module is invalid',
  'SuiteCRM interaction module is invalid',
]

function fail(message) {
  throw new Error(message)
}

function clean(value) {
  return String(value ?? '').trim()
}

function databaseConfiguration(environment = process.env) {
  const connectionString = clean(environment.DATABASE_PUBLIC_URL || environment.DATABASE_URL)
  if (!connectionString) fail('DATABASE_PUBLIC_URL or DATABASE_URL is required')
  const url = new URL(connectionString)
  const privateRailway = url.hostname.endsWith('.railway.internal')
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1'
  return {
    connectionString,
    ssl: privateRailway || local ? undefined : { rejectUnauthorized: false },
  }
}

function parseArgs(argv) {
  let apply = false
  for (const argument of argv) {
    if (argument === '--apply') apply = true
    else fail(`Unknown argument: ${argument}`)
  }
  return { apply }
}

function stableDigest(rows) {
  return crypto.createHash('sha256')
    .update(JSON.stringify(rows.map((row) => ({
      outboxId: row.outbox_id,
      pipelineId: row.pipeline_id,
      interactionId: row.interaction_id,
      referenceCode: row.reference_code,
    }))), 'utf8')
    .digest('hex')
}

async function loadCandidates(client, lock = false) {
  const result = await client.query(
    `SELECT
       outbox.id::text AS outbox_id,
       interaction.pipeline_id::text,
       pipeline.workspace_organization_id::text AS organization_id,
       interaction.id::text AS interaction_id,
       interaction.reference_code,
       outbox.status,
       outbox.attempts
     FROM sync_outbox outbox
     JOIN crm_interactions interaction
       ON interaction.id::text = outbox.aggregate_id
     JOIN pipeline_spaces pipeline ON pipeline.id = interaction.pipeline_id
     WHERE outbox.target_system = 'suitecrm'
       AND outbox.aggregate_type = 'crm_interactions'
       AND outbox.operation = 'reproject_record'
       AND pipeline.sync_enabled = true
       AND (
         outbox.status = 'dead'
         OR (outbox.status = 'failed' AND outbox.attempts >= 8)
       )
       AND outbox.last_error = ANY($1::text[])
       AND (
         (interaction.sync_status = 'failed' AND interaction.sync_error = outbox.last_error)
         OR (interaction.sync_status = 'syncing' AND interaction.sync_error IS NULL)
       )
       AND interaction.suitecrm_module = 'Emails'
       AND outbox.payload->>'suiteCrmModule' = 'Emails'
       AND outbox.payload->>'localId' = interaction.id::text
     ORDER BY interaction.pipeline_id, interaction.reference_code, outbox.id
     ${lock ? 'FOR UPDATE OF outbox, interaction' : ''}`,
    [FAILURE_DETAILS],
  )
  return result.rows
}

function summarize(rows) {
  const pipelines = new Map()
  for (const row of rows) {
    pipelines.set(row.pipeline_id, (pipelines.get(row.pipeline_id) || 0) + 1)
  }
  return {
    candidates: rows.length,
    pipelines: [...pipelines.entries()].map(([pipelineId, records]) => ({ pipelineId, records })),
    digest: stableDigest(rows),
    providerWrites: 0,
  }
}

async function applyRepair(client, actor, expectedDigest) {
  await client.query('BEGIN')
  try {
    const candidates = await loadCandidates(client, true)
    const digest = stableDigest(candidates)
    if (digest !== expectedDigest) fail('Email projection repair candidates changed after review')
    if (candidates.length === 0) fail('No failed SuiteCRM Email projections require repair')
    const outboxIds = candidates.map((row) => row.outbox_id)
    const interactionIds = candidates.map((row) => row.interaction_id)
    const requeued = await client.query(
      `UPDATE sync_outbox
       SET status = 'queued',
           attempts = 0,
           last_error = NULL,
           available_at = now(),
           processed_at = NULL,
           locked_at = NULL,
           lock_token = NULL,
           updated_at = now()
       WHERE id = ANY($1::uuid[])
         AND (
           status = 'dead'
           OR (status = 'failed' AND attempts >= 8)
         )
       RETURNING id::text`,
      [outboxIds],
    )
    if (requeued.rowCount !== candidates.length) fail('Email projection outbox repair count changed')
    const reset = await client.query(
     `UPDATE crm_interactions
       SET sync_status = 'pending', sync_error = NULL, updated_at = now()
       WHERE id = ANY($1::uuid[])
         AND sync_status IN ('failed', 'syncing')
       RETURNING id::text`,
      [interactionIds],
    )
    if (reset.rowCount !== candidates.length) fail('Email interaction repair count changed')

    for (const pipeline of summarize(candidates).pipelines) {
      const candidate = candidates.find((row) => row.pipeline_id === pipeline.pipelineId)
      const eventKey = `suitecrm-email-global-id-repair-v1:${pipeline.pipelineId}:${digest}`
      await client.query(
        `INSERT INTO audit_events (
           actor, event_type, aggregate_type, aggregate_id, payload, event_key,
           subject, organization_id, is_system
         ) VALUES ($1, 'crm.email_projection.repair_queued', 'pipeline_space', $2, $3::jsonb, $4, $1, $5::uuid, false)
         ON CONFLICT (event_key) WHERE event_key IS NOT NULL DO NOTHING`,
        [
          actor,
          pipeline.pipelineId,
          JSON.stringify({
            pipelineId: pipeline.pipelineId,
            records: pipeline.records,
            candidateDigest: digest,
            failureDetails: FAILURE_DETAILS,
            providerWrites: 0,
          }),
          eventKey,
          candidate.organization_id,
        ],
      )
    }
    await client.query('COMMIT')
    return summarize(candidates)
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  }
}

async function main() {
  const { apply } = parseArgs(process.argv.slice(2))
  const pool = new Pool({ ...databaseConfiguration(), max: 1 })
  try {
    const candidates = await loadCandidates(pool)
    const plan = summarize(candidates)
    console.log(JSON.stringify({ mode: apply ? 'apply' : 'plan', ...plan }, null, 2))
    if (!apply) {
      console.log(`To apply: ${CONFIRMATION_VARIABLE}=${CONFIRMATION_PREFIX}:${plan.digest}`)
      return
    }
    const confirmation = clean(process.env[CONFIRMATION_VARIABLE])
    if (confirmation !== `${CONFIRMATION_PREFIX}:${plan.digest}`) {
      fail(`${CONFIRMATION_VARIABLE} must match the reviewed candidate digest`)
    }
    const actor = clean(process.env[ACTOR_VARIABLE]).toLowerCase()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(actor)) {
      fail(`${ACTOR_VARIABLE} must identify the operator`)
    }
    const result = await applyRepair(pool, actor, plan.digest)
    console.log(JSON.stringify({ mode: 'applied', ...result }, null, 2))
  } finally {
    await pool.end()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
