#!/usr/bin/env node
import { createRequire } from 'node:module'

const requireFromApp = createRequire(new URL('../app_src/package.json', import.meta.url))
const { Pool } = requireFromApp('pg')

const DEMO_EMAIL = 'demo-system@clawpilot.example'
const DEMO_WORKSPACE_ID = '10000000-0000-4000-8000-000000000001'
const DEMO_PIPELINE_ID = '20000000-0000-4000-8000-000000000001'
const DEMO_BOARD_ID = '30000000-0000-4000-8000-000000000001'

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required')

const sslMode = String(process.env.PGSSLMODE || process.env.DATABASE_SSL || '').toLowerCase()
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: sslMode === 'require' || sslMode === 'true' ? { rejectUnauthorized: false } : undefined,
  connectionTimeoutMillis: 5000,
  query_timeout: 15000,
})

try {
  const result = await pool.query(`
    WITH metadata AS (
      SELECT anchor_date
      FROM demo_dataset_metadata
      WHERE dataset_key = 'workspace-demo'
    )
    SELECT metadata.anchor_date::text,
      (SELECT count(*) FROM workspace_organizations
        WHERE id = $1::uuid AND is_demo = true AND name = 'ClawPilot Demo Company')::integer AS workspaces,
      (SELECT count(*) FROM app_users
        WHERE email = $2 AND status = 'active')::integer AS system_users,
      (SELECT count(*) FROM app_user_organization_memberships
        WHERE organization_id = $1::uuid AND status = 'active')::integer AS memberships,
      (SELECT count(*) FROM pipeline_spaces
        WHERE id = $3::uuid AND workspace_organization_id = $1::uuid
          AND sheet_id IS NULL AND sync_enabled = false)::integer AS pipelines,
      (SELECT count(*) FROM operations_activation_scopes
        WHERE organization_id = $1::uuid
          AND data_pipeline_id = $3::uuid
          AND state = 'shadow')::integer AS operations_activation_scopes,
      (SELECT count(*) FROM project_boards
        WHERE id = $4::uuid AND workspace_organization_id = $1::uuid)::integer AS boards,
      (SELECT count(*) FROM crm_organizations WHERE pipeline_id = $3::uuid)::integer AS organizations,
      (SELECT count(*) FROM crm_contacts WHERE pipeline_id = $3::uuid)::integer AS contacts,
      (SELECT count(*) FROM crm_opportunities WHERE pipeline_id = $3::uuid)::integer AS opportunities,
      (SELECT count(*) FROM crm_interactions WHERE pipeline_id = $3::uuid)::integer AS interactions,
      (SELECT count(*) FROM crm_interactions interaction
        WHERE interaction.pipeline_id = $3::uuid
          AND interaction.occurred_at::date BETWEEN metadata.anchor_date - 30 AND metadata.anchor_date)::integer AS interactions_recent,
      (SELECT count(*) FROM crm_interactions interaction
        WHERE interaction.pipeline_id = $3::uuid
          AND interaction.occurred_at::date BETWEEN metadata.anchor_date - 60 AND metadata.anchor_date - 31)::integer AS interactions_follow_up,
      (SELECT count(*) FROM crm_interactions interaction
        WHERE interaction.pipeline_id = $3::uuid
          AND interaction.occurred_at::date BETWEEN metadata.anchor_date - 90 AND metadata.anchor_date - 61)::integer AS interactions_context,
      (SELECT count(*) FROM quickbooks_transactions
        WHERE organization_id = $1::uuid AND entity_type = 'Invoice')::integer AS invoices,
      (SELECT count(*) FROM quickbooks_items
        WHERE organization_id = $1::uuid)::integer AS products,
      (SELECT count(*) FROM toast_pos_orders
        WHERE organization_id = $1::uuid
          AND business_date BETWEEN metadata.anchor_date - 29 AND metadata.anchor_date)::integer AS pos_orders,
      (SELECT count(DISTINCT business_date) FROM toast_pos_orders
        WHERE organization_id = $1::uuid
          AND business_date BETWEEN metadata.anchor_date - 29 AND metadata.anchor_date)::integer AS pos_business_days,
      (SELECT count(*) FROM toast_menu_catalog_items
        WHERE organization_id = $1::uuid AND active = true)::integer AS pos_menu_items,
      (SELECT count(*) FROM pos_accounting_profiles
        WHERE organization_id = $1::uuid AND effective_to IS NULL)::integer AS accounting_profiles,
      (SELECT count(*) FROM pos_accounting_catalog_mappings
        WHERE organization_id = $1::uuid AND effective_to IS NULL
          AND validation_status = 'valid')::integer AS accounting_mappings,
      (SELECT count(*) FROM quickbooks_tax_codes
        WHERE organization_id = $1::uuid AND active = true)::integer AS quickbooks_tax_codes,
      (SELECT count(*) FROM quickbooks_classes
        WHERE organization_id = $1::uuid AND active = true)::integer AS quickbooks_classes,
      (SELECT count(*) FROM quickbooks_departments
        WHERE organization_id = $1::uuid AND active = true)::integer AS quickbooks_departments,
      (SELECT count(*) FROM organization_quickbooks_connections
        WHERE organization_id = $1::uuid
          AND maton_connection_id = 'demo-synthetic-no-provider'
          AND write_mode = 'disabled'
          AND catalog_sync_enabled = false)::integer AS isolated_connections,
      (
        (SELECT count(*) FROM crm_organizations
          WHERE pipeline_id = $3::uuid AND email IS NOT NULL
            AND lower(email) !~ '@demo\\.clawpilot\\.example$')
        + (SELECT count(*) FROM crm_contacts
          WHERE pipeline_id = $3::uuid AND email IS NOT NULL
            AND lower(email) !~ '@demo\\.clawpilot\\.example$')
        + (SELECT count(*) FROM quickbooks_customers
          WHERE organization_id = $1::uuid AND email IS NOT NULL
            AND lower(email) !~ '@demo\\.clawpilot\\.example$')
        + (SELECT count(*) FROM quickbooks_vendors
          WHERE organization_id = $1::uuid AND email IS NOT NULL
            AND lower(email) !~ '@demo\\.clawpilot\\.example$')
      )::integer AS unsafe_emails,
      (
        (SELECT count(*)
         FROM crm_organizations demo_record
         JOIN crm_organizations live_record
           ON lower(btrim(live_record.name)) = lower(btrim(demo_record.name))
         JOIN pipeline_spaces live_pipeline ON live_pipeline.id = live_record.pipeline_id
         WHERE demo_record.pipeline_id = $3::uuid
           AND live_pipeline.workspace_organization_id <> $1::uuid)
        + (SELECT count(*)
         FROM crm_contacts demo_record
         JOIN crm_contacts live_record
           ON (
             demo_record.email IS NOT NULL AND live_record.email IS NOT NULL
             AND lower(btrim(live_record.email)) = lower(btrim(demo_record.email))
           ) OR lower(btrim(live_record.full_name)) = lower(btrim(demo_record.full_name))
         JOIN pipeline_spaces live_pipeline ON live_pipeline.id = live_record.pipeline_id
         WHERE demo_record.pipeline_id = $3::uuid
           AND live_pipeline.workspace_organization_id <> $1::uuid)
      )::integer AS live_identity_overlaps
    FROM metadata
  `, [DEMO_WORKSPACE_ID, DEMO_EMAIL, DEMO_PIPELINE_ID, DEMO_BOARD_ID])
  const row = result.rows[0]
  if (!row || row.workspaces !== 1 || row.system_users !== 1 || row.memberships < 1
    || row.pipelines !== 1 || row.operations_activation_scopes !== 1 || row.boards !== 1
    || row.organizations < 5 || row.contacts < 5
    || row.opportunities < 5 || row.interactions < 12 || row.invoices < 6
    || row.interactions_recent < 1 || row.interactions_follow_up < 1 || row.interactions_context < 1
    || row.products < 11 || row.pos_orders < 180 || row.pos_business_days !== 30
    || row.pos_menu_items !== 5 || row.accounting_profiles !== 1 || row.accounting_mappings < 11
    || row.quickbooks_tax_codes < 1 || row.quickbooks_classes < 1 || row.quickbooks_departments < 1
    || row.isolated_connections !== 1
    || row.unsafe_emails !== 0 || row.live_identity_overlaps !== 0) {
    throw new Error(`demo account verification failed: ${JSON.stringify(row || {})}`)
  }
  console.log(JSON.stringify({ ok: true, ...row }))
} finally {
  await pool.end()
}
