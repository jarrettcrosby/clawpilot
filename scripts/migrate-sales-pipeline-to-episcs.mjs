#!/usr/bin/env node

import { createRequire } from 'node:module'

const requireFromApp = createRequire(new URL('../app_src/package.json', import.meta.url))
const { Pool } = requireFromApp('pg')

const SOURCE_WORKSPACE_NAME = 'Suburbia Sandwich Co'
const TARGET_WORKSPACE_NAME = 'Express Parcel International DBA EPISCS'
const SALES_PIPELINE_NAME = 'Sales pipeline'
const PLACEHOLDER_PIPELINE_NAME = 'My pipeline'
const CONFIRMATION = 'MOVE_SALES_PIPELINE_TO_EPISCS'
const LOCK_KEY = 'clawpilot:sales-pipeline-to-episcs:v1'
const MIGRATION_VERSION = 'v1'
const CONTACT_FINALIZATION_PHASE = 'root-contact-finalization'

function parseArgs(argv) {
  return {
    apply: argv.includes('--apply'),
    finalizeRootContacts: argv.includes('--finalize-root-contacts'),
    json: argv.includes('--json'),
  }
}

function clean(value) {
  return String(value ?? '').trim()
}

function nullable(value) {
  const normalized = clean(value)
  return normalized || null
}

function asNumber(value, fallback = 0) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function suiteCrmDateTime(value) {
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return null
  return parsed.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '')
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function single(rows, message) {
  if (rows.length !== 1) throw new Error(`${message}; found ${rows.length}`)
  return rows[0]
}

function unique(values) {
  return [...new Set(values.filter(Boolean))]
}

function recordIds(rows) {
  return rows.map((row) => row.id)
}

async function queryRows(client, text, values = []) {
  return (await client.query(text, values)).rows
}

async function tableCount(client, table, pipelineId) {
  const rows = await queryRows(
    client,
    `SELECT count(*)::integer AS count FROM ${table} WHERE pipeline_id = $1::uuid`,
    [pipelineId],
  )
  return rows[0]?.count || 0
}

async function crmCounts(client, pipelineId) {
  const organizations = await tableCount(client, 'crm_organizations', pipelineId)
  const contacts = await tableCount(client, 'crm_contacts', pipelineId)
  const opportunities = await tableCount(client, 'crm_opportunities', pipelineId)
  const interactions = await tableCount(client, 'crm_interactions', pipelineId)
  const meetings = await tableCount(client, 'crm_meetings', pipelineId)
  const leads = await tableCount(client, 'crm_leads', pipelineId)
  const campaigns = await tableCount(client, 'crm_campaigns', pipelineId)
  const products = await tableCount(client, 'crm_products', pipelineId)
  return { organizations, contacts, opportunities, interactions, meetings, leads, campaigns, products }
}

async function crmRecordIds(client, pipelineId) {
  return queryRows(
    client,
    `SELECT id::text FROM crm_organizations WHERE pipeline_id = $1::uuid
     UNION ALL SELECT id::text FROM crm_contacts WHERE pipeline_id = $1::uuid
     UNION ALL SELECT id::text FROM crm_opportunities WHERE pipeline_id = $1::uuid
     UNION ALL SELECT id::text FROM crm_interactions WHERE pipeline_id = $1::uuid
     UNION ALL SELECT id::text FROM crm_meetings WHERE pipeline_id = $1::uuid
     UNION ALL SELECT id::text FROM crm_leads WHERE pipeline_id = $1::uuid
     UNION ALL SELECT id::text FROM crm_campaigns WHERE pipeline_id = $1::uuid
     UNION ALL SELECT id::text FROM crm_products WHERE pipeline_id = $1::uuid`,
    [pipelineId],
  )
}

async function workspaceByName(client, name) {
  return single(
    await queryRows(
      client,
      `SELECT id::text, name, reference_code
       FROM workspace_organizations
       WHERE lower(btrim(name)) = lower($1)
       FOR UPDATE`,
      [name],
    ),
    `Workspace ${name} is ambiguous or missing`,
  )
}

async function pipelineByName(client, ownerEmail, name) {
  return single(
    await queryRows(
      client,
      `SELECT id::text, name, owner_email, workspace_organization_id::text,
         is_default, sheet_id, drive_folder_id, short_link_id::text,
         provisioning_status, sync_enabled
       FROM pipeline_spaces
       WHERE owner_email = $1 AND lower(btrim(name)) = lower($2)
       FOR UPDATE`,
      [ownerEmail, name],
    ),
    `Pipeline ${name} for ${ownerEmail} is ambiguous or missing`,
  )
}

async function placeholderPipeline(client, ownerEmail, salesPipelineId, sourceWorkspaceId, targetWorkspaceId) {
  return single(
    await queryRows(
      client,
      `SELECT id::text, name, owner_email, workspace_organization_id::text,
         is_default, sheet_id, drive_folder_id, short_link_id::text,
         provisioning_status, sync_enabled
       FROM pipeline_spaces
       WHERE owner_email = $1
         AND id <> $2::uuid
         AND lower(btrim(name)) = lower($3)
         AND workspace_organization_id = ANY($4::uuid[])
         AND sheet_id IS NULL
         AND drive_folder_id IS NULL
       FOR UPDATE`,
      [ownerEmail, salesPipelineId, PLACEHOLDER_PIPELINE_NAME, [sourceWorkspaceId, targetWorkspaceId]],
    ),
    `Unprovisioned ${PLACEHOLDER_PIPELINE_NAME} for ${ownerEmail} is ambiguous or missing`,
  )
}

async function rootOrganization(client, pipelineId, workspaceId) {
  return single(
    await queryRows(
      client,
      `SELECT *
       FROM crm_organizations
       WHERE pipeline_id = $1::uuid
         AND workspace_organization_id = $2::uuid
         AND relationship_type = 'workspace_root'
       FOR UPDATE`,
      [pipelineId, workspaceId],
    ),
    `Pipeline ${pipelineId} does not have one root CRM organization for workspace ${workspaceId}`,
  )
}

async function crmBoard(client, ownerEmail, workspaceId) {
  return single(
    await queryRows(
      client,
      `SELECT board.id::text, board.name, board.owner_email, board.workspace_organization_id::text,
         projection.pipeline_id::text,
         COALESCE(card_summary.card_count, 0)::integer AS card_count,
         COALESCE(card_summary.comment_count, 0)::integer AS comment_count
       FROM project_boards board
       JOIN crm_board_projections projection ON projection.board_id = board.id
       LEFT JOIN LATERAL (
         SELECT count(*) AS card_count,
           sum(jsonb_array_length(COALESCE(card.payload->'comments', '[]'::jsonb))) AS comment_count
         FROM crm_board_cards card
         WHERE card.board_id = board.id
       ) card_summary ON true
       WHERE board.owner_email = $1
         AND board.workspace_organization_id = $2::uuid
         AND lower(btrim(board.name)) = 'crm board'
       FOR UPDATE OF board, projection`,
      [ownerEmail, workspaceId],
    ),
    `CRM Board for ${ownerEmail} and workspace ${workspaceId} is ambiguous or missing`,
  )
}

async function nonOwnerBoardBindings(client, salesPipelineId, sourceWorkspaceId, ownerEmail) {
  const rows = await queryRows(
    client,
    `SELECT board.id::text AS board_id, board.owner_email,
       target.id::text AS target_pipeline_id,
       COALESCE(card_summary.comment_count, 0)::integer AS comment_count
     FROM crm_board_projections projection
     JOIN project_boards board ON board.id = projection.board_id
     LEFT JOIN LATERAL (
       SELECT pipeline.id
       FROM pipeline_spaces pipeline
       WHERE pipeline.owner_email = board.owner_email
         AND pipeline.workspace_organization_id = $2::uuid
         AND pipeline.id <> $1::uuid
       ORDER BY pipeline.is_default DESC, pipeline.created_at, pipeline.id
       LIMIT 1
     ) target ON true
     LEFT JOIN LATERAL (
       SELECT sum(jsonb_array_length(COALESCE(card.payload->'comments', '[]'::jsonb))) AS comment_count
       FROM crm_board_cards card
       WHERE card.board_id = board.id
     ) card_summary ON true
     WHERE projection.pipeline_id = $1::uuid
       AND board.workspace_organization_id = $2::uuid
       AND board.owner_email <> $3
     ORDER BY board.owner_email
     FOR UPDATE OF board, projection`,
    [salesPipelineId, sourceWorkspaceId, ownerEmail],
  )
  for (const row of rows) {
    assert(row.target_pipeline_id, `CRM Board owner ${row.owner_email} has no Suburbia pipeline to receive the board`)
    assert(row.comment_count === 0, `CRM Board owner ${row.owner_email} has comments that require manual migration`)
  }
  return rows
}

async function memberOrganizations(client, salesPipelineId) {
  const rows = await queryRows(
    client,
    `SELECT organization.id::text, organization.reference_code, organization.name,
       organization.workspace_organization_id::text,
       (SELECT count(*)::integer FROM crm_contacts record WHERE record.organization_id = organization.id) AS contacts,
       (SELECT count(*)::integer FROM crm_opportunities record WHERE record.organization_id = organization.id) AS opportunities,
       (SELECT count(*)::integer FROM crm_interactions record WHERE record.organization_id = organization.id) AS interactions,
       (SELECT count(*)::integer FROM crm_meetings record WHERE record.organization_id = organization.id) AS meetings,
       (SELECT count(*)::integer FROM crm_leads record WHERE record.organization_id = organization.id) AS leads
     FROM crm_organizations organization
     WHERE organization.pipeline_id = $1::uuid
       AND organization.relationship_type = 'workspace_member'
     ORDER BY organization.name
     FOR UPDATE`,
    [salesPipelineId],
  )
  for (const row of rows) {
    const dependent = row.contacts + row.opportunities + row.interactions + row.meetings + row.leads
    assert(dependent === 0, `Workspace member ${row.name} has ${dependent} dependent CRM records`)
  }
  return rows
}

async function readContext(client, actorEmail) {
  const sourceWorkspace = await workspaceByName(client, SOURCE_WORKSPACE_NAME)
  const targetWorkspace = await workspaceByName(client, TARGET_WORKSPACE_NAME)
  const salesPipeline = await pipelineByName(client, actorEmail, SALES_PIPELINE_NAME)
  const placeholder = await placeholderPipeline(
    client,
    actorEmail,
    salesPipeline.id,
    sourceWorkspace.id,
    targetWorkspace.id,
  )
  const initial = salesPipeline.workspace_organization_id === sourceWorkspace.id
    && placeholder.workspace_organization_id === targetWorkspace.id
  const complete = salesPipeline.workspace_organization_id === targetWorkspace.id
    && placeholder.workspace_organization_id === sourceWorkspace.id
  assert(initial || complete, 'Sales and placeholder pipelines are not in a recognized migration state')

  const membership = single(
    await queryRows(
      client,
      `SELECT user_email, role, status
       FROM app_user_organization_memberships
       WHERE user_email = $1 AND organization_id = $2::uuid
       FOR UPDATE`,
      [actorEmail, targetWorkspace.id],
    ),
    `${actorEmail} does not have one EPISCS membership`,
  )
  assert(membership.status === 'active', `${actorEmail} EPISCS membership is not active`)
  assert(['owner', 'admin'].includes(membership.role), `${actorEmail} is not an EPISCS owner or admin`)

  const salesRoot = await rootOrganization(
    client,
    salesPipeline.id,
    initial ? sourceWorkspace.id : targetWorkspace.id,
  )
  const placeholderRoot = await rootOrganization(
    client,
    placeholder.id,
    initial ? targetWorkspace.id : sourceWorkspace.id,
  )
  const sourceBoard = await crmBoard(
    client,
    actorEmail,
    initial ? sourceWorkspace.id : targetWorkspace.id,
  )
  const placeholderBoard = await crmBoard(
    client,
    actorEmail,
    initial ? targetWorkspace.id : sourceWorkspace.id,
  )
  assert(sourceBoard.pipeline_id === salesPipeline.id, 'Sales CRM Board is not bound to Sales pipeline')
  assert(placeholderBoard.pipeline_id === placeholder.id, 'Placeholder CRM Board is not bound to placeholder pipeline')

  return {
    state: initial ? 'initial' : 'complete',
    actorEmail,
    sourceWorkspace,
    targetWorkspace,
    salesPipeline,
    placeholder,
    salesRoot,
    placeholderRoot,
    sourceBoard,
    placeholderBoard,
  }
}

const ROOT_SWAP_COLUMNS = [
  'suitecrm_id',
  'source_key',
  'source_sheet_id',
  'source_row_number',
  'priority',
  'name',
  'account_type',
  'account_manager',
  'website',
  'linkedin_url',
  'phone',
  'billing_address_street',
  'billing_address_city',
  'billing_address_state',
  'billing_address_postal_code',
  'billing_address_country',
  'description',
  'source_payload',
  'source_hash',
  'identity_key',
  'reference_code',
  'email',
  'email_opt_out',
]

async function swapRootOrganizations(client, context) {
  const assignments = ROOT_SWAP_COLUMNS.map((column) => (
    `${column} = CASE organization.id WHEN $1::uuid THEN target.${column} ELSE source.${column} END`
  ))
  assignments.push(
    'workspace_organization_id = CASE organization.id WHEN $1::uuid THEN $3::uuid ELSE $4::uuid END',
    "sync_status = 'pending'",
    'sync_error = NULL',
    'updated_by = $5',
    'updated_at = now()',
  )
  await client.query(
    `WITH source AS MATERIALIZED (
       SELECT * FROM crm_organizations WHERE id = $1::uuid
     ), target AS MATERIALIZED (
       SELECT * FROM crm_organizations WHERE id = $2::uuid
     )
     UPDATE crm_organizations organization
     SET ${assignments.join(',\n         ')}
     FROM source, target
     WHERE organization.id = ANY(ARRAY[$1::uuid, $2::uuid])`,
    [
      context.salesRoot.id,
      context.placeholderRoot.id,
      context.targetWorkspace.id,
      context.sourceWorkspace.id,
      context.actorEmail,
    ],
  )
}

async function latestSuiteCrmPayload(client, aggregateId) {
  const rows = await queryRows(
    client,
    `SELECT payload
     FROM sync_outbox
     WHERE target_system = 'suitecrm'
       AND operation = 'upsert_record'
       AND aggregate_id = $1
     ORDER BY created_at DESC, id DESC
     LIMIT 1`,
    [aggregateId],
  )
  const payload = rows[0]?.payload
  return payload && typeof payload === 'object' ? structuredClone(payload) : null
}

async function enqueueSuiteCrmMigration(client, input) {
  const payload = input.payload
  payload.entity = input.entity
  payload.pipelineId = input.pipelineId
  payload.localId = input.id
  payload.suiteCrmId = input.suiteCrmId
  payload.attributes = payload.attributes && typeof payload.attributes === 'object' ? payload.attributes : {}
  payload.attributes.global_id_c = input.referenceCode
  await client.query(
    `INSERT INTO sync_outbox (
       aggregate_type, aggregate_id, operation, target_system, payload,
       status, attempts, idempotency_key, created_at, available_at, updated_at
     ) VALUES ($1, $2, 'upsert_record', 'suitecrm', $3::jsonb,
       'queued', 0, $4, now(), now(), now())
     ON CONFLICT (target_system, idempotency_key)
     WHERE idempotency_key IS NOT NULL
     DO UPDATE SET
       payload = EXCLUDED.payload,
       status = CASE WHEN sync_outbox.status = 'processing' THEN sync_outbox.status ELSE 'queued' END,
       attempts = CASE WHEN sync_outbox.status = 'processing' THEN sync_outbox.attempts ELSE 0 END,
       last_error = CASE WHEN sync_outbox.status = 'processing' THEN sync_outbox.last_error ELSE NULL END,
       available_at = CASE WHEN sync_outbox.status = 'processing' THEN sync_outbox.available_at ELSE now() END,
       processed_at = CASE WHEN sync_outbox.status = 'processing' THEN sync_outbox.processed_at ELSE NULL END,
       locked_at = CASE WHEN sync_outbox.status = 'processing' THEN sync_outbox.locked_at ELSE NULL END,
       lock_token = CASE WHEN sync_outbox.status = 'processing' THEN sync_outbox.lock_token ELSE NULL END,
       updated_at = now()`,
    [
      `crm_${input.entity}`,
      input.id,
      JSON.stringify(payload),
      `crm:workspace-transfer:${MIGRATION_VERSION}:${input.idempotencyPhase ? `${input.idempotencyPhase}:` : ''}${input.entity}:${input.id}:${input.workspaceId}`,
    ],
  )
}

async function stageOrganizationRelationships(client, pipelineId, organizationIds, workspaceId) {
  if (organizationIds.length === 0) return 0
  const rows = await queryRows(
    client,
    `SELECT organization.*, parent.suitecrm_id AS parent_suitecrm_id
     FROM crm_organizations organization
     LEFT JOIN crm_organizations parent ON parent.id = organization.parent_organization_id
     WHERE organization.id = ANY($1::uuid[])
     ORDER BY organization.id`,
    [organizationIds],
  )
  for (const row of rows) {
    const payload = await latestSuiteCrmPayload(client, row.id) || { attributes: {} }
    payload.attributes = {
      ...(payload.attributes || {}),
      global_id_c: row.reference_code,
      name: clean(row.name),
      account_type: clean(row.account_type),
      website: clean(row.website),
      email1: clean(row.email),
      phone_office: clean(row.phone),
      billing_address_street: clean(row.billing_address_street),
      billing_address_city: clean(row.billing_address_city),
      billing_address_state: clean(row.billing_address_state),
      billing_address_postalcode: clean(row.billing_address_postal_code),
      billing_address_country: clean(row.billing_address_country),
      parent_id: clean(row.parent_suitecrm_id),
      description: clean(row.description),
    }
    delete payload.relationships
    await enqueueSuiteCrmMigration(client, {
      entity: 'organizations', pipelineId, id: row.id, suiteCrmId: row.suitecrm_id,
      referenceCode: row.reference_code, workspaceId, payload,
    })
  }
  await client.query(
    `UPDATE crm_organizations
     SET sync_status = 'pending', sync_error = NULL, updated_at = now()
     WHERE id = ANY($1::uuid[])`,
    [organizationIds],
  )
  return rows.length
}

async function stageRootContacts(client, pipelineId, rootId, workspaceId, options = {}) {
  const rows = await queryRows(
    client,
    `SELECT contact.*, organization.suitecrm_id AS organization_suitecrm_id
     FROM crm_contacts contact
     JOIN crm_organizations organization ON organization.id = contact.organization_id
     WHERE contact.pipeline_id = $1::uuid AND contact.organization_id = $2::uuid
       AND ($3::uuid[] IS NULL OR contact.id = ANY($3::uuid[]))
     ORDER BY contact.id`,
    [pipelineId, rootId, options.contactIds?.length ? options.contactIds : null],
  )
  for (const row of rows) {
    const payload = await latestSuiteCrmPayload(client, row.id) || { attributes: {} }
    payload.attributes = {
      ...(payload.attributes || {}),
      global_id_c: row.reference_code,
      first_name: clean(row.first_name),
      last_name: clean(row.last_name) || clean(row.full_name),
      title: clean(row.job_title),
      email1: clean(row.email),
      phone_work: clean(row.phone_work),
      phone_mobile: clean(row.phone_mobile),
      primary_address_street: clean(row.primary_address_street),
      primary_address_city: clean(row.primary_address_city),
      primary_address_state: clean(row.primary_address_state),
      primary_address_postalcode: clean(row.primary_address_postal_code),
      primary_address_country: clean(row.primary_address_country),
      account_id: clean(row.organization_suitecrm_id),
      description: clean(row.description),
    }
    delete payload.relationships
    await enqueueSuiteCrmMigration(client, {
      entity: 'contacts', pipelineId, id: row.id, suiteCrmId: row.suitecrm_id,
      referenceCode: row.reference_code, workspaceId, payload,
      idempotencyPhase: options.idempotencyPhase,
    })
  }
  if (rows.length > 0) {
    await client.query(
      `UPDATE crm_contacts SET sync_status = 'pending', sync_error = NULL, updated_at = now()
       WHERE id = ANY($1::uuid[])`,
      [recordIds(rows)],
    )
  }
  return rows.length
}

async function finalizeRootContacts(client, context, environmentName) {
  const contacts = await queryRows(
    client,
    `SELECT id::text, reference_code, full_name
     FROM crm_contacts
     WHERE pipeline_id = $1::uuid
       AND organization_id = $2::uuid
     ORDER BY id`,
    [context.salesPipeline.id, context.salesRoot.id],
  )
  const existing = await queryRows(
    client,
    `SELECT aggregate_id, status
     FROM sync_outbox
     WHERE target_system = 'suitecrm'
       AND operation = 'upsert_record'
       AND idempotency_key LIKE $1`,
    [`crm:workspace-transfer:${MIGRATION_VERSION}:${CONTACT_FINALIZATION_PHASE}:contacts:%:${context.targetWorkspace.id}`],
  )
  const succeeded = new Set(
    existing.filter((row) => row.status === 'succeeded').map((row) => row.aggregate_id),
  )
  if (contacts.length === 0 || contacts.every((contact) => succeeded.has(contact.id))) {
    return { state: 'already-finalized', contacts: contacts.length }
  }
  const pendingContacts = contacts.filter((contact) => !succeeded.has(contact.id))
  const staged = await stageRootContacts(
    client,
    context.salesPipeline.id,
    context.salesRoot.id,
    context.targetWorkspace.id,
    {
      idempotencyPhase: CONTACT_FINALIZATION_PHASE,
      contactIds: pendingContacts.map((contact) => contact.id),
    },
  )
  await client.query(
    `INSERT INTO audit_events (
       actor, event_type, aggregate_type, aggregate_id, payload, event_key,
       subject, organization_id, is_system, created_at
     ) VALUES ($1, 'crm.pipeline_workspace.root_contacts_finalization_queued',
       'pipeline_space', $2, $3::jsonb, $4, $5, $6::uuid, true, now())
     ON CONFLICT (event_key) WHERE event_key IS NOT NULL DO NOTHING`,
    [
      context.actorEmail,
      context.salesPipeline.id,
      JSON.stringify({
        migrationVersion: MIGRATION_VERSION,
        environment: environmentName,
        pipelineId: context.salesPipeline.id,
        workspaceId: context.targetWorkspace.id,
        contacts: contacts.map((contact) => ({
          id: contact.id,
          referenceCode: contact.reference_code,
          name: contact.full_name,
        })),
      }),
      `crm-pipeline-workspace-root-contacts-finalization:${MIGRATION_VERSION}:${context.salesPipeline.id}:${context.targetWorkspace.id}`,
      SALES_PIPELINE_NAME,
      context.targetWorkspace.id,
    ],
  )
  return { state: 'queued', contacts: staged, alreadySucceeded: succeeded.size }
}

async function stageRootInteractions(client, pipelineId, rootId, workspaceId) {
  const rows = await queryRows(
    client,
    `SELECT interaction.*, organization.suitecrm_id AS organization_suitecrm_id,
       contact.suitecrm_id AS contact_suitecrm_id
     FROM crm_interactions interaction
     JOIN crm_organizations organization ON organization.id = interaction.organization_id
     LEFT JOIN crm_contacts contact ON contact.id = interaction.contact_id
     WHERE interaction.pipeline_id = $1::uuid AND interaction.organization_id = $2::uuid
     ORDER BY interaction.id`,
    [pipelineId, rootId],
  )
  for (const row of rows) {
    const payload = await latestSuiteCrmPayload(client, row.id) || { attributes: {} }
    payload.attributes = {
      ...(payload.attributes || {}),
      global_id_c: row.reference_code,
      name: clean(row.subject),
      occurred_at_c: suiteCrmDateTime(row.occurred_at),
      parent_type: 'Accounts',
      parent_id: clean(row.organization_suitecrm_id),
      contact_id: clean(row.contact_suitecrm_id),
      description: clean(row.description),
    }
    payload.relationships = row.contact_suitecrm_id ? [{
      linkFieldName: 'contact',
      relatedModuleName: 'Contacts',
      relatedBeanId: row.contact_suitecrm_id,
    }] : []
    await enqueueSuiteCrmMigration(client, {
      entity: 'interactions', pipelineId, id: row.id, suiteCrmId: row.suitecrm_id,
      referenceCode: row.reference_code, workspaceId, payload,
    })
  }
  if (rows.length > 0) {
    await client.query(
      `UPDATE crm_interactions SET sync_status = 'pending', sync_error = NULL, updated_at = now()
       WHERE id = ANY($1::uuid[])`,
      [recordIds(rows)],
    )
  }
  return rows.length
}

async function stageRootMeetings(client, pipelineId, rootId, workspaceId) {
  const rows = await queryRows(
    client,
    `SELECT meeting.*, organization.suitecrm_id AS organization_suitecrm_id,
       contact.suitecrm_id AS contact_suitecrm_id,
       lead.suitecrm_id AS lead_suitecrm_id,
       opportunity.suitecrm_id AS opportunity_suitecrm_id
     FROM crm_meetings meeting
     JOIN crm_organizations organization ON organization.id = meeting.organization_id
     LEFT JOIN crm_contacts contact ON contact.id = meeting.contact_id
     LEFT JOIN crm_leads lead ON lead.id = meeting.lead_id
     LEFT JOIN crm_opportunities opportunity ON opportunity.id = meeting.opportunity_id
     WHERE meeting.pipeline_id = $1::uuid AND meeting.organization_id = $2::uuid
     ORDER BY meeting.id`,
    [pipelineId, rootId],
  )
  for (const row of rows) {
    const payload = await latestSuiteCrmPayload(client, row.id) || { attributes: {} }
    const startsAt = new Date(row.starts_at)
    const endsAt = new Date(row.ends_at)
    const duration = Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime())
      ? 30
      : Math.max(1, Math.round((endsAt.getTime() - startsAt.getTime()) / 60_000))
    payload.attributes = {
      ...(payload.attributes || {}),
      global_id_c: row.reference_code,
      name: clean(row.subject),
      date_start: suiteCrmDateTime(row.starts_at),
      duration_hours: Math.floor(duration / 60),
      duration_minutes: duration % 60,
      status: row.status === 'completed' ? 'Held' : row.status === 'cancelled' ? 'Not Held' : 'Planned',
      location: clean(row.location),
      parent_type: 'Accounts',
      parent_id: clean(row.organization_suitecrm_id),
      description: clean(row.description),
    }
    payload.relationships = [
      row.organization_suitecrm_id && { linkFieldName: 'accounts', relatedModuleName: 'Accounts', relatedBeanId: row.organization_suitecrm_id },
      row.contact_suitecrm_id && { linkFieldName: 'contacts', relatedModuleName: 'Contacts', relatedBeanId: row.contact_suitecrm_id },
      row.lead_suitecrm_id && { linkFieldName: 'leads', relatedModuleName: 'Leads', relatedBeanId: row.lead_suitecrm_id },
      row.opportunity_suitecrm_id && { linkFieldName: 'opportunity', relatedModuleName: 'Opportunities', relatedBeanId: row.opportunity_suitecrm_id },
    ].filter(Boolean)
    await enqueueSuiteCrmMigration(client, {
      entity: 'meetings', pipelineId, id: row.id, suiteCrmId: row.suitecrm_id,
      referenceCode: row.reference_code, workspaceId, payload,
    })
  }
  if (rows.length > 0) {
    await client.query(
      `UPDATE crm_meetings SET sync_status = 'pending', sync_error = NULL, updated_at = now()
       WHERE id = ANY($1::uuid[])`,
      [recordIds(rows)],
    )
  }
  return rows.length
}

async function migrateDocuments(client, context, nonOwnerBoards) {
  const actorDocuments = await queryRows(
    client,
    `SELECT document.id::text, document.source_key, document.slug,
       CASE
         WHEN document.pipeline_id = $1::uuid OR document.board_id = $3::uuid THEN $5::uuid
         ELSE $6::uuid
       END::text AS target_workspace_id
     FROM app_documents document
     WHERE document.owner_email = $7
       AND (
         document.pipeline_id = ANY($2::uuid[])
         OR document.board_id = ANY($4::uuid[])
       )
     ORDER BY document.id
     FOR UPDATE`,
    [
      context.salesPipeline.id,
      [context.salesPipeline.id, context.placeholder.id],
      context.sourceBoard.id,
      [context.sourceBoard.id, context.placeholderBoard.id],
      context.targetWorkspace.id,
      context.sourceWorkspace.id,
      context.actorEmail,
    ],
  )
  for (const document of actorDocuments) {
    await client.query(
      `UPDATE app_documents
       SET source_key = $2, slug = $3, updated_at = now()
       WHERE id = $1::uuid`,
      [
        document.id,
        `__workspace_transfer__:${MIGRATION_VERSION}:${document.id}:source`,
        `__workspace_transfer__-${MIGRATION_VERSION}-${document.id}-slug`,
      ],
    )
  }
  for (const document of actorDocuments) {
    await client.query(
      `UPDATE app_documents
       SET workspace_organization_id = $2::uuid, updated_at = now()
       WHERE id = $1::uuid`,
      [document.id, document.target_workspace_id],
    )
  }
  for (const document of actorDocuments) {
    await client.query(
      `UPDATE app_documents
       SET source_key = $2, slug = $3, updated_at = now()
       WHERE id = $1::uuid`,
      [document.id, document.source_key, document.slug],
    )
  }

  const nonOwnerDocuments = []
  for (const binding of nonOwnerBoards) {
    const moved = await queryRows(
      client,
      `UPDATE app_documents
       SET pipeline_id = $3::uuid,
           workspace_organization_id = $4::uuid,
           updated_at = now()
       WHERE owner_email = $1
         AND pipeline_id = $2::uuid
       RETURNING id::text`,
      [binding.owner_email, context.salesPipeline.id, binding.target_pipeline_id, context.sourceWorkspace.id],
    )
    nonOwnerDocuments.push(...moved)
  }
  return {
    actorDocumentIds: recordIds(actorDocuments),
    nonOwnerDocumentIds: recordIds(nonOwnerDocuments),
  }
}

async function migratePreferences(client, context, nonOwnerBoards) {
  await client.query(
    `UPDATE app_user_workspace_preferences
     SET default_pipeline_id = $3::uuid, updated_at = now()
     WHERE user_email = $1
       AND workspace_organization_id = $2::uuid
       AND default_pipeline_id = $4::uuid`,
    [context.actorEmail, context.sourceWorkspace.id, context.placeholder.id, context.salesPipeline.id],
  )
  const targetDefaultBoard = single(
    await queryRows(
      client,
      `SELECT id::text FROM project_boards
       WHERE owner_email = $1 AND workspace_organization_id = $2::uuid AND is_default
       ORDER BY created_at, id LIMIT 1`,
      [context.actorEmail, context.targetWorkspace.id],
    ),
    'EPISCS default project board is missing',
  )
  await client.query(
    `INSERT INTO app_user_workspace_preferences (
       user_email, workspace_organization_id, default_board_id, default_pipeline_id,
       created_at, updated_at
     ) VALUES ($1, $2::uuid, $3::uuid, $4::uuid, now(), now())
     ON CONFLICT (user_email, workspace_organization_id) DO UPDATE SET
       default_board_id = COALESCE(app_user_workspace_preferences.default_board_id, EXCLUDED.default_board_id),
       default_pipeline_id = EXCLUDED.default_pipeline_id,
       updated_at = now()`,
    [context.actorEmail, context.targetWorkspace.id, targetDefaultBoard.id, context.salesPipeline.id],
  )
  for (const binding of nonOwnerBoards) {
    await client.query(
      `UPDATE app_user_workspace_preferences
       SET default_pipeline_id = $3::uuid, updated_at = now()
       WHERE user_email = $1
         AND workspace_organization_id = $2::uuid
         AND default_pipeline_id = $4::uuid`,
      [binding.owner_email, context.sourceWorkspace.id, binding.target_pipeline_id, context.salesPipeline.id],
    )
  }
}

async function migrateShortLinks(client, context) {
  await client.query(
    `UPDATE short_links link
     SET organization_root_id = $2::uuid, updated_at = now()
     FROM pipeline_spaces pipeline
     WHERE pipeline.id = $1::uuid
       AND link.id = pipeline.short_link_id`,
    [context.salesPipeline.id, context.targetWorkspace.id],
  )
  await client.query(
    `UPDATE short_links link
     SET organization_root_id = $2::uuid, updated_at = now()
     FROM pipeline_spaces pipeline
     WHERE pipeline.id = $1::uuid
       AND link.id = pipeline.short_link_id`,
    [context.placeholder.id, context.sourceWorkspace.id],
  )
  const moved = await queryRows(
    client,
    `WITH sales_references AS (
       SELECT reference_code FROM crm_organizations WHERE pipeline_id = $1::uuid
       UNION SELECT reference_code FROM crm_contacts WHERE pipeline_id = $1::uuid
       UNION SELECT reference_code FROM crm_opportunities WHERE pipeline_id = $1::uuid
       UNION SELECT reference_code FROM crm_interactions WHERE pipeline_id = $1::uuid
       UNION SELECT reference_code FROM crm_meetings WHERE pipeline_id = $1::uuid
       UNION SELECT reference_code FROM crm_leads WHERE pipeline_id = $1::uuid
       UNION SELECT reference_code FROM crm_campaigns WHERE pipeline_id = $1::uuid
       UNION SELECT reference_code FROM crm_products WHERE pipeline_id = $1::uuid
     ), suburbia_references AS (
       SELECT reference_code FROM crm_organizations record JOIN pipeline_spaces pipeline ON pipeline.id = record.pipeline_id WHERE pipeline.workspace_organization_id = $2::uuid
       UNION SELECT reference_code FROM crm_contacts record JOIN pipeline_spaces pipeline ON pipeline.id = record.pipeline_id WHERE pipeline.workspace_organization_id = $2::uuid
       UNION SELECT reference_code FROM crm_opportunities record JOIN pipeline_spaces pipeline ON pipeline.id = record.pipeline_id WHERE pipeline.workspace_organization_id = $2::uuid
       UNION SELECT reference_code FROM crm_interactions record JOIN pipeline_spaces pipeline ON pipeline.id = record.pipeline_id WHERE pipeline.workspace_organization_id = $2::uuid
       UNION SELECT reference_code FROM crm_meetings record JOIN pipeline_spaces pipeline ON pipeline.id = record.pipeline_id WHERE pipeline.workspace_organization_id = $2::uuid
       UNION SELECT reference_code FROM crm_leads record JOIN pipeline_spaces pipeline ON pipeline.id = record.pipeline_id WHERE pipeline.workspace_organization_id = $2::uuid
       UNION SELECT reference_code FROM crm_campaigns record JOIN pipeline_spaces pipeline ON pipeline.id = record.pipeline_id WHERE pipeline.workspace_organization_id = $2::uuid
       UNION SELECT reference_code FROM crm_products record JOIN pipeline_spaces pipeline ON pipeline.id = record.pipeline_id WHERE pipeline.workspace_organization_id = $2::uuid
     ), movable AS (
       SELECT reference_code FROM sales_references
       EXCEPT SELECT reference_code FROM suburbia_references
     )
     UPDATE short_links link
     SET organization_root_id = $3::uuid, updated_at = now()
     WHERE link.source_app = 'clawpilot-crm'
       AND (
         link.slug IN (SELECT reference_code FROM movable)
         OR link.slug IN (SELECT 'mail-' || reference_code FROM movable)
       )
     RETURNING link.id::text`,
    [context.salesPipeline.id, context.sourceWorkspace.id, context.targetWorkspace.id],
  )
  return recordIds(moved)
}

async function migrateAuditScope(client, context, movedDocumentIds, movedLinkIds) {
  const salesRecords = recordIds(await crmRecordIds(client, context.salesPipeline.id))
  const placeholderRecords = recordIds(await crmRecordIds(client, context.placeholder.id))
  const salesIds = unique([
    context.salesPipeline.id,
    context.sourceBoard.id,
    ...salesRecords,
    ...movedDocumentIds,
    ...movedLinkIds,
  ])
  const placeholderIds = unique([
    context.placeholder.id,
    context.placeholderBoard.id,
    ...placeholderRecords,
  ])
  await client.query(
    `UPDATE audit_events
     SET organization_id = $2::uuid
     WHERE organization_id = $1::uuid
       AND (
         aggregate_id = ANY($3::text[])
         OR payload->>'pipelineId' = $4
         OR payload->>'boardId' = $5
       )`,
    [context.sourceWorkspace.id, context.targetWorkspace.id, salesIds, context.salesPipeline.id, context.sourceBoard.id],
  )
  await client.query(
    `UPDATE audit_events
     SET organization_id = $2::uuid
     WHERE organization_id = $1::uuid
       AND (
         aggregate_id = ANY($3::text[])
         OR payload->>'pipelineId' = $4
         OR payload->>'boardId' = $5
       )`,
    [context.targetWorkspace.id, context.sourceWorkspace.id, placeholderIds, context.placeholder.id, context.placeholderBoard.id],
  )
}

async function enqueueWorkbookBranding(client, context) {
  if (!context.salesPipeline.sheet_id) return 0
  const branding = await queryRows(
    client,
    `SELECT revision::integer FROM workspace_organization_branding WHERE organization_id = $1::uuid`,
    [context.targetWorkspace.id],
  )
  const revision = branding[0]?.revision || 0
  await client.query(
    `INSERT INTO sync_outbox (
       aggregate_type, aggregate_id, operation, target_system, payload,
       status, attempts, idempotency_key, created_at, available_at, updated_at
     ) VALUES (
       'pipeline_branding', $1, 'apply_workbook_branding', 'google_sheets', $2::jsonb,
       'queued', 0, $3, now(), now(), now()
     )
     ON CONFLICT (target_system, idempotency_key)
     WHERE idempotency_key IS NOT NULL
     DO UPDATE SET
       payload = EXCLUDED.payload,
       status = CASE WHEN sync_outbox.status = 'processing' THEN sync_outbox.status ELSE 'queued' END,
       attempts = CASE WHEN sync_outbox.status = 'processing' THEN sync_outbox.attempts ELSE 0 END,
       last_error = CASE WHEN sync_outbox.status = 'processing' THEN sync_outbox.last_error ELSE NULL END,
       available_at = CASE WHEN sync_outbox.status = 'processing' THEN sync_outbox.available_at ELSE now() END,
       processed_at = CASE WHEN sync_outbox.status = 'processing' THEN sync_outbox.processed_at ELSE NULL END,
       updated_at = now()`,
    [
      context.salesPipeline.id,
      JSON.stringify({
        pipelineId: context.salesPipeline.id,
        sheetId: context.salesPipeline.sheet_id,
        organizationId: context.targetWorkspace.id,
        brandingRevision: revision,
      }),
      `pipeline:${context.salesPipeline.id}:workspace-transfer-branding:${context.targetWorkspace.id}`,
    ],
  )
  return 1
}

async function validateState(client, context, expectedCounts, memberOrganizationCount, nonOwnerBoards, documents) {
  const refreshed = await readContext(client, context.actorEmail)
  assert(refreshed.state === 'complete', 'Migration validation did not resolve the completed state')
  const salesCounts = await crmCounts(client, context.salesPipeline.id)
  const placeholderCounts = await crmCounts(client, context.placeholder.id)
  assert(salesCounts.organizations === expectedCounts.sales.organizations - memberOrganizationCount, 'Sales organization count changed unexpectedly')
  for (const key of ['contacts', 'opportunities', 'interactions', 'meetings', 'leads', 'campaigns', 'products']) {
    assert(salesCounts[key] === expectedCounts.sales[key], `Sales ${key} count changed unexpectedly`)
  }
  assert(
    placeholderCounts.organizations === expectedCounts.placeholder.organizations + memberOrganizationCount,
    'Suburbia placeholder organization count changed unexpectedly',
  )
  for (const key of ['contacts', 'opportunities', 'interactions', 'meetings', 'leads', 'campaigns', 'products']) {
    assert(placeholderCounts[key] === expectedCounts.placeholder[key], `Suburbia placeholder ${key} count changed unexpectedly`)
  }
  const touchedBoardIds = unique([
    context.sourceBoard.id,
    context.placeholderBoard.id,
    ...nonOwnerBoards.map((board) => board.board_id),
  ])
  const touchedPipelineIds = unique([
    context.salesPipeline.id,
    context.placeholder.id,
    ...nonOwnerBoards.map((board) => board.target_pipeline_id),
  ])
  const scopeErrors = await queryRows(
    client,
    `SELECT count(*)::integer AS count
     FROM crm_board_projections projection
     JOIN project_boards board ON board.id = projection.board_id
     JOIN pipeline_spaces pipeline ON pipeline.id = projection.pipeline_id
     WHERE projection.board_id = ANY($1::uuid[])
       AND (
         board.workspace_organization_id IS DISTINCT FROM projection.workspace_organization_id
         OR pipeline.workspace_organization_id IS DISTINCT FROM projection.workspace_organization_id
       )`,
    [touchedBoardIds],
  )
  assert(scopeErrors[0]?.count === 0, 'CRM board projections have a workspace mismatch')
  const documentErrors = await queryRows(
    client,
    `SELECT count(*)::integer AS count
     FROM app_documents document
     LEFT JOIN pipeline_spaces pipeline ON pipeline.id = document.pipeline_id
     LEFT JOIN project_boards board ON board.id = document.board_id
     WHERE (
         document.id = ANY($1::uuid[])
         OR document.pipeline_id = ANY($2::uuid[])
         OR document.board_id = ANY($3::uuid[])
       )
       AND (
         (pipeline.id IS NOT NULL AND document.workspace_organization_id IS DISTINCT FROM pipeline.workspace_organization_id)
         OR (board.id IS NOT NULL AND document.workspace_organization_id IS DISTINCT FROM board.workspace_organization_id)
       )`,
    [
      unique([...documents.actorDocumentIds, ...documents.nonOwnerDocumentIds]),
      touchedPipelineIds,
      touchedBoardIds,
    ],
  )
  assert(documentErrors[0]?.count === 0, 'Documents have a workspace mismatch')
  const unauthorized = await queryRows(
    client,
    `SELECT count(*)::integer AS count
     FROM pipeline_space_members member
     WHERE member.pipeline_id = $1::uuid
       AND NOT EXISTS (
         SELECT 1 FROM app_user_organization_memberships membership
         WHERE membership.user_email = member.user_email
           AND membership.organization_id = $2::uuid
           AND membership.status = 'active'
       )`,
    [context.salesPipeline.id, context.targetWorkspace.id],
  )
  assert(unauthorized[0]?.count === 0, 'Sales pipeline retains a user without EPISCS access')
  const crmRelationshipErrors = await queryRows(
    client,
    `SELECT (
       (SELECT count(*) FROM crm_contacts record JOIN crm_organizations parent ON parent.id = record.organization_id WHERE record.pipeline_id = ANY($1::uuid[]) AND record.pipeline_id <> parent.pipeline_id)
       + (SELECT count(*) FROM crm_opportunities record JOIN crm_organizations parent ON parent.id = record.organization_id WHERE record.pipeline_id = ANY($1::uuid[]) AND record.pipeline_id <> parent.pipeline_id)
       + (SELECT count(*) FROM crm_interactions record JOIN crm_organizations parent ON parent.id = record.organization_id WHERE record.pipeline_id = ANY($1::uuid[]) AND record.pipeline_id <> parent.pipeline_id)
       + (SELECT count(*) FROM crm_meetings record JOIN crm_organizations parent ON parent.id = record.organization_id WHERE record.pipeline_id = ANY($1::uuid[]) AND record.pipeline_id <> parent.pipeline_id)
     )::integer AS count`,
    [[context.salesPipeline.id, context.placeholder.id]],
  )
  assert(crmRelationshipErrors[0]?.count === 0, 'CRM records cross pipeline boundaries')
  return { sales: salesCounts, suburbiaPlaceholder: placeholderCounts }
}

async function insertMigrationAudit(client, context, summary, environmentName) {
  const payload = {
    migrationVersion: MIGRATION_VERSION,
    environment: environmentName,
    fromWorkspaceId: context.sourceWorkspace.id,
    fromWorkspaceName: context.sourceWorkspace.name,
    toWorkspaceId: context.targetWorkspace.id,
    toWorkspaceName: context.targetWorkspace.name,
    salesPipelineId: context.salesPipeline.id,
    suburbiaPlaceholderPipelineId: context.placeholder.id,
    movedWorkspaceMemberOrganizations: summary.memberOrganizations,
    counts: summary.counts,
    suiteCrmRestaged: summary.suiteCrmRestaged,
    message: `${SALES_PIPELINE_NAME} migrated from ${SOURCE_WORKSPACE_NAME} to ${TARGET_WORKSPACE_NAME}`,
  }
  const entries = [
    {
      organizationId: context.targetWorkspace.id,
      eventType: 'crm.pipeline_workspace.migrated_in',
      subject: SALES_PIPELINE_NAME,
      key: `crm-pipeline-workspace-migrated-in:${MIGRATION_VERSION}:${context.salesPipeline.id}:${context.targetWorkspace.id}`,
    },
    {
      organizationId: context.sourceWorkspace.id,
      eventType: 'crm.pipeline_workspace.migrated_out',
      subject: SALES_PIPELINE_NAME,
      key: `crm-pipeline-workspace-migrated-out:${MIGRATION_VERSION}:${context.salesPipeline.id}:${context.sourceWorkspace.id}`,
    },
  ]
  for (const entry of entries) {
    await client.query(
      `INSERT INTO audit_events (
         actor, event_type, aggregate_type, aggregate_id, payload, event_key,
         subject, organization_id, is_system, created_at
       ) VALUES ($1, $2, 'pipeline_space', $3, $4::jsonb, $5, $6, $7::uuid, true, now())
       ON CONFLICT (event_key) WHERE event_key IS NOT NULL DO NOTHING`,
      [
        context.actorEmail,
        entry.eventType,
        context.salesPipeline.id,
        JSON.stringify(payload),
        entry.key,
        entry.subject,
        entry.organizationId,
      ],
    )
  }
}

async function executeMigration(client, context, environmentName) {
  const expectedCounts = {
    sales: await crmCounts(client, context.salesPipeline.id),
    placeholder: await crmCounts(client, context.placeholder.id),
  }
  const memberRows = await memberOrganizations(client, context.salesPipeline.id)
  const nonOwnerBoards = await nonOwnerBoardBindings(
    client,
    context.salesPipeline.id,
    context.sourceWorkspace.id,
    context.actorEmail,
  )

  await client.query(
    `UPDATE pipeline_spaces
     SET is_default = false, updated_at = now()
     WHERE id = ANY($1::uuid[])`,
    [[context.salesPipeline.id, context.placeholder.id]],
  )
  await client.query(
    `UPDATE pipeline_spaces
     SET workspace_organization_id = CASE id
           WHEN $1::uuid THEN $3::uuid
           ELSE $4::uuid
         END,
         updated_at = now()
     WHERE id = ANY($2::uuid[])`,
    [
      context.salesPipeline.id,
      [context.salesPipeline.id, context.placeholder.id],
      context.targetWorkspace.id,
      context.sourceWorkspace.id,
    ],
  )
  await client.query(
    `UPDATE pipeline_spaces
     SET is_default = CASE id WHEN $1::uuid THEN $3::boolean ELSE $4::boolean END,
         updated_at = now()
     WHERE id = ANY($2::uuid[])`,
    [
      context.salesPipeline.id,
      [context.salesPipeline.id, context.placeholder.id],
      context.salesPipeline.is_default,
      context.placeholder.is_default,
    ],
  )
  await client.query(
    `UPDATE project_boards
     SET name = '__workspace_transfer__' || id::text,
         updated_at = now()
     WHERE id = ANY($1::uuid[])`,
    [[context.sourceBoard.id, context.placeholderBoard.id]],
  )
  await client.query(
    `UPDATE project_boards
     SET workspace_organization_id = CASE id
           WHEN $1::uuid THEN $3::uuid
           ELSE $4::uuid
         END,
         updated_at = now()
     WHERE id = ANY($2::uuid[])`,
    [
      context.sourceBoard.id,
      [context.sourceBoard.id, context.placeholderBoard.id],
      context.targetWorkspace.id,
      context.sourceWorkspace.id,
    ],
  )

  const projectionValues = [
    { boardId: context.sourceBoard.id, pipelineId: context.salesPipeline.id, workspaceId: context.targetWorkspace.id },
    { boardId: context.placeholderBoard.id, pipelineId: context.placeholder.id, workspaceId: context.sourceWorkspace.id },
    ...nonOwnerBoards.map((binding) => ({
      boardId: binding.board_id,
      pipelineId: binding.target_pipeline_id,
      workspaceId: context.sourceWorkspace.id,
    })),
  ]
  for (const projection of projectionValues) {
    await client.query(
      `UPDATE crm_board_projections
       SET pipeline_id = $2::uuid, workspace_organization_id = $3::uuid, updated_at = now()
       WHERE board_id = $1::uuid`,
      [projection.boardId, projection.pipelineId, projection.workspaceId],
    )
  }
  await client.query(
    `UPDATE project_boards
     SET name = CASE id WHEN $1::uuid THEN $3 ELSE $4 END,
         updated_at = now()
     WHERE id = ANY($2::uuid[])`,
    [
      context.sourceBoard.id,
      [context.sourceBoard.id, context.placeholderBoard.id],
      context.sourceBoard.name,
      context.placeholderBoard.name,
    ],
  )
  for (const binding of nonOwnerBoards) {
    await client.query('DELETE FROM crm_board_cards WHERE board_id = $1::uuid', [binding.board_id])
  }

  await client.query(
    `DELETE FROM pipeline_space_members member
     WHERE member.pipeline_id = $1::uuid
       AND NOT EXISTS (
         SELECT 1 FROM app_user_organization_memberships membership
         WHERE membership.user_email = member.user_email
           AND membership.organization_id = $2::uuid
           AND membership.status = 'active'
       )`,
    [context.salesPipeline.id, context.targetWorkspace.id],
  )
  await client.query(
    `DELETE FROM pipeline_google_permissions permission
     WHERE permission.pipeline_id = $1::uuid
       AND NOT EXISTS (
         SELECT 1 FROM app_user_organization_memberships membership
         WHERE membership.user_email = permission.user_email
           AND membership.organization_id = $2::uuid
           AND membership.status = 'active'
       )`,
    [context.salesPipeline.id, context.targetWorkspace.id],
  )
  await client.query(
    `DELETE FROM project_board_members member
     WHERE member.board_id = $1::uuid
       AND NOT EXISTS (
         SELECT 1 FROM app_user_organization_memberships membership
         WHERE membership.user_email = member.user_email
           AND membership.organization_id = $2::uuid
           AND membership.status = 'active'
       )`,
    [context.sourceBoard.id, context.targetWorkspace.id],
  )

  if (memberRows.length > 0) {
    await client.query(
      `UPDATE crm_organizations
       SET pipeline_id = $2::uuid,
           parent_organization_id = $3::uuid,
           updated_by = $4,
           updated_at = now()
       WHERE id = ANY($1::uuid[])`,
      [recordIds(memberRows), context.placeholder.id, context.placeholderRoot.id, context.actorEmail],
    )
  }
  await swapRootOrganizations(client, context)

  const documents = await migrateDocuments(client, context, nonOwnerBoards)
  await migratePreferences(client, context, nonOwnerBoards)
  const movedLinkIds = await migrateShortLinks(client, context)
  await migrateAuditScope(client, context, documents.actorDocumentIds, movedLinkIds)

  const customerOrganizationIds = recordIds(await queryRows(
    client,
    `SELECT id::text FROM crm_organizations
     WHERE pipeline_id = $1::uuid AND relationship_type = 'customer'
     ORDER BY id`,
    [context.salesPipeline.id],
  ))
  const suiteCrmRestaged = {
    organizations: (
      await stageOrganizationRelationships(
        client,
        context.salesPipeline.id,
        [context.salesRoot.id, ...customerOrganizationIds],
        context.targetWorkspace.id,
      )
    ) + (
      await stageOrganizationRelationships(
        client,
        context.placeholder.id,
        [context.placeholderRoot.id],
        context.sourceWorkspace.id,
      )
    ),
    // Shared canonical contacts can exist in both roots. Stage Suburbia first so
    // the migrated EPISCS relationship is the final SuiteCRM primary Account.
    contacts: (
      await stageRootContacts(client, context.placeholder.id, context.placeholderRoot.id, context.sourceWorkspace.id)
    ) + (
      await stageRootContacts(client, context.salesPipeline.id, context.salesRoot.id, context.targetWorkspace.id)
    ),
    interactions: await stageRootInteractions(
      client,
      context.salesPipeline.id,
      context.salesRoot.id,
      context.targetWorkspace.id,
    ),
    meetings: await stageRootMeetings(
      client,
      context.salesPipeline.id,
      context.salesRoot.id,
      context.targetWorkspace.id,
    ),
  }
  await enqueueWorkbookBranding(client, context)

  const counts = await validateState(
    client,
    context,
    expectedCounts,
    memberRows.length,
    nonOwnerBoards,
    documents,
  )
  const summary = {
    memberOrganizations: memberRows.map((row) => ({
      referenceCode: row.reference_code,
      name: row.name,
      workspaceOrganizationId: row.workspace_organization_id,
    })),
    nonOwnerBoards: nonOwnerBoards.map((row) => ({ ownerEmail: row.owner_email, pipelineId: row.target_pipeline_id })),
    movedDocuments: documents.actorDocumentIds.length,
    reassignedUserDocuments: documents.nonOwnerDocumentIds.length,
    movedShortLinks: movedLinkIds.length,
    suiteCrmRestaged,
    counts,
  }
  await insertMigrationAudit(client, context, summary, environmentName)
  return summary
}

async function completedSummary(client, context) {
  const counts = {
    sales: await crmCounts(client, context.salesPipeline.id),
    suburbiaPlaceholder: await crmCounts(client, context.placeholder.id),
  }
  const pending = await queryRows(
    client,
    `SELECT status, target_system, operation, count(*)::integer AS count
     FROM sync_outbox
     WHERE idempotency_key LIKE $1
     GROUP BY status, target_system, operation
     ORDER BY target_system, operation, status`,
    [`%workspace-transfer:${MIGRATION_VERSION}:%`],
  )
  return { counts, syncOutbox: pending }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  assert(process.env.DATABASE_URL, 'DATABASE_URL is required')
  const actorEmail = clean(process.env.CLAWPILOT_MIGRATION_ACTOR).toLowerCase()
  assert(actorEmail, 'CLAWPILOT_MIGRATION_ACTOR is required')
  if (args.apply) {
    assert(
      process.env.CLAWPILOT_EPISCS_MIGRATION_CONFIRM === CONFIRMATION,
      `Set CLAWPILOT_EPISCS_MIGRATION_CONFIRM=${CONFIRMATION} to apply`,
    )
  }
  const environmentName = clean(process.env.CLAWPILOT_MIGRATION_ENVIRONMENT) || 'unknown'
  const sslMode = clean(process.env.PGSSLMODE || process.env.DATABASE_SSL).toLowerCase()
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: sslMode === 'require' || sslMode === 'true' || process.env.DATABASE_URL.includes('rlwy.net')
      ? { rejectUnauthorized: false }
      : undefined,
  })
  const client = await pool.connect()
  let result
  try {
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE')
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [LOCK_KEY])
    const context = await readContext(client, actorEmail)
    if (context.state === 'complete') {
      const finalization = args.finalizeRootContacts
        ? await finalizeRootContacts(client, context, environmentName)
        : null
      result = {
        ok: true,
        mode: args.apply ? 'apply' : 'dry-run',
        state: finalization
          ? finalization.state === 'already-finalized'
            ? 'already-complete'
            : args.apply
              ? 'root-contact-finalization-queued'
              : 'validated-root-contact-finalization-rollback'
          : 'already-complete',
        environment: environmentName,
        salesPipelineId: context.salesPipeline.id,
        sourceWorkspace: context.sourceWorkspace,
        targetWorkspace: context.targetWorkspace,
        ...(finalization ? { rootContactFinalization: finalization } : {}),
        ...(await completedSummary(client, context)),
      }
    } else {
      const summary = await executeMigration(client, context, environmentName)
      result = {
        ok: true,
        mode: args.apply ? 'apply' : 'dry-run',
        state: args.apply ? 'completed' : 'validated-rollback',
        environment: environmentName,
        salesPipelineId: context.salesPipeline.id,
        sourceWorkspace: context.sourceWorkspace,
        targetWorkspace: context.targetWorkspace,
        summary,
      }
    }
    if (args.apply) await client.query('COMMIT')
    else await client.query('ROLLBACK')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release()
    await pool.end()
  }
  if (args.json) console.log(JSON.stringify(result, null, 2))
  else {
    console.log(`${result.state}: ${result.salesPipelineId}`)
    console.log(JSON.stringify(result.summary || result.counts, null, 2))
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
