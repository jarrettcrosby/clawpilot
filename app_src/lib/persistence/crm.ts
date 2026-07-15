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
  CrmCampaign,
  CrmEntity,
  CrmInteraction,
  CrmLead,
  CrmMeeting,
  CrmOpportunity,
  CrmOrganization,
  CrmRecord,
  CrmSummary,
  SuiteCrmOutboxRecord,
} from '@/lib/crm/types'
import { isPostgresStorageEnabled } from '@/lib/persistence/config'
import { query, withTransaction } from '@/lib/persistence/postgres'
import { appPublicUrl } from '@/lib/publicUrl'
import { shortLinkUrl } from '@/lib/shortlinks'
import {
  ensurePrimaryWorkspaceOrganization,
  workspaceOrganizationAncestors,
} from '@/lib/organizations'
import { requireActiveAppUser } from '@/lib/users'
import { zonedDateTimeToIso } from '@/lib/zonedDateTime'

const ENTITY_TABLE: Record<CrmEntity, string> = {
  organizations: 'crm_organizations',
  contacts: 'crm_contacts',
  leads: 'crm_leads',
  opportunities: 'crm_opportunities',
  meetings: 'crm_meetings',
  interactions: 'crm_interactions',
  campaigns: 'crm_campaigns',
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
    workspaceOrganizationReferenceCode?: string | null
    relationshipType?: 'workspace_root' | 'workspace_member' | 'customer'
    priority?: string
    name: string
    accountType?: string
    accountManager?: string
    website?: string
    linkedinUrl?: string
    phone?: string
    email?: string
    emailOptOut?: boolean
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
    appUserEmail?: string | null
    appUserReferenceCode?: string | null
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
    emailOptOut?: boolean
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

export type StageLeadInput = CommonStageInput & {
  entity: 'leads'
  fields: {
    organizationId?: string | null
    organizationSuiteCrmId?: string | null
    convertedContactId?: string | null
    convertedOpportunityId?: string | null
    firstName?: string
    lastName?: string
    fullName: string
    companyName?: string
    jobTitle?: string
    email?: string
    phoneWork?: string
    phoneMobile?: string
    status?: string
    source?: string
    assignedTo?: string
    description?: string
    emailOptOut?: boolean
  }
}

export type StageMeetingInput = CommonStageInput & {
  entity: 'meetings'
  fields: {
    organizationId?: string | null
    organizationSuiteCrmId?: string | null
    contactId?: string | null
    leadId?: string | null
    opportunityId?: string | null
    parentSuiteCrmId?: string | null
    parentSuiteCrmType?: 'Accounts' | 'Contacts' | 'Leads' | 'Opportunities'
    subject: string
    description?: string
    startsAt: string
    endsAt: string
    timezone?: string
    location?: string
    attendeeEmails?: string[]
    status?: CrmMeeting['status']
    provider?: string
    externalEventId?: string | null
    externalEventUrl?: string | null
    joinUrl?: string | null
  }
}

export type StageCampaignInput = CommonStageInput & {
  entity: 'campaigns'
  fields: {
    name: string
    campaignType?: 'email'
    status?: CrmCampaign['status']
    startDate?: string | null
    endDate?: string | null
    subjectTemplate?: string
    bodyTemplate?: string
    senderEmail?: string
    description?: string
  }
}

export type StageInteractionInput = CommonStageInput & {
  entity: 'interactions'
  fields: {
    organizationId?: string | null
    contactId?: string | null
    opportunityId?: string | null
    leadId?: string | null
    meetingId?: string | null
    campaignId?: string | null
    parentSuiteCrmId?: string | null
    parentSuiteCrmType?: 'Accounts' | 'Contacts' | 'Leads' | 'Opportunities' | 'Meetings' | 'Campaigns'
    interactionType?: string
    subject: string
    agentName?: string
    occurredAt?: string | null
    description?: string
    direction?: CrmInteraction['direction']
    deliveryStatus?: string
    providerMessageId?: string | null
    providerThreadId?: string | null
    metadata?: Record<string, unknown>
  }
}

export type StageCrmRecordInput =
  | StageOrganizationInput
  | StageContactInput
  | StageLeadInput
  | StageOpportunityInput
  | StageMeetingInput
  | StageInteractionInput
  | StageCampaignInput

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

function isoTimestamp(value: unknown) {
  const raw = clean(value)
  if (!raw) return null
  const parsed = new Date(raw)
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
}

function suiteCrmDateTime(value: unknown) {
  return isoTimestamp(value)?.replace('T', ' ').replace(/\.\d{3}Z$/, '') || null
}

function suiteCrmAttributes(input: StageCrmRecordInput, referenceCode: string) {
  const globalId = { global_id_c: referenceCode }
  if (input.entity === 'organizations') {
    const fields = input.fields
    return {
      ...globalId,
      name: clean(fields.name),
      account_type: clean(fields.accountType),
      website: clean(fields.website),
      email1: clean(fields.email),
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
      ...globalId,
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
  if (input.entity === 'leads') {
    const fields = input.fields
    return {
      ...globalId,
      first_name: clean(fields.firstName),
      last_name: clean(fields.lastName) || clean(fields.fullName),
      account_name: clean(fields.companyName),
      title: clean(fields.jobTitle),
      email1: clean(fields.email),
      phone_work: clean(fields.phoneWork),
      phone_mobile: clean(fields.phoneMobile),
      status: clean(fields.status),
      lead_source: clean(fields.source),
      description: clean(fields.description),
    }
  }
  if (input.entity === 'opportunities') {
    const fields = input.fields
    return {
      ...globalId,
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
  if (input.entity === 'meetings') {
    const fields = input.fields
    const startsAt = new Date(fields.startsAt)
    const endsAt = new Date(fields.endsAt)
    const duration = Number.isFinite(startsAt.getTime()) && Number.isFinite(endsAt.getTime())
      ? Math.max(1, Math.round((endsAt.getTime() - startsAt.getTime()) / 60_000))
      : 30
    return {
      ...globalId,
      name: clean(fields.subject),
      date_start: suiteCrmDateTime(fields.startsAt),
      duration_hours: Math.floor(duration / 60),
      duration_minutes: duration % 60,
      status: clean(fields.status) === 'completed' ? 'Held' : clean(fields.status) === 'cancelled' ? 'Not Held' : 'Planned',
      location: clean(fields.location),
      parent_type: fields.parentSuiteCrmId ? clean(fields.parentSuiteCrmType) : '',
      parent_id: clean(fields.parentSuiteCrmId),
      description: clean(fields.description),
    }
  }
  if (input.entity === 'campaigns') {
    const fields = input.fields
    const status = clean(fields.status)
    return {
      ...globalId,
      name: clean(fields.name),
      campaign_type: 'Email',
      status: status === 'sent' ? 'Complete' : status === 'draft' ? 'Planning' : status === 'paused' ? 'Inactive' : 'Active',
      start_date: isoDate(fields.startDate),
      end_date: isoDate(fields.endDate),
      content: clean(fields.bodyTemplate),
      description: clean(fields.description),
    }
  }
  const fields = input.fields
  return {
    ...globalId,
    name: clean(fields.subject),
    parent_type: fields.parentSuiteCrmId ? clean(fields.parentSuiteCrmType) : '',
    parent_id: clean(fields.parentSuiteCrmId),
    description: clean(fields.description),
  }
}

async function suiteCrmRelationships(
  client: PoolClient,
  input: StageCrmRecordInput,
): Promise<NonNullable<SuiteCrmOutboxRecord['relationships']>> {
  if (input.entity !== 'meetings') return []
  const fields = input.fields
  const result = await client.query<{
    link_field_name: 'accounts' | 'contacts' | 'leads' | 'opportunity'
    related_module_name: 'Accounts' | 'Contacts' | 'Leads' | 'Opportunities'
    related_bean_id: string
  }>(
    `SELECT 'accounts'::text AS link_field_name, 'Accounts'::text AS related_module_name, suitecrm_id AS related_bean_id
     FROM crm_organizations
     WHERE pipeline_id = $1::uuid AND id = $2::uuid AND suitecrm_id IS NOT NULL
     UNION ALL
     SELECT 'contacts', 'Contacts', suitecrm_id
     FROM crm_contacts
     WHERE pipeline_id = $1::uuid AND id = $3::uuid AND suitecrm_id IS NOT NULL
     UNION ALL
     SELECT 'leads', 'Leads', suitecrm_id
     FROM crm_leads
     WHERE pipeline_id = $1::uuid AND id = $4::uuid AND suitecrm_id IS NOT NULL
     UNION ALL
     SELECT 'opportunity', 'Opportunities', suitecrm_id
     FROM crm_opportunities
     WHERE pipeline_id = $1::uuid AND id = $5::uuid AND suitecrm_id IS NOT NULL`,
    [
      input.pipelineId,
      fields.organizationId || null,
      fields.contactId || null,
      fields.leadId || null,
      fields.opportunityId || null,
    ],
  )
  return result.rows.map((row) => ({
    linkFieldName: row.link_field_name,
    relatedModuleName: row.related_module_name,
    relatedBeanId: row.related_bean_id,
  }))
}

async function enqueueSuiteCrmRecord(
  client: PoolClient,
  input: StageCrmRecordInput,
  localId: string,
  suiteCrmId: string,
  referenceCode: string,
  sourceHash: string,
) {
  const relationships = await suiteCrmRelationships(client, input)
  const payload: SuiteCrmOutboxRecord = {
    entity: input.entity,
    pipelineId: input.pipelineId,
    localId,
    suiteCrmId,
    attributes: suiteCrmAttributes(input, referenceCode),
    ...(relationships.length > 0 ? { relationships } : {}),
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
    [
      `crm_${input.entity}`,
      localId,
      JSON.stringify(payload),
      `crm:${input.entity}:v3:${localId}:${sourceHash}`,
    ],
  )
}

async function applyWorkspaceOrganizationIdentity(
  client: PoolClient,
  row: { id: string; suitecrm_id: string; reference_code: string },
  referenceCode: string | null | undefined,
) {
  if (!referenceCode) return row
  if (!/^ga[0-9]{7}$/.test(referenceCode)) throw new Error('Workspace organization reference is invalid')
  const result = await client.query<{ id: string; suitecrm_id: string; reference_code: string }>(
    `UPDATE crm_organizations
     SET reference_code = $2, updated_at = now()
     WHERE id = $1::uuid
     RETURNING id::text, suitecrm_id, reference_code`,
    [row.id, referenceCode],
  )
  return result.rows[0]
}

async function applyAppUserContactIdentity(
  client: PoolClient,
  row: { id: string; suitecrm_id: string; reference_code: string },
  email: string | null | undefined,
  referenceCode: string | null | undefined,
) {
  if (!email && !referenceCode) return row
  if (!email || !referenceCode || !/^gc[0-9]{7}$/.test(referenceCode)) {
    throw new Error('App user contact identity is invalid')
  }
  const result = await client.query<{ id: string; suitecrm_id: string; reference_code: string }>(
    `UPDATE crm_contacts
     SET app_user_email = $2, reference_code = $3, updated_at = now()
     WHERE id = $1::uuid
     RETURNING id::text, suitecrm_id, reference_code`,
    [row.id, email, referenceCode],
  )
  return result.rows[0]
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
    const updated = await client.query<{ id: string; suitecrm_id: string; reference_code: string }>(
      `UPDATE crm_organizations SET
         suitecrm_id = COALESCE(suitecrm_id, $3), source_key = $4, identity_key = $4,
         parent_organization_id = $5::uuid, workspace_organization_id = $6::uuid,
         relationship_type = $7, source_sheet_id = COALESCE($8, source_sheet_id),
         source_row_number = COALESCE($9, source_row_number), priority = $10, name = $11,
         account_type = $12, account_manager = $13, website = $14, linkedin_url = $15,
         phone = $16, email = $17, email_opt_out = $18,
         billing_address_street = $19, billing_address_city = $20,
         billing_address_state = $21, billing_address_postal_code = $22,
         billing_address_country = $23, description = $24, source_payload = $25::jsonb,
         sync_status = CASE WHEN source_hash IS DISTINCT FROM $26 THEN 'pending' ELSE sync_status END,
         sync_error = CASE WHEN source_hash IS DISTINCT FROM $26 THEN NULL ELSE sync_error END,
         source_hash = $26, updated_by = $27, updated_at = now()
       WHERE pipeline_id = $1::uuid AND id = $2::uuid
       RETURNING id::text, suitecrm_id, reference_code`,
      [
        input.pipelineId, input.localId, suiteCrmId, identityKey,
        fields.parentOrganizationId || null, fields.workspaceOrganizationId || null, relationshipType,
        input.sourceSheetId || null, input.sourceRowNumber || null, nullable(fields.priority), clean(fields.name),
        nullable(fields.accountType), nullable(fields.accountManager), nullable(fields.website), nullable(fields.linkedinUrl),
        nullable(fields.phone), nullable(fields.email), fields.emailOptOut === true,
        nullable(fields.address), nullable(fields.city), nullable(fields.state), nullable(fields.postalCode),
        nullable(fields.country), nullable(fields.description), JSON.stringify(input.sourcePayload || {}),
        sourceHash, input.actorEmail,
      ],
    )
    if (!updated.rows[0]) throw new Error('CRM organization was not found')
    return applyWorkspaceOrganizationIdentity(
      client,
      updated.rows[0],
      fields.workspaceOrganizationReferenceCode,
    )
  }
  const result = await client.query<{ id: string; suitecrm_id: string; reference_code: string }>(
    `
      INSERT INTO crm_organizations (
        pipeline_id, suitecrm_id, source_key, identity_key, reference_code, parent_organization_id,
        workspace_organization_id, relationship_type, source_sheet_id, source_row_number,
        priority, name, account_type, account_manager, website, linkedin_url, phone, email, email_opt_out,
        billing_address_street, billing_address_city, billing_address_state,
        billing_address_postal_code, billing_address_country, description,
        source_payload, source_hash, sync_status, sync_error, created_by, updated_by
      )
      VALUES (
        $1::uuid, $2, $3, $3,
        COALESCE((SELECT reference_code FROM crm_organizations WHERE pipeline_id = $1::uuid AND identity_key = $3), allocate_crm_reference('ga')),
        $4::uuid, $5::uuid, $6, $7, $8, $9, $10, $11,
        $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24::jsonb, $25,
        'pending', NULL, $26, $26
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
        email = EXCLUDED.email,
        email_opt_out = EXCLUDED.email_opt_out,
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
      RETURNING id::text, suitecrm_id, reference_code
    `,
    [
      input.pipelineId, suiteCrmId, identityKey, fields.parentOrganizationId || null,
      fields.workspaceOrganizationId || null, relationshipType, input.sourceSheetId || null,
      input.sourceRowNumber || null, nullable(fields.priority), clean(fields.name), nullable(fields.accountType),
      nullable(fields.accountManager), nullable(fields.website), nullable(fields.linkedinUrl), nullable(fields.phone),
      nullable(fields.email), fields.emailOptOut === true, nullable(fields.address), nullable(fields.city),
      nullable(fields.state), nullable(fields.postalCode), nullable(fields.country), nullable(fields.description),
      JSON.stringify(input.sourcePayload || {}), sourceHash, input.actorEmail,
    ],
  )
  return applyWorkspaceOrganizationIdentity(
    client,
    result.rows[0],
    fields.workspaceOrganizationReferenceCode,
  )
}

async function stageContact(
  client: PoolClient,
  input: StageContactInput,
  suiteCrmId: string,
  sourceHash: string,
  identityKey: string,
) {
  const fields = input.fields
  if (!fields.organizationId || !fields.organizationSuiteCrmId) {
    throw new Error('CRM contacts require an organization')
  }
  if (input.localId) {
    const updated = await client.query<{ id: string; suitecrm_id: string; reference_code: string }>(
      `UPDATE crm_contacts SET
         organization_id = $3::uuid, suitecrm_id = COALESCE(suitecrm_id, $4),
         source_key = $5, identity_key = $5, source_sheet_id = COALESCE($6, source_sheet_id),
         source_row_number = COALESCE($7, source_row_number), priority = $8,
         first_name = $9, last_name = $10, full_name = $11, contact_type = $12,
         account_manager = $13, job_title = $14, email = $15, linkedin_url = $16,
         phone_work = $17, phone_mobile = $18, primary_address_street = $19,
         primary_address_city = $20, primary_address_state = $21,
         primary_address_postal_code = $22, primary_address_country = $23,
         description = $24, email_opt_out = $25, source_payload = $26::jsonb,
         sync_status = CASE WHEN source_hash IS DISTINCT FROM $27 THEN 'pending' ELSE sync_status END,
         sync_error = CASE WHEN source_hash IS DISTINCT FROM $27 THEN NULL ELSE sync_error END,
         source_hash = $27, updated_by = $28, updated_at = now()
       WHERE pipeline_id = $1::uuid AND id = $2::uuid
       RETURNING id::text, suitecrm_id, reference_code`,
      [
        input.pipelineId, input.localId, fields.organizationId || null, suiteCrmId, identityKey,
        input.sourceSheetId || null, input.sourceRowNumber || null, nullable(fields.priority),
        nullable(fields.firstName), nullable(fields.lastName), clean(fields.fullName), nullable(fields.contactType),
        nullable(fields.accountManager), nullable(fields.jobTitle), nullable(fields.email), nullable(fields.linkedinUrl),
        nullable(fields.phoneWork), nullable(fields.phoneMobile), nullable(fields.address), nullable(fields.city),
        nullable(fields.state), nullable(fields.postalCode), nullable(fields.country), nullable(fields.description),
        fields.emailOptOut === true, JSON.stringify(input.sourcePayload || {}), sourceHash, input.actorEmail,
      ],
    )
    if (!updated.rows[0]) throw new Error('CRM contact was not found')
    return applyAppUserContactIdentity(
      client,
      updated.rows[0],
      fields.appUserEmail,
      fields.appUserReferenceCode,
    )
  }
  const result = await client.query<{ id: string; suitecrm_id: string; reference_code: string }>(
    `
      INSERT INTO crm_contacts (
        pipeline_id, organization_id, suitecrm_id, source_key, identity_key, reference_code, source_sheet_id, source_row_number,
        priority, first_name, last_name, full_name, contact_type, account_manager, job_title,
        email, linkedin_url, phone_work, phone_mobile, primary_address_street,
        primary_address_city, primary_address_state, primary_address_postal_code,
        primary_address_country, description, email_opt_out, source_payload, source_hash,
        sync_status, sync_error, created_by, updated_by
      )
      VALUES (
        $1::uuid, $2::uuid, $3, $4, $4,
        COALESCE((SELECT reference_code FROM crm_contacts WHERE pipeline_id = $1::uuid AND identity_key = $4), allocate_crm_reference('gc')),
        $5, $6, $7, $8, $9, $10, $11, $12, $13,
        $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25::jsonb, $26,
        'pending', NULL, $27, $27
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
        email_opt_out = EXCLUDED.email_opt_out,
        source_payload = EXCLUDED.source_payload,
        source_hash = EXCLUDED.source_hash,
        sync_status = CASE WHEN crm_contacts.source_hash IS DISTINCT FROM EXCLUDED.source_hash THEN 'pending' ELSE crm_contacts.sync_status END,
        sync_error = CASE WHEN crm_contacts.source_hash IS DISTINCT FROM EXCLUDED.source_hash THEN NULL ELSE crm_contacts.sync_error END,
        updated_by = EXCLUDED.updated_by,
        updated_at = now()
      RETURNING id::text, suitecrm_id, reference_code
    `,
    [
      input.pipelineId, fields.organizationId || null, suiteCrmId, identityKey, input.sourceSheetId || null,
      input.sourceRowNumber || null, nullable(fields.priority), nullable(fields.firstName), nullable(fields.lastName),
      clean(fields.fullName), nullable(fields.contactType), nullable(fields.accountManager), nullable(fields.jobTitle),
      nullable(fields.email), nullable(fields.linkedinUrl), nullable(fields.phoneWork), nullable(fields.phoneMobile),
      nullable(fields.address), nullable(fields.city), nullable(fields.state), nullable(fields.postalCode), nullable(fields.country),
      nullable(fields.description), fields.emailOptOut === true, JSON.stringify(input.sourcePayload || {}), sourceHash, input.actorEmail,
    ],
  )
  return applyAppUserContactIdentity(
    client,
    result.rows[0],
    fields.appUserEmail,
    fields.appUserReferenceCode,
  )
}

async function stageLead(client: PoolClient, input: StageLeadInput, suiteCrmId: string, sourceHash: string) {
  const fields = input.fields
  const result = await client.query<{ id: string; suitecrm_id: string; reference_code: string }>(
    `
      INSERT INTO crm_leads (
        pipeline_id, organization_id, converted_contact_id, converted_opportunity_id,
        suitecrm_id, source_key, reference_code, first_name, last_name, full_name, company_name,
        job_title, email, phone_work, phone_mobile, status, lead_source, assigned_to,
        description, email_opt_out, source_payload, source_hash, sync_status,
        sync_error, created_by, updated_by
      )
      VALUES (
        $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6,
        COALESCE((SELECT reference_code FROM crm_leads WHERE pipeline_id = $1::uuid AND source_key = $6), allocate_crm_reference('gl')),
        $7, $8, $9, $10,
        $11, $12, $13, $14, $15, $16, $17, $18, $19, $20::jsonb, $21,
        'pending', NULL, $22, $22
      )
      ON CONFLICT (pipeline_id, source_key) DO UPDATE SET
        organization_id = EXCLUDED.organization_id,
        converted_contact_id = EXCLUDED.converted_contact_id,
        converted_opportunity_id = EXCLUDED.converted_opportunity_id,
        suitecrm_id = COALESCE(crm_leads.suitecrm_id, EXCLUDED.suitecrm_id),
        first_name = EXCLUDED.first_name,
        last_name = EXCLUDED.last_name,
        full_name = EXCLUDED.full_name,
        company_name = EXCLUDED.company_name,
        job_title = EXCLUDED.job_title,
        email = EXCLUDED.email,
        phone_work = EXCLUDED.phone_work,
        phone_mobile = EXCLUDED.phone_mobile,
        status = EXCLUDED.status,
        lead_source = EXCLUDED.lead_source,
        assigned_to = EXCLUDED.assigned_to,
        description = EXCLUDED.description,
        email_opt_out = EXCLUDED.email_opt_out,
        source_payload = EXCLUDED.source_payload,
        source_hash = EXCLUDED.source_hash,
        sync_status = CASE WHEN crm_leads.source_hash IS DISTINCT FROM EXCLUDED.source_hash THEN 'pending' ELSE crm_leads.sync_status END,
        sync_error = CASE WHEN crm_leads.source_hash IS DISTINCT FROM EXCLUDED.source_hash THEN NULL ELSE crm_leads.sync_error END,
        updated_by = EXCLUDED.updated_by,
        updated_at = now()
      RETURNING id::text, suitecrm_id, reference_code
    `,
    [
      input.pipelineId, fields.organizationId || null, fields.convertedContactId || null,
      fields.convertedOpportunityId || null, suiteCrmId, input.sourceKey, nullable(fields.firstName),
      nullable(fields.lastName), clean(fields.fullName), nullable(fields.companyName), nullable(fields.jobTitle),
      nullable(fields.email), nullable(fields.phoneWork), nullable(fields.phoneMobile), nullable(fields.status),
      nullable(fields.source), nullable(fields.assignedTo), nullable(fields.description), fields.emailOptOut === true,
      JSON.stringify(input.sourcePayload || {}), sourceHash, input.actorEmail,
    ],
  )
  return result.rows[0]
}

async function stageOpportunity(client: PoolClient, input: StageOpportunityInput, suiteCrmId: string, sourceHash: string) {
  const fields = input.fields
  const result = await client.query<{ id: string; suitecrm_id: string; reference_code: string }>(
    `
      INSERT INTO crm_opportunities (
        pipeline_id, organization_id, suitecrm_id, source_key, reference_code, source_sheet_id, source_row_number,
        priority, name, owner_name, organization_name, status, stage, loss_reason, lead_source,
        amount, probability, expected_close, description, source_payload, source_hash,
        sync_status, sync_error, created_by, updated_by
      )
      VALUES (
        $1::uuid, $2::uuid, $3, $4,
        COALESCE((SELECT reference_code FROM crm_opportunities WHERE pipeline_id = $1::uuid AND source_key = $4), allocate_crm_reference('go')),
        $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
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
      RETURNING id::text, suitecrm_id, reference_code
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

async function stageMeeting(client: PoolClient, input: StageMeetingInput, suiteCrmId: string, sourceHash: string) {
  const fields = input.fields
  const startsAt = isoTimestamp(fields.startsAt)
  const endsAt = isoTimestamp(fields.endsAt)
  if (!startsAt || !endsAt || Date.parse(endsAt) <= Date.parse(startsAt)) throw new Error('CRM meeting time is invalid')
  const result = await client.query<{ id: string; suitecrm_id: string; reference_code: string }>(
    `
      INSERT INTO crm_meetings (
        pipeline_id, organization_id, contact_id, lead_id, opportunity_id, suitecrm_id,
        source_key, reference_code, subject, description, starts_at, ends_at, timezone, location,
        attendee_emails, status, provider, external_event_id, external_event_url,
        join_url, source_payload, source_hash, sync_status, sync_error, created_by, updated_by
      )
      VALUES (
        $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, $7,
        COALESCE((SELECT reference_code FROM crm_meetings WHERE pipeline_id = $1::uuid AND source_key = $7), allocate_crm_reference('gm')),
        $8, $9,
        $10::timestamptz, $11::timestamptz, $12, $13, $14::text[], $15, $16,
        $17, $18, $19, $20::jsonb, $21, 'pending', NULL, $22, $22
      )
      ON CONFLICT (pipeline_id, source_key) DO UPDATE SET
        organization_id = EXCLUDED.organization_id,
        contact_id = EXCLUDED.contact_id,
        lead_id = EXCLUDED.lead_id,
        opportunity_id = EXCLUDED.opportunity_id,
        suitecrm_id = COALESCE(crm_meetings.suitecrm_id, EXCLUDED.suitecrm_id),
        subject = EXCLUDED.subject,
        description = EXCLUDED.description,
        starts_at = EXCLUDED.starts_at,
        ends_at = EXCLUDED.ends_at,
        timezone = EXCLUDED.timezone,
        location = EXCLUDED.location,
        attendee_emails = EXCLUDED.attendee_emails,
        status = EXCLUDED.status,
        provider = EXCLUDED.provider,
        external_event_id = COALESCE(EXCLUDED.external_event_id, crm_meetings.external_event_id),
        external_event_url = COALESCE(EXCLUDED.external_event_url, crm_meetings.external_event_url),
        join_url = COALESCE(EXCLUDED.join_url, crm_meetings.join_url),
        source_payload = EXCLUDED.source_payload,
        source_hash = EXCLUDED.source_hash,
        sync_status = CASE WHEN crm_meetings.source_hash IS DISTINCT FROM EXCLUDED.source_hash THEN 'pending' ELSE crm_meetings.sync_status END,
        sync_error = CASE WHEN crm_meetings.source_hash IS DISTINCT FROM EXCLUDED.source_hash THEN NULL ELSE crm_meetings.sync_error END,
        updated_by = EXCLUDED.updated_by,
        updated_at = now()
      RETURNING id::text, suitecrm_id, reference_code
    `,
    [
      input.pipelineId, fields.organizationId || null, fields.contactId || null, fields.leadId || null,
      fields.opportunityId || null, suiteCrmId, input.sourceKey, clean(fields.subject), nullable(fields.description),
      startsAt, endsAt, clean(fields.timezone) || 'America/New_York', nullable(fields.location), fields.attendeeEmails || [],
      fields.status || 'planned', nullable(fields.provider), fields.externalEventId || null,
      fields.externalEventUrl || null, fields.joinUrl || null, JSON.stringify(input.sourcePayload || {}),
      sourceHash, input.actorEmail,
    ],
  )
  return result.rows[0]
}

async function stageCampaign(client: PoolClient, input: StageCampaignInput, suiteCrmId: string, sourceHash: string) {
  const fields = input.fields
  const result = await client.query<{ id: string; suitecrm_id: string; reference_code: string }>(
    `
      INSERT INTO crm_campaigns (
        pipeline_id, suitecrm_id, source_key, reference_code, name, campaign_type, status,
        start_date, end_date, subject_template, body_template, sender_email,
        description, source_payload, source_hash, sync_status, sync_error, created_by, updated_by
      )
      VALUES (
        $1::uuid, $2, $3,
        COALESCE((SELECT reference_code FROM crm_campaigns WHERE pipeline_id = $1::uuid AND source_key = $3), allocate_crm_reference('gk')),
        $4, $5, $6, $7::date, $8::date, $9, $10, $11,
        $12, $13::jsonb, $14, 'pending', NULL, $15, $15
      )
      ON CONFLICT (pipeline_id, source_key) DO UPDATE SET
        suitecrm_id = COALESCE(crm_campaigns.suitecrm_id, EXCLUDED.suitecrm_id),
        name = EXCLUDED.name,
        campaign_type = EXCLUDED.campaign_type,
        status = EXCLUDED.status,
        start_date = EXCLUDED.start_date,
        end_date = EXCLUDED.end_date,
        subject_template = EXCLUDED.subject_template,
        body_template = EXCLUDED.body_template,
        sender_email = EXCLUDED.sender_email,
        description = EXCLUDED.description,
        source_payload = EXCLUDED.source_payload,
        source_hash = EXCLUDED.source_hash,
        sync_status = CASE WHEN crm_campaigns.source_hash IS DISTINCT FROM EXCLUDED.source_hash THEN 'pending' ELSE crm_campaigns.sync_status END,
        sync_error = CASE WHEN crm_campaigns.source_hash IS DISTINCT FROM EXCLUDED.source_hash THEN NULL ELSE crm_campaigns.sync_error END,
        updated_by = EXCLUDED.updated_by,
        updated_at = now()
      RETURNING id::text, suitecrm_id, reference_code
    `,
    [
      input.pipelineId, suiteCrmId, input.sourceKey, clean(fields.name), fields.campaignType || 'email',
      fields.status || 'draft', isoDate(fields.startDate), isoDate(fields.endDate), nullable(fields.subjectTemplate),
      nullable(fields.bodyTemplate), nullable(fields.senderEmail), nullable(fields.description),
      JSON.stringify(input.sourcePayload || {}), sourceHash, input.actorEmail,
    ],
  )
  return result.rows[0]
}

async function stageInteraction(client: PoolClient, input: StageInteractionInput, suiteCrmId: string, sourceHash: string) {
  const fields = input.fields
  const result = await client.query<{ id: string; suitecrm_id: string; reference_code: string }>(
    `
      INSERT INTO crm_interactions (
        pipeline_id, organization_id, contact_id, lead_id, opportunity_id, meeting_id,
        campaign_id, suitecrm_id, source_key, reference_code, source_sheet_id, source_row_number,
        interaction_type, subject, agent_name, occurred_at, description, direction,
        delivery_status, provider_message_id, provider_thread_id, metadata,
        source_payload, source_hash, sync_status, sync_error, created_by, updated_by
      )
      VALUES (
        $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7::uuid,
        $8, $9,
        COALESCE((SELECT reference_code FROM crm_interactions WHERE pipeline_id = $1::uuid AND source_key = $9), allocate_crm_reference('gi')),
        $10, $11, $12, $13, $14, $15::timestamptz, $16, $17, $18,
        $19, $20, $21::jsonb, $22::jsonb, $23, 'pending', NULL, $24, $24
      )
      ON CONFLICT (pipeline_id, source_key) DO UPDATE SET
        organization_id = EXCLUDED.organization_id,
        contact_id = EXCLUDED.contact_id,
        lead_id = EXCLUDED.lead_id,
        opportunity_id = EXCLUDED.opportunity_id,
        meeting_id = EXCLUDED.meeting_id,
        campaign_id = EXCLUDED.campaign_id,
        suitecrm_id = COALESCE(crm_interactions.suitecrm_id, EXCLUDED.suitecrm_id),
        source_sheet_id = EXCLUDED.source_sheet_id,
        source_row_number = EXCLUDED.source_row_number,
        interaction_type = EXCLUDED.interaction_type,
        subject = EXCLUDED.subject,
        agent_name = EXCLUDED.agent_name,
        occurred_at = EXCLUDED.occurred_at,
        description = EXCLUDED.description,
        direction = EXCLUDED.direction,
        delivery_status = EXCLUDED.delivery_status,
        provider_message_id = EXCLUDED.provider_message_id,
        provider_thread_id = EXCLUDED.provider_thread_id,
        metadata = EXCLUDED.metadata,
        source_payload = EXCLUDED.source_payload,
        source_hash = EXCLUDED.source_hash,
        sync_status = CASE WHEN crm_interactions.source_hash IS DISTINCT FROM EXCLUDED.source_hash THEN 'pending' ELSE crm_interactions.sync_status END,
        sync_error = CASE WHEN crm_interactions.source_hash IS DISTINCT FROM EXCLUDED.source_hash THEN NULL ELSE crm_interactions.sync_error END,
        updated_by = EXCLUDED.updated_by,
        updated_at = now()
      RETURNING id::text, suitecrm_id, reference_code
    `,
    [
      input.pipelineId, fields.organizationId || null, fields.contactId || null, fields.leadId || null,
      fields.opportunityId || null, fields.meetingId || null, fields.campaignId || null,
      suiteCrmId, input.sourceKey, input.sourceSheetId || null, input.sourceRowNumber || null,
      nullable(fields.interactionType), clean(fields.subject), nullable(fields.agentName), isoTimestamp(fields.occurredAt),
      nullable(fields.description), fields.direction || 'internal', nullable(fields.deliveryStatus),
      fields.providerMessageId || null, fields.providerThreadId || null, JSON.stringify(fields.metadata || {}),
      JSON.stringify(input.sourcePayload || {}), sourceHash, input.actorEmail,
    ],
  )
  return result.rows[0]
}

function crmReferenceDestination(referenceCode: string, pipelineId: string) {
  const origin = appPublicUrl()
  if (!origin.startsWith('https://')) return null
  const destination = new URL(`/crm/${encodeURIComponent(referenceCode)}`, origin)
  destination.searchParams.set('pipeline', pipelineId)
  return destination.toString()
}

function crmReferenceShortUrl(referenceCode: unknown) {
  const code = clean(referenceCode)
  if (!code) return null
  try {
    const url = new URL(shortLinkUrl(code))
    return url.protocol === 'https:' ? url.toString() : null
  } catch {
    return null
  }
}

async function ensureCrmReferenceShortLink(
  client: PoolClient,
  input: { pipelineId: string; entity: CrmEntity; referenceCode: string; title: string },
) {
  const destinationUrl = crmReferenceDestination(input.referenceCode, input.pipelineId)
  if (!destinationUrl) return null
  const owner = await client.query<{ owner_email: string; organization_root_id: string }>(
    `WITH RECURSIVE ancestors AS (
       SELECT organization.id, organization.parent_id, ARRAY[organization.id] AS path
       FROM pipeline_spaces pipeline
       JOIN workspace_organizations organization ON organization.id = pipeline.workspace_organization_id
       WHERE pipeline.id = $1::uuid
       UNION ALL
       SELECT parent.id, parent.parent_id, ancestor.path || parent.id
       FROM ancestors ancestor
       JOIN workspace_organizations parent ON parent.id = ancestor.parent_id
       WHERE NOT parent.id = ANY(ancestor.path)
     )
     SELECT pipeline.owner_email, root.id::text AS organization_root_id
     FROM pipeline_spaces pipeline
     JOIN LATERAL (
       SELECT id FROM ancestors ORDER BY (parent_id IS NULL) DESC LIMIT 1
     ) root ON true
     WHERE pipeline.id = $1::uuid
     LIMIT 1`,
    [input.pipelineId],
  )
  if (!owner.rows[0]) throw new Error('CRM pipeline owner was not found')
  const inserted = await client.query<{ slug: string }>(
    `INSERT INTO short_links (
       owner_email, organization_root_id, source_app, slug, destination_url, title, tags, created_at, updated_at
     )
     VALUES ($1, $2::uuid, 'clawpilot-crm', $3, $4, $5, $6::text[], now(), now())
     ON CONFLICT (slug) DO UPDATE SET
       organization_root_id = EXCLUDED.organization_root_id,
       destination_url = EXCLUDED.destination_url,
       title = EXCLUDED.title,
       tags = EXCLUDED.tags,
       deleted_at = NULL,
       disabled_at = NULL,
       updated_at = now()
     WHERE short_links.source_app = 'clawpilot-crm'
       AND short_links.owner_email = EXCLUDED.owner_email
     RETURNING slug`,
    [
      owner.rows[0].owner_email,
      owner.rows[0].organization_root_id,
      input.referenceCode,
      destinationUrl,
      input.title.slice(0, 200),
      ['crm', input.entity, input.referenceCode],
    ],
  )
  return inserted.rows[0] ? crmReferenceShortUrl(input.referenceCode) : null
}

export async function stageCrmRecordInPostgres(input: StageCrmRecordInput) {
  if (input.entity === 'meetings') {
    const timezone = clean(input.fields.timezone) || 'America/New_York'
    const startsAt = zonedDateTimeToIso(input.fields.startsAt, timezone)
    const endsAt = zonedDateTimeToIso(input.fields.endsAt, timezone)
    if (!startsAt || !endsAt || Date.parse(endsAt) <= Date.parse(startsAt)) {
      throw new Error('CRM meeting time is invalid for the selected timezone')
    }
    input = { ...input, fields: { ...input.fields, startsAt, endsAt, timezone } }
  }
  const identityKey = input.entity === 'organizations'
    ? organizationIdentityKey(input.fields)
    : input.entity === 'contacts'
      ? contactIdentityKey(input.fields)
      : null
  const sourceKey = identityKey || clean(input.sourceKey)
  if (!sourceKey || sourceKey.length > 500) throw new Error('CRM source key is invalid')
  const suiteCrmId = (
    input.entity === 'organizations' && input.fields.workspaceOrganizationId
  ) || (
    input.entity === 'contacts' && input.fields.appUserEmail
  )
    ? stableGlobalSuiteCrmId(input.entity, sourceKey)
    : stableSuiteCrmId(input.pipelineId, input.entity, sourceKey)
  const sourceHash = crmSourceHash({ fields: input.fields, sourcePayload: input.sourcePayload || {} })
  return withTransaction(async (client) => {
    let row: { id: string; suitecrm_id: string; reference_code: string }
    switch (input.entity) {
      case 'organizations':
        row = await stageOrganization(client, input, suiteCrmId, sourceHash, sourceKey)
        break
      case 'contacts':
        row = await stageContact(client, input, suiteCrmId, sourceHash, sourceKey)
        break
      case 'leads':
        row = await stageLead(client, input, suiteCrmId, sourceHash)
        break
      case 'opportunities':
        row = await stageOpportunity(client, input, suiteCrmId, sourceHash)
        break
      case 'meetings':
        row = await stageMeeting(client, input, suiteCrmId, sourceHash)
        break
      case 'campaigns':
        row = await stageCampaign(client, input, suiteCrmId, sourceHash)
        break
      case 'interactions':
        row = await stageInteraction(client, input, suiteCrmId, sourceHash)
        break
    }
    await enqueueSuiteCrmRecord(client, input, row.id, row.suitecrm_id, row.reference_code, sourceHash)
    const title = clean('name' in input.fields ? input.fields.name : 'fullName' in input.fields
      ? input.fields.fullName : 'subject' in input.fields ? input.fields.subject : row.reference_code)
    const shortUrl = await ensureCrmReferenceShortLink(client, {
      pipelineId: input.pipelineId,
      entity: input.entity,
      referenceCode: row.reference_code,
      title: title || row.reference_code,
    })
    await client.query(
      `INSERT INTO audit_events (actor, event_type, aggregate_type, aggregate_id, payload)
       VALUES ($1, 'crm.record.staged', $2, $3, $4::jsonb)`,
      [input.actorEmail, `crm_${input.entity}`, row.id, JSON.stringify({ pipelineId: input.pipelineId, sourceKey })],
    )
    return {
      id: row.id,
      suiteCrmId: row.suitecrm_id,
      referenceCode: row.reference_code,
      shortUrl,
      sourceHash,
    }
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
    referenceCode: string
    shortUrl: string | null
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
        workspaceOrganizationReferenceCode: organization.referenceCode,
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

export async function syncAppUserProfileToCrm(input: {
  email: string
  pipelineId: string
}) {
  const user = await requireActiveAppUser(input.email)
  const ownedPipeline = await query<{ id: string }>(
    `SELECT id::text
     FROM pipeline_spaces
     WHERE id = $1::uuid AND owner_email = $2
     LIMIT 1`,
    [input.pipelineId, user.email],
  )
  if (!ownedPipeline.rows[0]) throw new Error('CRM profile synchronization requires an owned pipeline')
  const displayName = clean(user.displayName) || user.email.split('@')[0]
  const workspaceOrganization = await ensurePrimaryWorkspaceOrganization(user.email)
  const hierarchy = await ensurePipelineCrmHierarchy({
    pipelineId: input.pipelineId,
    actorEmail: user.email,
  })
  const organization = hierarchy.lineage.find((candidate) => (
    candidate.workspaceOrganizationId === workspaceOrganization.id
  )) || hierarchy.customerParent
  const contact = await stageCrmRecordInPostgres({
    entity: 'contacts',
    pipelineId: input.pipelineId,
    sourceKey: `profile:${user.email}`,
    actorEmail: user.email,
    sourcePayload: {
      source: 'clawpilot_profile',
      userEmail: user.email,
      workspaceOrganizationId: workspaceOrganization.id,
      timezone: user.timezone,
      locale: user.locale,
    },
    fields: {
      organizationId: organization.id,
      organizationSuiteCrmId: organization.suiteCrmId,
      appUserEmail: user.email,
      appUserReferenceCode: user.referenceCode,
      fullName: displayName,
      email: user.email,
      jobTitle: clean(user.jobTitle),
      contactType: 'ClawPilot user',
      description: 'Managed from the ClawPilot user profile.',
    },
  })
  return {
    workspaceOrganizationId: workspaceOrganization.id,
    organizationId: organization.id,
    organizationName: organization.name,
    organizationReferenceCode: organization.referenceCode,
    contactId: contact.id,
    contactReferenceCode: contact.referenceCode,
    appUserEmail: user.email,
    displayName,
  }
}

export async function syncPipelineOwnerProfileToCrm(pipelineId: string) {
  const pipeline = await query<{ owner_email: string }>(
    `SELECT owner_email
     FROM pipeline_spaces
     WHERE id = $1::uuid
     LIMIT 1`,
    [pipelineId],
  )
  const ownerEmail = pipeline.rows[0]?.owner_email
  if (!ownerEmail) throw new Error('Pipeline was not found')
  return syncAppUserProfileToCrm({ email: ownerEmail, pipelineId })
}

export async function syncAppUserProfileToOwnedPipelines(email: string) {
  const user = await requireActiveAppUser(email)
  const pipelines = await query<{ id: string }>(
    `SELECT id::text
     FROM pipeline_spaces
     WHERE owner_email = $1
     ORDER BY created_at, id`,
    [user.email],
  )
  const profiles = []
  for (const pipeline of pipelines.rows) {
    profiles.push(await syncAppUserProfileToCrm({ email: user.email, pipelineId: pipeline.id }))
  }
  return profiles
}

function organizationFromRow(row: Record<string, unknown>): CrmOrganization {
  return {
    id: String(row.id), referenceCode: clean(row.reference_code), shortUrl: crmReferenceShortUrl(row.reference_code),
    pipelineId: String(row.pipeline_id),
    parentOrganizationId: nullable(row.parent_organization_id),
    parentOrganizationName: clean(row.parent_organization_name),
    workspaceOrganizationId: nullable(row.workspace_organization_id),
    relationshipType: (row.relationship_type || 'customer') as CrmOrganization['relationshipType'],
    suiteCrmId: nullable(row.suitecrm_id),
    sourceKey: String(row.source_key), sourceRowNumber: row.source_row_number === null ? null : Number(row.source_row_number),
    priority: clean(row.priority), name: clean(row.name), accountType: clean(row.account_type), accountManager: clean(row.account_manager),
    website: clean(row.website), linkedinUrl: clean(row.linkedin_url), phone: clean(row.phone),
    email: clean(row.email), emailOptOut: row.email_opt_out === true, address: clean(row.billing_address_street),
    city: clean(row.billing_address_city), state: clean(row.billing_address_state), postalCode: clean(row.billing_address_postal_code),
    country: clean(row.billing_address_country), description: clean(row.description), syncStatus: row.sync_status as CrmOrganization['syncStatus'],
    syncError: nullable(row.sync_error), updatedAt: String(row.updated_at),
  }
}

function contactFromRow(row: Record<string, unknown>): CrmContact {
  return {
    id: String(row.id), referenceCode: clean(row.reference_code), shortUrl: crmReferenceShortUrl(row.reference_code),
    pipelineId: String(row.pipeline_id), organizationId: nullable(row.organization_id),
    organizationName: clean(row.organization_name), suiteCrmId: nullable(row.suitecrm_id), sourceKey: String(row.source_key),
    sourceRowNumber: row.source_row_number === null ? null : Number(row.source_row_number), priority: clean(row.priority),
    firstName: clean(row.first_name), lastName: clean(row.last_name), fullName: clean(row.full_name), contactType: clean(row.contact_type),
    accountManager: clean(row.account_manager), jobTitle: clean(row.job_title), email: clean(row.email), linkedinUrl: clean(row.linkedin_url),
    phoneWork: clean(row.phone_work), phoneMobile: clean(row.phone_mobile), address: clean(row.primary_address_street),
    city: clean(row.primary_address_city), state: clean(row.primary_address_state), postalCode: clean(row.primary_address_postal_code),
    country: clean(row.primary_address_country), description: clean(row.description), emailOptOut: row.email_opt_out === true,
    syncStatus: row.sync_status as CrmContact['syncStatus'],
    syncError: nullable(row.sync_error), updatedAt: String(row.updated_at),
  }
}

function opportunityFromRow(row: Record<string, unknown>): CrmOpportunity {
  return {
    id: String(row.id), referenceCode: clean(row.reference_code), shortUrl: crmReferenceShortUrl(row.reference_code),
    pipelineId: String(row.pipeline_id), organizationId: nullable(row.organization_id), suiteCrmId: nullable(row.suitecrm_id),
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
    id: String(row.id), referenceCode: clean(row.reference_code), shortUrl: crmReferenceShortUrl(row.reference_code),
    pipelineId: String(row.pipeline_id), organizationId: nullable(row.organization_id), contactId: nullable(row.contact_id),
    opportunityId: nullable(row.opportunity_id), leadId: nullable(row.lead_id), meetingId: nullable(row.meeting_id),
    campaignId: nullable(row.campaign_id), suiteCrmId: nullable(row.suitecrm_id), sourceKey: String(row.source_key),
    sourceRowNumber: row.source_row_number === null ? null : Number(row.source_row_number), interactionType: clean(row.interaction_type),
    subject: clean(row.subject), agentName: clean(row.agent_name), occurredAt: row.occurred_at ? String(row.occurred_at) : null,
    description: clean(row.description), direction: (row.direction || 'internal') as CrmInteraction['direction'],
    deliveryStatus: clean(row.delivery_status), providerMessageId: nullable(row.provider_message_id),
    providerThreadId: nullable(row.provider_thread_id), syncStatus: row.sync_status as CrmInteraction['syncStatus'], syncError: nullable(row.sync_error),
    updatedAt: String(row.updated_at),
  }
}

function leadFromRow(row: Record<string, unknown>): CrmLead {
  return {
    id: String(row.id), referenceCode: clean(row.reference_code), shortUrl: crmReferenceShortUrl(row.reference_code),
    pipelineId: String(row.pipeline_id), organizationId: nullable(row.organization_id), organizationName: clean(row.organization_name),
    convertedContactId: nullable(row.converted_contact_id), convertedOpportunityId: nullable(row.converted_opportunity_id),
    suiteCrmId: nullable(row.suitecrm_id), sourceKey: String(row.source_key), firstName: clean(row.first_name),
    lastName: clean(row.last_name), fullName: clean(row.full_name), companyName: clean(row.company_name),
    jobTitle: clean(row.job_title), email: clean(row.email), phoneWork: clean(row.phone_work), phoneMobile: clean(row.phone_mobile),
    status: clean(row.status), source: clean(row.lead_source), assignedTo: clean(row.assigned_to), description: clean(row.description),
    emailOptOut: row.email_opt_out === true, syncStatus: row.sync_status as CrmLead['syncStatus'], syncError: nullable(row.sync_error),
    updatedAt: String(row.updated_at),
  }
}

function meetingFromRow(row: Record<string, unknown>): CrmMeeting {
  return {
    id: String(row.id), referenceCode: clean(row.reference_code), shortUrl: crmReferenceShortUrl(row.reference_code),
    pipelineId: String(row.pipeline_id), organizationId: nullable(row.organization_id), organizationName: clean(row.organization_name),
    contactId: nullable(row.contact_id), contactName: clean(row.contact_name), leadId: nullable(row.lead_id),
    leadName: clean(row.lead_name), opportunityId: nullable(row.opportunity_id), opportunityName: clean(row.opportunity_name),
    suiteCrmId: nullable(row.suitecrm_id), sourceKey: String(row.source_key), subject: clean(row.subject),
    description: clean(row.description), startsAt: String(row.starts_at), endsAt: String(row.ends_at),
    timezone: clean(row.timezone), location: clean(row.location), attendeeEmails: Array.isArray(row.attendee_emails)
      ? row.attendee_emails.map(clean).filter(Boolean) : [],
    status: row.status as CrmMeeting['status'], provider: clean(row.provider), externalEventId: nullable(row.external_event_id),
    externalEventUrl: nullable(row.external_event_url), joinUrl: nullable(row.join_url),
    syncStatus: row.sync_status as CrmMeeting['syncStatus'], syncError: nullable(row.sync_error), updatedAt: String(row.updated_at),
  }
}

function campaignFromRow(row: Record<string, unknown>): CrmCampaign {
  return {
    id: String(row.id), referenceCode: clean(row.reference_code), shortUrl: crmReferenceShortUrl(row.reference_code),
    pipelineId: String(row.pipeline_id), suiteCrmId: nullable(row.suitecrm_id), sourceKey: String(row.source_key),
    name: clean(row.name), campaignType: (row.campaign_type || 'email') as CrmCampaign['campaignType'],
    status: row.status as CrmCampaign['status'], startDate: row.start_date ? String(row.start_date).slice(0, 10) : '',
    endDate: row.end_date ? String(row.end_date).slice(0, 10) : '', subjectTemplate: clean(row.subject_template),
    bodyTemplate: clean(row.body_template), senderEmail: clean(row.sender_email), description: clean(row.description),
    recipientCount: finite(row.recipient_count), sentCount: finite(row.sent_count), failedCount: finite(row.failed_count),
    syncStatus: row.sync_status as CrmCampaign['syncStatus'], syncError: nullable(row.sync_error), updatedAt: String(row.updated_at),
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
         AND ($2 = '' OR organization.reference_code ILIKE '%' || $2 || '%'
           OR organization.name ILIKE '%' || $2 || '%'
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
       WHERE contact.pipeline_id = $1::uuid AND ($2 = '' OR contact.reference_code ILIKE '%' || $2 || '%' OR contact.full_name ILIKE '%' || $2 || '%' OR contact.email ILIKE '%' || $2 || '%' OR organization.name ILIKE '%' || $2 || '%')
       ORDER BY contact.full_name, contact.id LIMIT $3`,
      [input.pipelineId, search, limit],
    )
    return result.rows.map(contactFromRow)
  }
  if (input.entity === 'leads') {
    const result = await query<Record<string, unknown>>(
      `SELECT lead.*, organization.name AS organization_name
       FROM crm_leads lead
       LEFT JOIN crm_organizations organization ON organization.id = lead.organization_id
       WHERE lead.pipeline_id = $1::uuid
         AND ($2 = '' OR lead.reference_code ILIKE '%' || $2 || '%' OR lead.full_name ILIKE '%' || $2 || '%'
           OR lead.email ILIKE '%' || $2 || '%' OR lead.company_name ILIKE '%' || $2 || '%' OR organization.name ILIKE '%' || $2 || '%')
       ORDER BY lead.updated_at DESC, lead.id LIMIT $3`,
      [input.pipelineId, search, limit],
    )
    return result.rows.map(leadFromRow)
  }
  if (input.entity === 'opportunities') {
    const result = await query<Record<string, unknown>>(
      `SELECT * FROM crm_opportunities
       WHERE pipeline_id = $1::uuid AND ($2 = '' OR reference_code ILIKE '%' || $2 || '%' OR name ILIKE '%' || $2 || '%' OR organization_name ILIKE '%' || $2 || '%')
       ORDER BY updated_at DESC, id LIMIT $3`,
      [input.pipelineId, search, limit],
    )
    return result.rows.map(opportunityFromRow)
  }
  if (input.entity === 'meetings') {
    const result = await query<Record<string, unknown>>(
      `SELECT meeting.*, organization.name AS organization_name, contact.full_name AS contact_name,
         lead.full_name AS lead_name, opportunity.name AS opportunity_name
       FROM crm_meetings meeting
       LEFT JOIN crm_organizations organization ON organization.id = meeting.organization_id
       LEFT JOIN crm_contacts contact ON contact.id = meeting.contact_id
       LEFT JOIN crm_leads lead ON lead.id = meeting.lead_id
       LEFT JOIN crm_opportunities opportunity ON opportunity.id = meeting.opportunity_id
       WHERE meeting.pipeline_id = $1::uuid
         AND ($2 = '' OR meeting.reference_code ILIKE '%' || $2 || '%' OR meeting.subject ILIKE '%' || $2 || '%'
           OR organization.name ILIKE '%' || $2 || '%' OR contact.full_name ILIKE '%' || $2 || '%' OR lead.full_name ILIKE '%' || $2 || '%')
       ORDER BY meeting.starts_at DESC, meeting.id LIMIT $3`,
      [input.pipelineId, search, limit],
    )
    return result.rows.map(meetingFromRow)
  }
  if (input.entity === 'campaigns') {
    const result = await query<Record<string, unknown>>(
      `SELECT * FROM crm_campaigns
       WHERE pipeline_id = $1::uuid
         AND ($2 = '' OR reference_code ILIKE '%' || $2 || '%' OR name ILIKE '%' || $2 || '%' OR description ILIKE '%' || $2 || '%')
       ORDER BY updated_at DESC, id LIMIT $3`,
      [input.pipelineId, search, limit],
    )
    return result.rows.map(campaignFromRow)
  }
  const result = await query<Record<string, unknown>>(
    `SELECT * FROM crm_interactions
     WHERE pipeline_id = $1::uuid AND ($2 = '' OR reference_code ILIKE '%' || $2 || '%' OR subject ILIKE '%' || $2 || '%' OR description ILIKE '%' || $2 || '%')
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
        (SELECT count(*) FROM crm_leads WHERE pipeline_id = $1::uuid)::text AS leads,
        (SELECT count(*) FROM crm_opportunities WHERE pipeline_id = $1::uuid)::text AS opportunities,
        (SELECT count(*) FROM crm_meetings WHERE pipeline_id = $1::uuid)::text AS meetings,
        (SELECT count(*) FROM crm_interactions WHERE pipeline_id = $1::uuid)::text AS interactions,
        (SELECT count(*) FROM crm_campaigns WHERE pipeline_id = $1::uuid)::text AS campaigns,
        (SELECT COALESCE(sum(amount), 0) FROM crm_opportunities WHERE pipeline_id = $1::uuid AND lower(COALESCE(status, '')) NOT IN ('won', 'lost', 'closed', 'abandoned'))::text AS open_pipeline_value,
        (SELECT COALESCE(sum(amount * probability / 100), 0) FROM crm_opportunities WHERE pipeline_id = $1::uuid AND lower(COALESCE(status, '')) NOT IN ('won', 'lost', 'closed', 'abandoned'))::text AS weighted_pipeline_value,
        (SELECT count(*) FROM (
          SELECT sync_status FROM crm_organizations WHERE pipeline_id = $1::uuid
          UNION ALL SELECT sync_status FROM crm_contacts WHERE pipeline_id = $1::uuid
          UNION ALL SELECT sync_status FROM crm_leads WHERE pipeline_id = $1::uuid
          UNION ALL SELECT sync_status FROM crm_opportunities WHERE pipeline_id = $1::uuid
          UNION ALL SELECT sync_status FROM crm_meetings WHERE pipeline_id = $1::uuid
          UNION ALL SELECT sync_status FROM crm_interactions WHERE pipeline_id = $1::uuid
          UNION ALL SELECT sync_status FROM crm_campaigns WHERE pipeline_id = $1::uuid
        ) records WHERE sync_status IN ('pending', 'syncing'))::text AS pending_sync,
        (SELECT count(*) FROM (
          SELECT sync_status FROM crm_organizations WHERE pipeline_id = $1::uuid
          UNION ALL SELECT sync_status FROM crm_contacts WHERE pipeline_id = $1::uuid
          UNION ALL SELECT sync_status FROM crm_leads WHERE pipeline_id = $1::uuid
          UNION ALL SELECT sync_status FROM crm_opportunities WHERE pipeline_id = $1::uuid
          UNION ALL SELECT sync_status FROM crm_meetings WHERE pipeline_id = $1::uuid
          UNION ALL SELECT sync_status FROM crm_interactions WHERE pipeline_id = $1::uuid
          UNION ALL SELECT sync_status FROM crm_campaigns WHERE pipeline_id = $1::uuid
        ) records WHERE sync_status = 'failed')::text AS failed_sync
    `,
    [pipelineId],
  )
  const row = result.rows[0] || {}
  return {
    organizations: finite(row.organizations), contacts: finite(row.contacts), leads: finite(row.leads),
    opportunities: finite(row.opportunities), meetings: finite(row.meetings), interactions: finite(row.interactions),
    campaigns: finite(row.campaigns), openPipelineValue: finite(row.open_pipeline_value),
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
    `SELECT id::text, reference_code, source_key, suitecrm_id,
       COALESCE(to_jsonb(record)->>'name', to_jsonb(record)->>'full_name', to_jsonb(record)->>'subject') AS display_name,
       COALESCE(to_jsonb(record)->>'organization_name', '') AS organization_name,
       to_jsonb(record)->>'organization_id' AS organization_id,
       COALESCE(to_jsonb(record)->>'email', '') AS email,
       COALESCE(to_jsonb(record)->>'phone_mobile', to_jsonb(record)->>'phone_work', to_jsonb(record)->>'phone', '') AS phone,
       COALESCE(to_jsonb(record)->>'email_opt_out', 'false') AS email_opt_out,
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
    referenceCode: clean(row.reference_code),
    shortUrl: crmReferenceShortUrl(row.reference_code),
    sourceKey: String(row.source_key),
    suiteCrmId: nullable(row.suitecrm_id),
    name: clean(row.display_name),
    organizationName: clean(row.organization_name),
    organizationId: nullable(row.organization_id),
    email: clean(row.email),
    phone: clean(row.phone),
    emailOptOut: row.email_opt_out === true || clean(row.email_opt_out) === 'true',
    workspaceOrganizationId: nullable(row.workspace_organization_id),
    parentOrganizationId: nullable(row.parent_organization_id),
    relationshipType: clean(row.relationship_type),
  }
}

export function crmEntityForReferenceCode(referenceValue: unknown): CrmEntity | null {
  const prefix = clean(referenceValue).slice(0, 2).toLowerCase()
  return ({
    ga: 'organizations',
    gc: 'contacts',
    gl: 'leads',
    go: 'opportunities',
    gm: 'meetings',
    gi: 'interactions',
    gk: 'campaigns',
  } as Record<string, CrmEntity>)[prefix] || null
}

export async function resolveCrmReferenceCode(referenceValue: unknown): Promise<string> {
  const referenceCode = clean(referenceValue).toLowerCase()
  if (!/^g[aciklmo][0-9]{7}$/.test(referenceCode)) throw new Error('CRM reference is invalid')
  if (!isPostgresStorageEnabled()) return referenceCode
  try {
    const result = await query<{ canonical_code: string }>(
      `SELECT canonical_code FROM crm_reference_registry WHERE reference_code = $1 LIMIT 1`,
      [referenceCode],
    )
    return clean(result.rows[0]?.canonical_code) || referenceCode
  } catch (error) {
    if ((error as { code?: string })?.code === '42P01') return referenceCode
    throw error
  }
}

export async function resolveCrmReferenceRoute(referenceValue: unknown) {
  const referenceCode = await resolveCrmReferenceCode(referenceValue)
  const entity = crmEntityForReferenceCode(referenceCode)
  if (!entity || !isPostgresStorageEnabled()) return { referenceCode, pipelineId: null }
  try {
    const result = await query<{ pipeline_id: string }>(
      `SELECT pipeline_id::text FROM ${ENTITY_TABLE[entity]} WHERE reference_code = $1 LIMIT 1`,
      [referenceCode],
    )
    return { referenceCode, pipelineId: result.rows[0]?.pipeline_id || null }
  } catch (error) {
    if ((error as { code?: string })?.code === '42P01') return { referenceCode, pipelineId: null }
    throw error
  }
}

export async function readCrmRecordByReference(input: {
  pipelineId: string
  referenceCode: unknown
}) {
  const referenceCode = await resolveCrmReferenceCode(input.referenceCode)
  const entity = crmEntityForReferenceCode(referenceCode)
  if (!entity || !/^g[aciklmo][0-9]{7}$/.test(referenceCode)) throw new Error('CRM reference is invalid')
  const table = ENTITY_TABLE[entity]
  const result = await query<{ id: string }>(
    `SELECT id::text FROM ${table} WHERE pipeline_id = $1::uuid AND reference_code = $2 LIMIT 1`,
    [input.pipelineId, referenceCode],
  )
  if (!result.rows[0]) throw new Error('CRM record not found')
  return {
    entity,
    ...(await readCrmRecordReference({ pipelineId: input.pipelineId, entity, id: result.rows[0].id })),
  }
}

export async function ensurePipelineCrmReferenceLinks(pipelineId: string) {
  const origin = appPublicUrl()
  if (!origin.startsWith('https://')) return 0
  const result = await query(
    `WITH RECURSIVE records AS (
       SELECT reference_code, name AS title, 'organizations'::text AS entity FROM crm_organizations WHERE pipeline_id = $1::uuid
       UNION ALL SELECT reference_code, full_name, 'contacts' FROM crm_contacts WHERE pipeline_id = $1::uuid
       UNION ALL SELECT reference_code, full_name, 'leads' FROM crm_leads WHERE pipeline_id = $1::uuid
       UNION ALL SELECT reference_code, name, 'opportunities' FROM crm_opportunities WHERE pipeline_id = $1::uuid
       UNION ALL SELECT reference_code, subject, 'meetings' FROM crm_meetings WHERE pipeline_id = $1::uuid
       UNION ALL SELECT reference_code, subject, 'interactions' FROM crm_interactions WHERE pipeline_id = $1::uuid
       UNION ALL SELECT reference_code, name, 'campaigns' FROM crm_campaigns WHERE pipeline_id = $1::uuid
     ), ancestors AS (
       SELECT organization.id, organization.parent_id, ARRAY[organization.id] AS path
       FROM pipeline_spaces pipeline
       JOIN workspace_organizations organization ON organization.id = pipeline.workspace_organization_id
       WHERE pipeline.id = $1::uuid
       UNION ALL
       SELECT parent.id, parent.parent_id, ancestor.path || parent.id
       FROM ancestors ancestor
       JOIN workspace_organizations parent ON parent.id = ancestor.parent_id
       WHERE NOT parent.id = ANY(ancestor.path)
     ), owner AS (
       SELECT pipeline.owner_email, root.id AS organization_root_id
       FROM pipeline_spaces pipeline
       JOIN LATERAL (
         SELECT id FROM ancestors ORDER BY (parent_id IS NULL) DESC LIMIT 1
       ) root ON true
       WHERE pipeline.id = $1::uuid
     )
     INSERT INTO short_links (
       owner_email, organization_root_id, source_app, slug, destination_url, title, tags, created_at, updated_at
     )
     SELECT owner.owner_email, owner.organization_root_id, 'clawpilot-crm', records.reference_code,
       $2 || '/crm/' || records.reference_code || '?pipeline=' || $1::text, left(records.title, 200),
       ARRAY['crm', records.entity, records.reference_code]::text[], now(), now()
     FROM records CROSS JOIN owner
     ON CONFLICT (slug) DO UPDATE SET
       organization_root_id = EXCLUDED.organization_root_id,
       destination_url = EXCLUDED.destination_url,
       title = EXCLUDED.title,
       tags = EXCLUDED.tags,
       deleted_at = NULL,
       disabled_at = NULL,
       updated_at = now()
     WHERE short_links.source_app = 'clawpilot-crm'
       AND short_links.owner_email = EXCLUDED.owner_email
       AND (short_links.destination_url, short_links.title, short_links.tags, short_links.deleted_at, short_links.disabled_at)
         IS DISTINCT FROM (EXCLUDED.destination_url, EXCLUDED.title, EXCLUDED.tags, NULL, NULL)`,
    [pipelineId, origin],
  )
  return result.rowCount || 0
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
    ready: unresolved === 0 && importStatus === 'succeeded',
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
