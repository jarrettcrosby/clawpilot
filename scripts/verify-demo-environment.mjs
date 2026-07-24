#!/usr/bin/env node
import { createRequire } from 'node:module'

const requireFromApp = createRequire(new URL('../app_src/package.json', import.meta.url))
const { Pool } = requireFromApp('pg')

const DEMO_EMAIL = 'demo-system@clawpilot.example'
const DEMO_WORKSPACE_ID = '10000000-0000-4000-8000-000000000001'
const DEMO_BOARD_ID = '30000000-0000-4000-8000-000000000001'
const QUARANTINE_ROTATION_ENABLED =
  String(process.env.DEMO_QUARANTINE_ROTATION_ENABLED || '').toLowerCase() === 'true'

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required')

const sslMode = String(process.env.PGSSLMODE || process.env.DATABASE_SSL || '').toLowerCase()
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: sslMode === 'require' || sslMode === 'true' ? { rejectUnauthorized: false } : undefined,
  connectionTimeoutMillis: 5000,
  query_timeout: 15000,
})

try {
  const rolloutGuard = await pool.query(
    `SELECT
       (SELECT count(*) FROM workspace_organizations
        WHERE id = $1::uuid AND is_demo = true)::integer AS workspaces,
       (SELECT count(*) FROM app_users
        WHERE email = $2 AND status = 'active')::integer AS system_users,
       (SELECT count(*) FROM pipeline_spaces
        WHERE workspace_organization_id = $1::uuid
          AND is_default = true
          AND sync_enabled = false
          AND reference_access_disabled = false)::integer AS active_pipelines,
       (SELECT count(*) FROM pipeline_spaces pipeline
        WHERE pipeline.workspace_organization_id = $1::uuid
          AND (
            EXISTS (
              SELECT 1 FROM crm_contact_source_aliases alias
              WHERE alias.pipeline_id = pipeline.id
            )
            OR EXISTS (
              SELECT 1 FROM crm_contact_merges merge_evidence
              WHERE merge_evidence.pipeline_id = pipeline.id
            )
          ))::integer AS immutable_pipelines,
       (SELECT count(*) FROM schema_migrations
        WHERE filename = '0103_pipeline_crm_reference_quarantine.sql')::integer
          AS quarantine_migrations`,
    [DEMO_WORKSPACE_ID, DEMO_EMAIL],
  )
  const guard = rolloutGuard.rows[0]
  if (!QUARANTINE_ROTATION_ENABLED && guard?.immutable_pipelines > 0) {
    if (guard.workspaces !== 1
      || guard.system_users !== 1
      || guard.active_pipelines !== 1
      || guard.quarantine_migrations !== 1) {
      throw new Error(`demo quarantine guard verification failed: ${JSON.stringify(guard || {})}`)
    }
    console.log(JSON.stringify({
      ok: true,
      mode: 'quarantine_guard_rollout',
      rotationEnabled: false,
      pendingImmutablePipelines: guard.immutable_pipelines,
      ...guard,
    }))
  } else {
  const result = await pool.query(`
    WITH metadata AS (
      SELECT anchor_date
      FROM demo_dataset_metadata
      WHERE dataset_key = 'workspace-demo'
    ), active_pipeline_candidates AS (
      SELECT id, updated_at, created_at
      FROM pipeline_spaces
      WHERE workspace_organization_id = $1::uuid
        AND is_default = true
        AND sync_enabled = false
        AND reference_access_disabled = false
    ), active_pipeline AS (
      SELECT id
      FROM active_pipeline_candidates
      ORDER BY updated_at DESC, created_at DESC, id
      LIMIT 1
    ), legacy_pipelines AS (
      SELECT id
      FROM pipeline_spaces
      WHERE workspace_organization_id = $1::uuid
        AND id IS DISTINCT FROM (SELECT id FROM active_pipeline)
    ), legacy_references AS (
      SELECT reference_code FROM crm_organizations
      WHERE pipeline_id IN (SELECT id FROM legacy_pipelines)
      UNION
      SELECT reference_code FROM crm_contacts
      WHERE pipeline_id IN (SELECT id FROM legacy_pipelines)
      UNION
      SELECT reference_code FROM crm_leads
      WHERE pipeline_id IN (SELECT id FROM legacy_pipelines)
      UNION
      SELECT reference_code FROM crm_products
      WHERE pipeline_id IN (SELECT id FROM legacy_pipelines)
      UNION
      SELECT reference_code FROM crm_opportunities
      WHERE pipeline_id IN (SELECT id FROM legacy_pipelines)
      UNION
      SELECT reference_code FROM crm_interactions
      WHERE pipeline_id IN (SELECT id FROM legacy_pipelines)
      UNION
      SELECT reference_code FROM crm_meetings
      WHERE pipeline_id IN (SELECT id FROM legacy_pipelines)
      UNION
      SELECT reference_code FROM crm_campaigns
      WHERE pipeline_id IN (SELECT id FROM legacy_pipelines)
      UNION
      SELECT survivor_reference_code FROM crm_contact_merges
      WHERE pipeline_id IN (SELECT id FROM legacy_pipelines)
      UNION
      SELECT duplicate_reference_code FROM crm_contact_merges
      WHERE pipeline_id IN (SELECT id FROM legacy_pipelines)
    ), expanded_legacy_references AS (
      SELECT reference_code FROM legacy_references
      UNION
      SELECT alias.alias_code
      FROM crm_reference_aliases alias
      JOIN legacy_references legacy
        ON legacy.reference_code = alias.canonical_code
    )
    SELECT metadata.anchor_date::text,
      (SELECT id::text FROM active_pipeline) AS active_pipeline_id,
      (SELECT count(*) FROM active_pipeline_candidates)::integer AS active_pipelines,
      (SELECT count(*) FROM workspace_organizations
        WHERE id = $1::uuid AND is_demo = true AND name = 'ClawPilot Demo Company')::integer AS workspaces,
      (SELECT count(*) FROM app_users
        WHERE email = $2 AND status = 'active')::integer AS system_users,
      (SELECT count(*) FROM app_user_organization_memberships
        WHERE organization_id = $1::uuid AND status = 'active')::integer AS memberships,
      (SELECT count(*) FROM pipeline_spaces
        WHERE id = (SELECT id FROM active_pipeline)
          AND workspace_organization_id = $1::uuid
          AND sheet_id IS NULL
          AND is_default = true
          AND sync_enabled = false
          AND reference_access_disabled = false)::integer AS pipelines,
      (SELECT count(*) FROM pipeline_spaces
        WHERE workspace_organization_id = $1::uuid
          AND id IS DISTINCT FROM (SELECT id FROM active_pipeline)
          AND (
            is_default = true
            OR sync_enabled = true
            OR reference_access_disabled = false
          ))::integer AS unsafe_legacy_pipelines,
      (SELECT count(*) FROM pipeline_spaces
        WHERE workspace_organization_id = $1::uuid
          AND id IS DISTINCT FROM (SELECT id FROM active_pipeline)
          AND reference_access_disabled = false)::integer AS accessible_legacy_pipelines,
      (SELECT count(*)
       FROM short_links link
       JOIN expanded_legacy_references legacy
         ON link.slug = legacy.reference_code
           OR link.slug = 'mail-' || legacy.reference_code
           OR legacy.reference_code = ANY(link.tags)
           OR link.destination_url LIKE '%/crm/' || legacy.reference_code || '%'
       WHERE link.disabled_at IS NULL
         AND link.deleted_at IS NULL)::integer AS enabled_legacy_crm_short_links,
      (SELECT count(*) FROM pipeline_space_members membership
        JOIN pipeline_spaces pipeline ON pipeline.id = membership.pipeline_id
        WHERE pipeline.workspace_organization_id = $1::uuid
          AND pipeline.id IS DISTINCT FROM (SELECT id FROM active_pipeline))::integer AS legacy_pipeline_memberships,
      (SELECT count(*)
       FROM app_user_workspace_preferences preference
       JOIN app_user_organization_memberships membership
         ON membership.organization_id = preference.workspace_organization_id
        AND membership.user_email = preference.user_email
        AND membership.status = 'active'
        WHERE preference.workspace_organization_id = $1::uuid
          AND preference.default_pipeline_id IS DISTINCT FROM (
            SELECT id FROM active_pipeline
          ))::integer AS legacy_default_preferences,
      (SELECT count(*)
       FROM sync_outbox outbox
       JOIN pipeline_spaces pipeline
         ON pipeline.id::text = outbox.payload->>'pipelineId'
       WHERE pipeline.workspace_organization_id = $1::uuid
         AND pipeline.id IS DISTINCT FROM (SELECT id FROM active_pipeline)
         AND outbox.target_system = 'suitecrm'
         AND outbox.status IN ('queued', 'failed', 'processing'))::integer AS active_legacy_outbox,
      (SELECT count(*)
       FROM crm_contact_merges merge_evidence
       JOIN pipeline_spaces pipeline ON pipeline.id = merge_evidence.pipeline_id
       WHERE pipeline.workspace_organization_id = $1::uuid
         AND pipeline.id IS DISTINCT FROM (SELECT id FROM active_pipeline)
         AND (
           (
             merge_evidence.survivor_outbox_id IS NOT NULL
             AND NOT EXISTS (
               SELECT 1 FROM sync_outbox
               WHERE id = merge_evidence.survivor_outbox_id
             )
           )
           OR (
             merge_evidence.duplicate_delete_outbox_id IS NOT NULL
             AND NOT EXISTS (
               SELECT 1 FROM sync_outbox
               WHERE id = merge_evidence.duplicate_delete_outbox_id
             )
           )
         ))::integer AS missing_legacy_outbox_evidence,
      (SELECT count(*)
       FROM crm_contact_merges merge_evidence
       JOIN pipeline_spaces pipeline ON pipeline.id = merge_evidence.pipeline_id
       JOIN sync_outbox outbox
         ON outbox.id IN (
           merge_evidence.survivor_outbox_id,
           merge_evidence.duplicate_delete_outbox_id
         )
       WHERE pipeline.workspace_organization_id = $1::uuid
         AND pipeline.id IS DISTINCT FROM (SELECT id FROM active_pipeline)
         AND outbox.status NOT IN ('succeeded', 'dead'))::integer AS nonterminal_legacy_outbox_evidence,
      (SELECT count(*) FROM operations_activation_scopes
        WHERE organization_id = $1::uuid
          AND data_pipeline_id = (SELECT id FROM active_pipeline)
          AND state = 'shadow')::integer AS operations_activation_scopes,
      (SELECT count(*) FROM project_boards
        WHERE id = $3::uuid AND workspace_organization_id = $1::uuid)::integer AS boards,
      (SELECT count(*) FROM crm_organizations
        WHERE pipeline_id = (SELECT id FROM active_pipeline))::integer AS organizations,
      (SELECT count(*) FROM crm_contacts
        WHERE pipeline_id = (SELECT id FROM active_pipeline))::integer AS contacts,
      (SELECT count(*) FROM crm_opportunities
        WHERE pipeline_id = (SELECT id FROM active_pipeline))::integer AS opportunities,
      (SELECT count(*) FROM crm_interactions
        WHERE pipeline_id = (SELECT id FROM active_pipeline))::integer AS interactions,
      (SELECT count(*) FROM crm_interactions interaction
        WHERE interaction.pipeline_id = (SELECT id FROM active_pipeline)
          AND interaction.occurred_at::date BETWEEN metadata.anchor_date - 30 AND metadata.anchor_date)::integer AS interactions_recent,
      (SELECT count(*) FROM crm_interactions interaction
        WHERE interaction.pipeline_id = (SELECT id FROM active_pipeline)
          AND interaction.occurred_at::date BETWEEN metadata.anchor_date - 60 AND metadata.anchor_date - 31)::integer AS interactions_follow_up,
      (SELECT count(*) FROM crm_interactions interaction
        WHERE interaction.pipeline_id = (SELECT id FROM active_pipeline)
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
          WHERE pipeline_id = (SELECT id FROM active_pipeline) AND email IS NOT NULL
            AND lower(email) !~ '@demo\\.clawpilot\\.example$')
        + (SELECT count(*) FROM crm_contacts
          WHERE pipeline_id = (SELECT id FROM active_pipeline) AND email IS NOT NULL
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
         WHERE demo_record.pipeline_id = (SELECT id FROM active_pipeline)
           AND live_pipeline.workspace_organization_id <> $1::uuid)
        + (SELECT count(*)
         FROM crm_contacts demo_record
         JOIN crm_contacts live_record
           ON (
             demo_record.email IS NOT NULL AND live_record.email IS NOT NULL
             AND lower(btrim(live_record.email)) = lower(btrim(demo_record.email))
           ) OR lower(btrim(live_record.full_name)) = lower(btrim(demo_record.full_name))
         JOIN pipeline_spaces live_pipeline ON live_pipeline.id = live_record.pipeline_id
         WHERE demo_record.pipeline_id = (SELECT id FROM active_pipeline)
           AND live_pipeline.workspace_organization_id <> $1::uuid)
      )::integer AS live_identity_overlaps
    FROM metadata
  `, [DEMO_WORKSPACE_ID, DEMO_EMAIL, DEMO_BOARD_ID])
  const row = result.rows[0]
  if (!row || row.workspaces !== 1 || row.system_users !== 1 || row.memberships < 1
    || row.active_pipelines !== 1 || row.pipelines !== 1
    || row.unsafe_legacy_pipelines !== 0 || row.accessible_legacy_pipelines !== 0
    || row.enabled_legacy_crm_short_links !== 0
    || row.legacy_pipeline_memberships !== 0 || row.legacy_default_preferences !== 0
    || row.active_legacy_outbox !== 0 || row.missing_legacy_outbox_evidence !== 0
    || row.nonterminal_legacy_outbox_evidence !== 0
    || row.operations_activation_scopes !== 1 || row.boards !== 1
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
  }
} finally {
  await pool.end()
}
