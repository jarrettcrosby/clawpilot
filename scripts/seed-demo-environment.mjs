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
const TOAST_RESTAURANT_GUID = '90000000-0000-4000-8000-000000000001'
const TOAST_MENU_GUID = '91000000-0000-4000-8000-000000000001'
const TOAST_TAX_GUID = '93000000-0000-4000-8000-000000000001'
const TOAST_DISCOUNT_GUID = '93000000-0000-4000-8000-000000000002'

const DEMO_MENU = [
  { id: '94000000-0000-4000-8000-000000000001', name: 'Harbor melt', groupId: '92000000-0000-4000-8000-000000000001', group: 'Sandwiches', categoryId: '93000000-0000-4000-8000-000000000011', price: 15 },
  { id: '94000000-0000-4000-8000-000000000002', name: 'Garden wrap', groupId: '92000000-0000-4000-8000-000000000001', group: 'Sandwiches', categoryId: '93000000-0000-4000-8000-000000000011', price: 13.5 },
  { id: '94000000-0000-4000-8000-000000000003', name: 'Market fries', groupId: '92000000-0000-4000-8000-000000000002', group: 'Sides', categoryId: '93000000-0000-4000-8000-000000000012', price: 6 },
  { id: '94000000-0000-4000-8000-000000000004', name: 'Cold brew', groupId: '92000000-0000-4000-8000-000000000003', group: 'Drinks', categoryId: '93000000-0000-4000-8000-000000000013', price: 5.5 },
  { id: '94000000-0000-4000-8000-000000000005', name: 'Seasonal bowl', groupId: '92000000-0000-4000-8000-000000000004', group: 'Bowls', categoryId: '93000000-0000-4000-8000-000000000014', price: 17 },
]

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
      `DELETE FROM pos_accounting_catalog_mappings WHERE organization_id = $1::uuid`,
      [ROOT_ORGANIZATION_ID],
    )
    await client.query(
      `DELETE FROM pos_accounting_profiles WHERE organization_id = $1::uuid`,
      [ROOT_ORGANIZATION_ID],
    )
    await client.query(
      `DELETE FROM organization_quickbooks_connections WHERE organization_id = $1::uuid`,
      [ROOT_ORGANIZATION_ID],
    )
    await client.query(
      `DELETE FROM toast_locations WHERE organization_id = $1::uuid`,
      [ROOT_ORGANIZATION_ID],
    )
    await client.query(
      `DELETE FROM sync_outbox
       WHERE target_system = 'suitecrm'
         AND payload->>'pipelineId' IN (
           SELECT id::text
           FROM pipeline_spaces
           WHERE workspace_organization_id = $1::uuid
         )`,
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
      `INSERT INTO toast_locations (
         organization_id, restaurant_guid, restaurant_name, location_name, location_code,
         timezone, active, test_mode, archived, analytics_access, standard_access,
         selected, last_verified_at, created_at, updated_at
       ) VALUES (
         $1::uuid, $2::uuid, 'Harbor Street Kitchen', 'Mobile kitchen', 'DEMO-TRUCK-01',
         'America/New_York', true, true, false, false, true, true,
         $3::timestamptz, $3::timestamptz, $3::timestamptz
       )`,
      [ROOT_ORGANIZATION_ID, TOAST_RESTAURANT_GUID, dataset.generatedAt],
    )
    await client.query(
      `INSERT INTO toast_menu_catalog_restaurants (
         organization_id, restaurant_guid, provider_restaurant_id, name, timezone,
         source_revision, synced_at, created_at, updated_at
       ) VALUES ($1::uuid, $2::uuid, $2::text, 'Harbor Street Kitchen', 'America/New_York',
         $3::timestamptz, $3::timestamptz, $3::timestamptz, $3::timestamptz)`,
      [ROOT_ORGANIZATION_ID, TOAST_RESTAURANT_GUID, dataset.generatedAt],
    )
    await client.query(
      `INSERT INTO toast_menu_catalog_menus (
         organization_id, restaurant_guid, menu_guid, provider_menu_id, name, visibility,
         position, source_revision, synced_at, created_at, updated_at
       ) VALUES ($1::uuid, $2::uuid, $3::uuid, $3::text, 'Harbor Street menu',
         ARRAY['POS','ONLINE']::text[], 0, $4::timestamptz, $4::timestamptz,
         $4::timestamptz, $4::timestamptz)`,
      [ROOT_ORGANIZATION_ID, TOAST_RESTAURANT_GUID, TOAST_MENU_GUID, dataset.generatedAt],
    )
    const menuGroups = [...new Map(DEMO_MENU.map((item) => [item.groupId, item])).values()]
    for (const [position, group] of menuGroups.entries()) {
      await client.query(
        `INSERT INTO toast_menu_catalog_groups (
           organization_id, restaurant_guid, menu_guid, group_guid, provider_group_id,
           name, visibility, position, source_revision, synced_at, created_at, updated_at
         ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $4::text, $5,
           ARRAY['POS','ONLINE']::text[], $6, $7::timestamptz, $7::timestamptz,
           $7::timestamptz, $7::timestamptz)`,
        [ROOT_ORGANIZATION_ID, TOAST_RESTAURANT_GUID, TOAST_MENU_GUID,
          group.groupId, group.group, position, dataset.generatedAt],
      )
      await client.query(
        `INSERT INTO toast_menu_catalog_sales_categories (
           organization_id, restaurant_guid, sales_category_guid,
           provider_sales_category_id, name, source_revision, synced_at, created_at, updated_at
         ) VALUES ($1::uuid, $2::uuid, $3::uuid, $3::text, $4,
           $5::timestamptz, $5::timestamptz, $5::timestamptz, $5::timestamptz)`,
        [ROOT_ORGANIZATION_ID, TOAST_RESTAURANT_GUID, group.categoryId,
          group.group, dataset.generatedAt],
      )
    }
    for (const [position, item] of DEMO_MENU.entries()) {
      await client.query(
        `INSERT INTO toast_menu_catalog_items (
           organization_id, restaurant_guid, menu_guid, group_guid, item_guid,
           provider_item_id, name, price, visibility, sales_category_guid,
           provider_sales_category_id, position, source_revision, synced_at, created_at, updated_at
         ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $5::text,
           $6, $7, ARRAY['POS','ONLINE']::text[], $8::uuid, $8::text, $9,
           $10::timestamptz, $10::timestamptz, $10::timestamptz, $10::timestamptz)`,
        [ROOT_ORGANIZATION_ID, TOAST_RESTAURANT_GUID, TOAST_MENU_GUID,
          item.groupId, item.id, item.name, item.price, item.categoryId, position, dataset.generatedAt],
      )
    }
    await client.query(
      `INSERT INTO toast_menu_catalog_sync_status (
         organization_id, restaurant_guid, provider_restaurant_id, source_revision,
         observed_source_revision, status, menu_count, group_count, item_count,
         sales_category_count, last_checked_at, last_synced_at, created_at, updated_at
       ) VALUES ($1::uuid, $2::uuid, $2::text, $3::timestamptz, $3::timestamptz,
         'ready', 1, $4, $5, $4, $3::timestamptz, $3::timestamptz,
         $3::timestamptz, $3::timestamptz)`,
      [ROOT_ORGANIZATION_ID, TOAST_RESTAURANT_GUID, dataset.generatedAt,
        menuGroups.length, DEMO_MENU.length],
    )
    for (let day = 0; day < 30; day += 1) {
      const businessDate = isoDaysAgo(day, 12).slice(0, 10)
      const orderCount = 6 + (day % 5)
      const daily = {
        gross: 0, net: 0, discounts: 0, tax: 0, tips: 0,
        service: 0, tendered: 0, total: 0, cash: 0, card: 0,
      }
      for (let orderIndex = 0; orderIndex < orderCount; orderIndex += 1) {
        const sequence = day * 20 + orderIndex + 1
        const gross = Number((12.5 + ((sequence * 137) % 2400) / 100).toFixed(2))
        const discount = orderIndex % 4 === 0 ? Number((gross * 0.1).toFixed(2)) : 0
        const net = Number((gross - discount).toFixed(2))
        const tax = Number((net * 0.0625).toFixed(2))
        const tip = orderIndex % 3 === 0 ? Number((net * 0.15).toFixed(2)) : 0
        const tendered = Number((net + tax).toFixed(2))
        const total = Number((tendered + tip).toFixed(2))
        const cash = orderIndex % 5 === 0 ? tendered : 0
        const card = cash ? 0 : tendered
        daily.gross += gross
        daily.net += net
        daily.discounts += discount
        daily.tax += tax
        daily.tips += tip
        daily.tendered += tendered
        daily.total += total
        daily.cash += cash
        daily.card += card
        const orderGuid = `demo-pos-${businessDate}-${String(orderIndex + 1).padStart(3, '0')}`
        const openedAt = isoDaysAgo(day, 11 + (orderIndex % 7))
        const selectedItem = DEMO_MENU[sequence % DEMO_MENU.length]
        const processingFee = cash ? null : Number((tendered * 0.029 + 0.15).toFixed(2))
        const details = {
          synthetic: true,
          checks: [{
            displayNumber: String(1000 + sequence),
            paymentStatus: 'PAID',
            amount: net,
            tax,
            total,
            serviceCharges: 0,
            selections: [{
              itemGuid: selectedItem.id,
              providerGuid: selectedItem.id,
              itemName: selectedItem.name,
              name: selectedItem.name,
              groupGuid: selectedItem.groupId,
              groupName: selectedItem.group,
              quantity: 1,
              gross,
              net,
              tax,
              voided: false,
              modifiers: [],
              discounts: discount ? [{
                providerGuid: TOAST_DISCOUNT_GUID,
                name: 'Demo discount',
                amount: discount,
              }] : [],
              taxes: [{
                providerGuid: TOAST_TAX_GUID,
                name: 'Sales tax',
                amount: tax,
              }],
            }],
            payments: [{
              type: cash ? 'CASH' : 'CREDIT',
              cardBrand: cash ? null : ['VISA', 'MASTERCARD', 'AMEX'][sequence % 3],
              status: 'CAPTURED',
              amount: tendered,
              tip,
              processingFee,
              refunded: false,
            }],
          }],
        }
        await client.query(
          `INSERT INTO toast_pos_orders (
             organization_id, restaurant_guid, order_guid, business_date, display_number,
             source, dining_option, approval_status, payment_status, opened_at, closed_at, paid_at,
             guest_count, check_count, item_count, gross_sales, net_sales, discounts, tax,
             service_charges, tips, refunds, tendered, total, cash_tender, card_tender,
             other_tender, voided, deleted, details, payload_hash, created_at, updated_at
           ) VALUES (
             $1::uuid, $2::uuid, $3, $4::date, $5, 'Demo counter', 'TAKE_OUT', 'APPROVED',
             'PAID', $6::timestamptz, $6::timestamptz, $6::timestamptz,
             1, 1, 1, $7, $8, $9, $10, 0, $11, 0, $12, $13, $14, $15,
             0, false, false, $16::jsonb, $17, $6::timestamptz, $6::timestamptz
           )`,
          [ROOT_ORGANIZATION_ID, TOAST_RESTAURANT_GUID, orderGuid, businessDate,
            String(1000 + sequence), openedAt, gross, net, discount, tax, tip,
            tendered, total, cash, card, JSON.stringify(details), digest(details)],
        )
      }
      for (const key of Object.keys(daily)) daily[key] = Number(daily[key].toFixed(2))
      await client.query(
        `INSERT INTO toast_daily_sales (
           organization_id, restaurant_guid, business_date, standard_orders_count,
           standard_gross_sales, standard_net_sales, standard_discounts, standard_voids,
           standard_refunds, standard_tax, standard_tips, standard_service_charges,
           standard_tendered, standard_total, standard_cash, standard_card,
           standard_other_tender, source_revision, updated_at
         ) VALUES (
           $1::uuid, $2::uuid, $3::date, $4, $5, $6, $7, 0, 0, $8, $9, 0,
           $10, $11, $12, $13, 0, 1, $14::timestamptz
         )`,
        [ROOT_ORGANIZATION_ID, TOAST_RESTAURANT_GUID, businessDate, orderCount,
          daily.gross, daily.net, daily.discounts, daily.tax, daily.tips,
          daily.tendered, daily.total, daily.cash, daily.card, dataset.generatedAt],
      )
      const sourceSummary = {
        synthetic: true,
        standardOrders: orderCount,
        standard: {
          grossSales: daily.gross, netSales: daily.net, discounts: daily.discounts,
          tax: daily.tax, tips: daily.tips, tendered: daily.tendered, total: daily.total,
          cash: daily.cash, card: daily.card, otherTender: 0,
        },
      }
      await client.query(
        `INSERT INTO toast_accounting_export_drafts (
           organization_id, restaurant_guid, business_date, idempotency_key, status,
           reconciliation_status, source_summary, proposed_lines, created_at, updated_at
         ) VALUES (
           $1::uuid, $2::uuid, $3::date, $4, 'needs_review', 'ready',
           $5::jsonb, '[]'::jsonb, $6::timestamptz, $6::timestamptz
         )`,
        [ROOT_ORGANIZATION_ID, TOAST_RESTAURANT_GUID, businessDate,
          digest(`demo-pos-draft:${businessDate}`), JSON.stringify(sourceSummary), dataset.generatedAt],
      )
    }

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
    const posAccounts = [
      ['qb-pos-account-clearing', 'POS Clearing', 'Asset', 'Bank'],
      ['qb-pos-account-cash', 'Cash on Hand', 'Asset', 'Bank'],
      ['qb-pos-account-tips', 'Tips Payable', 'Liability', 'Other Current Liability'],
      ['qb-pos-account-fees', 'Merchant Processing Fees', 'Expense', 'Expense'],
    ]
    for (const [id, name, classification, accountType] of posAccounts) {
      await client.query(
        `INSERT INTO quickbooks_accounts (
           organization_id, quickbooks_account_id, name, fully_qualified_name, classification,
           account_type, current_balance, active, source_payload, synced_at
         ) VALUES ($1::uuid, $2, $3, $3, $4, $5, 0, true, $6::jsonb, $7::timestamptz)`,
        [ROOT_ORGANIZATION_ID, id, name, classification, accountType,
          JSON.stringify({ Id: id, Name: name, synthetic: true }), dataset.generatedAt],
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
    const posItems = [
      ...DEMO_MENU.map((item) => ({ id: `qb-pos-item-${item.id.slice(-3)}`, name: item.name, price: item.price })),
      { id: 'qb-pos-item-discount', name: 'POS Discounts', price: 0 },
    ]
    for (const item of posItems) {
      await client.query(
        `INSERT INTO quickbooks_items (
           organization_id, quickbooks_item_id, name, fully_qualified_name, item_type,
           description, unit_price, purchase_cost, active, taxable, source_payload, synced_at
         ) VALUES ($1::uuid, $2, $3, $3, 'NonInventory',
           'Synthetic Toast posting target used by the demo account.', $4, 0, true, true,
           $5::jsonb, $6::timestamptz)`,
        [ROOT_ORGANIZATION_ID, item.id, item.name, item.price,
          JSON.stringify({ Id: item.id, Name: item.name, Type: 'NonInventory', synthetic: true }),
          dataset.generatedAt],
      )
    }
    await client.query(
      `INSERT INTO quickbooks_tax_codes (
         organization_id, quickbooks_tax_code_id, name, description, taxable,
         active, source_payload, synced_at
       ) VALUES ($1::uuid, 'qb-tax-sales', 'Demo sales tax',
         'Synthetic taxable sales code', true, true, $2::jsonb, $3::timestamptz)`,
      [ROOT_ORGANIZATION_ID, JSON.stringify({ Id: 'qb-tax-sales', Name: 'Demo sales tax', Taxable: true, synthetic: true }), dataset.generatedAt],
    )
    await client.query(
      `INSERT INTO quickbooks_classes (
         organization_id, quickbooks_class_id, name, fully_qualified_name,
         active, source_payload, synced_at
       ) VALUES ($1::uuid, 'qb-class-food-truck', 'Food truck', 'Food truck',
         true, $2::jsonb, $3::timestamptz)`,
      [ROOT_ORGANIZATION_ID, JSON.stringify({ Id: 'qb-class-food-truck', Name: 'Food truck', synthetic: true }), dataset.generatedAt],
    )
    await client.query(
      `INSERT INTO quickbooks_departments (
         organization_id, quickbooks_department_id, name, fully_qualified_name,
         active, source_payload, synced_at
       ) VALUES ($1::uuid, 'qb-department-mobile-kitchen', 'Mobile kitchen', 'Mobile kitchen',
         true, $2::jsonb, $3::timestamptz)`,
      [ROOT_ORGANIZATION_ID, JSON.stringify({ Id: 'qb-department-mobile-kitchen', Name: 'Mobile kitchen', synthetic: true }), dataset.generatedAt],
    )
    await client.query(
      `INSERT INTO pos_accounting_profiles (
         organization_id, restaurant_guid, profile_revision, schema_version, effective_from,
         quickbooks_binding_status, quickbooks_connection_fingerprint, quickbooks_company_name,
         quickbooks_connection_verified_at, quickbooks_catalog_synced_at, posting_method,
         quickbooks_class_id, quickbooks_class_name, quickbooks_department_id,
         quickbooks_department_name, quickbooks_clearing_account_id,
         quickbooks_clearing_account_name, track_sales_tax, breakout_dimensions,
         memo_mode, custom_transaction_number, transaction_number_suffix,
         suppress_zero_over_short, auto_payout_tips, deposit_checks_with_cash,
         open_check_policy, batch_hold_policy,
         email_notifications_enabled, email_notifications_enabled_at, created_by, created_at
       ) VALUES (
         $1::uuid, NULL, 1, 1, $2::timestamptz, 'verified', $3,
         'ClawPilot Demo Company', $2::timestamptz, $2::timestamptz,
         'itemized_sales_receipt', 'qb-class-food-truck', 'Food truck',
         'qb-department-mobile-kitchen', 'Mobile kitchen', 'qb-pos-account-clearing',
         'POS Clearing', true, ARRAY['order_source','payment_type']::text[],
         'pos_date', true, 'POS', true, false, false, 'hold', 'hold_until_settled',
         false, NULL, $4, $2::timestamptz
       )`,
      [ROOT_ORGANIZATION_ID, dataset.generatedAt, digest('demo-synthetic-no-provider'), DEMO_EMAIL],
    )
    const mappingRevision = new Date(dataset.generatedAt).getTime()
    const mappings = [
      ...DEMO_MENU.map((item) => ['sales_item', item.id, item.name, 'item', `qb-pos-item-${item.id.slice(-3)}`, item.name]),
      ['discount', TOAST_DISCOUNT_GUID, 'Demo discount', 'item', 'qb-pos-item-discount', 'POS Discounts'],
      ['tax', TOAST_TAX_GUID, 'Sales tax', 'tax_code', 'qb-tax-sales', 'Demo sales tax'],
      ['service_charge', 'summary:tips', 'Credit tips', 'account', 'qb-pos-account-tips', 'Tips Payable'],
      ['fee', 'summary:processing_fees', 'Processing fees', 'account', 'qb-pos-account-fees', 'Merchant Processing Fees'],
      ['cash_drawer', 'summary:cash', 'Cash in drawer', 'account', 'qb-pos-account-cash', 'Cash on Hand'],
      ['card_brand', 'summary:card_settlement', 'Calculated card settlement', 'account', '1000', 'Operating Checking'],
    ]
    for (const [sourceKind, sourceId, sourceName, targetType, targetId, targetName] of mappings) {
      await client.query(
        `INSERT INTO pos_accounting_catalog_mappings (
           organization_id, restaurant_guid, source_kind, source_id, source_name,
           target_type, target_id, target_name, active, mapping_revision,
           effective_from, validation_status, source_catalog_revision,
           target_catalog_revision, last_validated_at, created_by, created_at
         ) VALUES ($1::uuid, NULL, $2, $3, $4, $5, $6, $7, true, 1,
           $8::timestamptz, 'valid', $9::bigint, $9::bigint,
           $8::timestamptz, $10, $8::timestamptz)`,
        [ROOT_ORGANIZATION_ID, sourceKind, sourceId, sourceName, targetType, targetId,
          targetName, dataset.generatedAt, mappingRevision, DEMO_EMAIL],
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
