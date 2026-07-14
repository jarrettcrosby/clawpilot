import crypto from 'node:crypto'
import type { PoolClient } from 'pg'
import {
  contactIdentityKey,
  crmSourceHash,
  organizationIdentityKey,
  stableGlobalSuiteCrmId,
  stableSuiteCrmId,
} from '@/lib/crm/stableId'
import type {
  CrmContact,
  CrmEntity,
  CrmInteraction,
  CrmOpportunity,
  CrmOrganization,
  CrmRecord,
  CrmSummary,
  SuiteCrmOutboxRecord,
} from '@/lib/crm/types'
import { query, withTransaction } from '@/lib/persistence/postgres'
import {
  ensurePrimaryWorkspaceOrganization,
  workspaceOrganizationAncestors,
} from '@/lib/organizations'

const ENTITY_TABLE: Record<CrmEntity, string> = {
  organizations: 'crm_organizations',
  contacts: 'crm_contacts',
  opportunities: 'crm_opportunities',
  interactions: 'crm_interactions',
}

type CommonStageInput = {
  pipelineId: string
  localId?: string | null
  sourceKey: string
  sourceSheetId?: string | null
  sourceRowNumber?: number | null
  sourcePayload?: Record<string, unknown>
  actorEmail: string
}

export type StageOrganizationInput = CommonStageInput & {
  entity: 'organizations'
  fields: {
    parentOrganizationId?: string | null
    parentOrganizationSuiteCrmId?: string | null
    workspaceOrganizationId?: string | null
    relationshipType?: 'workspace_root' | 'workspace_member' | 'customer'
    priority?: string
    name: string
    accountType?: string
    accountManager?: string
    website?: string
    linkedinUrl?: string
    phone?: string
    address?: string
    city?: string
    state?: string
    postalCode?: string
    country?: string
    description?: string
  }
}

export type StageContactInput = CommonStageInput & {
  entity: 'contacts'
  fields: {
    organizationId?: string | null
    organizationSuiteCrmId?: string | null
    priority?: string
    firstName?: string
    lastName?: string
    fullName: string
    contactType?: string
    accountManager?: string
    jobTitle?: string
    email?: string
    linkedinUrl?: string
    phoneWork?: string
    phoneMobile?: string
    address?: string
    city?: string
    state?: string
    postalCode?: string
    country?: string
    description?: string
  }
}

export type StageOpportunityInput = CommonStageInput & {
  entity: 'opportunities'
  fields: {
    organizationId?: string | null
    organizationSuiteCrmId?: string | null
    priority?: string
    name: string
    owner?: string
    organization?: string
    status?: string
    stage?: string
    lossReason?: string
    source?: string
    value?: number
    probability?: number
    expectedClose?: string | null
    notes?: string
  }
}

export type StageInteractionInput = CommonStageInput & {
  entity: 'interactions'
  fields: {
    organizationId?: string | null
    contactId?: string | null
    opportunityId?: string | null
    parentSuiteCrmId?: string | null
    interactionType?: string
    subject: string
    agentName?: string
    occurredAt?: string | null
    description?: string
  }
}

export type StageCrmRecordInput =
  | StageOrganizationInput
  | StageContactInput
  | StageOpportunityInput
  | StageInteractionInput

export type CrmOutboxItem = {
  id: string
  aggregateType: string
  aggregateId: string
  operation: 'upsert_record' | 'delete_record'
  payload: SuiteCrmOutboxRecord
  attempts: number
  lockToken: string
}

function clean(value: unknown) {
  return String(value ?? '').trim()
}

function nullable(value: unknown) {
  const normalized = clean(value)
  return normalized || null
}

function finite(value: unknown, fallback = 0) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function isoDate(value: unknown) {
  const raw = clean(value)
  if (!raw) return null
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw
  const parsed = new Date(raw)
  if (Number.isNaN(parsed.getTime())) return null
  return parsed.toISOString().slice(0, 10)
}

function suiteCrmAttributes(input: StageCrmRecordInput) {
  if (input.entity === 'organizations') {
    const fields = input.fields
    return {
      name: clean(fields.name),
      account_type: clean(fields.accountType),
      website: clean(fields.website),
      phone_office: clean(fields.phone),
      billing_address_street: clean(fields.address),
      billing_address_city: clean(fields.city),
      billing_address_state: clean(fields.state),
      billing_address_postalcode: clean(fields.postalCode),
      billing_address_country: clean(fields.country),
      parent_id: clean(fields.parentOrganizationSuiteCrmId),
      description: clean(fields.description),
    }
  }
  if (input.entity === 'contacts') {
    const fields = input.fields
    return {
      first_name: clean(fields.firstName),
      last_name: clean(fields.lastName) || clean(fields.fullName),
      title: clean(fields.jobTitle),
      email1: clean(fields.email),
      phone_work: clean(fields.phoneWork),
      phone_mobile: clean(fields.phoneMobile),
      primary_address_street: clean(fields.address),
      primary_address_city: clean(fields.city),
      primary_address_state: clean(fields.state),
      primary_address_postalcode: clean(fields.postalCode),
      primary_address_country: clean(fields.country),
      account_id: clean(fields.organizationSuiteCrmId),
      description: clean(fields.description),
    }
  }
  if (input.entity === 'opportunities') {
    const fields = input.fields
    return {
      name: clean(fields.name),
      account_id: clean(fields.organizationSuiteCrmId),
      sales_stage: clean(fields.stage),
      amount: Math.max(0, finite(fields.value)),
      probability: Math.max(0, Math.min(100, finite(fields.probability))),
      date_closed: isoDate(fields.expectedClose),
      lead_source: clean(fields.source),
      description: clean(fields.notes),
    }
  }
  const fields = input.fields
  return {
    name: clean(fields.subject),
    parent_type: fields.parentSuiteCrmId ? 'Opportunities' : '',
    parent_id: clean(fields.parentSuiteCrmId),
    description: clean(fields.description),
  }
}

async function enqueueSuiteCrmRecord(
  client: PoolClient,
  input: StageCrmRecordInput,
  localId: string,
  suiteCrmId: string,
  sourceHash: string,
) {
  const payload: SuiteCrmOutboxRecord = {
    entity: input.entity,
    pipelineId: input.pipelineId,
    localId,
    suiteCrmId,
    attributes: suiteCrmAttributes(input),
  }
  await client.query(
    `
      INSERT INTO sync_outbox (
        aggregate_type, aggregate_id, operation, target_system, payload,
        status, idempotency_key, created_at, available_at, updated_at
      )
      VALUES ($1, $2, 'upsert_record', 'suitecrm', $3::jsonb, 'queued', $4, now(), now(), now())
      ON CONFLICT (target_system, idempotency_key)
      WHERE idempotency_key IS NOT NULL
      DO UPDATE SET updated_at = sync_outbox.updated_at
    `,
    [`crm_${input.entity}`, localId, JSON.stringify(payload), `crm:${input.entity}:${localId}:${sourceHash}`],
  )
}

async function stageOrganization(
  client: PoolClient,
  input: StageOrganizationInput,
  suiteCrmId: string,
  sourceHash: string,
  identityKey: string,
) {
  const fields = input.fields
  const relationshipType = fields.relationshipType || 'customer'
  if (input.localId) {
    const updated = await client.query<{ id: string; suitecrm_id: string }>(
      `UPDATE crm_organizations SET
         suitecrm_id = COALESCE(suitecrm_id, $3), source_key = $4, identity_key = $4,
         parent_organization_id = $5::uuid, workspace_organization_id = $6::uuid,
         relationship_type = $7, source_sheet_id = COALESCE($8, source_sheet_id),
         source_row_number = COALESCE($9, source_row_number), priority = $10, name = $11,
         account_type = $12, account_manager = $13, website = $14, linkedin_url = $15,
         phone = $16, billing_address_street = $17, billing_address_city = $18,
         billing_address_state = $19, billing_address_postal_code = $20,
         billing_address_country = $21, description = $22, source_payload = $23::jsonb,
         sync_status = CASE WHEN source_hash IS DISTINCT FROM $24 THEN 'pending' ELSE sync_status END,
         sync_error = CASE WHEN source_hash IS DISTINCT FROM $24 THEN NULL ELSE sync_error END,
         source_hash = $24, updated_by = $25, updated_at = now()
       WHERE pipeline_id = $1::uuid AND id = $2::uuid
       RETURNING id::text, suitecrm_id`,
      [
        input.pipelineId, input.localId, suiteCrmId, identityKey,
        fields.parentOrganizationId || null, fields.workspaceOrganizationId || null, relationshipType,
        input.sourceSheetId || null, input.sourceRowNumber || null, nullable(fields.priority), clean(fields.name),
        nullable(fields.accountType), nullable(fields.accountManager), nullable(fields.website), nullable(fields.linkedinUrl),
        nullable(fields.phone), nullable(fields.address), nullable(fields.city), nullable(fields.state),
        nullable(fields.postalCode), nullable(fields.country), nullable(fields.description),
        JSON.stringify(input.sourcePayload || {}), sourceHash, input.actorEmail,
      ],
    )
    if (!updated.rows[0]) throw new Error('CRM organization was not found')
    return updated.rows[0]
  }
  const result = await client.query<{ id: string; suitecrm_id: string }>(
    `
      INSERT INTO crm_organizations (
        pipeline_id, suitecrm_id, source_key, identity_key, parent_organization_id,
        workspace_organization_id, relationship_type, source_sheet_id, source_row_number,
        priority, name, account_type, account_manager, website, linkedin_url, phone,
        billing_address_street, billing_address_city, billing_address_state,
        billing_address_postal_code, billing_address_country, description,
        source_payload, source_hash, sync_status, sync_error, created_by, updated_by
      )
      VALUES (
        $1::uuid, $2, $3, $3, $4::uuid, $5::uuid, $6, $7, $8, $9, $10, $11,
        $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22::jsonb, $23,
        'pending', NULL, $24, $24
      )
      ON CONFLICT (pipeline_id, identity_key) DO UPDATE SET
        suitecrm_id = COALESCE(crm_organizations.suitecrm_id, EXCLUDED.suitecrm_id),
        source_key = EXCLUDED.source_key,
        parent_organization_id = EXCLUDED.parent_organization_id,
        workspace_organization_id = EXCLUDED.workspace_organization_id,
        relationship_type = EXCLUDED.relationship_type,
        source_sheet_id = COALESCE(EXCLUDED.source_sheet_id, crm_organizations.source_sheet_id),
        source_row_number = COALESCE(EXCLUDED.source_row_number, crm_organizations.source_row_number),
        priority = EXCLUDED.priority,
        name = EXCLUDED.name,
        account_type = EXCLUDED.account_type,
        account_manager = EXCLUDED.account_manager,
        website = EXCLUDED.website,
        linkedin_url = EXCLUDED.linkedin_url,
        phone = EXCLUDED.phone,
        billing_address_street = EXCLUDED.billing_address_street,
        billing_address_city = EXCLUDED.billing_address_city,
        billing_address_state = EXCLUDED.billing_address_state,
        billing_address_postal_code = EXCLUDED.billing_address_postal_code,
        billing_address_country = EXCLUDED.billing_address_country,
        description = EXCLUDED.description,
        source_payload = EXCLUDED.source_payload,
        source_hash = EXCLUDED.source_hash,
        sync_status = CASE WHEN crm_organizations.source_hash IS DISTINCT FROM EXCLUDED.source_hash THEN 'pending' ELSE crm_organizations.sync_status END,
        sync_error = CASE WHEN crm_organizations.source_hash IS DISTINCT FROM EXCLUDED.source_hash THEN NULL ELSE crm_organizations.sync_error END,
        updated_by = EXCLUDED.updated_by,
        updated_at = now()
      RETURNING id::text, suitecrm_id
    `,
    [
      input.pipelineId, suiteCrmId, identityKey, fields.parentOrganizationId || null,
      fields.workspaceOrganizationId || null, relationshipType, input.sourceSheetId || null,
      input.sourceRowNumber || null, nullable(fields.priority), clean(fields.name), nullable(fields.accountType),
      nullable(fields.accountManager), nullable(fields.website), nullable(fields.linkedinUrl), nullable(fields.phone),
      nullable(fields.address), nullable(fields.city), nullable(fields.state), nullable(fields.postalCode),
      nullable(fields.country), nullable(fields.description), JSON.stringify(input.sourcePayload || {}), sourceHash,
      input.actorEmail,
    ],
  )
  return result.rows[0]
}

async function stageContact(
  client: PoolClient,
  input: StageContactInput,
  suiteCrmId: string,
  sourceHash: string,
  identityKey: string,
) {
  const fields = input.fields
  if (input.localId) {
    const updated = await client.query<{ id: string; suitecrm_id: string }>(
      `UPDATE crm_contacts SET
         organization_id = $3::uuid, suitecrm_id = COALESCE(suitecrm_id, $4),
         source_key = $5, identity_key = $5, source_sheet_id = COALESCE($6, source_sheet_id),
         source_row_number = COALESCE($7, source_row_number), priority = $8,
         first_name = $9, last_name = $10, full_name = $11, contact_type = $12,
         account_manager = $13, job_title = $14, email = $15, linkedin_url = $16,
         phone_work = $17, phone_mobile = $18, primary_address_street = $19,
         primary_address_city = $20, primary_address_state = $21,
         primary_address_postal_code = $22, primary_address_country = $23,
         description = $24, source_payload = $25::jsonb,
         sync_status = CASE WHEN source_hash IS DISTINCT FROM $26 THEN 'pending' ELSE sync_status END,
         sync_error = CASE WHEN source_hash IS DISTINCT FROM $26 THEN NULL ELSE sync_error END,
         source_hash = $26, updated_by = $27, updated_at = now()
       WHERE pipeline_id = $1::uuid AND id = $2::uuid
       RETURNING id::text, suitecrm_id`,
      [
        input.pipelineId, input.localId, fields.organizationId || null, suiteCrmId, identityKey,
        input.sourceSheetId || null, input.sourceRowNumber || null, nullable(fields.priority),
        nullable(fields.firstName), nullable(fields.lastName), clean(fields.fullName), nullable(fields.contactType),
        nullable(fields.accountManager), nullable(fields.jobTitle), nullable(fields.email), nullable(fields.linkedinUrl),
        nullable(fields.phoneWork), nullable(fields.phoneMobile), nullable(fields.address), nullable(fields.city),
        nullable(fields.state), nullable(fields.postalCode), nullable(fields.country), nullable(fields.description),
        JSON.stringify(input.sourcePayload || {}), sourceHash, input.actorEmail,
      ],
    )
    if (!updated.rows[0]) throw new Error('CRM contact was not found')
    return updated.rows[0]
  }
  const result = await client.query<{ id: string; suitecrm_id: string }>(
    `
      INSERT INTO crm_contacts (
        pipeline_id, organization_id, suitecrm_id, source_key, identity_key, source_sheet_id, source_row_number,
        priority, first_name, last_name, full_name, contact_type, account_manager, job_title,
        email, linkedin_url, phone_work, phone_mobile, primary_address_street,
        primary_address_city, primary_address_state, primary_address_postal_code,
        primary_address_country, description, source_payload, source_hash,
        sync_status, sync_error, created_by, updated_by
      )
      VALUES (
        $1::uuid, $2::uuid, $3, $4, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
        $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24::jsonb, $25,
        'pending', NULL, $26, $26
      )
      ON CONFLICT (pipeline_id, identity_key) DO UPDATE SET
        organization_id = EXCLUDED.organization_id,
        suitecrm_id = COALESCE(crm_contacts.suitecrm_id, EXCLUDED.suitecrm_id),
        source_key = EXCLUDED.source_key,
        source_sheet_id = COALESCE(EXCLUDED.source_sheet_id, crm_contacts.source_sheet_id),
        source_row_number = COALESCE(EXCLUDED.source_row_number, crm_contacts.source_row_number),
        priority = EXCLUDED.priority,
        first_name = EXCLUDED.first_name,
        last_name = EXCLUDED.last_name,
        full_name = EXCLUDED.full_name,
        contact_type = EXCLUDED.contact_type,
        account_manager = EXCLUDED.account_manager,
        job_title = EXCLUDED.job_title,
        email = EXCLUDED.email,
        linkedin_url = EXCLUDED.linkedin_url,
        phone_work = EXCLUDED.phone_work,
        phone_mobile = EXCLUDED.phone_mobile,
        primary_address_street = EXCLUDED.primary_address_street,
        primary_address_city = EXCLUDED.primary_address_city,
        primary_address_state = EXCLUDED.primary_address_state,
        primary_address_postal_code = EXCLUDED.primary_address_postal_code,
        primary_address_country = EXCLUDED.primary_address_country,
        description = EXCLUDED.description,
        source_payload = EXCLUDED.source_payload,
        source_hash = EXCLUDED.source_hash,
        sync_status = CASE WHEN crm_contacts.source_hash IS DISTINCT FROM EXCLUDED.source_hash THEN 'pending' ELSE crm_contacts.sync_status END,
        sync_error = CASE WHEN crm_contacts.source_hash IS DISTINCT FROM EXCLUDED.source_hash THEN NULL ELSE crm_contacts.sync_error END,
        updated_by = EXCLUDED.updated_by,
        updated_at = now()
      RETURNING id::text, suitecrm_id
    `,
    [
      input.pipelineId, fields.organizationId || null, suiteCrmId, identityKey, input.sourceSheetId || null,
      input.sourceRowNumber || null, nullable(fields.priority), nullable(fields.firstName), nullable(fields.lastName),
      clean(fields.fullName), nullable(fields.contactType), nullable(fields.accountManager), nullable(fields.jobTitle),
      nullable(fields.email), nullable(fields.linkedinUrl), nullable(fields.phoneWork), nullable(fields.phoneMobile),
      nullable(fields.address), nullable(fields.city), nullable(fields.state), nullable(fields.postalCode), nullable(fields.country),
      nullable(fields.description), JSON.stringify(input.sourcePayload || {}), sourceHash, input.actorEmail,
    ],
  )
  return result.rows[0]
}

async function stageOpportunity(client: PoolClient, input: StageOpportunityInput, suiteCrmId: string, sourceHash: string) {
  const fields = input.fields
  const result = await client.query<{ id: string; suitecrm_id: string }>(
    `
      INSERT INTO crm_opportunities (
        pipeline_id, organization_id, suitecrm_id, source_key, source_sheet_id, source_row_number,
        priority, name, owner_name, organization_name, status, stage, loss_reason, lead_source,
        amount, probability, expected_close, description, source_payload, source_hash,
        sync_status, sync_error, created_by, updated_by
      )
      VALUES (
        $1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
        $15, $16, $17::date, $18, $19::jsonb, $20, 'pending', NULL, $21, $21
      )
      ON CONFLICT (pipeline_id, source_key) DO UPDATE SET
        organization_id = EXCLUDED.organization_id,
        suitecrm_id = COALESCE(crm_opportunities.suitecrm_id, EXCLUDED.suitecrm_id),
        source_sheet_id = EXCLUDED.source_sheet_id,
        source_row_number = EXCLUDED.source_row_number,
        priority = EXCLUDED.priority,
        name = EXCLUDED.name,
        owner_name = EXCLUDED.owner_name,
        organization_name = EXCLUDED.organization_name,
        status = EXCLUDED.status,
        stage = EXCLUDED.stage,
        loss_reason = EXCLUDED.loss_reason,
        lead_source = EXCLUDED.lead_source,
        amount = EXCLUDED.amount,
        probability = EXCLUDED.probability,
        expected_close = EXCLUDED.expected_close,
        description = EXCLUDED.description,
        source_payload = EXCLUDED.source_payload,
        source_hash = EXCLUDED.source_hash,
        sync_status = CASE WHEN crm_opportunities.source_hash IS DISTINCT FROM EXCLUDED.source_hash THEN 'pending' ELSE crm_opportunities.sync_status END,
        sync_error = CASE WHEN crm_opportunities.source_hash IS DISTINCT FROM EXCLUDED.source_hash THEN NULL ELSE crm_opportunities.sync_error END,
        updated_by = EXCLUDED.updated_by,
        updated_at = now()
      RETURNING id::text, suitecrm_id
    `,
    [
      input.pipelineId, fields.organizationId || null, suiteCrmId, input.sourceKey, input.sourceSheetId || null,
      input.sourceRowNumber || null, nullable(fields.priority), clean(fields.name), nullable(fields.owner),
      nullable(fields.organization), nullable(fields.status), nullable(fields.stage), nullable(fields.lossReason),
      nullable(fields.source), Math.max(0, finite(fields.value)), Math.max(0, Math.min(100, finite(fields.probability))),
      isoDate(fields.expectedClose), nullable(fields.notes), JSON.stringify(input.sourcePayload || {}), sourceHash, input.actorEmail,
    ],
  )
  return result.rows[0]
}

async function stageInteraction(client: PoolClient, input: StageInteractionInput, suiteCrmId: string, sourceHash: string) {
  const fields = input.fields
  const result = await client.query<{ id: string; suitecrm_id: string }>(
    `
      INSERT INTO crm_interactions (
        pipeline_id, organization_id, contact_id, opportunity_id, suitecrm_id,
        source_key, source_sheet_id, source_row_number, interaction_type, subject,
        agent_name, occurred_at, description, source_payload, source_hash,
        sync_status, sync_error, created_by, updated_by
      )
      VALUES (
        $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $8, $9, $10,
        $11, $12::timestamptz, $13, $14::jsonb, $15, 'pending', NULL, $16, $16
      )
      ON CONFLICT (pipeline_id, source_key) DO UPDATE SET
        organization_id = EXCLUDED.organization_id,
        contact_id = EXCLUDED.contact_id,
        opportunity_id = EXCLUDED.opportunity_id,
        suitecrm_id = COALESCE(crm_interactions.suitecrm_id, EXCLUDED.suitecrm_id),
        source_sheet_id = EXCLUDED.source_sheet_id,
        source_row_number = EXCLUDED.source_row_number,
        interaction_type = EXCLUDED.interaction_type,
        subject = EXCLUDED.subject,
        agent_name = EXCLUDED.agent_name,
        occurred_at = EXCLUDED.occurred_at,
        description = EXCLUDED.description,
        source_payload = EXCLUDED.source_payload,
        source_hash = EXCLUDED.source_hash,
        sync_status = CASE WHEN crm_interactions.source_hash IS DISTINCT FROM EXCLUDED.source_hash THEN 'pending' ELSE crm_interactions.sync_status END,
        sync_error = CASE WHEN crm_interactions.source_hash IS DISTINCT FROM EXCLUDED.source_hash THEN NULL ELSE crm_interactions.sync_error END,
        updated_by = EXCLUDED.updated_by,
        updated_at = now()
      RETURNING id::text, suitecrm_id
    `,
    [
      input.pipelineId, fields.organizationId || null, fields.contactId || null, fields.opportunityId || null,
      suiteCrmId, input.sourceKey, input.sourceSheetId || null, input.sourceRowNumber || null,
      nullable(fields.interactionType), clean(fields.subject), nullable(fields.agentName), nullable(fields.occurredAt),
      nullable(fields.description), JSON.stringify(input.sourcePayload || {}), sourceHash, input.actorEmail,
    ],
  )
  return result.rows[0]
}

export async function stageCrmRecordInPostgres(input: StageCrmRecordInput) {
  const identityKey = input.entity === 'organizations'
    ? organizationIdentityKey(input.fields)
    : input.entity === 'contacts'
      ? contactIdentityKey(input.fields)
      : null
  const sourceKey = identityKey || clean(input.sourceKey)
  if (!sourceKey || sourceKey.length > 500) throw new Error('CRM source key is invalid')
  const suiteCrmId = input.entity === 'organizations' && input.fields.workspaceOrganizationId
    ? stableGlobalSuiteCrmId(input.entity, sourceKey)
    : stableSuiteCrmId(input.pipelineId, input.entity, sourceKey)
  const sourceHash = crmSourceHash({ fields: input.fields, sourcePayload: input.sourcePayload || {} })
  return withTransaction(async (client) => {
    const row = input.entity === 'organizations'
      ? await stageOrganization(client, input, suiteCrmId, sourceHash, sourceKey)
      : input.entity === 'contacts'
        ? await stageContact(client, input, suiteCrmId, sourceHash, sourceKey)
        : input.entity === 'opportunities'
          ? await stageOpportunity(client, input, suiteCrmId, sourceHash)
          : await stageInteraction(client, input, suiteCrmId, sourceHash)
    await enqueueSuiteCrmRecord(client, input, row.id, row.suitecrm_id, sourceHash)
    await client.query(
      `INSERT INTO audit_events (actor, event_type, aggregate_type, aggregate_id, payload)
       VALUES ($1, 'crm.record.staged', $2, $3, $4::jsonb)`,
      [input.actorEmail, `crm_${input.entity}`, row.id, JSON.stringify({ pipelineId: input.pipelineId, sourceKey })],
    )
    return { id: row.id, suiteCrmId: row.suitecrm_id, sourceHash }
  })
}

export async function ensurePipelineCrmHierarchy(input: {
  pipelineId: string
  actorEmail: string
}) {
  const pipelineResult = await query<{
    owner_email: string
    workspace_organization_id: string | null
  }>(
    `SELECT owner_email, workspace_organization_id::text
     FROM pipeline_spaces
     WHERE id = $1::uuid
     LIMIT 1`,
    [input.pipelineId],
  )
  const pipeline = pipelineResult.rows[0]
  if (!pipeline) throw new Error('Pipeline was not found')

  let workspaceOrganizationId = pipeline.workspace_organization_id
  if (!workspaceOrganizationId) {
    const organization = await ensurePrimaryWorkspaceOrganization(pipeline.owner_email)
    workspaceOrganizationId = organization.id
    await query(
      `UPDATE pipeline_spaces
       SET workspace_organization_id = $2::uuid, updated_at = now()
       WHERE id = $1::uuid`,
      [input.pipelineId, workspaceOrganizationId],
    )
  }

  const lineage = await workspaceOrganizationAncestors(workspaceOrganizationId)
  if (lineage.length === 0) throw new Error('Pipeline organization hierarchy was not found')
  const staged: Array<{
    id: string
    suiteCrmId: string
    workspaceOrganizationId: string
    name: string
  }> = []
  let parent: { id: string; suiteCrmId: string } | null = null
  for (const organization of lineage) {
    const row = await stageCrmRecordInPostgres({
      entity: 'organizations',
      pipelineId: input.pipelineId,
      sourceKey: `workspace:${organization.id}`,
      actorEmail: input.actorEmail,
      sourcePayload: { source: 'clawpilot_workspace', workspaceOrganizationId: organization.id },
      fields: {
        name: organization.name,
        workspaceOrganizationId: organization.id,
        parentOrganizationId: parent?.id || null,
        parentOrganizationSuiteCrmId: parent?.suiteCrmId || null,
        relationshipType: organization.organizationType === 'root' ? 'workspace_root' : 'workspace_member',
        accountType: organization.organizationType === 'root' ? 'Parent organization' : 'Member organization',
      },
    })
    parent = row
    staged.push({ ...row, workspaceOrganizationId: organization.id, name: organization.name })
  }
  const customerParent = staged[staged.length - 1]
  const customers = await query<Record<string, unknown>>(
    `SELECT *
     FROM crm_organizations
     WHERE pipeline_id = $1::uuid
       AND relationship_type = 'customer'
       AND parent_organization_id IS DISTINCT FROM $2::uuid`,
    [input.pipelineId, customerParent.id],
  )
  for (const customer of customers.rows) {
    await stageCrmRecordInPostgres({
      entity: 'organizations',
      pipelineId: input.pipelineId,
      localId: String(customer.id),
      sourceKey: String(customer.source_key),
      sourceSheetId: nullable(customer.source_sheet_id),
      sourceRowNumber: customer.source_row_number === null ? null : Number(customer.source_row_number),
      sourcePayload: customer.source_payload as Record<string, unknown>,
      actorEmail: input.actorEmail,
      fields: {
        parentOrganizationId: customerParent.id,
        parentOrganizationSuiteCrmId: customerParent.suiteCrmId,
        relationshipType: 'customer',
        priority: clean(customer.priority),
        name: clean(customer.name),
        accountType: clean(customer.account_type),
        accountManager: clean(customer.account_manager),
        website: clean(customer.website),
        linkedinUrl: clean(customer.linkedin_url),
        phone: clean(customer.phone),
        address: clean(customer.billing_address_street),
        city: clean(customer.billing_address_city),
        state: clean(customer.billing_address_state),
        postalCode: clean(customer.billing_address_postal_code),
        country: clean(customer.billing_address_country),
        description: clean(customer.description),
      },
    })
  }
  return { lineage: staged, customerParent }
}

function organizationFromRow(row: Record<string, unknown>): CrmOrganization {
  return {
    id: String(row.id), pipelineId: String(row.pipeline_id),
    parentOrganizationId: nullable(row.parent_organization_id),
    parentOrganizationName: clean(row.parent_organization_name),
    workspaceOrganizationId: nullable(row.workspace_organization_id),
    relationshipType: (row.relationship_type || 'customer') as CrmOrganization['relationshipType'],
    suiteCrmId: nullable(row.suitecrm_id),
    sourceKey: String(row.source_key), sourceRowNumber: row.source_row_number === null ? null : Number(row.source_row_number),
    priority: clean(row.priority), name: clean(row.name), accountType: clean(row.account_type), accountManager: clean(row.account_manager),
    website: clean(row.website), linkedinUrl: clean(row.linkedin_url), phone: clean(row.phone), address: clean(row.billing_address_street),
    city: clean(row.billing_address_city), state: clean(row.billing_address_state), postalCode: clean(row.billing_address_postal_code),
    country: clean(row.billing_address_country), description: clean(row.description), syncStatus: row.sync_status as CrmOrganization['syncStatus'],
    syncError: nullable(row.sync_error), updatedAt: String(row.updated_at),
  }
}

function contactFromRow(row: Record<string, unknown>): CrmContact {
  return {
    id: String(row.id), pipelineId: String(row.pipeline_id), organizationId: nullable(row.organization_id),
    organizationName: clean(row.organization_name), suiteCrmId: nullable(row.suitecrm_id), sourceKey: String(row.source_key),
    sourceRowNumber: row.source_row_number === null ? null : Number(row.source_row_number), priority: clean(row.priority),
    firstName: clean(row.first_name), lastName: clean(row.last_name), fullName: clean(row.full_name), contactType: clean(row.contact_type),
    accountManager: clean(row.account_manager), jobTitle: clean(row.job_title), email: clean(row.email), linkedinUrl: clean(row.linkedin_url),
    phoneWork: clean(row.phone_work), phoneMobile: clean(row.phone_mobile), address: clean(row.primary_address_street),
    city: clean(row.primary_address_city), state: clean(row.primary_address_state), postalCode: clean(row.primary_address_postal_code),
    country: clean(row.primary_address_country), description: clean(row.description), syncStatus: row.sync_status as CrmContact['syncStatus'],
    syncError: nullable(row.sync_error), updatedAt: String(row.updated_at),
  }
}

function opportunityFromRow(row: Record<string, unknown>): CrmOpportunity {
  return {
    id: String(row.id), pipelineId: String(row.pipeline_id), organizationId: nullable(row.organization_id), suiteCrmId: nullable(row.suitecrm_id),
    sourceKey: String(row.source_key), sourceRowNumber: row.source_row_number === null ? null : Number(row.source_row_number),
    priority: clean(row.priority), name: clean(row.name), owner: clean(row.owner_name), organization: clean(row.organization_name),
    status: clean(row.status), stage: clean(row.stage), lossReason: clean(row.loss_reason), source: clean(row.lead_source),
    value: finite(row.amount), probability: finite(row.probability), expectedClose: row.expected_close ? String(row.expected_close).slice(0, 10) : '',
    notes: clean(row.description), syncStatus: row.sync_status as CrmOpportunity['syncStatus'], syncError: nullable(row.sync_error),
    updatedAt: String(row.updated_at),
  }
}

function interactionFromRow(row: Record<string, unknown>): CrmInteraction {
  return {
    id: String(row.id), pipelineId: String(row.pipeline_id), organizationId: nullable(row.organization_id), contactId: nullable(row.contact_id),
    opportunityId: nullable(row.opportunity_id), suiteCrmId: nullable(row.suitecrm_id), sourceKey: String(row.source_key),
    sourceRowNumber: row.source_row_number === null ? null : Number(row.source_row_number), interactionType: clean(row.interaction_type),
    subject: clean(row.subject), agentName: clean(row.agent_name), occurredAt: row.occurred_at ? String(row.occurred_at) : null,
    description: clean(row.description), syncStatus: row.sync_status as CrmInteraction['syncStatus'], syncError: nullable(row.sync_error),
    updatedAt: String(row.updated_at),
  }
}

export async function listCrmRecordsInPostgres(input: {
  pipelineId: string
  entity: CrmEntity
  query?: string
  limit?: number
}): Promise<CrmRecord[]> {
  const search = clean(input.query).slice(0, 200)
  const limit = Math.max(1, Math.min(Math.trunc(Number(input.limit) || 250), 1000))
  if (input.entity === 'organizations') {
    const result = await query<Record<string, unknown>>(
      `SELECT organization.*, parent.name AS parent_organization_name
       FROM crm_organizations organization
       LEFT JOIN crm_organizations parent ON parent.id = organization.parent_organization_id
       WHERE organization.pipeline_id = $1::uuid
         AND ($2 = '' OR organization.name ILIKE '%' || $2 || '%'
           OR organization.account_type ILIKE '%' || $2 || '%'
           OR parent.name ILIKE '%' || $2 || '%')
       ORDER BY
         CASE organization.relationship_type WHEN 'workspace_root' THEN 0 WHEN 'workspace_member' THEN 1 ELSE 2 END,
         organization.name, organization.id
       LIMIT $3`,
      [input.pipelineId, search, limit],
    )
    return result.rows.map(organizationFromRow)
  }
  if (input.entity === 'contacts') {
    const result = await query<Record<string, unknown>>(
      `SELECT contact.*, organization.name AS organization_name
       FROM crm_contacts contact LEFT JOIN crm_organizations organization ON organization.id = contact.organization_id
       WHERE contact.pipeline_id = $1::uuid AND ($2 = '' OR contact.full_name ILIKE '%' || $2 || '%' OR contact.email ILIKE '%' || $2 || '%' OR organization.name ILIKE '%' || $2 || '%')
       ORDER BY contact.full_name, contact.id LIMIT $3`,
      [input.pipelineId, search, limit],
    )
    return result.rows.map(contactFromRow)
  }
  if (input.entity === 'opportunities') {
    const result = await query<Record<string, unknown>>(
      `SELECT * FROM crm_opportunities
       WHERE pipeline_id = $1::uuid AND ($2 = '' OR name ILIKE '%' || $2 || '%' OR organization_name ILIKE '%' || $2 || '%')
       ORDER BY updated_at DESC, id LIMIT $3`,
      [input.pipelineId, search, limit],
    )
    return result.rows.map(opportunityFromRow)
  }
  const result = await query<Record<string, unknown>>(
    `SELECT * FROM crm_interactions
     WHERE pipeline_id = $1::uuid AND ($2 = '' OR subject ILIKE '%' || $2 || '%' OR description ILIKE '%' || $2 || '%')
     ORDER BY occurred_at DESC NULLS LAST, updated_at DESC, id LIMIT $3`,
    [input.pipelineId, search, limit],
  )
  return result.rows.map(interactionFromRow)
}

export async function readCrmSummaryFromPostgres(pipelineId: string): Promise<CrmSummary> {
  const result = await query<Record<string, string>>(
    `
      SELECT
        (SELECT count(*) FROM crm_organizations WHERE pipeline_id = $1::uuid)::text AS organizations,
        (SELECT count(*) FROM crm_contacts WHERE pipeline_id = $1::uuid)::text AS contacts,
        (SELECT count(*) FROM crm_opportunities WHERE pipeline_id = $1::uuid)::text AS opportunities,
        (SELECT count(*) FROM crm_interactions WHERE pipeline_id = $1::uuid)::text AS interactions,
        (SELECT COALESCE(sum(amount), 0) FROM crm_opportunities WHERE pipeline_id = $1::uuid AND lower(COALESCE(status, '')) NOT IN ('won', 'lost', 'closed', 'abandoned'))::text AS open_pipeline_value,
        (SELECT COALESCE(sum(amount * probability / 100), 0) FROM crm_opportunities WHERE pipeline_id = $1::uuid AND lower(COALESCE(status, '')) NOT IN ('won', 'lost', 'closed', 'abandoned'))::text AS weighted_pipeline_value,
        (SELECT count(*) FROM (
          SELECT sync_status FROM crm_organizations WHERE pipeline_id = $1::uuid
          UNION ALL SELECT sync_status FROM crm_contacts WHERE pipeline_id = $1::uuid
          UNION ALL SELECT sync_status FROM crm_opportunities WHERE pipeline_id = $1::uuid
          UNION ALL SELECT sync_status FROM crm_interactions WHERE pipeline_id = $1::uuid
        ) records WHERE sync_status IN ('pending', 'syncing'))::text AS pending_sync,
        (SELECT count(*) FROM (
          SELECT sync_status FROM crm_organizations WHERE pipeline_id = $1::uuid
          UNION ALL SELECT sync_status FROM crm_contacts WHERE pipeline_id = $1::uuid
          UNION ALL SELECT sync_status FROM crm_opportunities WHERE pipeline_id = $1::uuid
          UNION ALL SELECT sync_status FROM crm_interactions WHERE pipeline_id = $1::uuid
        ) records WHERE sync_status = 'failed')::text AS failed_sync
    `,
    [pipelineId],
  )
  const row = result.rows[0] || {}
  return {
    organizations: finite(row.organizations), contacts: finite(row.contacts), opportunities: finite(row.opportunities),
    interactions: finite(row.interactions), openPipelineValue: finite(row.open_pipeline_value),
    weightedPipelineValue: finite(row.weighted_pipeline_value), pendingSync: finite(row.pending_sync), failedSync: finite(row.failed_sync),
  }
}

export async function readCrmRecordReference(input: {
  pipelineId: string
  entity: CrmEntity
  id: string
}) {
  const table = ENTITY_TABLE[input.entity]
  const result = await query<Record<string, unknown>>(
    `SELECT id::text, source_key, suitecrm_id,
       COALESCE(to_jsonb(record)->>'name', to_jsonb(record)->>'full_name', to_jsonb(record)->>'subject') AS display_name,
       COALESCE(to_jsonb(record)->>'organization_name', '') AS organization_name,
       to_jsonb(record)->>'workspace_organization_id' AS workspace_organization_id,
       to_jsonb(record)->>'parent_organization_id' AS parent_organization_id,
       COALESCE(to_jsonb(record)->>'relationship_type', '') AS relationship_type
     FROM ${table} record WHERE pipeline_id = $1::uuid AND id = $2::uuid LIMIT 1`,
    [input.pipelineId, input.id],
  )
  const row = result.rows[0]
  if (!row) throw new Error('CRM record not found')
  return {
    id: String(row.id),
    sourceKey: String(row.source_key),
    suiteCrmId: nullable(row.suitecrm_id),
    name: clean(row.display_name),
    organizationName: clean(row.organization_name),
    workspaceOrganizationId: nullable(row.workspace_organization_id),
    parentOrganizationId: nullable(row.parent_organization_id),
    relationshipType: clean(row.relationship_type),
  }
}

export async function claimSuiteCrmOutboxInPostgres(input: { limit?: number; maxAttempts?: number; leaseSeconds?: number } = {}) {
  const limit = Math.max(1, Math.min(Math.trunc(Number(input.limit) || 10), 50))
  const maxAttempts = Math.max(1, Math.min(Math.trunc(Number(input.maxAttempts) || 8), 20))
  const leaseSeconds = Math.max(60, Math.min(Math.trunc(Number(input.leaseSeconds) || 300), 1800))
  const lockToken = crypto.randomUUID()
  return withTransaction(async (client) => {
    await client.query(
      `UPDATE sync_outbox SET status = 'failed', last_error = COALESCE(last_error, 'SuiteCRM worker lease expired'),
       available_at = now(), locked_at = NULL, lock_token = NULL, updated_at = now()
       WHERE target_system = 'suitecrm' AND status = 'processing'
       AND (locked_at IS NULL OR locked_at < now() - ($1::text || ' seconds')::interval)`,
      [leaseSeconds],
    )
    const result = await client.query<Record<string, unknown>>(
      `WITH candidates AS (
         SELECT id FROM sync_outbox
         WHERE target_system = 'suitecrm' AND operation IN ('upsert_record', 'delete_record')
           AND status IN ('queued', 'failed') AND attempts < $1 AND available_at <= now()
         ORDER BY available_at, created_at FOR UPDATE SKIP LOCKED LIMIT $2
       )
       UPDATE sync_outbox outbox SET status = 'processing', attempts = outbox.attempts + 1,
         locked_at = now(), lock_token = $3, updated_at = now()
       FROM candidates WHERE outbox.id = candidates.id
       RETURNING outbox.id::text, outbox.aggregate_type, outbox.aggregate_id, outbox.operation,
         outbox.payload, outbox.attempts, outbox.lock_token`,
      [maxAttempts, limit, lockToken],
    )
    for (const row of result.rows) {
      const entity = String(row.aggregate_type).replace(/^crm_/, '') as CrmEntity
      const table = ENTITY_TABLE[entity]
      if (table && row.operation === 'upsert_record') {
        await client.query(
          `UPDATE ${table} SET sync_status = 'syncing', sync_error = NULL, updated_at = now() WHERE id = $1::uuid`,
          [row.aggregate_id],
        )
      }
    }
    return result.rows.map((row) => ({
      id: String(row.id), aggregateType: String(row.aggregate_type), aggregateId: String(row.aggregate_id),
      operation: row.operation as CrmOutboxItem['operation'], payload: row.payload as SuiteCrmOutboxRecord,
      attempts: Number(row.attempts), lockToken: String(row.lock_token),
    } satisfies CrmOutboxItem))
  })
}

function tableForAggregate(aggregateType: string) {
  const entity = aggregateType.replace(/^crm_/, '') as CrmEntity
  return ENTITY_TABLE[entity] || null
}

export async function completeSuiteCrmOutboxInPostgres(item: CrmOutboxItem) {
  return withTransaction(async (client) => {
    const completed = await client.query(
      `UPDATE sync_outbox SET status = 'succeeded', processed_at = now(), last_error = NULL,
       locked_at = NULL, lock_token = NULL, updated_at = now()
       WHERE id = $1::uuid AND status = 'processing' AND lock_token = $2 RETURNING aggregate_type, aggregate_id`,
      [item.id, item.lockToken],
    )
    if (!completed.rows[0]) throw new Error('SuiteCRM outbox lease was lost')
    const table = tableForAggregate(item.aggregateType)
    if (table && item.operation === 'upsert_record') {
      await client.query(
        `UPDATE ${table} SET sync_status = 'synced', sync_error = NULL, suitecrm_synced_at = now(), updated_at = now() WHERE id = $1::uuid`,
        [item.aggregateId],
      )
      await client.query(
        `UPDATE pipeline_spaces SET crm_last_synced_at = now(), updated_at = now()
         WHERE id = (SELECT pipeline_id FROM ${table} WHERE id = $1::uuid)`,
        [item.aggregateId],
      )
    } else if (item.operation === 'delete_record') {
      await client.query(
        `UPDATE pipeline_spaces SET crm_last_synced_at = now(), updated_at = now() WHERE id = $1::uuid`,
        [item.payload.pipelineId],
      )
    }
  })
}

export async function failSuiteCrmOutboxInPostgres(input: { item: CrmOutboxItem; error: string; maxAttempts?: number }) {
  const maxAttempts = Math.max(1, Math.min(Math.trunc(Number(input.maxAttempts) || 8), 20))
  const message = clean(input.error).slice(0, 500) || 'SuiteCRM synchronization failed'
  return withTransaction(async (client) => {
    const dead = input.item.attempts >= maxAttempts
    const result = await client.query<{ status: 'failed' | 'dead' }>(
      `UPDATE sync_outbox SET status = $3, last_error = $4,
       available_at = CASE WHEN $3 = 'failed' THEN now() + (LEAST(300, power(2, GREATEST(attempts, 1)))::text || ' seconds')::interval ELSE available_at END,
       processed_at = CASE WHEN $3 = 'dead' THEN now() ELSE NULL END,
       locked_at = NULL, lock_token = NULL, updated_at = now()
       WHERE id = $1::uuid AND status = 'processing' AND lock_token = $2 RETURNING status`,
      [input.item.id, input.item.lockToken, dead ? 'dead' : 'failed', message],
    )
    if (!result.rows[0]) throw new Error('SuiteCRM outbox lease was lost')
    const table = tableForAggregate(input.item.aggregateType)
    if (table && input.item.operation === 'upsert_record') {
      await client.query(`UPDATE ${table} SET sync_status = 'failed', sync_error = $2, updated_at = now() WHERE id = $1::uuid`, [input.item.aggregateId, message])
    }
    return result.rows[0].status
  })
}

export async function writeSuiteCrmWorkerHeartbeat(input: Record<string, unknown>) {
  await query(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ('crm.outbox.worker.heartbeat', $1::jsonb, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
    [JSON.stringify({ ...input, checkedAt: new Date().toISOString() })],
  )
}

export async function readSuiteCrmWorkerHeartbeat() {
  const result = await query<{ value: Record<string, unknown> }>(
    "SELECT value FROM app_settings WHERE key = 'crm.outbox.worker.heartbeat' LIMIT 1",
  )
  return result.rows[0]?.value || null
}

export async function readCrmWorkbookProjectionContext(pipelineId: string) {
  const result = await query<{ id: string; sheet_id: string; owner_email: string }>(
    `SELECT id::text, sheet_id, owner_email
     FROM pipeline_spaces
     WHERE id = $1::uuid AND sync_enabled = true AND sheet_id IS NOT NULL
     LIMIT 1`,
    [pipelineId],
  )
  const row = result.rows[0]
  return row ? { pipelineId: row.id, sheetId: row.sheet_id, ownerEmail: row.owner_email } : null
}

export async function readCrmWorkbookProjectionReadiness(pipelineId: string) {
  const result = await query<{ unresolved: string; import_status: string | null }>(
    `SELECT
       (
         SELECT count(*)::text
         FROM sync_outbox
         WHERE target_system = 'suitecrm'
           AND payload->>'pipelineId' = $1::text
           AND status <> 'succeeded'
       ) AS unresolved,
       (
         SELECT status
         FROM crm_sync_runs
         WHERE pipeline_id = $1::uuid AND direction = 'sheet_to_crm'
         ORDER BY started_at DESC, id DESC
         LIMIT 1
       ) AS import_status`,
    [pipelineId],
  )
  const row = result.rows[0]
  const unresolved = Number(row?.unresolved || 0)
  const importStatus = row?.import_status || null
  return {
    ready: unresolved === 0 && importStatus !== 'running' && importStatus !== 'failed',
    unresolved,
    importStatus,
  }
}

export async function beginCrmSyncRun(input: {
  pipelineId: string
  direction: 'sheet_to_crm' | 'crm_to_sheet' | 'reconcile'
  sourceSystem: string
  targetSystem: string
  actorEmail: string
}) {
  const result = await query<{ id: string }>(
    `INSERT INTO crm_sync_runs (pipeline_id, direction, source_system, target_system, started_by)
     VALUES ($1::uuid, $2, $3, $4, $5) RETURNING id::text`,
    [input.pipelineId, input.direction, input.sourceSystem, input.targetSystem, input.actorEmail],
  )
  return result.rows[0].id
}

export async function finishCrmSyncRun(input: {
  id: string
  status: 'succeeded' | 'failed'
  counts?: Record<string, number>
  error?: string | null
}) {
  await query(
    `UPDATE crm_sync_runs SET status = $2, counts = $3::jsonb, error = $4, finished_at = now()
     WHERE id = $1::uuid AND status = 'running'`,
    [input.id, input.status, JSON.stringify(input.counts || {}), nullable(input.error)?.slice(0, 1000) || null],
  )
}
