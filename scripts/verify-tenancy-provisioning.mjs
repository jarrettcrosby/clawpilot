#!/usr/bin/env node
import { createRequire } from 'node:module'

const requireFromApp = createRequire(new URL('../app_src/package.json', import.meta.url))
const { Pool } = requireFromApp('pg')

if (!process.env.DATABASE_URL) {
  console.error('verify:tenancy-data failed: DATABASE_URL is required')
  process.exit(1)
}

const sslMode = String(process.env.PGSSLMODE || process.env.DATABASE_SSL || '').toLowerCase()
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: sslMode === 'require' || sslMode === 'true' ? { rejectUnauthorized: false } : undefined,
  connectionTimeoutMillis: 5000,
  query_timeout: 30000,
})

async function violations(client, sql) {
  const result = await client.query(sql)
  return result.rows
}

async function main() {
  const client = await pool.connect()
  try {
    const personalPipelines = await violations(client, `
        SELECT app_user.email, pipeline.id::text AS pipeline_id,
          pipeline.provisioning_status, pipeline.sheet_id, pipeline.short_link_id::text,
          pipeline.sync_enabled,
          EXISTS (
            SELECT 1
            FROM sync_outbox outbox
            WHERE outbox.aggregate_type = 'pipeline_space'
              AND outbox.aggregate_id = pipeline.id::text
              AND outbox.operation = 'provision_pipeline'
              AND outbox.target_system = 'google_workspace'
              AND outbox.status IN ('queued', 'processing')
          ) AS provisioning_queued
        FROM app_users app_user
        LEFT JOIN pipeline_spaces pipeline
          ON pipeline.owner_email = app_user.email
         AND pipeline.is_default
        WHERE app_user.status = 'active'
          AND app_user.organization_id IS NOT NULL
          AND (
            pipeline.id IS NULL
            OR (
              NOT (
                pipeline.provisioning_status = 'ready'
                AND pipeline.sheet_id IS NOT NULL
                AND pipeline.short_link_id IS NOT NULL
                AND pipeline.sync_enabled
              )
              AND NOT EXISTS (
                SELECT 1
                FROM sync_outbox outbox
                WHERE outbox.aggregate_type = 'pipeline_space'
                  AND outbox.aggregate_id = pipeline.id::text
                  AND outbox.operation = 'provision_pipeline'
                  AND outbox.target_system = 'google_workspace'
                  AND outbox.status IN ('queued', 'processing')
              )
            )
          )
        ORDER BY app_user.email
      `)
    const crmBoards = await violations(client, `
        SELECT app_user.email, app_user.organization_id::text AS user_organization_id,
          board.id::text AS board_id, projection.pipeline_id::text,
          projection.workspace_organization_id::text AS projection_organization_id
        FROM app_users app_user
        LEFT JOIN project_boards board
          ON board.owner_email = app_user.email
         AND lower(btrim(board.name)) = 'crm board'
        LEFT JOIN crm_board_projections projection ON projection.board_id = board.id
        LEFT JOIN pipeline_spaces pipeline ON pipeline.id = projection.pipeline_id
        WHERE app_user.status = 'active'
          AND app_user.organization_id IS NOT NULL
          AND (
            board.id IS NULL
            OR projection.board_id IS NULL
            OR projection.workspace_organization_id IS DISTINCT FROM app_user.organization_id
            OR pipeline.workspace_organization_id IS DISTINCT FROM app_user.organization_id
          )
        ORDER BY app_user.email
      `)
    const crmPipelineConsistency = await violations(client, `
        SELECT projection.workspace_organization_id::text AS workspace_organization_id,
          array_agg(DISTINCT projection.pipeline_id::text ORDER BY projection.pipeline_id::text) AS pipeline_ids
        FROM crm_board_projections projection
        JOIN project_boards board ON board.id = projection.board_id
        JOIN app_users app_user ON app_user.email = board.owner_email
        WHERE app_user.status = 'active'
        GROUP BY projection.workspace_organization_id
        HAVING count(DISTINCT projection.pipeline_id) <> 1
      `)

    const report = {
      personalPipelineViolations: personalPipelines,
      crmBoardViolations: crmBoards,
      crmPipelineConsistencyViolations: crmPipelineConsistency,
    }
    if (personalPipelines.length || crmBoards.length || crmPipelineConsistency.length) {
      console.error(JSON.stringify(report, null, 2))
      throw new Error('Tenancy provisioning invariants failed')
    }

    const summary = await client.query(`
      SELECT
        (SELECT count(*) FROM app_users WHERE status = 'active' AND organization_id IS NOT NULL)::int AS active_users,
        (SELECT count(*) FROM pipeline_spaces WHERE is_default)::int AS personal_pipelines,
        (SELECT count(*) FROM crm_board_projections)::int AS crm_boards
    `)
    console.log(`PASS verify-tenancy-provisioning ${JSON.stringify(summary.rows[0])}`)
  } finally {
    client.release()
    await pool.end()
  }
}

main().catch((error) => {
  console.error(`verify:tenancy-data failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
