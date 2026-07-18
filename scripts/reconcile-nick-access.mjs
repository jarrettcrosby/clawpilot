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
  viewOrganizationAudit: true,
  viewSystemAudit: true,
}

function fail(message) {
  console.error(`users:reconcile-nick-access failed: ${message}`)
  process.exit(1)
}

if (!process.env.DATABASE_URL) fail('DATABASE_URL is required')
if (process.env.CLAWPILOT_USER_ACCESS_CONFIRM !== 'nick-disabled-admin-v2') {
  fail('CLAWPILOT_USER_ACCESS_CONFIRM=nick-disabled-admin-v2 is required')
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
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('clawpilot-reconcile-nick-access-v2'))`)
    const current = await client.query(
      `SELECT app_user.organization_id::text, app_user.status AS user_status,
         organization.parent_id::text, organization.name AS organization_name,
         membership.status AS membership_status, membership.role AS membership_role
       FROM app_users app_user
       JOIN workspace_organizations organization ON organization.id = app_user.organization_id
       JOIN app_user_organization_memberships membership
         ON membership.user_email = app_user.email
        AND membership.organization_id = app_user.organization_id
       WHERE app_user.email = $1
       FOR UPDATE OF app_user, organization, membership`,
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
         status = 'disabled', organization_name = $3, updated_at = now()
       WHERE email = $1`,
      [NICK_EMAIL, JSON.stringify(ADMIN_PERMISSIONS), ORGANIZATION_NAME],
    )
    await client.query(
      `UPDATE app_user_organization_memberships
       SET role = 'admin', permissions = $3::jsonb, status = 'disabled',
         updated_by = $4, updated_at = now()
       WHERE user_email = $1 AND organization_id = $2::uuid`,
      [NICK_EMAIL, current.rows[0].organization_id, JSON.stringify(ADMIN_PERMISSIONS), actor],
    )
    const revoked = await client.query(
      `UPDATE app_sessions
       SET revoked_at = now(), revoked_reason = 'account_disabled_by_operator'
       WHERE (authenticated_user_email = $1 OR effective_user_email = $1)
         AND revoked_at IS NULL
       RETURNING id`,
      [NICK_EMAIL],
    )
    if (current.rows[0].user_status !== 'disabled' || current.rows[0].membership_status !== 'disabled') {
      await client.query(
        `INSERT INTO audit_events (
           actor, event_type, aggregate_type, aggregate_id, subject, organization_id, payload
         ) VALUES ($1, 'user.status.updated', 'app_user', $2, $2, $3::uuid, $4::jsonb)`,
        [actor, NICK_EMAIL, current.rows[0].organization_id, JSON.stringify({
          previousStatus: current.rows[0].membership_status,
          previousUserStatus: current.rows[0].user_status,
          status: 'disabled',
          organizationId: current.rows[0].organization_id,
          source: 'operator-disabled-access-reconciliation',
          revokedSessions: revoked.rowCount,
        })],
      )
    }
    await client.query(
      `INSERT INTO audit_events (
         actor, event_type, aggregate_type, aggregate_id, subject, organization_id, payload
       ) VALUES ($1, 'user.admin_access.reconciled', 'app_user', $2, $2, $3::uuid, $4::jsonb)`,
      [actor, NICK_EMAIL, current.rows[0].organization_id, JSON.stringify({
        subject: NICK_EMAIL,
        organizationId: current.rows[0].organization_id,
        organizationName: ORGANIZATION_NAME,
        previousOrganizationName: current.rows[0].organization_name,
        previousRole: current.rows[0].membership_role,
        role: 'admin',
        status: 'disabled',
        revokedSessions: revoked.rowCount,
      })],
    )
    await client.query('COMMIT')
    console.log(JSON.stringify({
      ok: true,
      email: NICK_EMAIL,
      role: 'admin',
      status: 'disabled',
      revokedSessions: revoked.rowCount,
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
