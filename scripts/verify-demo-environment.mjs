#!/usr/bin/env node
import { createRequire } from 'node:module'

const requireFromApp = createRequire(new URL('../app_src/package.json', import.meta.url))
const { Pool } = requireFromApp('pg')

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required')
if (process.env.CLAWPILOT_DEMO_MODE !== '1') throw new Error('CLAWPILOT_DEMO_MODE=1 is required')

const sslMode = String(process.env.PGSSLMODE || process.env.DATABASE_SSL || '').toLowerCase()
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: sslMode === 'require' || sslMode === 'true' ? { rejectUnauthorized: false } : undefined,
  connectionTimeoutMillis: 5000,
  query_timeout: 15000,
})

try {
  const result = await pool.query(`
    SELECT metadata.anchor_date::text,
      (SELECT count(*) FROM app_users WHERE email = 'demo@clawpilot.example' AND status = 'active')::integer AS users,
      (SELECT count(*) FROM crm_organizations)::integer AS organizations,
      (SELECT count(*) FROM crm_contacts)::integer AS contacts,
      (SELECT count(*) FROM crm_opportunities)::integer AS opportunities,
      (SELECT count(*) FROM crm_interactions)::integer AS interactions,
      (SELECT count(*) FROM crm_interactions interaction
        WHERE interaction.occurred_at::date BETWEEN metadata.anchor_date - 30 AND metadata.anchor_date)::integer AS interactions_recent,
      (SELECT count(*) FROM crm_interactions interaction
        WHERE interaction.occurred_at::date BETWEEN metadata.anchor_date - 60 AND metadata.anchor_date - 31)::integer AS interactions_follow_up,
      (SELECT count(*) FROM crm_interactions interaction
        WHERE interaction.occurred_at::date BETWEEN metadata.anchor_date - 90 AND metadata.anchor_date - 61)::integer AS interactions_context,
      (SELECT count(*) FROM quickbooks_transactions WHERE entity_type = 'Invoice')::integer AS invoices,
      (SELECT count(*) FROM quickbooks_items)::integer AS products,
      (SELECT count(*) FROM organization_quickbooks_connections
        WHERE maton_connection_id = 'demo-synthetic-no-provider'
          AND write_mode = 'disabled')::integer AS isolated_connections
    FROM demo_dataset_metadata metadata
    WHERE metadata.dataset_key = 'public-demo'
  `)
  const row = result.rows[0]
  if (!row || row.users !== 1 || row.organizations < 5 || row.contacts < 5
    || row.opportunities < 5 || row.interactions < 12 || row.invoices < 6
    || row.interactions_recent < 1 || row.interactions_follow_up < 1 || row.interactions_context < 1
    || row.products < 5 || row.isolated_connections !== 1) {
    throw new Error(`demo dataset verification failed: ${JSON.stringify(row || {})}`)
  }
  console.log(JSON.stringify({ ok: true, ...row }))
} finally {
  await pool.end()
}
