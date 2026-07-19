#!/usr/bin/env node
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import { buildDemoDataset } from './demo-dataset.mjs'

const requireFromApp = createRequire(new URL('../app_src/package.json', import.meta.url))
const { Pool } = requireFromApp('pg')

const DEMO_EMAIL = 'demo-system@clawpilot.example'
const ROOT_ORGANIZATION_ID = '10000000-0000-4000-8000-000000000001'
const PIPELINE_ID = '20000000-0000-4000-8000-000000000001'
const BOARD_ID = '30000000-0000-4000-8000-000000000001'

function fail(message) {
  console.error(`demo:seed failed: ${message}`)
  process.exit(1)
}

if (!process.env.DATABASE_URL) fail('DATABASE_URL is required')
const environment = String(process.env.RAILWAY_ENVIRONMENT_NAME || '').toLowerCase()

const dataset = buildDemoDataset(process.env.DEMO_ANCHOR_DATE || '')
const sslMode = String(process.env.PGSSLMODE || process.env.DATABASE_SSL || '').toLowerCase()
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: sslMode === 'require' || sslMode === 'true' ? { rejectUnauthorized: false } : undefined,
  connectionTimeoutMillis: 5000,
  query_timeout: 60000,
})

function uuid(prefix, index) {
  return `${prefix}0000000-0000-4000-8000-${String(index).padStart(12, '0')}`
}

function digest(value) {
  return crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex')
}

function isoDaysAgo(days, hour = 15) {
  const value = new Date(`${dataset.anchorDate}T12:00:00.000Z`)
  value.setUTCDate(value.getUTCDate() - days)
  value.setUTCHours(hour, 0, 0, 0)
  return value.toISOString()
}

async function main() {
  const client = await pool.connect()
  try {
    await client.query(`SELECT pg_advisory_lock(hashtext('clawpilot-demo-account-seed'))`)
    await client.query('BEGIN')
    await client.query(
      `DELETE FROM app_documents WHERE workspace_organization_id = $1::uuid`,
      [ROOT_ORGANIZATION_ID],
    )
    await client.query(
      `DELETE FROM tasks
       WHERE board_id IN (
         SELECT id FROM project_boards WHERE workspace_organization_id = $1::uuid
       )`,
      [ROOT_ORGANIZATION_ID],
    )
    await client.query(
      `DELETE FROM organization_quickbooks_connections WHERE organization_id = $1::uuid`,
      [ROOT_ORGANIZATION_ID],
    )
    await client.query(
      `DELETE FROM pipeline_spaces WHERE workspace_organization_id = $1::uuid`,
      [ROOT_ORGANIZATION_ID],
    )
    await client.query(
      `DELETE FROM project_boards WHERE workspace_organization_id = $1::uuid`,
      [ROOT_ORGANIZATION_ID],
    )
    await client.query(`DELETE FROM demo_dataset_metadata WHERE dataset_key IN ('workspace-demo', 'public-demo')`)

    const root = await client.query(
      `INSERT INTO workspace_organizations (
         id, parent_id, name, organization_type, is_demo, created_at, updated_at
       ) VALUES ($1::uuid, NULL, 'ClawPilot Demo Company', 'root', true, $2::timestamptz, $2::timestamptz)
       ON CONFLICT (id) DO UPDATE SET
         parent_id = NULL,
         name = EXCLUDED.name,
         organization_type = 'root',
         is_demo = true,
         updated_at = EXCLUDED.updated_at
       RETURNING reference_code`,
      [ROOT_ORGANIZATION_ID, dataset.generatedAt],
    )
    const rootReference = root.rows[0].reference_code
    await client.query(
      `INSERT INTO app_users (
         email, role, status, display_name, job_title, timezone, locale, permissions,
         organization_id, organization_name, crm_user_enabled, reference_code,
         invited_at, activated_at, last_login_at, created_at, updated_at
       ) VALUES (
         $1, 'member', 'active', 'ClawPilot Demo Team', 'Demo account steward', 'America/New_York', 'en-US',
         $2::jsonb, $3::uuid, 'ClawPilot Demo Company', false, NULL,
         $4::timestamptz, $4::timestamptz, $4::timestamptz, $4::timestamptz, $4::timestamptz
       )
       ON CONFLICT (email) DO UPDATE SET
         role = 'member',
         status = 'active',
         display_name = EXCLUDED.display_name,
         job_title = EXCLUDED.job_title,
         timezone = EXCLUDED.timezone,
         locale = EXCLUDED.locale,
         permissions = EXCLUDED.permissions,
         organization_id = EXCLUDED.organization_id,
         organization_name = EXCLUDED.organization_name,
         crm_user_enabled = false,
         updated_at = EXCLUDED.updated_at`,
      [DEMO_EMAIL, JSON.stringify({
        accessDemo: false,
        inviteUsers: false,
        manageUserAccess: false,
        createBoards: false,
        createPipelines: false,
        viewFullReleaseHistory: false,
        manageBackups: false,
        manageLinks: false,
        viewAccounting: true,
        prepareAccounting: false,
        approveAccounting: false,
        viewOrganizationAudit: true,
        viewSystemAudit: false,
      }), ROOT_ORGANIZATION_ID, dataset.generatedAt],
    )
    await client.query(
      `UPDATE workspace_organizations SET created_by = $2, updated_by = $2 WHERE id = $1::uuid`,
      [ROOT_ORGANIZATION_ID, DEMO_EMAIL],
    )
    await client.query(
      `INSERT INTO app_user_organization_memberships (
         user_email, organization_id, role, permissions, status, is_default,
         created_by, updated_by, created_at, updated_at
       ) VALUES ($1, $2::uuid, 'owner', $3::jsonb, 'active', true, $1, $1, $4::timestamptz, $4::timestamptz)
       ON CONFLICT (user_email, organization_id) DO UPDATE SET
         role = 'owner',
         permissions = EXCLUDED.permissions,
         status = 'active',
         is_default = true,
         updated_by = EXCLUDED.updated_by,
         updated_at = EXCLUDED.updated_at`,
      [DEMO_EMAIL, ROOT_ORGANIZATION_ID, JSON.stringify({
        accessDemo: true,
        inviteUsers: false,
        manageUserAccess: false,
        createBoards: false,
        createPipelines: false,
        viewFullReleaseHistory: false,
        manageBackups: false,
        manageLinks: false,
        viewAccounting: true,
        prepareAccounting: false,
        approveAccounting: false,
        viewOrganizationAudit: true,
        viewSystemAudit: false,
      }), dataset.generatedAt],
    )
    await client.query(
      `INSERT INTO workspace_organization_branding (
         organization_id, primary_color, accent_color, updated_by, created_at, updated_at
       ) VALUES ($1::uuid, '#1F2430', '#A8C7FA', $2, $3::timestamptz, $3::timestamptz)
       ON CONFLICT (organization_id) DO UPDATE SET
         primary_color = EXCLUDED.primary_color,
         accent_color = EXCLUDED.accent_color,
         updated_by = EXCLUDED.updated_by,
         updated_at = EXCLUDED.updated_at`,
      [ROOT_ORGANIZATION_ID, DEMO_EMAIL, dataset.generatedAt],
    )

    await client.query(
      `INSERT INTO pipeline_spaces (
         id, name, owner_email, is_default, sync_enabled, projection,
         workspace_organization_id, provisioning_status, created_at, updated_at
       ) VALUES ($1::uuid, 'Demo Revenue Pipeline', $2, true, false, $3::jsonb,
         $4::uuid, 'not_requested', $5::timestamptz, $5::timestamptz)`,
      [PIPELINE_ID, DEMO_EMAIL, JSON.stringify({
        syncedAt: dataset.generatedAt,
        source: 'demo',
        summary: {
          opportunities: dataset.opportunities.length,
          organizations: dataset.organizations.length + 1,
          contacts: dataset.people.length,
          totalOpenValue: dataset.opportunities.filter((item) => item.status === 'Open').reduce((sum, item) => sum + Number(item.amount), 0),
        },
        opportunities: [],
      }), ROOT_ORGANIZATION_ID, dataset.generatedAt],
    )
    await client.query(
      `INSERT INTO pipeline_space_members (pipeline_id, user_email, access_role, shared_by, created_at, updated_at)
       VALUES ($1::uuid, $2, 'editor', $2, $3::timestamptz, $3::timestamptz)`,
      [PIPELINE_ID, DEMO_EMAIL, dataset.generatedAt],
    )
    await client.query(
      `INSERT INTO project_boards (
         id, name, owner_email, is_default, workspace_organization_id, created_at, updated_at
       ) VALUES ($1::uuid, 'Demo Operations Board', $2, true, $3::uuid, $4::timestamptz, $4::timestamptz)`,
      [BOARD_ID, DEMO_EMAIL, ROOT_ORGANIZATION_ID, dataset.generatedAt],
    )
    await client.query(
      `INSERT INTO project_board_members (board_id, user_email, access_role, shared_by, created_at, updated_at)
       VALUES ($1::uuid, $2, 'editor', $2, $3::timestamptz, $3::timestamptz)`,
      [BOARD_ID, DEMO_EMAIL, dataset.generatedAt],
    )
    await client.query(
       `INSERT INTO app_user_workspace_preferences (
         user_email, workspace_organization_id, default_board_id, default_pipeline_id, created_at, updated_at
       ) VALUES ($1, $2::uuid, $3::uuid, $4::uuid, $5::timestamptz, $5::timestamptz)
       ON CONFLICT (user_email, workspace_organization_id) DO UPDATE SET
         default_board_id = EXCLUDED.default_board_id,
         default_pipeline_id = EXCLUDED.default_pipeline_id,
         updated_at = EXCLUDED.updated_at`,
      [DEMO_EMAIL, ROOT_ORGANIZATION_ID, BOARD_ID, PIPELINE_ID, dataset.generatedAt],
    )

    const crmRootId = uuid('4', 1)
    await client.query(
      `INSERT INTO crm_organizations (
         id, pipeline_id, suitecrm_id, source_key, identity_key, reference_code,
         workspace_organization_id, relationship_type, name, account_type, account_manager,
         description, source_payload, source_hash, sync_status, suitecrm_synced_at,
         created_by, updated_by, created_at, updated_at
       ) VALUES (
         $1::uuid, $2::uuid, $3, 'workspace:demo-root', 'workspace:demo-root', $4,
         $5::uuid, 'workspace_root', 'ClawPilot Demo Company', 'Parent organization', 'ClawPilot Demo Team',
         'Synthetic parent organization for the ClawPilot demo account.', $6::jsonb, $7,
         'synced', $8::timestamptz, $9, $9, $8::timestamptz, $8::timestamptz
       )`,
      [crmRootId, PIPELINE_ID, 'demo-suitecrm-root', rootReference, ROOT_ORGANIZATION_ID,
        JSON.stringify({ source: 'demo', synthetic: true }), digest('demo-root'), dataset.generatedAt, DEMO_EMAIL],
    )

    const organizationIds = new Map()
    for (const [index, organization] of dataset.organizations.entries()) {
      const id = uuid('4', index + 2)
      organizationIds.set(organization.providerId, id)
      const payload = { provider: 'quickbooks', synthetic: true, customerId: organization.providerId }
      await client.query(
        `INSERT INTO crm_organizations (
           id, pipeline_id, suitecrm_id, source_key, identity_key, parent_organization_id,
           relationship_type, priority, name, account_type, account_manager, email, phone,
           billing_address_city, billing_address_state, billing_address_country, description,
           source_payload, source_hash, sync_status, suitecrm_synced_at,
           created_by, updated_by, created_at, updated_at
         ) VALUES (
           $1::uuid, $2::uuid, $3, $4, $4, $5::uuid, 'customer', $6, $7,
           'Customer', 'ClawPilot Demo Team', $8, $9, $10, $11, 'US',
           'Synthetic customer account with activity in the rolling 90-day demo window.',
           $12::jsonb, $13, 'synced', $14::timestamptz, $15, $15, $14::timestamptz, $14::timestamptz
         )`,
        [id, PIPELINE_ID, `demo-suitecrm-account-${index + 1}`, `quickbooks:customer:${organization.providerId}`,
          crmRootId, organization.priority, organization.name, organization.email, organization.phone,
          organization.city, organization.state, JSON.stringify(payload), digest(payload),
          isoDaysAgo(88 - index * 5), DEMO_EMAIL],
      )
    }

    const contactIds = new Map()
    for (const [index, person] of dataset.people.entries()) {
      const id = uuid('5', index + 1)
      contactIds.set(person.email, id)
      const organizationId = organizationIds.get(person.organizationProviderId)
      const [firstName, ...lastParts] = person.fullName.split(' ')
      const payload = { provider: 'quickbooks', synthetic: true, customerId: person.organizationProviderId }
      await client.query(
        `INSERT INTO crm_contacts (
           id, pipeline_id, organization_id, suitecrm_id, source_key, identity_key,
           priority, first_name, last_name, full_name, contact_type, account_manager,
           job_title, email, phone_work, description, source_payload, source_hash,
           sync_status, suitecrm_synced_at, created_by, updated_by, created_at, updated_at
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, $4, $5, $6, 'B', $7, $8, $9,
           'Customer', 'ClawPilot Demo Team', $10, $11, $12,
           'Synthetic CRM contact associated with a demo customer account.',
           $13::jsonb, $14, 'synced', $15::timestamptz, $16, $16, $15::timestamptz, $15::timestamptz
         )`,
        [id, PIPELINE_ID, organizationId, `demo-suitecrm-contact-${index + 1}`,
          `quickbooks:customer-contact:${person.organizationProviderId}`, `contact:email:${person.email}`,
          firstName, lastParts.join(' '), person.fullName, person.title, person.email, person.phone,
          JSON.stringify(payload), digest(payload), isoDaysAgo(84 - index * 4), DEMO_EMAIL],
      )
    }

    const productIds = new Map()
    for (const [index, product] of dataset.products.entries()) {
      const id = uuid('7', index + 1)
      productIds.set(product.providerId, id)
      const payload = { provider: 'quickbooks', synthetic: true, itemId: product.providerId }
      await client.query(
        `INSERT INTO crm_products (
           id, pipeline_id, suitecrm_id, source_key, name, sku, product_type, category,
           status, price, cost, currency, description, active, source_payload, source_hash,
           sync_status, suitecrm_synced_at, created_by, updated_by, created_at, updated_at
         ) VALUES (
           $1::uuid, $2::uuid, $3, $4, $5, $6, $7, $7, 'Active', $8, $9, 'USD',
           'Synthetic QuickBooks product synchronized into the CRM catalog.', true,
           $10::jsonb, $11, 'synced', $12::timestamptz, $13, $13, $12::timestamptz, $12::timestamptz
         )`,
        [id, PIPELINE_ID, `demo-suitecrm-product-${index + 1}`, `quickbooks:item:${product.providerId}`,
          product.name, product.sku, product.type, product.price, product.cost,
          JSON.stringify(payload), digest(payload), dataset.generatedAt, DEMO_EMAIL],
      )
    }

    const opportunityIds = new Map()
    for (const [index, opportunity] of dataset.opportunities.entries()) {
      const id = uuid('6', index + 1)
      opportunityIds.set(opportunity.organizationProviderId, id)
      const organization = dataset.organizations.find((item) => item.providerId === opportunity.organizationProviderId)
      const organizationId = organizationIds.get(opportunity.organizationProviderId)
      const payload = { source: 'demo', synthetic: true, products: opportunity.productIds }
      await client.query(
        `INSERT INTO crm_opportunities (
           id, pipeline_id, organization_id, suitecrm_id, source_key, priority, name,
           owner_name, organization_name, status, stage, lead_source, amount, probability,
           expected_close, description, source_payload, source_hash, sync_status, suitecrm_synced_at,
           created_by, updated_by, created_at, updated_at
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, 'ClawPilot Demo Team', $8,
           $9, $10, 'Referral', $11, $12, $13::date,
           'Synthetic opportunity demonstrating products, touchpoints, and stage-weighted forecasting.',
           $14::jsonb, $15, 'synced', $16::timestamptz, $17, $17, $16::timestamptz, $16::timestamptz
         )`,
        [id, PIPELINE_ID, organizationId, `demo-suitecrm-opportunity-${index + 1}`,
          opportunity.sourceKey, opportunity.priority, opportunity.name, organization.name,
          opportunity.status, opportunity.stage, opportunity.amount, opportunity.probability,
          opportunity.expectedClose, JSON.stringify(payload), digest(payload), isoDaysAgo(76 - index * 7), DEMO_EMAIL],
      )
      for (const [sortOrder, providerId] of opportunity.productIds.entries()) {
        await client.query(
          `INSERT INTO crm_opportunity_products (
             pipeline_id, opportunity_id, product_id, sort_order, created_by, created_at, updated_at
           ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::timestamptz, $6::timestamptz)`,
          [PIPELINE_ID, id, productIds.get(providerId), sortOrder, DEMO_EMAIL, dataset.generatedAt],
        )
      }
    }

    for (const [index, interaction] of dataset.interactions.entries()) {
      const organizationId = organizationIds.get(interaction.organizationProviderId)
      const contactId = contactIds.get(interaction.contactEmail)
      const opportunityId = opportunityIds.get(interaction.organizationProviderId)
      const payload = { source: 'demo', synthetic: true, cohort: index < 7 ? '0-30' : index < 12 ? '31-60' : '61-90' }
      await client.query(
        `INSERT INTO crm_interactions (
           id, pipeline_id, organization_id, contact_id, opportunity_id, suitecrm_id,
           source_key, interaction_type, subject, agent_name, occurred_at, description,
           direction, delivery_status, metadata, source_payload, source_hash,
           sync_status, suitecrm_synced_at, created_by, updated_by, created_at, updated_at
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, $7, $8, $9,
           'ClawPilot Demo Team', $10::timestamptz, $11, $12, 'logged', $13::jsonb,
           $13::jsonb, $14, 'synced', $10::timestamptz, $15, $15, $10::timestamptz, $10::timestamptz
         )`,
        [uuid('8', index + 1), PIPELINE_ID, organizationId, contactId, opportunityId,
          `demo-suitecrm-interaction-${index + 1}`, interaction.sourceKey, interaction.kind,
          interaction.subject, interaction.occurredAt, interaction.description, interaction.direction,
          JSON.stringify(payload), digest(payload), DEMO_EMAIL],
      )
    }

    const taskDefinitions = [
      ['demo-task-1', 'Review Acorn Ridge expansion proposal', 'in-progress', 'high', 4],
      ['demo-task-2', 'Prepare Cedar Harbor reporting rollout', 'todo', 'high', 9],
      ['demo-task-3', 'Reconcile June operating statements', 'review', 'medium', 18],
      ['demo-task-4', 'Document customer onboarding playbook', 'backlog', 'medium', 33],
      ['demo-task-5', 'Confirm Highline pilot stakeholders', 'done', 'low', 47],
    ]
    for (const [id, title, status, priority, daysAgo] of taskDefinitions) {
      const createdAt = isoDaysAgo(Number(daysAgo) + 7)
      const updatedAt = isoDaysAgo(Number(daysAgo))
      const payload = {
        id, title, desc: 'Synthetic project card showing a realistic operator workflow in the demo account.',
        status, priority, category: 'operations', tags: ['demo', 'customer-work'], assignedAgent: null,
        checklist: [{ id: `${id}-check-1`, text: 'Review linked CRM context', done: status === 'done' }],
        comments: [], activity: [], createdAt, updatedAt,
      }
      await client.query(
        `INSERT INTO tasks (
           id, title, status, priority, category, assigned_agent, created_at, updated_at,
           payload, payload_hash, source, board_id
         ) VALUES ($1, $2, $3, $4, 'operations', NULL, $5::timestamptz, $6::timestamptz,
           $7::jsonb, $8, 'demo', $9::uuid)`,
        [id, title, status, priority, createdAt, updatedAt, JSON.stringify(payload), digest(payload), BOARD_ID],
      )
    }

    const documents = [
      ['demo-weekly-brief', 'Weekly Pipeline Brief', 'pipeline-brief', 'A concise view of revenue movement, aging opportunities, and recommended follow-ups across the synthetic 90-day history.'],
      ['demo-account-plan', 'Acorn Ridge Account Plan', 'account-plan', 'Stakeholders, products, recent interactions, commercial goals, and the next decision for Acorn Ridge Retail.'],
      ['demo-finance-review', 'Monthly Finance Review', 'finance-review', 'Revenue, receivables, expenses, invoice aging, and reconciliation notes generated from synthetic QuickBooks records.'],
    ]
    for (const [sourceKey, title, category, content] of documents) {
      await client.query(
        `INSERT INTO app_documents (
           owner_email, source_key, source, kind, status, title, slug, category,
           content, excerpt, tags, content_hash, board_id, pipeline_id,
           workspace_organization_id, generated_at, created_at, updated_at
         ) VALUES ($1, $2, 'system', 'report', 'generated', $3, $2, $4,
           $5, $6, ARRAY['demo','synthetic'], $7, $8::uuid, $9::uuid,
           $10::uuid, $11::timestamptz, $11::timestamptz, $11::timestamptz)`,
        [DEMO_EMAIL, sourceKey, title, category, content, content.slice(0, 160), digest(content),
          BOARD_ID, PIPELINE_ID, ROOT_ORGANIZATION_ID, dataset.generatedAt],
      )
    }

    await client.query(
      `INSERT INTO organization_quickbooks_connections (
         organization_id, credential_owner_email, maton_connection_id, company_name, country,
         company_profile, status, catalog_sync_enabled, verified_at, created_by, updated_by,
         write_mode, crm_pipeline_id, crm_customer_sync_enabled, crm_product_sync_enabled,
         last_catalog_synced_at, last_crm_synced_at, created_at, updated_at
       ) VALUES (
         $1::uuid, $2, 'demo-synthetic-no-provider', 'ClawPilot Demo Company', 'US',
         $3::jsonb, 'active', false, $4::timestamptz, $2, $2, 'disabled', $5::uuid,
         true, true, $4::timestamptz, $4::timestamptz, $4::timestamptz, $4::timestamptz
       )`,
      [ROOT_ORGANIZATION_ID, DEMO_EMAIL, JSON.stringify({
        legalName: 'ClawPilot Demo Company LLC',
        email: 'finance@demo.clawpilot.example',
        phone: '+1-202-555-0199',
        address: { lines: ['100 Demo Avenue'], city: 'Boston', region: 'MA', postalCode: '02110', country: 'US' },
        synthetic: true,
      }), dataset.generatedAt, PIPELINE_ID],
    )
    for (const account of dataset.accounts) {
      await client.query(
        `INSERT INTO quickbooks_accounts (
           organization_id, quickbooks_account_id, name, fully_qualified_name, classification,
           account_type, current_balance, active, source_payload, synced_at
         ) VALUES ($1::uuid, $2, $3, $3, $4, $5, $6, true, $7::jsonb, $8::timestamptz)`,
        [ROOT_ORGANIZATION_ID, account.id, account.name, account.classification, account.type,
          account.balance, JSON.stringify({ Id: account.id, Name: account.name, synthetic: true }), dataset.generatedAt],
      )
    }
    for (const product of dataset.products) {
      await client.query(
        `INSERT INTO quickbooks_items (
           organization_id, quickbooks_item_id, name, fully_qualified_name, item_type, sku,
           description, unit_price, purchase_cost, active, taxable, source_payload, synced_at
         ) VALUES ($1::uuid, $2, $3, $3, $4, $5,
           'Synthetic product or service used by the demo account.', $6, $7, true, false, $8::jsonb, $9::timestamptz)`,
        [ROOT_ORGANIZATION_ID, product.providerId, product.name, product.type, product.sku,
          product.price, product.cost, JSON.stringify({ Id: product.providerId, Name: product.name, Type: product.type, synthetic: true }), dataset.generatedAt],
      )
      await client.query(
        `INSERT INTO quickbooks_crm_links (
           organization_id, pipeline_id, provider_entity_type, provider_entity_id,
           crm_entity_type, crm_record_id, source_hash, synced_at, created_at, updated_at
         ) VALUES ($1::uuid, $2::uuid, 'item', $3, 'product', $4::uuid, $5, $6::timestamptz, $6::timestamptz, $6::timestamptz)`,
        [ROOT_ORGANIZATION_ID, PIPELINE_ID, product.providerId, productIds.get(product.providerId),
          digest(product), dataset.generatedAt],
      )
    }
    for (const organization of dataset.organizations) {
      const person = dataset.people.find((item) => item.organizationProviderId === organization.providerId)
      const sourcePayload = {
        Id: organization.providerId,
        DisplayName: person?.fullName || organization.name,
        CompanyName: organization.name,
        GivenName: person?.fullName.split(' ')[0] || '',
        FamilyName: person?.fullName.split(' ').slice(1).join(' ') || '',
        PrimaryEmailAddr: { Address: person?.email || organization.email },
        PrimaryPhone: { FreeFormNumber: organization.phone },
        synthetic: true,
      }
      await client.query(
        `INSERT INTO quickbooks_customers (
           organization_id, quickbooks_customer_id, display_name, company_name, email, phone,
           currency_code, balance, active, source_payload, synced_at
         ) VALUES ($1::uuid, $2, $3, $4, $5, $6, 'USD', $7, true, $8::jsonb, $9::timestamptz)`,
        [ROOT_ORGANIZATION_ID, organization.providerId, person?.fullName || organization.name,
          organization.name, person?.email || organization.email, organization.phone,
          dataset.invoices.filter((invoice) => invoice.organizationProviderId === organization.providerId)
            .reduce((sum, invoice) => sum + Number(invoice.balance), 0),
          JSON.stringify(sourcePayload), dataset.generatedAt],
      )
      await client.query(
        `INSERT INTO quickbooks_crm_links (
           organization_id, pipeline_id, provider_entity_type, provider_entity_id,
           crm_entity_type, crm_record_id, source_hash, synced_at, created_at, updated_at
         ) VALUES ($1::uuid, $2::uuid, 'customer', $3, 'organization', $4::uuid, $5, $6::timestamptz, $6::timestamptz, $6::timestamptz)`,
        [ROOT_ORGANIZATION_ID, PIPELINE_ID, organization.providerId, organizationIds.get(organization.providerId),
          digest(sourcePayload), dataset.generatedAt],
      )
      if (person) {
        await client.query(
          `INSERT INTO quickbooks_crm_links (
             organization_id, pipeline_id, provider_entity_type, provider_entity_id,
             crm_entity_type, crm_record_id, source_hash, synced_at, created_at, updated_at
           ) VALUES ($1::uuid, $2::uuid, 'customer', $3, 'contact', $4::uuid, $5, $6::timestamptz, $6::timestamptz, $6::timestamptz)`,
          [ROOT_ORGANIZATION_ID, PIPELINE_ID, organization.providerId, contactIds.get(person.email),
            digest(sourcePayload), dataset.generatedAt],
        )
      }
    }
    for (const vendor of dataset.vendors) {
      await client.query(
        `INSERT INTO quickbooks_vendors (
           organization_id, quickbooks_vendor_id, display_name, company_name, email,
           currency_code, balance, active, source_payload, synced_at
         ) VALUES ($1::uuid, $2, $3, $3, $4, 'USD', $5, true, $6::jsonb, $7::timestamptz)`,
        [ROOT_ORGANIZATION_ID, vendor.id, vendor.name, vendor.email, vendor.balance,
          JSON.stringify({ Id: vendor.id, DisplayName: vendor.name, synthetic: true }), dataset.generatedAt],
      )
    }
    for (const invoice of dataset.invoices) {
      const customer = dataset.organizations.find((item) => item.providerId === invoice.organizationProviderId)
      const subtotal = invoice.lines.reduce((sum, line) => sum + Number(line.item.price) * line.quantity, 0)
      const tax = invoice.total - subtotal
      const sourcePayload = {
        Id: invoice.providerId,
        DocNumber: invoice.documentNumber,
        TxnDate: invoice.transactionDate,
        DueDate: invoice.dueDate,
        CustomerRef: { value: invoice.organizationProviderId, name: invoice.partyName },
        BillEmail: { Address: customer?.email },
        BillAddr: { Line1: '100 Demo Avenue', City: customer?.city, CountrySubDivisionCode: customer?.state, PostalCode: '00000' },
        CurrencyRef: { value: 'USD' },
        TotalAmt: invoice.total,
        Balance: invoice.balance,
        TxnTaxDetail: { TotalTax: tax },
        CustomerMemo: { value: invoice.memo },
        Line: invoice.lines.map((line, index) => ({
          Id: String(index + 1),
          DetailType: 'SalesItemLineDetail',
          Description: line.item.name,
          Amount: Number(line.item.price) * line.quantity,
          SalesItemLineDetail: {
            ItemRef: { value: line.item.providerId, name: line.item.name },
            Qty: line.quantity,
            UnitPrice: line.item.price,
          },
        })),
        synthetic: true,
      }
      await client.query(
        `INSERT INTO quickbooks_transactions (
           organization_id, entity_type, quickbooks_transaction_id, document_number,
           transaction_date, due_date, party_id, party_name, currency_code,
           total_amount, open_balance, transaction_status, email_status, memo,
           source_payload, synced_at
         ) VALUES ($1::uuid, 'Invoice', $2, $3, $4::date, $5::date, $6, $7, 'USD',
           $8, $9, $10, 'EmailSent', $11, $12::jsonb, $13::timestamptz)`,
        [ROOT_ORGANIZATION_ID, invoice.providerId, invoice.documentNumber,
          invoice.transactionDate, invoice.dueDate, invoice.organizationProviderId, invoice.partyName,
          invoice.total, invoice.balance, invoice.status, invoice.memo, JSON.stringify(sourcePayload), dataset.generatedAt],
      )
    }

    for (let monthOffset = 0; monthOffset < 12; monthOffset += 1) {
      const date = new Date(`${dataset.anchorDate}T12:00:00.000Z`)
      date.setUTCMonth(date.getUTCMonth() - monthOffset)
      date.setUTCDate(10)
      const amount = 24000 + ((11 - monthOffset) * 1750)
      await client.query(
        `INSERT INTO quickbooks_transactions (
           organization_id, entity_type, quickbooks_transaction_id, document_number,
           transaction_date, account_id, account_name, currency_code, total_amount,
           open_balance, transaction_status, memo, source_payload, synced_at
         ) VALUES ($1::uuid, 'Deposit', $2, $3, $4::date, '1000', 'Operating Checking',
           'USD', $5, 0, 'Posted', 'Synthetic monthly sales deposit', $6::jsonb, $7::timestamptz)`,
        [ROOT_ORGANIZATION_ID, `qb-deposit-${monthOffset + 1}`, `DEP-${monthOffset + 1}`,
          date.toISOString().slice(0, 10), amount,
          JSON.stringify({ synthetic: true, monthOffset }), dataset.generatedAt],
      )
    }

    const reportRows = [
      { kind: 'section', label: 'Income', values: [] },
      { kind: 'data', label: 'Service Revenue', values: ['318400.00'] },
      { kind: 'data', label: 'Implementation Revenue', values: ['126800.00'] },
      { kind: 'summary', label: 'Total Income', values: ['445200.00'] },
      { kind: 'section', label: 'Expenses', values: [] },
      { kind: 'data', label: 'Cost of Services', values: ['103200.00'] },
      { kind: 'data', label: 'Operating Expenses', values: ['46000.00'] },
      { kind: 'summary', label: 'Net Operating Income', values: ['296000.00'] },
    ]
    for (const [reportKey, periodKey, reportName, startOffset] of [
      ['profit_loss', 'six_months', 'Profit and Loss', 182],
      ['profit_loss', 'ytd', 'Profit and Loss', 365],
      ['balance_sheet', 'as_of_today', 'Balance Sheet', 0],
      ['cash_flow', 'six_months', 'Statement of Cash Flows', 182],
      ['ar_aging', 'as_of_today', 'Accounts Receivable Aging', 0],
    ]) {
      await client.query(
        `INSERT INTO quickbooks_financial_reports (
           organization_id, report_key, period_key, report_name, report_basis,
           start_period, end_period, currency_code, generated_at, columns_payload,
           rows_payload, report_options, status, last_attempted_at, synced_at
         ) VALUES ($1::uuid, $2, $3, $4, 'Accrual', $5::date, $6::date, 'USD',
           $7::timestamptz, $8::jsonb, $9::jsonb, $10::jsonb, 'ready', $7::timestamptz, $7::timestamptz)`,
        [ROOT_ORGANIZATION_ID, reportKey, periodKey, reportName,
          startOffset ? isoDaysAgo(startOffset).slice(0, 10) : dataset.anchorDate,
          dataset.anchorDate, dataset.generatedAt,
          JSON.stringify([{ title: 'Account', type: 'Account' }, { title: 'Total', type: 'Money' }]),
          JSON.stringify(reportRows), JSON.stringify({ synthetic: true, anchorDate: dataset.anchorDate })],
      )
    }
    await client.query(
      `INSERT INTO quickbooks_sync_outbox (
         organization_id, sync_kind, status, result_summary, requested_by,
         created_at, updated_at, completed_at
       ) VALUES ($1::uuid, 'catalog', 'succeeded', $2::jsonb, $3,
         $4::timestamptz, $4::timestamptz, $4::timestamptz)`,
      [ROOT_ORGANIZATION_ID, JSON.stringify({
        accounts: dataset.accounts.length,
        items: dataset.products.length,
        customers: dataset.organizations.length,
        vendors: dataset.vendors.length,
        transactions: dataset.invoices.length + 12,
        reportsReady: 5,
        synthetic: true,
      }), DEMO_EMAIL, dataset.generatedAt],
    )

    await client.query(
      `INSERT INTO project_board_members (
         board_id, user_email, access_role, shared_by, created_at, updated_at
       )
       SELECT $1::uuid, membership.user_email,
         CASE WHEN membership.user_email = $2 THEN 'editor' ELSE 'viewer' END,
         $2, $3::timestamptz, $3::timestamptz
       FROM app_user_organization_memberships membership
       WHERE membership.organization_id = $4::uuid
         AND membership.status = 'active'
       ON CONFLICT (board_id, user_email) DO UPDATE SET
         access_role = EXCLUDED.access_role,
         shared_by = EXCLUDED.shared_by,
         updated_at = EXCLUDED.updated_at`,
      [BOARD_ID, DEMO_EMAIL, dataset.generatedAt, ROOT_ORGANIZATION_ID],
    )
    await client.query(
      `INSERT INTO pipeline_space_members (
         pipeline_id, user_email, access_role, shared_by, created_at, updated_at
       )
       SELECT $1::uuid, membership.user_email,
         CASE WHEN membership.user_email = $2 THEN 'editor' ELSE 'viewer' END,
         $2, $3::timestamptz, $3::timestamptz
       FROM app_user_organization_memberships membership
       WHERE membership.organization_id = $4::uuid
         AND membership.status = 'active'
       ON CONFLICT (pipeline_id, user_email) DO UPDATE SET
         access_role = EXCLUDED.access_role,
         shared_by = EXCLUDED.shared_by,
         updated_at = EXCLUDED.updated_at`,
      [PIPELINE_ID, DEMO_EMAIL, dataset.generatedAt, ROOT_ORGANIZATION_ID],
    )
    await client.query(
      `INSERT INTO app_user_workspace_preferences (
         user_email, workspace_organization_id, default_board_id, default_pipeline_id,
         created_at, updated_at
       )
       SELECT membership.user_email, $1::uuid, $2::uuid, $3::uuid,
         $4::timestamptz, $4::timestamptz
       FROM app_user_organization_memberships membership
       WHERE membership.organization_id = $1::uuid
         AND membership.status = 'active'
       ON CONFLICT (user_email, workspace_organization_id) DO UPDATE SET
         default_board_id = EXCLUDED.default_board_id,
         default_pipeline_id = EXCLUDED.default_pipeline_id,
         updated_at = EXCLUDED.updated_at`,
      [ROOT_ORGANIZATION_ID, BOARD_ID, PIPELINE_ID, dataset.generatedAt],
    )

    await client.query(
      `INSERT INTO demo_dataset_metadata (
         dataset_key, dataset_version, anchor_date, recent_window_days,
         context_window_days, generated_at, summary
       ) VALUES ('workspace-demo', $1, $2::date, 30, 90, $3::timestamptz, $4::jsonb)`,
      [dataset.version, dataset.anchorDate, dataset.generatedAt, JSON.stringify({
        synthetic: true,
        donorShape: ['relationship-sales', 'operating-finance'],
        windows: dataset.windows,
        organizations: dataset.organizations.length,
        contacts: dataset.people.length,
        opportunities: dataset.opportunities.length,
        interactions: dataset.interactions.length,
        invoices: dataset.invoices.length,
      })],
    )
    await client.query('COMMIT')
    console.log(JSON.stringify({
      ok: true,
      environment: environment || 'local',
      anchorDate: dataset.anchorDate,
      organizations: dataset.organizations.length + 1,
      contacts: dataset.people.length,
      opportunities: dataset.opportunities.length,
      interactions: dataset.interactions.length,
      invoices: dataset.invoices.length,
      products: dataset.products.length,
    }))
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    await client.query(`SELECT pg_advisory_unlock(hashtext('clawpilot-demo-account-seed'))`).catch(() => undefined)
    client.release()
    await pool.end()
  }
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)))
