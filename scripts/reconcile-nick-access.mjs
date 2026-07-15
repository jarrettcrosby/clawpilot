#!/usr/bin/env node
import { createRequire } from 'node:module'

const requireFromApp = createRequire(new URL('../app_src/package.json', import.meta.url))
const { Pool } = requireFromApp('pg')

const NICK_EMAIL = 'nick@episcs.com'
const ORGANIZATION_NAME = "Nick's Organization"
const ADMIN_PERMISSIONS = {
  inviteUsers: true,
  manageUserAccess: true,
  createBoards: true,
  createPipelines: true,
  viewFullReleaseHistory: true,
  manageBackups: true,
  manageLinks: true,
}

function fail(message) {
  console.error(`users:reconcile-nick-access failed: ${message}`)
  process.exit(1)
}

if (!process.env.DATABASE_URL) fail('DATABASE_URL is required')
if (process.env.CLAWPILOT_USER_ACCESS_CONFIRM !== 'nick-admin-v1') {
  fail('CLAWPILOT_USER_ACCESS_CONFIRM=nick-admin-v1 is required')
}

const actor = String(process.env.CLAWPILOT_USER_ACCESS_ACTOR || '').trim().toLowerCase()
if (!actor) fail('CLAWPILOT_USER_ACCESS_ACTOR is required')

const sslMode = String(process.env.PGSSLMODE || process.env.DATABASE_SSL || '').toLowerCase()
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: sslMode === 'require' || sslMode === 'true' ? { rejectUnauthorized: false } : undefined,
  connectionTimeoutMillis: 5000,
  query_timeout: 30000,
})

async function main() {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('clawpilot-reconcile-nick-access-v1'))`)
    const current = await client.query(
      `SELECT app_user.organization_id::text, organization.parent_id::text,
         organization.name AS organization_name
       FROM app_users app_user
       JOIN workspace_organizations organization ON organization.id = app_user.organization_id
       WHERE app_user.email = $1
       FOR UPDATE OF app_user, organization`,
      [NICK_EMAIL],
    )
    if (!current.rows[0]) throw new Error('Nick must already be assigned to an organization')
    if (!current.rows[0].parent_id) throw new Error("Nick's Organization must remain a child organization")

    await client.query(
      `UPDATE workspace_organizations
       SET name = $2, updated_by = $3, updated_at = now()
       WHERE id = $1::uuid`,
      [current.rows[0].organization_id, ORGANIZATION_NAME, actor],
    )
    await client.query(
      `UPDATE app_users
       SET role = 'admin', permissions = $2::jsonb,
         organization_name = $3, updated_at = now()
       WHERE email = $1`,
      [NICK_EMAIL, JSON.stringify(ADMIN_PERMISSIONS), ORGANIZATION_NAME],
    )
    await client.query(
      `INSERT INTO audit_events (actor, event_type, aggregate_type, aggregate_id, payload)
       VALUES ($1, 'user.admin_access.reconciled', 'app_user', $2, $3::jsonb)`,
      [actor, NICK_EMAIL, JSON.stringify({
        organizationId: current.rows[0].organization_id,
        organizationName: ORGANIZATION_NAME,
        previousOrganizationName: current.rows[0].organization_name,
        role: 'admin',
      })],
    )
    await client.query('COMMIT')
    console.log(JSON.stringify({
      ok: true,
      email: NICK_EMAIL,
      role: 'admin',
      organizationId: current.rows[0].organization_id,
      organizationName: ORGANIZATION_NAME,
    }))
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release()
    await pool.end()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
