import crypto from 'node:crypto'
import type { PoolClient } from 'pg'
import {
  contactIdentityKey,
  crmSourceHash,
  organizationIdentityKey,
  stableGlobalSuiteCrmId,
  stableSuiteCrmId,
} from '@/lib/crm/stableId'
import { crmDateOnly } from '@/lib/crm/dateOnly.mjs'
import type {
  CrmContact,
  CrmCampaign,
  CrmEntity,
  CrmInteraction,
  CrmLead,
  CrmMeeting,
  CrmOpportunity,
  CrmOrganization,
  CrmProduct,
  CrmRecord,
  CrmSummary,
  SuiteCrmOutboxRecord,
} from '@/lib/crm/types'
import { isPostgresStorageEnabled } from '@/lib/persistence/config'
import { syncPipelineProductDropdownCatalogInPostgres } from '@/lib/persistence/pipeline'
import { splitPipelineProductNames } from '@/lib/pipeline/productNames.mjs'
import { query, withTransaction } from '@/lib/persistence/postgres'
import { appPublicUrl } from '@/lib/publicUrl'
import { shortLinkUrl } from '@/lib/shortlinks'
import {
  ensurePrimaryWorkspaceOrganization,
  workspaceOrganizationAncestors,
} from '@/lib/organizations'
import { recordAuditEvent } from '@/lib/auditWriter'
import { requireActiveAppUser } from '@/lib/users'
import { zonedDateTimeToIso } from '@/lib/zonedDateTime'

const ENTITY_TABLE: Record<CrmEntity, string> = {
  organizations: 'crm_organizations',
  contacts: 'crm_contacts',
  products: 'crm_products',
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
  emitSuiteCrmOutbox?: boolean
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
    pipelineUser?: boolean
  }
}

export type StageProductInput = CommonStageInput & {
  entity: 'products'
  fields: {
    name: string
    sku?: string
    productType?: string
    category?: string
    status?: string
    price?: number
    cost?: number
    currency?: string
    url?: string
    description?: string
    active?: boolean
  }
}

export type StageOpportunityInput = CommonStageInput & {
  entity: 'opportunities'
  fields: {
    organizationId?: string | null
    organizationSuiteCrmId?: string | null
    contactIds?: string[]
    ownerContactId?: string | null
    productIds?: string[]
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
    contactSuiteCrmId?: string | null
    opportunityId?: string | null
    leadId?: string | null
    meetingId?: string | null
    campaignId?: string | null
    parentSuiteCrmId?: string | null
    parentSuiteCrmType?: 'Accounts' | 'Contacts' | 'Leads' | 'Opportunities' | 'Meetings' | 'Campaigns'
    interactionType?: string
    subject: string
    agentEmail?: string | null
    agentSuiteCrmUserId?: string | null
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
  | StageProductInput
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

function uniqueUuidList(value: unknown) {
  if (!Array.isArray(value)) return []
  const ids = value.map(clean).filter((id) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))
  return [...new Set(ids)]
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
  if (input.entity === 'products') {
    const fields = input.fields
    return {
      ...globalId,
      name: clean(fields.name),
      part_number: clean(fields.sku),
      type: clean(fields.productType) || 'Good',
      category: clean(fields.category),
      cost: Math.max(0, finite(fields.cost)),
      price: Math.max(0, finite(fields.price)),
      url: clean(fields.url),
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
    occurred_at_c: suiteCrmDateTime(fields.occurredAt),
    parent_type: fields.parentSuiteCrmId ? clean(fields.parentSuiteCrmType) : '',
    parent_id: clean(fields.parentSuiteCrmId),
    contact_id: clean(fields.contactSuiteCrmId),
    ...(fields.agentSuiteCrmUserId ? { assigned_user_id: clean(fields.agentSuiteCrmUserId) } : {}),
    description: clean(fields.description),
  }
}

async function suiteCrmRelationships(
  client: PoolClient,
  input: StageCrmRecordInput,
): Promise<NonNullable<SuiteCrmOutboxRecord['relationships']>> {
  if (input.entity === 'interactions') {
    const result = await client.query<{
      link_field_name: 'contact'
      related_module_name: 'Contacts'
      related_bean_id: string
    }>(
      `SELECT 'contact'::text AS link_field_name, 'Contacts'::text AS related_module_name,
         suitecrm_id AS related_bean_id
       FROM crm_contacts
       WHERE pipeline_id = $1::uuid AND id = $2::uuid AND suitecrm_id IS NOT NULL`,
      [input.pipelineId, input.fields.contactId || null],
    )
    return result.rows.map((row) => ({
      linkFieldName: row.link_field_name,
      relatedModuleName: row.related_module_name,
      relatedBeanId: row.related_bean_id,
    }))
  }
  if (input.entity === 'opportunities') {
    const result = await client.query<{
      link_field_name: 'contacts'
      related_module_name: 'Contacts'
      related_bean_id: string
    }>(
      `SELECT 'contacts'::text AS link_field_name, 'Contacts'::text AS related_module_name,
         linked.related_bean_id
       FROM (
         SELECT DISTINCT ON (contact.suitecrm_id)
           contact.suitecrm_id AS related_bean_id, selected.sort_order, contact.id
         FROM (
           SELECT relationship.contact_id, relationship.sort_order
           FROM crm_opportunity_contacts relationship
           WHERE relationship.pipeline_id = $1::uuid
             AND relationship.opportunity_id = $2::uuid
           UNION ALL
           SELECT opportunity.owner_contact_id, -1
           FROM crm_opportunities opportunity
           WHERE opportunity.pipeline_id = $1::uuid
             AND opportunity.id = $2::uuid
             AND opportunity.owner_contact_id IS NOT NULL
         ) selected
         JOIN crm_contacts contact
           ON contact.pipeline_id = $1::uuid
          AND contact.id = selected.contact_id
         WHERE contact.suitecrm_id IS NOT NULL
         ORDER BY contact.suitecrm_id, selected.sort_order, contact.id
       ) linked
       ORDER BY linked.sort_order, linked.id`,
      [input.pipelineId, input.localId || null],
    )
    // Live SuiteCRM metadata has no Opportunities link to AOS_Products. Do not
    // emit a guessed relationship field; the local product join stays durable.
    return result.rows.map((row) => ({
      linkFieldName: row.link_field_name,
      relatedModuleName: row.related_module_name,
      relatedBeanId: row.related_bean_id,
    }))
  }
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
): Promise<string | null> {
  const relationships = await suiteCrmRelationships(client, { ...input, localId })
  const payload: SuiteCrmOutboxRecord = {
    entity: input.entity,
    pipelineId: input.pipelineId,
    localId,
    suiteCrmId,
    attributes: suiteCrmAttributes(input, referenceCode),
    ...(relationships.length > 0 ? { relationships } : {}),
  }
  const idempotencyKey = `crm:${input.entity}:v3:${localId}:${sourceHash}`
  const inserted = await client.query<{ idempotency_key: string }>(
    `
      INSERT INTO sync_outbox (
        aggregate_type, aggregate_id, operation, target_system, payload,
        status, idempotency_key, created_at, available_at, updated_at
      )
      VALUES ($1, $2, 'upsert_record', 'suitecrm', $3::jsonb, 'queued', $4, now(), now(), now())
      ON CONFLICT (target_system, idempotency_key)
      WHERE idempotency_key IS NOT NULL
      DO UPDATE SET
        payload = EXCLUDED.payload,
        status = 'queued',
        attempts = 0,
        last_error = NULL,
        available_at = now(),
        processed_at = NULL,
        locked_at = NULL,
        lock_token = NULL,
        updated_at = now()
      WHERE sync_outbox.status IN ('succeeded', 'dead')
      RETURNING idempotency_key
    `,
    [
      `crm_${input.entity}`,
      localId,
      JSON.stringify(payload),
      idempotencyKey,
    ],
  )
  return inserted.rows[0]?.idempotency_key || null
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
         pipeline_user = COALESCE($29::boolean, pipeline_user),
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
        fields.pipelineUser === undefined ? null : fields.pipelineUser,
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
        sync_status, sync_error, created_by, updated_by, pipeline_user
      )
      VALUES (
        $1::uuid, $2::uuid, $3, $4, $4,
        COALESCE((SELECT reference_code FROM crm_contacts WHERE pipeline_id = $1::uuid AND identity_key = $4), allocate_crm_reference('gc')),
        $5, $6, $7, $8, $9, $10, $11, $12, $13,
        $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25::jsonb, $26,
        'pending', NULL, $27, $27, COALESCE($28::boolean, false)
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
        pipeline_user = COALESCE($28::boolean, crm_contacts.pipeline_user),
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
      fields.pipelineUser === undefined ? null : fields.pipelineUser,
    ],
  )
  return applyAppUserContactIdentity(
    client,
    result.rows[0],
    fields.appUserEmail,
    fields.appUserReferenceCode,
  )
}

async function stageProduct(client: PoolClient, input: StageProductInput, suiteCrmId: string, sourceHash: string) {
  const fields = input.fields
  const currency = clean(fields.currency).toUpperCase() || 'USD'
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error('CRM product currency is invalid')
  const sku = clean(fields.sku)
  if (sku.length > 25) throw new Error('CRM product SKU must be 25 characters or fewer')
  const result = await client.query<{ id: string; suitecrm_id: string; reference_code: string }>(
    `
      INSERT INTO crm_products (
        pipeline_id, suitecrm_id, source_key, source_sheet_id, source_row_number, reference_code,
        name, sku, product_type, category, status, price, cost, currency, url, description, active,
        source_payload, source_hash, sync_status, sync_error, created_by, updated_by
      )
      VALUES (
        $1::uuid, $2, $3, $4, $5,
        COALESCE((SELECT reference_code FROM crm_products WHERE pipeline_id = $1::uuid AND source_key = $3), allocate_crm_reference('gp')),
        $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
        $17::jsonb, $18, 'pending', NULL, $19, $19
      )
      ON CONFLICT (pipeline_id, source_key) DO UPDATE SET
        suitecrm_id = COALESCE(crm_products.suitecrm_id, EXCLUDED.suitecrm_id),
        source_sheet_id = COALESCE(EXCLUDED.source_sheet_id, crm_products.source_sheet_id),
        source_row_number = COALESCE(EXCLUDED.source_row_number, crm_products.source_row_number),
        name = EXCLUDED.name,
        sku = EXCLUDED.sku,
        product_type = EXCLUDED.product_type,
        category = EXCLUDED.category,
        status = EXCLUDED.status,
        price = EXCLUDED.price,
        cost = EXCLUDED.cost,
        currency = EXCLUDED.currency,
        url = EXCLUDED.url,
        description = EXCLUDED.description,
        active = EXCLUDED.active,
        source_payload = EXCLUDED.source_payload,
        source_hash = EXCLUDED.source_hash,
        sync_status = CASE WHEN crm_products.source_hash IS DISTINCT FROM EXCLUDED.source_hash THEN 'pending' ELSE crm_products.sync_status END,
        sync_error = CASE WHEN crm_products.source_hash IS DISTINCT FROM EXCLUDED.source_hash THEN NULL ELSE crm_products.sync_error END,
        updated_by = EXCLUDED.updated_by,
        updated_at = now()
      RETURNING id::text, suitecrm_id, reference_code
    `,
    [
      input.pipelineId, suiteCrmId, input.sourceKey, input.sourceSheetId || null,
      input.sourceRowNumber || null, clean(fields.name), nullable(sku), clean(fields.productType) || 'Good',
      nullable(fields.category), clean(fields.status) || 'Active', Math.max(0, finite(fields.price)),
      Math.max(0, finite(fields.cost)), currency, nullable(fields.url), nullable(fields.description), fields.active !== false,
      JSON.stringify(input.sourcePayload || {}), sourceHash, input.actorEmail,
    ],
  )
  return result.rows[0]
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
  if (fields.ownerContactId) {
    const owner = await client.query(
      `SELECT 1 FROM crm_contacts WHERE pipeline_id = $1::uuid AND id = $2::uuid LIMIT 1`,
      [input.pipelineId, fields.ownerContactId],
    )
    if (!owner.rowCount) throw new Error('Opportunity owner contact was not found in this pipeline')
  }
  const result = await client.query<{ id: string; suitecrm_id: string; reference_code: string }>(
    `
      INSERT INTO crm_opportunities (
        pipeline_id, organization_id, suitecrm_id, source_key, reference_code, source_sheet_id, source_row_number,
        priority, name, owner_name, organization_name, status, stage, loss_reason, lead_source,
        amount, probability, expected_close, description, source_payload, source_hash,
        sync_status, sync_error, created_by, updated_by, owner_contact_id
      )
      VALUES (
        $1::uuid, $2::uuid, $3, $4,
        COALESCE((SELECT reference_code FROM crm_opportunities WHERE pipeline_id = $1::uuid AND source_key = $4), allocate_crm_reference('go')),
        $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
        $15, $16, $17::date, $18, $19::jsonb, $20, 'pending', NULL, $21, $21, $22::uuid
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
        owner_contact_id = CASE WHEN $23::boolean THEN EXCLUDED.owner_contact_id ELSE crm_opportunities.owner_contact_id END,
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
      fields.ownerContactId || null, fields.ownerContactId !== undefined,
    ],
  )
  const row = result.rows[0]
  if (input.fields.contactIds !== undefined) {
    const contactIds = uniqueUuidList(input.fields.contactIds)
    if (contactIds.length !== input.fields.contactIds.length) throw new Error('Opportunity contact selection is invalid')
    if (contactIds.length > 0) {
      const eligible = await client.query<{ id: string }>(
        `SELECT id::text
         FROM crm_contacts
         WHERE pipeline_id = $1::uuid
           AND id = ANY($2::uuid[])
           AND organization_id = $3::uuid`,
        [input.pipelineId, contactIds, input.fields.organizationId || null],
      )
      if (eligible.rowCount !== contactIds.length) {
        throw new Error('Opportunity contacts must belong to the selected organization')
      }
    }
    await client.query(
      `DELETE FROM crm_opportunity_contacts
       WHERE pipeline_id = $1::uuid AND opportunity_id = $2::uuid`,
      [input.pipelineId, row.id],
    )
    for (const [index, contactId] of contactIds.entries()) {
      await client.query(
        `INSERT INTO crm_opportunity_contacts (
           pipeline_id, opportunity_id, contact_id, is_primary, sort_order, created_by, updated_at
         ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, now())`,
        [input.pipelineId, row.id, contactId, index === 0, index, input.actorEmail],
      )
    }
  }
  if (input.fields.productIds !== undefined) {
    const productIds = uniqueUuidList(input.fields.productIds)
    if (productIds.length !== input.fields.productIds.length) throw new Error('Opportunity product selection is invalid')
    if (productIds.length > 0) {
      const eligible = await client.query<{ id: string }>(
        `SELECT id::text
         FROM crm_products
         WHERE pipeline_id = $1::uuid
           AND id = ANY($2::uuid[])`,
        [input.pipelineId, productIds],
      )
      if (eligible.rowCount !== productIds.length) {
        throw new Error('Opportunity products must belong to the selected pipeline')
      }
    }
    await client.query(
      `DELETE FROM crm_opportunity_products
       WHERE pipeline_id = $1::uuid AND opportunity_id = $2::uuid`,
      [input.pipelineId, row.id],
    )
    for (const [index, productId] of productIds.entries()) {
      await client.query(
        `INSERT INTO crm_opportunity_products (
           pipeline_id, opportunity_id, product_id, sort_order, created_by, updated_at
         ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, now())`,
        [input.pipelineId, row.id, productId, index, input.actorEmail],
      )
    }
  }
  return row
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
        interaction_type, subject, agent_email, agent_name, occurred_at, description, direction,
        delivery_status, provider_message_id, provider_thread_id, metadata,
        source_payload, source_hash, sync_status, sync_error, created_by, updated_by
      )
      VALUES (
        $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7::uuid,
        $8, $9,
        COALESCE((SELECT reference_code FROM crm_interactions WHERE pipeline_id = $1::uuid AND source_key = $9), allocate_crm_reference('gi')),
        $10, $11, $12, $13, $14, $15, $16::timestamptz, $17, $18, $19,
        $20, $21, $22::jsonb, $23::jsonb, $24, 'pending', NULL, $25, $25
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
        agent_email = EXCLUDED.agent_email,
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
      nullable(fields.interactionType), clean(fields.subject), fields.agentEmail || null,
      nullable(fields.agentName), isoTimestamp(fields.occurredAt), nullable(fields.description),
      fields.direction || 'internal', nullable(fields.deliveryStatus), fields.providerMessageId || null,
      fields.providerThreadId || null, JSON.stringify(fields.metadata || {}),
      JSON.stringify(input.sourcePayload || {}), sourceHash, input.actorEmail,
    ],
  )
  return result.rows[0]
}

function crmReferenceDestination(referenceCode: string) {
  const origin = appPublicUrl()
  if (!origin.startsWith('https://')) return null
  const destination = new URL(`/crm/${encodeURIComponent(referenceCode)}`, origin)
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
  const destinationUrl = crmReferenceDestination(input.referenceCode)
  if (!destinationUrl) return null
  const owner = await client.query<{ owner_email: string; organization_id: string }>(
    `SELECT pipeline.owner_email, pipeline.workspace_organization_id::text AS organization_id
     FROM pipeline_spaces pipeline
     WHERE pipeline.id = $1::uuid
       AND pipeline.workspace_organization_id IS NOT NULL
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
      owner.rows[0].organization_id,
      input.referenceCode,
      destinationUrl,
      input.title.slice(0, 200),
      ['crm', input.entity, input.referenceCode],
    ],
  )
  return inserted.rows[0] ? crmReferenceShortUrl(input.referenceCode) : null
}

async function normalizeStageCrmRecordInput(
  client: PoolClient,
  input: StageCrmRecordInput,
): Promise<StageCrmRecordInput> {
  if (input.entity === 'opportunities') {
    const organization = await client.query<{ name: string; suitecrm_id: string | null }>(
      `SELECT name, suitecrm_id
       FROM crm_organizations
       WHERE pipeline_id = $1::uuid AND id = $2::uuid
       LIMIT 1`,
      [input.pipelineId, input.fields.organizationId || null],
    )
    if (!organization.rows[0]) throw new Error('Opportunity organization was not found')
    return {
      ...input,
      fields: {
        ...input.fields,
        organization: clean(organization.rows[0].name),
        organizationSuiteCrmId: nullable(organization.rows[0].suitecrm_id),
      },
    }
  }
  if (input.entity === 'meetings') {
    const timezone = clean(input.fields.timezone) || 'America/New_York'
    const startsAt = zonedDateTimeToIso(input.fields.startsAt, timezone)
    const endsAt = zonedDateTimeToIso(input.fields.endsAt, timezone)
    if (!startsAt || !endsAt || Date.parse(endsAt) <= Date.parse(startsAt)) {
      throw new Error('CRM meeting time is invalid for the selected timezone')
    }
    return { ...input, fields: { ...input.fields, startsAt, endsAt, timezone } }
  }
  if (input.entity === 'interactions') {
    const fields = input.fields
    const agentEmail = clean(fields.agentEmail).toLowerCase()
    const agentLookup = agentEmail || clean(fields.agentName)
    const agent = agentLookup
      ? await client.query<{ email: string; display_name: string | null; suitecrm_user_id: string | null }>(
          `SELECT app_user.email, app_user.display_name, app_user.suitecrm_user_id
           FROM app_users app_user
           JOIN pipeline_spaces pipeline ON pipeline.id = $1::uuid
           LEFT JOIN pipeline_space_members membership
             ON membership.pipeline_id = pipeline.id
            AND membership.user_email = app_user.email
           WHERE (app_user.email = lower($2) OR lower(COALESCE(app_user.display_name, '')) = lower($2))
             AND app_user.status = 'active'
             AND (pipeline.owner_email = app_user.email OR membership.user_email IS NOT NULL)
           ORDER BY app_user.email
           LIMIT 2`,
          [input.pipelineId, agentLookup],
        )
      : null
    if ((agent?.rows.length || 0) > 1) throw new Error('Interaction agent mapping is ambiguous')
    if (agentEmail && !agent?.rows[0]) {
      throw new Error('Interaction agent must be an active ClawPilot user with pipeline access')
    }
    const relationship = await client.query<{
      organization_id: string | null
      organization_suitecrm_id: string | null
      contact_suitecrm_id: string | null
      contact_organization_id: string | null
    }>(
      `WITH resolved AS (
         SELECT COALESCE(
           $2::uuid,
           (SELECT organization_id FROM crm_contacts WHERE pipeline_id = $1::uuid AND id = $3::uuid),
           (SELECT organization_id FROM crm_leads WHERE pipeline_id = $1::uuid AND id = $4::uuid),
           (SELECT organization_id FROM crm_opportunities WHERE pipeline_id = $1::uuid AND id = $5::uuid),
           (SELECT organization_id FROM crm_meetings WHERE pipeline_id = $1::uuid AND id = $6::uuid)
         ) AS organization_id
       )
       SELECT organization.id::text AS organization_id,
         organization.suitecrm_id AS organization_suitecrm_id,
         contact.suitecrm_id AS contact_suitecrm_id,
         contact.organization_id::text AS contact_organization_id
       FROM resolved
       LEFT JOIN crm_organizations organization
         ON organization.pipeline_id = $1::uuid
        AND organization.id = resolved.organization_id
       LEFT JOIN crm_contacts contact
         ON contact.pipeline_id = $1::uuid
        AND contact.id = $3::uuid`,
      [
        input.pipelineId,
        fields.organizationId || null,
        fields.contactId || null,
        fields.leadId || null,
        fields.opportunityId || null,
        fields.meetingId || null,
      ],
    )
    const organization = relationship.rows[0]
    if (
      fields.organizationId
      && fields.contactId
      && organization?.contact_organization_id !== organization?.organization_id
    ) {
      throw new Error('Interaction contact must belong to the selected organization')
    }
    return {
      ...input,
      fields: {
        ...fields,
        agentEmail: agent?.rows[0]?.email || null,
        agentName: agent?.rows[0]
          ? clean(agent.rows[0].display_name) || agent.rows[0].email
          : fields.agentName,
        agentSuiteCrmUserId: agent?.rows[0]?.suitecrm_user_id || null,
        organizationId: organization?.organization_id || null,
        contactSuiteCrmId: organization?.contact_suitecrm_id || null,
        parentSuiteCrmId: organization?.organization_suitecrm_id || fields.parentSuiteCrmId || null,
        parentSuiteCrmType: organization?.organization_suitecrm_id ? 'Accounts' : fields.parentSuiteCrmType,
      },
    }
  }
  return input
}

export async function stageCrmRecordWithClient(client: PoolClient, rawInput: StageCrmRecordInput) {
  const input = await normalizeStageCrmRecordInput(client, rawInput)
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
  let row: { id: string; suitecrm_id: string; reference_code: string }
  switch (input.entity) {
    case 'organizations':
      row = await stageOrganization(client, input, suiteCrmId, sourceHash, sourceKey)
      break
    case 'contacts':
      row = await stageContact(client, input, suiteCrmId, sourceHash, sourceKey)
      break
    case 'products':
      row = await stageProduct(client, input, suiteCrmId, sourceHash)
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
  let suiteCrmOutboxKey: string | null = null
  if (input.emitSuiteCrmOutbox !== false) {
    suiteCrmOutboxKey = await enqueueSuiteCrmRecord(
      client,
      input,
      row.id,
      row.suitecrm_id,
      row.reference_code,
      sourceHash,
    )
  } else {
    const table = ENTITY_TABLE[input.entity]
    await client.query(
      `UPDATE ${table}
       SET sync_status = 'synced', sync_error = NULL, suitecrm_synced_at = now(), updated_at = now()
       WHERE id = $1::uuid`,
      [row.id],
    )
  }
  const title = clean('name' in input.fields ? input.fields.name : 'fullName' in input.fields
    ? input.fields.fullName : 'subject' in input.fields ? input.fields.subject : row.reference_code)
  const shortUrl = await ensureCrmReferenceShortLink(client, {
    pipelineId: input.pipelineId,
    entity: input.entity,
    referenceCode: row.reference_code,
    title: title || row.reference_code,
  })
  if (suiteCrmOutboxKey) {
    await recordAuditEvent({
      actor: input.actorEmail,
      eventType: 'crm.record.staged',
      aggregateType: `crm_${input.entity}`,
      aggregateId: row.id,
      eventKey: `crm-stage:${suiteCrmOutboxKey}`,
      payload: {
        pipelineId: input.pipelineId,
        sourceKey,
        referenceCode: row.reference_code,
        recordTitle: title || row.reference_code,
        message: `${title || row.reference_code} queued for CRM synchronization`,
      },
    }, client)
  }
  return {
    id: row.id,
    suiteCrmId: row.suitecrm_id,
    referenceCode: row.reference_code,
    shortUrl,
    sourceHash,
  }
}

export async function stageCrmRecordInPostgres(input: StageCrmRecordInput) {
  const staged = await withTransaction((client) => stageCrmRecordWithClient(client, input))
  if (input.entity === 'products') {
    await syncPipelineProductDropdownCatalogInPostgres({
      pipelineId: input.pipelineId,
      actorEmail: input.actorEmail,
    })
  }
  return staged
}

async function lockCrmMutation(client: PoolClient, key: string) {
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [key])
}

export async function createCrmOpportunityInPostgres(input: StageOpportunityInput): Promise<{
  opportunity: CrmOpportunity
  created: boolean
}> {
  return withTransaction(async (client) => {
    const mutationKey = `crm-opportunity-create:${input.pipelineId}:${clean(input.sourceKey)}`
    const requestFingerprint = crmSourceHash({ fields: input.fields, sourcePayload: input.sourcePayload || {} })
    await lockCrmMutation(client, mutationKey)
    const receipt = await client.query<{ aggregate_id: string; request_fingerprint: string | null }>(
      `SELECT aggregate_id, payload->>'requestFingerprint' AS request_fingerprint
       FROM audit_events WHERE event_key = $1 LIMIT 1`,
      [mutationKey],
    )
    if (receipt.rows[0]) {
      if (receipt.rows[0].request_fingerprint && receipt.rows[0].request_fingerprint !== requestFingerprint) {
        throw new Error('Idempotency-Key was already used with a different opportunity payload')
      }
      const replayed = await client.query<Record<string, unknown>>(
        `SELECT * FROM crm_opportunities
         WHERE pipeline_id = $1::uuid AND id = $2::uuid
         LIMIT 1`,
        [input.pipelineId, receipt.rows[0].aggregate_id],
      )
      if (!replayed.rows[0]) throw new Error('Opportunity not found')
      const [opportunity] = await hydrateOpportunityRowsWithClient(client, replayed.rows, input.pipelineId)
      return { opportunity, created: false }
    }

    const existing = await client.query<Record<string, unknown>>(
      `SELECT * FROM crm_opportunities
       WHERE pipeline_id = $1::uuid AND source_key = $2
       LIMIT 1`,
      [input.pipelineId, clean(input.sourceKey)],
    )
    if (existing.rows[0]) {
      await recordAuditEvent({
        actor: input.actorEmail,
        eventType: 'pipeline.opportunity.created',
        aggregateType: 'crm_opportunity',
        aggregateId: String(existing.rows[0].id),
        eventKey: mutationKey,
        organizationId: nullable(existing.rows[0].organization_id),
        payload: { pipelineId: input.pipelineId, requestFingerprint: null, recoveredReceipt: true },
      }, client)
      const [opportunity] = await hydrateOpportunityRowsWithClient(client, existing.rows, input.pipelineId)
      return { opportunity, created: false }
    }

    const staged = await stageCrmRecordWithClient(client, input)
    const created = await client.query<Record<string, unknown>>(
      `SELECT * FROM crm_opportunities
       WHERE pipeline_id = $1::uuid AND id = $2::uuid
       LIMIT 1`,
      [input.pipelineId, staged.id],
    )
    await recordAuditEvent({
      actor: input.actorEmail,
      eventType: 'pipeline.opportunity.created',
      aggregateType: 'crm_opportunity',
      aggregateId: staged.id,
      eventKey: mutationKey,
      organizationId: input.fields.organizationId || null,
      payload: { pipelineId: input.pipelineId, requestFingerprint },
    }, client)
    const [opportunity] = await hydrateOpportunityRowsWithClient(client, created.rows, input.pipelineId)
    return { opportunity, created: true }
  })
}

export async function updateCrmOpportunityInPostgres(input: {
  pipelineId: string
  opportunityId: string
  mutationKey: string
  expectedUpdatedAt: string
  actorEmail: string
  fields: StageOpportunityInput['fields']
}): Promise<{
  opportunity: CrmOpportunity
  applied: boolean
  replayed: boolean
  conflict: boolean
}> {
  return withTransaction(async (client) => {
    const receiptKey = `pipeline-opportunity-update:${input.mutationKey}`
    const requestFingerprint = crmSourceHash({
      expectedUpdatedAt: input.expectedUpdatedAt,
      fields: input.fields,
    })
    await lockCrmMutation(client, receiptKey)
    const receipt = await client.query<{ request_fingerprint: string | null }>(
      `SELECT payload->>'requestFingerprint' AS request_fingerprint
       FROM audit_events WHERE event_key = $1 LIMIT 1`,
      [receiptKey],
    )
    if (receipt.rows[0]) {
      if (
        receipt.rows[0].request_fingerprint
        && receipt.rows[0].request_fingerprint !== requestFingerprint
      ) {
        throw new Error('Idempotency-Key was already used with a different opportunity update')
      }
      const replayed = await client.query<Record<string, unknown>>(
        `SELECT * FROM crm_opportunities
         WHERE pipeline_id = $1::uuid AND id = $2::uuid
         LIMIT 1`,
        [input.pipelineId, input.opportunityId],
      )
      if (!replayed.rows[0]) throw new Error('Opportunity not found')
      const [opportunity] = await hydrateOpportunityRowsWithClient(client, replayed.rows, input.pipelineId)
      return { opportunity, applied: false, replayed: true, conflict: false }
    }

    const locked = await client.query<Record<string, unknown>>(
      `SELECT opportunity.*, organization.suitecrm_id AS organization_suitecrm_id
       FROM crm_opportunities opportunity
       LEFT JOIN crm_organizations organization ON organization.id = opportunity.organization_id
       WHERE opportunity.pipeline_id = $1::uuid AND opportunity.id = $2::uuid
       FOR UPDATE OF opportunity`,
      [input.pipelineId, input.opportunityId],
    )
    const row = locked.rows[0]
    if (!row) throw new Error('Opportunity not found')
    const [current] = await hydrateOpportunityRowsWithClient(client, [row], input.pipelineId)
    if (current.updatedAt !== input.expectedUpdatedAt) {
      return { opportunity: current, applied: false, replayed: false, conflict: true }
    }

    await stageCrmRecordWithClient(client, {
      entity: 'opportunities',
      pipelineId: input.pipelineId,
      localId: current.id,
      sourceKey: current.sourceKey,
      sourcePayload: { source: 'clawpilot-pipeline' },
      actorEmail: input.actorEmail,
      fields: {
        ...input.fields,
        organizationId: current.organizationId,
        organizationSuiteCrmId: nullable(row.organization_suitecrm_id),
        contactIds: input.fields.contactIds ?? current.contactIds,
        productIds: input.fields.productIds ?? current.productIds,
        ownerContactId: input.fields.ownerContactId === undefined ? current.ownerContactId : input.fields.ownerContactId,
      },
    })
    await recordAuditEvent({
      actor: input.actorEmail,
      eventType: 'pipeline.opportunity.updated',
      aggregateType: 'crm_opportunity',
      aggregateId: current.id,
      eventKey: receiptKey,
      organizationId: current.organizationId,
      payload: {
        pipelineId: input.pipelineId,
        opportunityId: current.id,
        requestFingerprint,
      },
    }, client)
    const updated = await client.query<Record<string, unknown>>(
      `SELECT * FROM crm_opportunities
       WHERE pipeline_id = $1::uuid AND id = $2::uuid
       LIMIT 1`,
      [input.pipelineId, input.opportunityId],
    )
    const [opportunity] = await hydrateOpportunityRowsWithClient(client, updated.rows, input.pipelineId)
    return { opportunity, applied: true, replayed: false, conflict: false }
  })
}

export function normalizeCrmDescription(value: unknown): string {
  const normalized = String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .trim()
  if (normalized.length > 10_000) throw new Error('CRM description must be 10,000 characters or fewer')
  return normalized
}

export type UpdateCrmDescriptionInput = {
  pipelineId: string
  entity: 'organizations' | 'contacts'
  id: string
  description: unknown
  actorEmail: string
}

export async function updateCrmDescriptionWithClient(client: PoolClient, input: UpdateCrmDescriptionInput) {
  const description = normalizeCrmDescription(input.description)
  if (input.entity === 'organizations') {
    const result = await client.query<Record<string, unknown>>(
      `SELECT organization.*, parent.suitecrm_id AS parent_suitecrm_id
       FROM crm_organizations organization
       LEFT JOIN crm_organizations parent ON parent.id = organization.parent_organization_id
       WHERE organization.pipeline_id = $1::uuid AND organization.id = $2::uuid
       LIMIT 1`,
      [input.pipelineId, input.id],
    )
    const row = result.rows[0]
    if (!row) throw new Error('CRM organization was not found')
    const sourcePayload = row.source_payload && typeof row.source_payload === 'object' && !Array.isArray(row.source_payload)
      ? row.source_payload as Record<string, unknown>
      : {}
    return stageCrmRecordWithClient(client, {
      entity: 'organizations',
      pipelineId: input.pipelineId,
      localId: input.id,
      sourceKey: clean(row.source_key),
      sourceSheetId: nullable(row.source_sheet_id),
      sourceRowNumber: row.source_row_number === null ? null : Number(row.source_row_number),
      sourcePayload,
      actorEmail: input.actorEmail,
      fields: {
        parentOrganizationId: nullable(row.parent_organization_id),
        parentOrganizationSuiteCrmId: nullable(row.parent_suitecrm_id),
        workspaceOrganizationId: nullable(row.workspace_organization_id),
        relationshipType: (row.relationship_type || 'customer') as StageOrganizationInput['fields']['relationshipType'],
        priority: clean(row.priority),
        name: clean(row.name),
        accountType: clean(row.account_type),
        accountManager: clean(row.account_manager),
        website: clean(row.website),
        linkedinUrl: clean(row.linkedin_url),
        phone: clean(row.phone),
        email: clean(row.email),
        emailOptOut: row.email_opt_out === true,
        address: clean(row.billing_address_street),
        city: clean(row.billing_address_city),
        state: clean(row.billing_address_state),
        postalCode: clean(row.billing_address_postal_code),
        country: clean(row.billing_address_country),
        description,
      },
    })
  }

  const result = await client.query<Record<string, unknown>>(
    `SELECT contact.*, organization.suitecrm_id AS organization_suitecrm_id,
       app_user.reference_code AS app_user_reference_code
     FROM crm_contacts contact
     JOIN crm_organizations organization ON organization.id = contact.organization_id
     LEFT JOIN app_users app_user ON app_user.email = contact.app_user_email
     WHERE contact.pipeline_id = $1::uuid AND contact.id = $2::uuid
     LIMIT 1`,
    [input.pipelineId, input.id],
  )
  const row = result.rows[0]
  if (!row) throw new Error('CRM contact was not found')
  const sourcePayload = row.source_payload && typeof row.source_payload === 'object' && !Array.isArray(row.source_payload)
    ? row.source_payload as Record<string, unknown>
    : {}
  return stageCrmRecordWithClient(client, {
    entity: 'contacts',
    pipelineId: input.pipelineId,
    localId: input.id,
    sourceKey: clean(row.source_key),
    sourceSheetId: nullable(row.source_sheet_id),
    sourceRowNumber: row.source_row_number === null ? null : Number(row.source_row_number),
    sourcePayload,
    actorEmail: input.actorEmail,
    fields: {
      organizationId: clean(row.organization_id),
      organizationSuiteCrmId: clean(row.organization_suitecrm_id),
      appUserEmail: nullable(row.app_user_email),
      appUserReferenceCode: nullable(row.app_user_reference_code),
      priority: clean(row.priority),
      firstName: clean(row.first_name),
      lastName: clean(row.last_name),
      fullName: clean(row.full_name),
      contactType: clean(row.contact_type),
      accountManager: clean(row.account_manager),
      jobTitle: clean(row.job_title),
      email: clean(row.email),
      linkedinUrl: clean(row.linkedin_url),
      phoneWork: clean(row.phone_work),
      phoneMobile: clean(row.phone_mobile),
      address: clean(row.primary_address_street),
      city: clean(row.primary_address_city),
      state: clean(row.primary_address_state),
      postalCode: clean(row.primary_address_postal_code),
      country: clean(row.primary_address_country),
      description,
      emailOptOut: row.email_opt_out === true,
    },
  })
}

export async function updateCrmDescriptionInPostgres(input: UpdateCrmDescriptionInput) {
  return withTransaction((client) => updateCrmDescriptionWithClient(client, input))
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
  const stagedByWorkspaceOrganization = new Map<string, { id: string; suiteCrmId: string }>()

  async function stageWorkspaceOrganization(inputOrganization: {
    id: string
    referenceCode: string
    name: string
    organizationType: 'root' | 'member'
  }, parentRecord: { id: string; suiteCrmId: string } | null) {
    const existing = await query<Record<string, unknown>>(
      `SELECT *
       FROM crm_organizations
       WHERE pipeline_id = $1::uuid AND reference_code = $2
       LIMIT 1`,
      [input.pipelineId, inputOrganization.referenceCode],
    )
    const current = existing.rows[0]
    const sourcePayload = current?.source_payload && typeof current.source_payload === 'object'
      ? current.source_payload as Record<string, unknown>
      : {}
    return stageCrmRecordInPostgres({
      entity: 'organizations',
      pipelineId: input.pipelineId,
      localId: current ? String(current.id) : null,
      sourceKey: `workspace:${inputOrganization.id}`,
      sourceSheetId: nullable(current?.source_sheet_id),
      sourceRowNumber: current?.source_row_number === null || current?.source_row_number === undefined
        ? null
        : Number(current.source_row_number),
      actorEmail: input.actorEmail,
      sourcePayload: {
        ...sourcePayload,
        source: 'clawpilot_workspace',
        workspaceOrganizationId: inputOrganization.id,
      },
      fields: {
        name: inputOrganization.name,
        workspaceOrganizationId: inputOrganization.id,
        workspaceOrganizationReferenceCode: inputOrganization.referenceCode,
        parentOrganizationId: parentRecord?.id || null,
        parentOrganizationSuiteCrmId: parentRecord?.suiteCrmId || null,
        relationshipType: inputOrganization.organizationType === 'root' ? 'workspace_root' : 'workspace_member',
        accountType: clean(current?.account_type)
          || (inputOrganization.organizationType === 'root' ? 'Parent organization' : 'Member organization'),
        priority: clean(current?.priority),
        accountManager: clean(current?.account_manager),
        website: clean(current?.website),
        linkedinUrl: clean(current?.linkedin_url),
        phone: clean(current?.phone),
        email: clean(current?.email),
        emailOptOut: current?.email_opt_out === true,
        address: clean(current?.billing_address_street),
        city: clean(current?.billing_address_city),
        state: clean(current?.billing_address_state),
        postalCode: clean(current?.billing_address_postal_code),
        country: clean(current?.billing_address_country),
        description: clean(current?.description),
      },
    })
  }

  let parent: { id: string; suiteCrmId: string } | null = null
  for (const organization of lineage) {
    const row = await stageWorkspaceOrganization(organization, parent)
    parent = row
    stagedByWorkspaceOrganization.set(organization.id, row)
    staged.push({ ...row, workspaceOrganizationId: organization.id, name: organization.name })
  }
  const customerParent = staged[staged.length - 1]

  const descendants = await query<{
    id: string
    reference_code: string
    parent_id: string
    name: string
    organization_type: 'root' | 'member'
  }>(
    `WITH RECURSIVE descendants AS (
       SELECT organization.id, organization.reference_code, organization.parent_id,
         organization.name, organization.organization_type, 1 AS depth,
         ARRAY[$1::uuid, organization.id] AS path
       FROM workspace_organizations organization
       WHERE organization.parent_id = $1::uuid
       UNION ALL
       SELECT child.id, child.reference_code, child.parent_id,
         child.name, child.organization_type, parent.depth + 1,
         parent.path || child.id
       FROM workspace_organizations child
       JOIN descendants parent ON child.parent_id = parent.id
       WHERE NOT child.id = ANY(parent.path)
     )
     SELECT id::text, reference_code, parent_id::text, name, organization_type
     FROM descendants
     ORDER BY depth, lower(name), id`,
    [workspaceOrganizationId],
  )
  const stagedDescendants: typeof staged = []
  for (const organization of descendants.rows) {
    const descendantParent = stagedByWorkspaceOrganization.get(organization.parent_id)
    if (!descendantParent) throw new Error('Workspace descendant hierarchy is incomplete')
    const row = await stageWorkspaceOrganization({
      id: organization.id,
      referenceCode: organization.reference_code,
      name: organization.name,
      organizationType: organization.organization_type,
    }, descendantParent)
    stagedByWorkspaceOrganization.set(organization.id, row)
    stagedDescendants.push({
      ...row,
      workspaceOrganizationId: organization.id,
      name: organization.name,
    })
  }

  const customers = await query<Record<string, unknown>>(
    `SELECT *
     FROM crm_organizations
     WHERE pipeline_id = $1::uuid
       AND relationship_type = 'customer'
       AND parent_organization_id IS NULL`,
    [input.pipelineId],
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
  return { lineage: staged, descendants: stagedDescendants, customerParent }
}

export async function syncAppUserProfileToCrm(input: {
  email: string
  pipelineId: string
}) {
  const user = await requireActiveAppUser(input.email)
  const organizationPipeline = await query<{ id: string }>(
    `SELECT pipeline.id::text
     FROM pipeline_spaces pipeline
     JOIN app_users app_user ON app_user.email = $2
     WHERE pipeline.id = $1::uuid
       AND pipeline.workspace_organization_id = app_user.organization_id
     LIMIT 1`,
    [input.pipelineId, user.email],
  )
  if (!organizationPipeline.rows[0]) throw new Error('CRM profile synchronization requires an organization pipeline')
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
    `SELECT pipeline.id::text
     FROM pipeline_spaces pipeline
     JOIN app_users app_user ON app_user.email = $1
     WHERE pipeline.workspace_organization_id = app_user.organization_id
     ORDER BY pipeline.created_at, pipeline.id`,
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
    pipelineUser: row.pipeline_user === true,
    syncStatus: row.sync_status as CrmContact['syncStatus'],
    syncError: nullable(row.sync_error), updatedAt: String(row.updated_at),
  }
}

function productFromRow(row: Record<string, unknown>): CrmProduct {
  return {
    id: String(row.id), referenceCode: clean(row.reference_code), shortUrl: crmReferenceShortUrl(row.reference_code),
    pipelineId: String(row.pipeline_id), suiteCrmId: nullable(row.suitecrm_id), sourceKey: String(row.source_key),
    sourceRowNumber: row.source_row_number === null ? null : Number(row.source_row_number), name: clean(row.name),
    sku: clean(row.sku), productType: clean(row.product_type), category: clean(row.category), status: clean(row.status),
    price: finite(row.price), cost: finite(row.cost), currency: clean(row.currency) || 'USD', url: clean(row.url),
    description: clean(row.description),
    active: row.active !== false, syncStatus: row.sync_status as CrmProduct['syncStatus'], syncError: nullable(row.sync_error),
    updatedAt: String(row.updated_at),
  }
}

function opportunityFromRow(
  row: Record<string, unknown>,
  contacts: CrmOpportunity['contacts'] = [],
  products: CrmProduct[] = [],
  ownerContact: CrmOpportunity['ownerContact'] = null,
): CrmOpportunity {
  return {
    id: String(row.id), referenceCode: clean(row.reference_code), shortUrl: crmReferenceShortUrl(row.reference_code),
    pipelineId: String(row.pipeline_id), organizationId: nullable(row.organization_id), suiteCrmId: nullable(row.suitecrm_id),
    sourceKey: String(row.source_key), sourceRowNumber: row.source_row_number === null ? null : Number(row.source_row_number),
    priority: clean(row.priority), name: clean(row.name), owner: clean(row.owner_name), organization: clean(row.organization_name),
    status: clean(row.status), stage: clean(row.stage), lossReason: clean(row.loss_reason), source: clean(row.lead_source),
    value: finite(row.amount), probability: finite(row.probability), expectedClose: crmDateOnly(row.expected_close),
    notes: clean(row.description), contactIds: contacts.map((contact) => contact.id), contacts,
    ownerContactId: nullable(row.owner_contact_id), ownerContact,
    productIds: products.map((product) => product.id), products,
    syncStatus: row.sync_status as CrmOpportunity['syncStatus'], syncError: nullable(row.sync_error),
    updatedAt: String(row.updated_at),
  }
}

async function hydrateOpportunityRows(
  rows: Record<string, unknown>[],
  pipelineId: string,
  runQuery: (text: string, values: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>,
) {
  if (rows.length === 0) return []
  const opportunityIds = rows.map((row) => String(row.id))
  const relationshipResult = await runQuery(
    `SELECT relationship.opportunity_id::text, relationship.is_primary,
       contact.id::text, contact.reference_code, contact.full_name, contact.email,
       contact.phone_work, contact.phone_mobile, contact.job_title
     FROM crm_opportunity_contacts relationship
     JOIN crm_contacts contact
       ON contact.pipeline_id = relationship.pipeline_id
      AND contact.id = relationship.contact_id
     WHERE relationship.pipeline_id = $1::uuid
       AND relationship.opportunity_id = ANY($2::uuid[])
     ORDER BY relationship.opportunity_id, relationship.sort_order, contact.full_name, contact.id`,
    [pipelineId, opportunityIds],
  )
  const byOpportunity = new Map<string, CrmOpportunity['contacts']>()
  for (const relationship of relationshipResult.rows) {
    const opportunityId = String(relationship.opportunity_id)
    const contacts = byOpportunity.get(opportunityId) || []
    contacts.push({
      id: String(relationship.id),
      referenceCode: clean(relationship.reference_code),
      fullName: clean(relationship.full_name),
      email: clean(relationship.email),
      phoneWork: clean(relationship.phone_work),
      phoneMobile: clean(relationship.phone_mobile),
      jobTitle: clean(relationship.job_title),
      isPrimary: relationship.is_primary === true,
    })
    byOpportunity.set(opportunityId, contacts)
  }
  const productResult = await runQuery(
    `SELECT relationship.opportunity_id::text, product.*
     FROM crm_opportunity_products relationship
     JOIN crm_products product
       ON product.pipeline_id = relationship.pipeline_id
      AND product.id = relationship.product_id
     WHERE relationship.pipeline_id = $1::uuid
       AND relationship.opportunity_id = ANY($2::uuid[])
     ORDER BY relationship.opportunity_id, relationship.sort_order, product.name, product.id`,
    [pipelineId, opportunityIds],
  )
  const productsByOpportunity = new Map<string, CrmProduct[]>()
  for (const relationship of productResult.rows) {
    const opportunityId = String(relationship.opportunity_id)
    const products = productsByOpportunity.get(opportunityId) || []
    products.push(productFromRow(relationship))
    productsByOpportunity.set(opportunityId, products)
  }
  const ownerResult = await runQuery(
    `SELECT opportunity.id::text AS opportunity_id, contact.id::text, contact.reference_code,
       contact.full_name, contact.email, contact.phone_work, contact.phone_mobile, contact.job_title
     FROM crm_opportunities opportunity
     JOIN crm_contacts contact
       ON contact.pipeline_id = opportunity.pipeline_id
      AND contact.id = opportunity.owner_contact_id
     WHERE opportunity.pipeline_id = $1::uuid
       AND opportunity.id = ANY($2::uuid[])`,
    [pipelineId, opportunityIds],
  )
  const ownersByOpportunity = new Map<string, NonNullable<CrmOpportunity['ownerContact']>>()
  for (const owner of ownerResult.rows) {
    ownersByOpportunity.set(String(owner.opportunity_id), {
      id: String(owner.id),
      referenceCode: clean(owner.reference_code),
      fullName: clean(owner.full_name),
      email: clean(owner.email),
      phoneWork: clean(owner.phone_work),
      phoneMobile: clean(owner.phone_mobile),
      jobTitle: clean(owner.job_title),
      isPrimary: false,
    })
  }
  return rows.map((row) => opportunityFromRow(
    row,
    byOpportunity.get(String(row.id)) || [],
    productsByOpportunity.get(String(row.id)) || [],
    ownersByOpportunity.get(String(row.id)) || null,
  ))
}

function hydrateOpportunityRowsWithClient(client: PoolClient, rows: Record<string, unknown>[], pipelineId: string) {
  return hydrateOpportunityRows(rows, pipelineId, (text, values) => client.query<Record<string, unknown>>(text, values))
}

function hydrateOpportunityRowsWithPool(rows: Record<string, unknown>[], pipelineId: string) {
  return hydrateOpportunityRows(rows, pipelineId, (text, values) => query<Record<string, unknown>>(text, values))
}

function interactionFromRow(row: Record<string, unknown>): CrmInteraction {
  return {
    id: String(row.id), referenceCode: clean(row.reference_code), shortUrl: crmReferenceShortUrl(row.reference_code),
    pipelineId: String(row.pipeline_id), organizationId: nullable(row.organization_id), organizationName: clean(row.organization_name),
    contactId: nullable(row.contact_id),
    opportunityId: nullable(row.opportunity_id), leadId: nullable(row.lead_id), meetingId: nullable(row.meeting_id),
    campaignId: nullable(row.campaign_id), suiteCrmId: nullable(row.suitecrm_id), sourceKey: String(row.source_key),
    sourceRowNumber: row.source_row_number === null ? null : Number(row.source_row_number), interactionType: clean(row.interaction_type),
    subject: clean(row.subject), agentEmail: nullable(row.agent_email), agentName: clean(row.agent_name),
    occurredAt: row.occurred_at ? String(row.occurred_at) : null,
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
    status: row.status as CrmCampaign['status'], startDate: crmDateOnly(row.start_date),
    endDate: crmDateOnly(row.end_date), subjectTemplate: clean(row.subject_template),
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
  needsReview?: boolean
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
  if (input.entity === 'products') {
    const result = await query<Record<string, unknown>>(
      `SELECT * FROM crm_products
       WHERE pipeline_id = $1::uuid
         AND ($2 = '' OR reference_code ILIKE '%' || $2 || '%'
           OR name ILIKE '%' || $2 || '%' OR sku ILIKE '%' || $2 || '%'
           OR product_type ILIKE '%' || $2 || '%' OR category ILIKE '%' || $2 || '%'
           OR url ILIKE '%' || $2 || '%')
       ORDER BY active DESC, lower(name), lower(COALESCE(sku, '')), id
       LIMIT $3`,
      [input.pipelineId, search, limit],
    )
    return result.rows.map(productFromRow)
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
      `SELECT opportunity.*, COALESCE(organization.name, opportunity.organization_name) AS organization_name
       FROM crm_opportunities opportunity
       LEFT JOIN crm_organizations organization
         ON organization.pipeline_id = opportunity.pipeline_id
        AND organization.id = opportunity.organization_id
       WHERE opportunity.pipeline_id = $1::uuid
         AND ($2 = '' OR opportunity.reference_code ILIKE '%' || $2 || '%'
           OR opportunity.name ILIKE '%' || $2 || '%'
           OR COALESCE(organization.name, opportunity.organization_name) ILIKE '%' || $2 || '%')
       ORDER BY opportunity.updated_at DESC, opportunity.id LIMIT $3`,
      [input.pipelineId, search, limit],
    )
    return hydrateOpportunityRowsWithPool(result.rows, input.pipelineId)
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
    `SELECT interaction.*,
       COALESCE(interaction.organization_id, contact.organization_id, lead.organization_id,
         opportunity.organization_id, meeting.organization_id) AS organization_id,
       organization.name AS organization_name
     FROM crm_interactions interaction
     LEFT JOIN crm_contacts contact ON contact.id = interaction.contact_id
     LEFT JOIN crm_leads lead ON lead.id = interaction.lead_id
     LEFT JOIN crm_opportunities opportunity ON opportunity.id = interaction.opportunity_id
     LEFT JOIN crm_meetings meeting ON meeting.id = interaction.meeting_id
     LEFT JOIN crm_organizations organization ON organization.id = COALESCE(
       interaction.organization_id, contact.organization_id, lead.organization_id,
       opportunity.organization_id, meeting.organization_id
     )
     WHERE interaction.pipeline_id = $1::uuid
       AND (NOT $3::boolean OR COALESCE(
         interaction.organization_id, contact.organization_id, lead.organization_id,
         opportunity.organization_id, meeting.organization_id
       ) IS NULL)
       AND ($2 = '' OR interaction.reference_code ILIKE '%' || $2 || '%'
         OR interaction.subject ILIKE '%' || $2 || '%'
         OR interaction.description ILIKE '%' || $2 || '%'
         OR organization.name ILIKE '%' || $2 || '%')
     ORDER BY interaction.occurred_at DESC NULLS LAST, interaction.updated_at DESC, interaction.id LIMIT $4`,
    [input.pipelineId, search, input.needsReview === true, limit],
  )
  return result.rows.map(interactionFromRow)
}

export async function readCrmOpportunityInPostgres(input: {
  pipelineId: string
  id: string
}): Promise<CrmOpportunity> {
  const result = await query<Record<string, unknown>>(
    `SELECT opportunity.*, COALESCE(organization.name, opportunity.organization_name) AS organization_name
     FROM crm_opportunities opportunity
     LEFT JOIN crm_organizations organization
       ON organization.pipeline_id = opportunity.pipeline_id
      AND organization.id = opportunity.organization_id
     WHERE opportunity.pipeline_id = $1::uuid AND opportunity.id = $2::uuid
     LIMIT 1`,
    [input.pipelineId, input.id],
  )
  const row = result.rows[0]
  if (!row) throw new Error('Opportunity not found')
  return (await hydrateOpportunityRowsWithPool([row], input.pipelineId))[0]
}

export async function appendCrmOpportunityCommentInPostgres(input: {
  pipelineId: string
  opportunityId: string
  sourceKey: string
  expectedUpdatedAt: string
  actorEmail: string
  actorName: string
  occurredAt: string
  comment: string
  commentLine: string
}): Promise<{ opportunity: CrmOpportunity; created: boolean; conflict: boolean }> {
  return withTransaction(async (client) => {
    const requestFingerprint = crmSourceHash({
      expectedUpdatedAt: input.expectedUpdatedAt,
      comment: input.comment,
      commentLine: input.commentLine,
    })
    const locked = await client.query<Record<string, unknown>>(
      `SELECT opportunity.*, organization.suitecrm_id AS organization_suitecrm_id
       FROM crm_opportunities opportunity
       LEFT JOIN crm_organizations organization ON organization.id = opportunity.organization_id
       WHERE opportunity.pipeline_id = $1::uuid AND opportunity.id = $2::uuid
       FOR UPDATE OF opportunity`,
      [input.pipelineId, input.opportunityId],
    )
    const row = locked.rows[0]
    if (!row) throw new Error('Opportunity not found')
    const [current] = await hydrateOpportunityRowsWithClient(client, [row], input.pipelineId)

    const existing = await client.query<{ request_fingerprint: string | null }>(
      `SELECT source_payload->>'requestFingerprint' AS request_fingerprint
       FROM crm_interactions
       WHERE pipeline_id = $1::uuid AND source_key = $2
       LIMIT 1`,
      [input.pipelineId, input.sourceKey],
    )
    if (existing.rows[0]) {
      if (
        existing.rows[0].request_fingerprint
        && existing.rows[0].request_fingerprint !== requestFingerprint
      ) {
        throw new Error('Idempotency-Key was already used with a different opportunity comment')
      }
      return { opportunity: current, created: false, conflict: false }
    }
    if (current.updatedAt !== input.expectedUpdatedAt) {
      return { opportunity: current, created: false, conflict: true }
    }

    const notes = current.notes ? `${current.notes}\n${input.commentLine}` : input.commentLine
    await stageCrmRecordWithClient(client, {
      entity: 'opportunities',
      pipelineId: input.pipelineId,
      localId: current.id,
      sourceKey: current.sourceKey,
      sourcePayload: { source: 'clawpilot-pipeline' },
      actorEmail: input.actorEmail,
      fields: {
        organizationId: current.organizationId,
        organizationSuiteCrmId: nullable(row.organization_suitecrm_id),
        contactIds: current.contactIds,
        productIds: current.productIds,
        ownerContactId: current.ownerContactId,
        name: current.name,
        organization: current.organization,
        priority: current.priority,
        owner: current.owner,
        status: current.status,
        stage: current.stage,
        lossReason: current.lossReason,
        source: current.source,
        value: current.value,
        probability: current.probability,
        expectedClose: current.expectedClose || null,
        notes,
      },
    })
    await stageCrmRecordWithClient(client, {
      entity: 'interactions',
      pipelineId: input.pipelineId,
      sourceKey: input.sourceKey,
      sourcePayload: {
        source: 'clawpilot-pipeline-comment',
        opportunityId: current.id,
        requestFingerprint,
      },
      actorEmail: input.actorEmail,
      fields: {
        organizationId: current.organizationId,
        opportunityId: current.id,
        parentSuiteCrmId: current.suiteCrmId,
        parentSuiteCrmType: 'Opportunities',
        interactionType: 'Note',
        subject: `Note: ${current.name}`,
        agentEmail: input.actorEmail,
        agentName: input.actorName,
        occurredAt: input.occurredAt,
        description: input.comment,
        direction: 'internal',
      },
    })

    const updated = await client.query<Record<string, unknown>>(
      `SELECT * FROM crm_opportunities
       WHERE pipeline_id = $1::uuid AND id = $2::uuid
       LIMIT 1`,
      [input.pipelineId, input.opportunityId],
    )
    const [opportunity] = await hydrateOpportunityRowsWithClient(client, updated.rows, input.pipelineId)
    return { opportunity, created: true, conflict: false }
  })
}

export type PipelineCatalogPerson = {
  id: string
  referenceCode: string
  displayName: string
  email: string
  jobTitle: string
  source: 'app_user' | 'external'
  appAccess: boolean
  status: string
  active: boolean
}

type PipelineCatalogOrganization = {
  pipelineId: string
  workspaceOrganizationId: string
  crmOrganizationId: string
  crmOrganizationSuiteCrmId: string
}

async function requirePipelineCatalogOrganization(input: {
  pipelineId: string
  actorEmail: string
  reconcile?: boolean
}): Promise<PipelineCatalogOrganization> {
  const result = await query<{
    pipeline_id: string
    workspace_organization_id: string | null
    crm_organization_id: string | null
    crm_organization_suitecrm_id: string | null
  }>(
    `SELECT pipeline.id::text AS pipeline_id,
       pipeline.workspace_organization_id::text AS workspace_organization_id,
       organization.id::text AS crm_organization_id,
       organization.suitecrm_id AS crm_organization_suitecrm_id
     FROM pipeline_spaces pipeline
     LEFT JOIN crm_organizations organization
       ON organization.pipeline_id = pipeline.id
      AND organization.workspace_organization_id = pipeline.workspace_organization_id
     WHERE pipeline.id = $1::uuid
     LIMIT 1`,
    [input.pipelineId],
  )
  const current = result.rows[0]
  if (!current) throw new Error('Pipeline was not found')
  if (
    current.workspace_organization_id
    && current.crm_organization_id
    && current.crm_organization_suitecrm_id
  ) {
    return {
      pipelineId: current.pipeline_id,
      workspaceOrganizationId: current.workspace_organization_id,
      crmOrganizationId: current.crm_organization_id,
      crmOrganizationSuiteCrmId: current.crm_organization_suitecrm_id,
    }
  }

  if (input.reconcile === false) {
    throw new Error('Pipeline setup is not initialized; an editor must open setup first')
  }

  const hierarchy = await ensurePipelineCrmHierarchy(input)
  const refreshed = await query<{ workspace_organization_id: string }>(
    `SELECT workspace_organization_id::text
     FROM pipeline_spaces
     WHERE id = $1::uuid AND workspace_organization_id IS NOT NULL
     LIMIT 1`,
    [input.pipelineId],
  )
  const workspaceOrganizationId = refreshed.rows[0]?.workspace_organization_id
  const organization = hierarchy.lineage.find((candidate) => (
    candidate.workspaceOrganizationId === workspaceOrganizationId
  ))
  if (!workspaceOrganizationId || !organization) throw new Error('Pipeline organization account was not found')
  return {
    pipelineId: input.pipelineId,
    workspaceOrganizationId,
    crmOrganizationId: organization.id,
    crmOrganizationSuiteCrmId: organization.suiteCrmId,
  }
}

async function ensurePipelineCatalogAppUserContacts(
  context: PipelineCatalogOrganization,
  actorEmail: string,
) {
  await withTransaction(async (client) => {
    await lockCrmMutation(client, `pipeline-catalog-people:${context.pipelineId}`)
    const users = await client.query<{
      email: string
      reference_code: string
      display_name: string | null
      job_title: string | null
      timezone: string | null
      locale: string | null
      contact_id: string | null
    }>(
      `SELECT app_user.email, app_user.reference_code, app_user.display_name, app_user.job_title,
         app_user.timezone, app_user.locale, contact.id::text AS contact_id
       FROM app_users app_user
       LEFT JOIN crm_contacts contact
         ON contact.pipeline_id = $1::uuid
        AND contact.app_user_email = app_user.email
       WHERE app_user.organization_id = $2::uuid
         AND app_user.status = 'active'
       ORDER BY app_user.email`,
      [context.pipelineId, context.workspaceOrganizationId],
    )
    for (const user of users.rows) {
      if (user.contact_id) continue
      const displayName = clean(user.display_name) || user.email.split('@')[0]
      await stageCrmRecordWithClient(client, {
        entity: 'contacts',
        pipelineId: context.pipelineId,
        sourceKey: `profile:${user.email}`,
        actorEmail,
        sourcePayload: {
          source: 'clawpilot_profile',
          userEmail: user.email,
          workspaceOrganizationId: context.workspaceOrganizationId,
          timezone: clean(user.timezone) || 'America/New_York',
          locale: clean(user.locale) || 'en-US',
        },
        fields: {
          organizationId: context.crmOrganizationId,
          organizationSuiteCrmId: context.crmOrganizationSuiteCrmId,
          appUserEmail: user.email,
          appUserReferenceCode: user.reference_code,
          fullName: displayName,
          email: user.email,
          jobTitle: clean(user.job_title),
          contactType: 'ClawPilot user',
          description: 'Managed from the ClawPilot user profile.',
        },
      })
    }
  })
}

async function ensurePipelineCatalogProducts(
  context: PipelineCatalogOrganization,
  actorEmail: string,
) {
  return withTransaction(async (client) => {
    let productsChanged = false
    await lockCrmMutation(client, `pipeline-catalog-products:${context.pipelineId}`)
    const state = await client.query<{ catalog: unknown }>(
      `SELECT COALESCE(dropdowns.catalog, setting.value) AS catalog
       FROM pipeline_spaces pipeline
       LEFT JOIN pipeline_dropdown_catalogs dropdowns ON dropdowns.pipeline_id = pipeline.id
       LEFT JOIN app_settings setting
         ON setting.key = 'pipeline.dropdowns.current:' || pipeline.id::text
       WHERE pipeline.id = $1::uuid
       LIMIT 1`,
      [context.pipelineId],
    )
    const opportunities = await client.query<{ id: string; name: string }>(
      `SELECT id::text, name
       FROM crm_opportunities
       WHERE pipeline_id = $1::uuid
       ORDER BY created_at, id`,
      [context.pipelineId],
    )
    const existing = await client.query<{ name: string }>(
      `SELECT name FROM crm_products WHERE pipeline_id = $1::uuid ORDER BY id`,
      [context.pipelineId],
    )
    const normalizedNames = new Set(existing.rows.map((row) => clean(row.name).toLowerCase().replace(/\s+/g, ' ')))
    const candidates: Array<{ name: string; origin: 'dropdown' | 'opportunity' }> = []
    const catalog = state.rows[0]?.catalog && typeof state.rows[0].catalog === 'object'
      ? state.rows[0].catalog as Record<string, unknown>
      : {}
    const dropdowns = catalog.dropdowns && typeof catalog.dropdowns === 'object'
      ? catalog.dropdowns as Record<string, unknown>
      : {}
    for (const key of ['product', 'products']) {
      const options = Array.isArray(dropdowns[key]) ? dropdowns[key] as Array<Record<string, unknown>> : []
      for (const option of [...options].sort((left, right) => finite(left.sort_order) - finite(right.sort_order))) {
        if (option.active === false) continue
        for (const name of splitPipelineProductNames(clean(option.label) || clean(option.value))) {
          candidates.push({ name, origin: 'dropdown' })
        }
      }
    }
    for (const opportunity of opportunities.rows) {
      for (const name of splitPipelineProductNames(opportunity.name)) {
        candidates.push({ name, origin: 'opportunity' })
      }
    }

    for (const candidate of candidates) {
      if (!candidate.name || candidate.name.length > 250) continue
      const normalized = candidate.name.toLowerCase().replace(/\s+/g, ' ')
      if (normalizedNames.has(normalized)) continue
      const suffix = crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 32)
      await stageCrmRecordWithClient(client, {
        entity: 'products',
        pipelineId: context.pipelineId,
        sourceKey: `pipeline-catalog-bootstrap:${suffix}`,
        actorEmail,
        sourcePayload: {
          source: 'clawpilot_pipeline_catalog_bootstrap',
          origin: candidate.origin,
          workspaceOrganizationId: context.workspaceOrganizationId,
        },
        fields: {
          name: candidate.name,
          status: 'Active',
          currency: 'USD',
          active: true,
        },
      })
      normalizedNames.add(normalized)
      productsChanged = true
    }

    const products = await client.query<{ id: string; name: string }>(
      `SELECT id::text, name FROM crm_products WHERE pipeline_id = $1::uuid ORDER BY id`,
      [context.pipelineId],
    )
    const productsByName = new Map<string, string[]>()
    for (const product of products.rows) {
      const normalized = clean(product.name).toLowerCase().replace(/\s+/g, ' ')
      const ids = productsByName.get(normalized) || []
      ids.push(product.id)
      productsByName.set(normalized, ids)
    }
    const relationships = await client.query<{
      opportunity_id: string
      product_id: string
      sort_order: number
    }>(
      `SELECT opportunity_id::text, product_id::text, sort_order
       FROM crm_opportunity_products
       WHERE pipeline_id = $1::uuid
       ORDER BY opportunity_id, sort_order, product_id`,
      [context.pipelineId],
    )
    const relationshipsByOpportunity = new Map<string, { productIds: Set<string>; nextSortOrder: number }>()
    for (const relationship of relationships.rows) {
      const state = relationshipsByOpportunity.get(relationship.opportunity_id) || {
        productIds: new Set<string>(),
        nextSortOrder: 0,
      }
      state.productIds.add(relationship.product_id)
      state.nextSortOrder = Math.max(state.nextSortOrder, Number(relationship.sort_order) + 1)
      relationshipsByOpportunity.set(relationship.opportunity_id, state)
    }
    const changedOpportunityIds: string[] = []
    for (const opportunity of opportunities.rows) {
      const state = relationshipsByOpportunity.get(opportunity.id) || {
        productIds: new Set<string>(),
        nextSortOrder: 0,
      }
      let changed = false
      for (const legacyName of clean(opportunity.name).split(',')) {
        const normalized = clean(legacyName).toLowerCase().replace(/\s+/g, ' ')
        const matches = productsByName.get(normalized) || []
        if (matches.length !== 1 || state.productIds.has(matches[0])) continue
        const inserted = await client.query(
          `INSERT INTO crm_opportunity_products (
             pipeline_id, opportunity_id, product_id, sort_order, created_by, updated_at
           ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, now())
           ON CONFLICT (opportunity_id, product_id) DO NOTHING
           RETURNING product_id`,
          [context.pipelineId, opportunity.id, matches[0], state.nextSortOrder, actorEmail],
        )
        if (!inserted.rowCount) continue
        state.productIds.add(matches[0])
        state.nextSortOrder += 1
        changed = true
      }
      relationshipsByOpportunity.set(opportunity.id, state)
      if (changed) changedOpportunityIds.push(opportunity.id)
    }
    for (const opportunityId of changedOpportunityIds) {
      const result = await client.query<Record<string, unknown>>(
        `SELECT opportunity.*, organization.suitecrm_id AS organization_suitecrm_id
         FROM crm_opportunities opportunity
         LEFT JOIN crm_organizations organization
           ON organization.pipeline_id = opportunity.pipeline_id
          AND organization.id = opportunity.organization_id
         WHERE opportunity.pipeline_id = $1::uuid AND opportunity.id = $2::uuid
         LIMIT 1`,
        [context.pipelineId, opportunityId],
      )
      const row = result.rows[0]
      if (!row) continue
      const [opportunity] = await hydrateOpportunityRowsWithClient(client, [row], context.pipelineId)
      const sourcePayload = row.source_payload && typeof row.source_payload === 'object'
        ? row.source_payload as Record<string, unknown>
        : {}
      await stageCrmRecordWithClient(client, {
        entity: 'opportunities',
        pipelineId: context.pipelineId,
        localId: opportunity.id,
        sourceKey: opportunity.sourceKey,
        sourceSheetId: nullable(row.source_sheet_id),
        sourceRowNumber: row.source_row_number === null ? null : Number(row.source_row_number),
        sourcePayload,
        actorEmail,
        fields: {
          organizationId: opportunity.organizationId,
          organizationSuiteCrmId: nullable(row.organization_suitecrm_id),
          contactIds: opportunity.contactIds,
          productIds: opportunity.productIds,
          ownerContactId: opportunity.ownerContactId,
          priority: opportunity.priority,
          name: opportunity.name,
          owner: opportunity.owner,
          organization: opportunity.organization,
          status: opportunity.status,
          stage: opportunity.stage,
          lossReason: opportunity.lossReason,
          source: opportunity.source,
          value: opportunity.value,
          probability: opportunity.probability,
          expectedClose: opportunity.expectedClose || null,
          notes: opportunity.notes,
        },
      })
    }
    return { productsChanged, opportunitiesChanged: changedOpportunityIds.length > 0 }
  })
}

async function readPipelineCatalogPeople(
  context: PipelineCatalogOrganization,
): Promise<PipelineCatalogPerson[]> {
  const result = await query<{
    id: string
    reference_code: string
    display_name: string
    email: string
    job_title: string
    source: 'app_user' | 'external'
    app_access: boolean
    status: string
    active: boolean
  }>(
    `SELECT contact.id::text, contact.reference_code,
       COALESCE(NULLIF(app_user.display_name, ''), app_user.email) AS display_name,
       app_user.email, COALESCE(app_user.job_title, '') AS job_title,
       'app_user'::text AS source, true AS app_access, app_user.status,
       (app_user.status = 'active') AS active
     FROM app_users app_user
     JOIN crm_contacts contact
       ON contact.pipeline_id = $1::uuid
      AND contact.app_user_email = app_user.email
     WHERE app_user.organization_id = $2::uuid
       AND app_user.status = 'active'
     UNION ALL
     SELECT contact.id::text, contact.reference_code, contact.full_name,
       COALESCE(contact.email, ''), COALESCE(contact.job_title, ''),
       'external'::text, false,
       COALESCE(NULLIF(contact.source_payload->>'status', ''), 'Active'),
       lower(COALESCE(contact.source_payload->>'active', 'true')) NOT IN ('false', '0', 'no', 'inactive')
     FROM crm_contacts contact
     WHERE contact.pipeline_id = $1::uuid
       AND contact.organization_id = $3::uuid
       AND contact.pipeline_user = true
       AND contact.app_user_email IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM app_users app_user WHERE app_user.email = lower(COALESCE(contact.email, ''))
       )
     ORDER BY source, display_name, email, id`,
    [context.pipelineId, context.workspaceOrganizationId, context.crmOrganizationId],
  )
  return result.rows.map((row) => ({
    id: row.id,
    referenceCode: row.reference_code,
    displayName: row.display_name,
    email: row.email,
    jobTitle: row.job_title,
    source: row.source,
    appAccess: row.app_access,
    status: row.status,
    active: row.active,
  }))
}

export async function readPipelineCatalogInPostgres(input: {
  pipelineId: string
  actorEmail: string
  reconcile?: boolean
}): Promise<{ people: PipelineCatalogPerson[]; products: CrmProduct[] }> {
  const context = await requirePipelineCatalogOrganization(input)
  if (input.reconcile !== false) {
    await ensurePipelineCatalogAppUserContacts(context, input.actorEmail)
    await ensurePipelineCatalogProducts(context, input.actorEmail)
  }
  const [people, products] = await Promise.all([
    readPipelineCatalogPeople(context),
    listCrmRecordsInPostgres({ pipelineId: input.pipelineId, entity: 'products', limit: 1000 }) as Promise<CrmProduct[]>,
  ])
  if (input.reconcile !== false) {
    await syncPipelineProductDropdownCatalogInPostgres({
      pipelineId: input.pipelineId,
      actorEmail: input.actorEmail,
      ownerNames: people.filter((person) => person.active).map((person) => person.displayName),
    })
  }
  return { people, products }
}

export async function upsertPipelineCatalogPersonInPostgres(input: {
  pipelineId: string
  actorEmail: string
  id?: string | null
  fullName: string
  email?: string
  jobTitle?: string
  active?: boolean
  deferDropdownSync?: boolean
}) {
  const context = await requirePipelineCatalogOrganization(input)
  const person = await withTransaction(async (client) => {
    await lockCrmMutation(client, `pipeline-catalog-people:${context.pipelineId}`)
    const email = clean(input.email).toLowerCase()
    if (email) {
      const appUser = await client.query(
        `SELECT 1 FROM app_users WHERE email = $1 LIMIT 1`,
        [email],
      )
      if (appUser.rowCount) throw new Error('This email belongs to a ClawPilot app user and cannot be CRM-only')
    }
    const identityKey = contactIdentityKey({
      email,
      fullName: input.fullName,
      organizationId: context.crmOrganizationId,
    })
    const current = await client.query<Record<string, unknown>>(
      `SELECT *
       FROM crm_contacts
       WHERE pipeline_id = $1::uuid
         AND ($2::uuid IS NOT NULL AND id = $2::uuid OR $2::uuid IS NULL AND identity_key = $3)
       LIMIT 1
       FOR UPDATE`,
      [context.pipelineId, input.id || null, identityKey],
    )
    const row = current.rows[0]
    if (input.id && !row) throw new Error('Pipeline person was not found')
    if (row && (
      nullable(row.organization_id) !== context.crmOrganizationId
      || nullable(row.app_user_email)
    )) {
      throw new Error('Pipeline person is outside the selected organization')
    }
    const existingPayload = row?.source_payload && typeof row.source_payload === 'object'
      ? row.source_payload as Record<string, unknown>
      : {}
    const active = input.active !== false
    const staged = await stageCrmRecordWithClient(client, {
      entity: 'contacts',
      pipelineId: context.pipelineId,
      localId: row ? String(row.id) : null,
      sourceKey: row ? String(row.source_key) : `pipeline-catalog-person:${crypto.randomUUID()}`,
      actorEmail: input.actorEmail,
      sourcePayload: {
        ...existingPayload,
        source: 'clawpilot_pipeline_catalog',
        workspaceOrganizationId: context.workspaceOrganizationId,
        status: active ? 'Active' : 'Inactive',
        active,
      },
      fields: {
        organizationId: context.crmOrganizationId,
        organizationSuiteCrmId: context.crmOrganizationSuiteCrmId,
        fullName: clean(input.fullName),
        email,
        jobTitle: clean(input.jobTitle),
        contactType: 'Pipeline user',
        pipelineUser: true,
      },
    })
    return {
      id: staged.id,
      referenceCode: staged.referenceCode,
      displayName: clean(input.fullName),
      email,
      jobTitle: clean(input.jobTitle),
      source: 'external' as const,
      appAccess: false,
      status: active ? 'Active' : 'Inactive',
      active,
    }
  })
  if (!input.deferDropdownSync) {
    const people = await readPipelineCatalogPeople(context)
    await syncPipelineProductDropdownCatalogInPostgres({
      pipelineId: context.pipelineId,
      actorEmail: input.actorEmail,
      ownerNames: people.filter((item) => item.active).map((item) => item.displayName),
    })
  }
  return person
}

export async function upsertPipelineCatalogProductInPostgres(input: {
  pipelineId: string
  actorEmail: string
  id?: string | null
  fields: StageProductInput['fields']
  deferDropdownSync?: boolean
}) {
  const context = await requirePipelineCatalogOrganization(input)
  const product = await withTransaction(async (client) => {
    await lockCrmMutation(client, `pipeline-catalog-products:${context.pipelineId}`)
    const sku = clean(input.fields.sku)
    const name = clean(input.fields.name)
    const matches = await client.query<Record<string, unknown>>(
      `SELECT *
       FROM crm_products
       WHERE pipeline_id = $1::uuid
         AND (
           $2::uuid IS NOT NULL AND id = $2::uuid
           OR $2::uuid IS NULL AND NULLIF($3, '') IS NOT NULL AND lower(COALESCE(sku, '')) = lower($3)
           OR $2::uuid IS NULL AND lower(name) = lower($4)
         )
       ORDER BY id
       FOR UPDATE`,
      [context.pipelineId, input.id || null, sku, name],
    )
    if (matches.rows.length > 1) {
      throw new Error('Product name and SKU identify different existing products')
    }
    const row = matches.rows[0]
    if (input.id && !row) throw new Error('Pipeline product was not found')
    const collision = await client.query(
      `SELECT 1
       FROM crm_products
       WHERE pipeline_id = $1::uuid
         AND id <> COALESCE($2::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
         AND (
           lower(name) = lower($3)
           OR NULLIF($4, '') IS NOT NULL AND lower(COALESCE(sku, '')) = lower($4)
         )
       LIMIT 1`,
      [context.pipelineId, row ? String(row.id) : null, name, sku],
    )
    if (collision.rowCount) throw new Error('Product name and SKU must be unique within the pipeline')
    const existingPayload = row?.source_payload && typeof row.source_payload === 'object'
      ? row.source_payload as Record<string, unknown>
      : {}
    const staged = await stageCrmRecordWithClient(client, {
      entity: 'products',
      pipelineId: context.pipelineId,
      localId: row ? String(row.id) : null,
      sourceKey: row ? String(row.source_key) : `pipeline-catalog-product:${crypto.randomUUID()}`,
      actorEmail: input.actorEmail,
      sourcePayload: {
        ...existingPayload,
        source: 'clawpilot_pipeline_catalog',
        workspaceOrganizationId: context.workspaceOrganizationId,
      },
      fields: input.fields,
    })
    const saved = await client.query<Record<string, unknown>>(
      `SELECT * FROM crm_products WHERE pipeline_id = $1::uuid AND id = $2::uuid LIMIT 1`,
      [context.pipelineId, staged.id],
    )
    return productFromRow(saved.rows[0])
  })
  if (!input.deferDropdownSync) {
    await syncPipelineProductDropdownCatalogInPostgres({
      pipelineId: context.pipelineId,
      actorEmail: input.actorEmail,
    })
  }
  return product
}

export async function listCrmPipelineUsersInPostgres(pipelineId: string): Promise<Array<{
  email: string
  displayName: string
  suiteCrmMapped: boolean
}>> {
  const result = await query<{
    email: string
    display_name: string | null
    suitecrm_user_id: string | null
  }>(
    `SELECT app_user.email, app_user.display_name, app_user.suitecrm_user_id
     FROM app_users app_user
     JOIN pipeline_spaces pipeline ON pipeline.id = $1::uuid
     LEFT JOIN pipeline_space_members membership
       ON membership.pipeline_id = pipeline.id
      AND membership.user_email = app_user.email
     WHERE app_user.status = 'active'
       AND (pipeline.owner_email = app_user.email OR membership.user_email IS NOT NULL)
     ORDER BY COALESCE(app_user.display_name, app_user.email), app_user.email`,
    [pipelineId],
  )
  return result.rows.map((row) => ({
    email: row.email,
    displayName: clean(row.display_name) || row.email,
    suiteCrmMapped: Boolean(row.suitecrm_user_id),
  }))
}

export async function readCrmSummaryFromPostgres(pipelineId: string): Promise<CrmSummary> {
  const result = await query<Record<string, string>>(
    `
      SELECT
        (SELECT count(*) FROM crm_organizations WHERE pipeline_id = $1::uuid)::text AS organizations,
        (SELECT count(*) FROM crm_contacts WHERE pipeline_id = $1::uuid)::text AS contacts,
        (SELECT count(*) FROM crm_products WHERE pipeline_id = $1::uuid)::text AS products,
        (SELECT count(*) FROM crm_leads WHERE pipeline_id = $1::uuid)::text AS leads,
        (SELECT count(*) FROM crm_opportunities WHERE pipeline_id = $1::uuid)::text AS opportunities,
        (SELECT count(*) FROM crm_meetings WHERE pipeline_id = $1::uuid)::text AS meetings,
        (SELECT count(*) FROM crm_interactions WHERE pipeline_id = $1::uuid)::text AS interactions,
        (SELECT count(*)
         FROM crm_interactions interaction
         LEFT JOIN crm_contacts contact ON contact.id = interaction.contact_id
         LEFT JOIN crm_leads lead ON lead.id = interaction.lead_id
         LEFT JOIN crm_opportunities opportunity ON opportunity.id = interaction.opportunity_id
         LEFT JOIN crm_meetings meeting ON meeting.id = interaction.meeting_id
         WHERE interaction.pipeline_id = $1::uuid
           AND COALESCE(
             interaction.organization_id, contact.organization_id, lead.organization_id,
             opportunity.organization_id, meeting.organization_id
           ) IS NULL)::text AS needs_review_interactions,
        (SELECT count(*) FROM crm_campaigns WHERE pipeline_id = $1::uuid)::text AS campaigns,
        (SELECT COALESCE(sum(amount), 0) FROM crm_opportunities WHERE pipeline_id = $1::uuid AND lower(COALESCE(status, '')) NOT IN ('won', 'lost', 'closed', 'abandoned'))::text AS open_pipeline_value,
        (SELECT COALESCE(sum(amount * probability / 100), 0) FROM crm_opportunities WHERE pipeline_id = $1::uuid AND lower(COALESCE(status, '')) NOT IN ('won', 'lost', 'closed', 'abandoned'))::text AS weighted_pipeline_value,
        (SELECT count(*) FROM (
          SELECT sync_status FROM crm_organizations WHERE pipeline_id = $1::uuid
          UNION ALL SELECT sync_status FROM crm_contacts WHERE pipeline_id = $1::uuid
          UNION ALL SELECT sync_status FROM crm_products WHERE pipeline_id = $1::uuid
          UNION ALL SELECT sync_status FROM crm_leads WHERE pipeline_id = $1::uuid
          UNION ALL SELECT sync_status FROM crm_opportunities WHERE pipeline_id = $1::uuid
          UNION ALL SELECT sync_status FROM crm_meetings WHERE pipeline_id = $1::uuid
          UNION ALL SELECT sync_status FROM crm_interactions WHERE pipeline_id = $1::uuid
          UNION ALL SELECT sync_status FROM crm_campaigns WHERE pipeline_id = $1::uuid
        ) records WHERE sync_status IN ('pending', 'syncing'))::text AS pending_sync,
        (SELECT count(*) FROM (
          SELECT sync_status FROM crm_organizations WHERE pipeline_id = $1::uuid
          UNION ALL SELECT sync_status FROM crm_contacts WHERE pipeline_id = $1::uuid
          UNION ALL SELECT sync_status FROM crm_products WHERE pipeline_id = $1::uuid
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
    organizations: finite(row.organizations), contacts: finite(row.contacts), products: finite(row.products), leads: finite(row.leads),
    opportunities: finite(row.opportunities), meetings: finite(row.meetings), interactions: finite(row.interactions),
    campaigns: finite(row.campaigns), openPipelineValue: finite(row.open_pipeline_value),
    weightedPipelineValue: finite(row.weighted_pipeline_value), pendingSync: finite(row.pending_sync), failedSync: finite(row.failed_sync),
    needsReviewInteractions: finite(row.needs_review_interactions),
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
       to_jsonb(record)->>'contact_id' AS contact_id,
       to_jsonb(record)->>'lead_id' AS lead_id,
       to_jsonb(record)->>'opportunity_id' AS opportunity_id,
       to_jsonb(record)->>'meeting_id' AS meeting_id,
       to_jsonb(record)->>'campaign_id' AS campaign_id,
       to_jsonb(record)->>'agent_email' AS agent_email,
       to_jsonb(record)->>'agent_name' AS agent_name,
       COALESCE(to_jsonb(record)->>'email', '') AS email,
       COALESCE(to_jsonb(record)->>'phone_mobile', to_jsonb(record)->>'phone_work', to_jsonb(record)->>'phone', '') AS phone,
       COALESCE(to_jsonb(record)->>'email_opt_out', 'false') AS email_opt_out,
       to_jsonb(record)->>'workspace_organization_id' AS workspace_organization_id,
       to_jsonb(record)->>'parent_organization_id' AS parent_organization_id,
       COALESCE(to_jsonb(record)->>'relationship_type', '') AS relationship_type,
       COALESCE(to_jsonb(record)->'source_payload', '{}'::jsonb) AS source_payload,
       to_jsonb(record)->>'external_event_id' AS external_event_id,
       COALESCE(to_jsonb(record)->>'status', '') AS record_status
     FROM ${table} record WHERE pipeline_id = $1::uuid AND id = $2::uuid LIMIT 1`,
    [input.pipelineId, input.id],
  )
  const row = result.rows[0]
  if (!row) throw new Error('CRM record not found')
  const sourcePayload = row.source_payload && typeof row.source_payload === 'object'
    && !Array.isArray(row.source_payload)
    ? row.source_payload as Record<string, unknown>
    : {}
  return {
    id: String(row.id),
    referenceCode: clean(row.reference_code),
    shortUrl: crmReferenceShortUrl(row.reference_code),
    sourceKey: String(row.source_key),
    suiteCrmId: nullable(row.suitecrm_id),
    name: clean(row.display_name),
    organizationName: clean(row.organization_name),
    organizationId: nullable(row.organization_id),
    contactId: nullable(row.contact_id),
    leadId: nullable(row.lead_id),
    opportunityId: nullable(row.opportunity_id),
    meetingId: nullable(row.meeting_id),
    campaignId: nullable(row.campaign_id),
    agentEmail: nullable(row.agent_email),
    agentName: clean(row.agent_name),
    email: clean(row.email),
    phone: clean(row.phone),
    emailOptOut: row.email_opt_out === true || clean(row.email_opt_out) === 'true',
    workspaceOrganizationId: nullable(row.workspace_organization_id),
    parentOrganizationId: nullable(row.parent_organization_id),
    relationshipType: clean(row.relationship_type),
    sourcePayload,
    externalEventId: nullable(row.external_event_id),
    status: clean(row.record_status),
  }
}

export function crmEntityForReferenceCode(referenceValue: unknown): CrmEntity | null {
  const prefix = clean(referenceValue).slice(0, 2).toLowerCase()
  return ({
    ga: 'organizations',
    gc: 'contacts',
    gp: 'products',
    gl: 'leads',
    go: 'opportunities',
    gm: 'meetings',
    gi: 'interactions',
    gk: 'campaigns',
  } as Record<string, CrmEntity>)[prefix] || null
}

export async function resolveCrmReferenceCode(referenceValue: unknown): Promise<string> {
  const referenceCode = clean(referenceValue).toLowerCase()
  if (!/^g[aciklmop][0-9]{7}$/.test(referenceCode)) throw new Error('CRM reference is invalid')
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

export async function resolveCrmReferenceRoute(referenceValue: unknown, options: {
  actorEmail?: unknown
  requestedPipelineId?: unknown
} = {}) {
  const referenceCode = await resolveCrmReferenceCode(referenceValue)
  const entity = crmEntityForReferenceCode(referenceCode)
  if (!entity || !isPostgresStorageEnabled()) return { referenceCode, pipelineId: null }
  const actorEmail = clean(options.actorEmail).toLowerCase()
  const requestedPipelineId = /^[0-9a-f-]{36}$/i.test(clean(options.requestedPipelineId))
    ? clean(options.requestedPipelineId)
    : ''
  try {
    const result = await query<{ pipeline_id: string }>(
      `SELECT pipeline.id::text AS pipeline_id
       FROM ${ENTITY_TABLE[entity]} record
       JOIN pipeline_spaces pipeline ON pipeline.id = record.pipeline_id
       LEFT JOIN pipeline_space_members membership
         ON membership.pipeline_id = pipeline.id AND membership.user_email = $2
       WHERE record.reference_code = $1
         AND ($2 = '' OR pipeline.owner_email = $2 OR membership.user_email = $2)
       ORDER BY
         CASE
           WHEN pipeline.id::text = $3 THEN 0
           WHEN pipeline.owner_email = $2 THEN 1
           WHEN membership.user_email = $2 THEN 2
           ELSE 3
         END,
         pipeline.is_default DESC,
         pipeline.created_at,
         pipeline.id
       LIMIT 1`,
      [referenceCode, actorEmail, requestedPipelineId],
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
  if (!entity || !/^g[aciklmop][0-9]{7}$/.test(referenceCode)) throw new Error('CRM reference is invalid')
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
       SELECT reference_code, name AS title, 'organizations'::text AS entity, email FROM crm_organizations WHERE pipeline_id = $1::uuid
       UNION ALL SELECT reference_code, full_name, 'contacts', email FROM crm_contacts WHERE pipeline_id = $1::uuid
       UNION ALL SELECT reference_code, name, 'products', NULL::text FROM crm_products WHERE pipeline_id = $1::uuid
       UNION ALL SELECT reference_code, full_name, 'leads', email FROM crm_leads WHERE pipeline_id = $1::uuid
       UNION ALL SELECT reference_code, name, 'opportunities', NULL::text FROM crm_opportunities WHERE pipeline_id = $1::uuid
       UNION ALL SELECT reference_code, subject, 'meetings', NULL::text FROM crm_meetings WHERE pipeline_id = $1::uuid
       UNION ALL SELECT reference_code, subject, 'interactions', NULL::text FROM crm_interactions WHERE pipeline_id = $1::uuid
       UNION ALL SELECT reference_code, name, 'campaigns', NULL::text FROM crm_campaigns WHERE pipeline_id = $1::uuid
     ), owner AS (
       SELECT pipeline.owner_email, pipeline.workspace_organization_id AS organization_id
       FROM pipeline_spaces pipeline
       WHERE pipeline.id = $1::uuid
         AND pipeline.workspace_organization_id IS NOT NULL
     ), links AS (
       SELECT records.reference_code AS slug,
         $2 || '/crm/' || records.reference_code AS destination_url,
         records.title,
         ARRAY['crm', records.entity, records.reference_code]::text[] AS tags
       FROM records
       UNION ALL
       SELECT 'mail-' || records.reference_code,
         $2 || '/crm/' || records.reference_code || '?action=compose-email',
         'Email ' || records.title,
         ARRAY['crm', 'email', records.entity, records.reference_code]::text[]
       FROM records
       WHERE records.entity IN ('organizations', 'contacts')
         AND NULLIF(btrim(records.email), '') IS NOT NULL
     )
     INSERT INTO short_links (
       owner_email, organization_root_id, source_app, slug, destination_url, title, tags, created_at, updated_at
     )
     SELECT owner.owner_email, owner.organization_id, 'clawpilot-crm', links.slug,
       links.destination_url, left(links.title, 200), links.tags, now(), now()
     FROM links CROSS JOIN owner
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
      await client.query(
        `UPDATE ${table}
         SET sync_status = $3, sync_error = $2, updated_at = now()
         WHERE id = $1::uuid`,
        [input.item.aggregateId, message, dead ? 'failed' : 'pending'],
      )
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
