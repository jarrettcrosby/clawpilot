import crypto from 'node:crypto'
import {
  buildCrmDataTransferCsv,
  buildCrmDataTransferCsvSegments,
  CRM_DATA_TRANSFER_SCHEMA_VERSION,
  crmDataTransferFieldDiffs,
  crmDataTransferNaturalKey,
  crmProductUniquenessConflicts,
  parseCrmDataTransferCsv,
  type CrmTransferClassification,
  type CrmTransferEntity,
  type CrmTransferFieldDiff,
  type CrmTransferRowError,
  type CrmWritableTransferEntity,
} from '@/lib/crm/dataTransferCsv'
import type { StageCrmRecordInput } from '@/lib/persistence/crm'
import { stageCrmRecordWithClient } from '@/lib/persistence/crm'
import { syncPipelineProductDropdownCatalogInPostgres } from '@/lib/persistence/pipeline'
import {
  acquireTransactionAdvisoryLock,
  query,
  withTransaction,
} from '@/lib/persistence/postgres'
import { recordAuditEvent } from '@/lib/auditWriter'

const ENTITY_TABLE: Record<CrmTransferEntity, string> = {
  organizations: 'crm_organizations',
  contacts: 'crm_contacts',
  products: 'crm_products',
  leads: 'crm_leads',
  opportunities: 'crm_opportunities',
  meetings: 'crm_meetings',
  interactions: 'crm_interactions',
  campaigns: 'crm_campaigns',
}

type QueryExecutor = (
  sql: string,
  values?: unknown[],
) => Promise<{ rows: Record<string, unknown>[] }>

type CurrentTransferRecord = {
  id: string
  referenceCode: string
  sourceKey: string
  sourceHash: string
  sourcePayload: Record<string, unknown>
  updatedAt: string
  recordVersion: string
  systemManaged: boolean
  fields: Record<string, unknown>
  values: Record<string, string>
}

type ReferenceRecord = {
  id: string
  referenceCode: string
  suiteCrmId: string | null
  name: string
}

type ReferenceMaps = {
  organizations: Map<string, ReferenceRecord>
  contacts: Map<string, ReferenceRecord>
  products: Map<string, ReferenceRecord>
}

export type CrmDataTransferPreviewRow = {
  rowNumber: number
  classification: CrmTransferClassification
  globalId: string
  displayName: string
  diffs: CrmTransferFieldDiff[]
  errors: CrmTransferRowError[]
  selected: boolean
}

export type CrmDataTransferPreview = {
  runId: string
  entity: CrmWritableTransferEntity
  expiresAt: string
  summary: Record<CrmTransferClassification | 'total', number>
  rows: CrmDataTransferPreviewRow[]
}

function clean(value: unknown) {
  return String(value ?? '').trim()
}

function nullable(value: unknown) {
  const normalized = clean(value)
  return normalized || null
}

function isoTimestamp(value: unknown) {
  const parsed = value instanceof Date ? value : new Date(String(value))
  if (Number.isNaN(parsed.getTime())) throw new Error('CRM record revision is invalid')
  return parsed.toISOString()
}

function sourcePayload(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function versionFor(updatedAt: string, sourceHash: string) {
  return crypto
    .createHash('sha256')
    .update(`${updatedAt}|${sourceHash}`)
    .digest('hex')
}

function numberText(value: unknown) {
  const number = Number(value)
  return Number.isFinite(number) ? String(number) : '0'
}

function yesNo(value: unknown) {
  return value === true ? 'yes' : 'no'
}

function pipeList(value: unknown) {
  if (!Array.isArray(value)) return ''
  return value.map(clean).filter(Boolean).join('|')
}

function fieldsToValues(
  entity: CrmWritableTransferEntity,
  fields: Record<string, unknown>,
): Record<string, string> {
  if (entity === 'organizations') {
    return {
      name: clean(fields.name),
      account_type: clean(fields.accountType),
      priority: clean(fields.priority),
      account_manager: clean(fields.accountManager),
      website: clean(fields.website),
      linkedin_url: clean(fields.linkedinUrl),
      phone: clean(fields.phone),
      email: clean(fields.email),
      email_opt_out: yesNo(fields.emailOptOut),
      address: clean(fields.address),
      city: clean(fields.city),
      state: clean(fields.state),
      postal_code: clean(fields.postalCode),
      country: clean(fields.country),
      description: clean(fields.description),
    }
  }
  if (entity === 'contacts') {
    return {
      organization_global_id: clean(fields.organizationGlobalId),
      full_name: clean(fields.fullName),
      first_name: clean(fields.firstName),
      last_name: clean(fields.lastName),
      priority: clean(fields.priority),
      contact_type: clean(fields.contactType),
      account_manager: clean(fields.accountManager),
      job_title: clean(fields.jobTitle),
      email: clean(fields.email),
      linkedin_url: clean(fields.linkedinUrl),
      phone_work: clean(fields.phoneWork),
      phone_mobile: clean(fields.phoneMobile),
      address: clean(fields.address),
      city: clean(fields.city),
      state: clean(fields.state),
      postal_code: clean(fields.postalCode),
      country: clean(fields.country),
      description: clean(fields.description),
      email_opt_out: yesNo(fields.emailOptOut),
    }
  }
  if (entity === 'products') {
    return {
      name: clean(fields.name),
      sku: clean(fields.sku),
      product_type: clean(fields.productType),
      category: clean(fields.category),
      status: clean(fields.status),
      price: numberText(fields.price),
      cost: numberText(fields.cost),
      currency: clean(fields.currency).toUpperCase(),
      url: clean(fields.url),
      description: clean(fields.description),
      active: yesNo(fields.active),
    }
  }
  if (entity === 'leads') {
    return {
      organization_global_id: clean(fields.organizationGlobalId),
      full_name: clean(fields.fullName),
      first_name: clean(fields.firstName),
      last_name: clean(fields.lastName),
      company_name: clean(fields.companyName),
      job_title: clean(fields.jobTitle),
      email: clean(fields.email),
      phone_work: clean(fields.phoneWork),
      phone_mobile: clean(fields.phoneMobile),
      status: clean(fields.status),
      source: clean(fields.source),
      assigned_to: clean(fields.assignedTo),
      description: clean(fields.description),
      email_opt_out: yesNo(fields.emailOptOut),
    }
  }
  return {
    organization_global_id: clean(fields.organizationGlobalId),
    contact_global_ids: pipeList(fields.contactGlobalIds),
    owner_contact_global_id: clean(fields.ownerContactGlobalId),
    product_global_ids: pipeList(fields.productGlobalIds),
    name: clean(fields.name),
    priority: clean(fields.priority),
    owner: clean(fields.owner),
    status: clean(fields.status),
    stage: clean(fields.stage),
    loss_reason: clean(fields.lossReason),
    source: clean(fields.source),
    value: numberText(fields.value),
    probability: numberText(fields.probability),
    expected_close: clean(fields.expectedClose),
    notes: clean(fields.notes),
  }
}

function writableFieldsFromRow(
  entity: CrmWritableTransferEntity,
  row: Record<string, unknown>,
) {
  if (entity === 'organizations') {
    return {
      name: clean(row.name),
      accountType: clean(row.account_type),
      priority: clean(row.priority),
      accountManager: clean(row.account_manager),
      website: clean(row.website),
      linkedinUrl: clean(row.linkedin_url),
      phone: clean(row.phone),
      email: clean(row.email).toLowerCase(),
      emailOptOut: row.email_opt_out === true,
      address: clean(row.billing_address_street),
      city: clean(row.billing_address_city),
      state: clean(row.billing_address_state),
      postalCode: clean(row.billing_address_postal_code),
      country: clean(row.billing_address_country),
      description: clean(row.description),
    }
  }
  if (entity === 'contacts') {
    return {
      organizationGlobalId: clean(row.organization_reference_code),
      fullName: clean(row.full_name),
      firstName: clean(row.first_name),
      lastName: clean(row.last_name),
      priority: clean(row.priority),
      contactType: clean(row.contact_type),
      accountManager: clean(row.account_manager),
      jobTitle: clean(row.job_title),
      email: clean(row.email).toLowerCase(),
      linkedinUrl: clean(row.linkedin_url),
      phoneWork: clean(row.phone_work),
      phoneMobile: clean(row.phone_mobile),
      address: clean(row.primary_address_street),
      city: clean(row.primary_address_city),
      state: clean(row.primary_address_state),
      postalCode: clean(row.primary_address_postal_code),
      country: clean(row.primary_address_country),
      description: clean(row.description),
      emailOptOut: row.email_opt_out === true,
    }
  }
  if (entity === 'products') {
    return {
      name: clean(row.name),
      sku: clean(row.sku),
      productType: clean(row.product_type) || 'Good',
      category: clean(row.category),
      status: clean(row.status) || 'Active',
      price: Number(row.price) || 0,
      cost: Number(row.cost) || 0,
      currency: clean(row.currency).toUpperCase(),
      url: clean(row.url),
      description: clean(row.description),
      active: row.active !== false,
    }
  }
  if (entity === 'leads') {
    return {
      organizationGlobalId: clean(row.organization_reference_code),
      fullName: clean(row.full_name),
      firstName: clean(row.first_name),
      lastName: clean(row.last_name),
      companyName: clean(row.company_name),
      jobTitle: clean(row.job_title),
      email: clean(row.email).toLowerCase(),
      phoneWork: clean(row.phone_work),
      phoneMobile: clean(row.phone_mobile),
      status: clean(row.status),
      source: clean(row.lead_source),
      assignedTo: clean(row.assigned_to),
      description: clean(row.description),
      emailOptOut: row.email_opt_out === true,
    }
  }
  return {
    organizationGlobalId: clean(row.organization_reference_code),
    contactGlobalIds: Array.isArray(row.contact_reference_codes)
      ? row.contact_reference_codes.map(clean).filter(Boolean)
      : [],
    ownerContactGlobalId: clean(row.owner_contact_reference_code),
    productGlobalIds: Array.isArray(row.product_reference_codes)
      ? row.product_reference_codes.map(clean).filter(Boolean)
      : [],
    name: clean(row.name),
    priority: clean(row.priority),
    owner: clean(row.owner_name),
    status: clean(row.status),
    stage: clean(row.stage),
    lossReason: clean(row.loss_reason),
    source: clean(row.lead_source),
    value: Number(row.amount) || 0,
    probability: Number(row.probability) || 0,
    expectedClose: row.expected_close
      ? new Date(String(row.expected_close)).toISOString().slice(0, 10)
      : null,
    notes: clean(row.description),
  }
}

function currentRecord(
  entity: CrmWritableTransferEntity,
  row: Record<string, unknown>,
): CurrentTransferRecord {
  const updatedAt = isoTimestamp(row.updated_at)
  const sourceHash = clean(row.source_hash)
  const fields = writableFieldsFromRow(entity, row)
  const payload = sourcePayload(row.source_payload)
  const archived = ['true', '1', 'yes'].includes(
    clean(payload.archived).toLowerCase(),
  )
  return {
    id: String(row.id),
    referenceCode: clean(row.reference_code),
    sourceKey: clean(row.source_key),
    sourceHash,
    sourcePayload: payload,
    updatedAt,
    recordVersion: versionFor(updatedAt, sourceHash),
    systemManaged: archived || (
      entity === 'organizations'
        ? clean(row.relationship_type) !== 'customer'
        : entity === 'contacts'
          ? row.pipeline_user === true
          : false
    ),
    fields,
    values: fieldsToValues(entity, fields),
  }
}

async function loadWritableRecords(
  executor: QueryExecutor,
  pipelineId: string,
  entity: CrmWritableTransferEntity,
) {
  let sql = ''
  if (entity === 'organizations') {
    sql = `SELECT record.*
      FROM crm_organizations record
      WHERE record.pipeline_id = $1::uuid
      ORDER BY lower(record.name), record.id`
  } else if (entity === 'contacts') {
    sql = `SELECT record.*, organization.reference_code AS organization_reference_code
      FROM crm_contacts record
      LEFT JOIN crm_organizations organization
        ON organization.pipeline_id = record.pipeline_id
       AND organization.id = record.organization_id
      WHERE record.pipeline_id = $1::uuid
      ORDER BY lower(record.full_name), record.id`
  } else if (entity === 'products') {
    sql = `SELECT record.*
      FROM crm_products record
      WHERE record.pipeline_id = $1::uuid
      ORDER BY lower(record.name), record.id`
  } else if (entity === 'leads') {
    sql = `SELECT record.*, organization.reference_code AS organization_reference_code
      FROM crm_leads record
      LEFT JOIN crm_organizations organization
        ON organization.pipeline_id = record.pipeline_id
       AND organization.id = record.organization_id
      WHERE record.pipeline_id = $1::uuid
      ORDER BY lower(record.full_name), record.id`
  } else {
    sql = `SELECT record.*, organization.reference_code AS organization_reference_code,
        owner_contact.reference_code AS owner_contact_reference_code,
        COALESCE((
          SELECT array_agg(contact.reference_code ORDER BY relationship.sort_order, contact.reference_code)
          FROM crm_opportunity_contacts relationship
          JOIN crm_contacts contact
            ON contact.pipeline_id = relationship.pipeline_id
           AND contact.id = relationship.contact_id
          WHERE relationship.pipeline_id = record.pipeline_id
            AND relationship.opportunity_id = record.id
        ), ARRAY[]::text[]) AS contact_reference_codes,
        COALESCE((
          SELECT array_agg(product.reference_code ORDER BY relationship.sort_order, product.reference_code)
          FROM crm_opportunity_products relationship
          JOIN crm_products product
            ON product.pipeline_id = relationship.pipeline_id
           AND product.id = relationship.product_id
          WHERE relationship.pipeline_id = record.pipeline_id
            AND relationship.opportunity_id = record.id
        ), ARRAY[]::text[]) AS product_reference_codes
      FROM crm_opportunities record
      LEFT JOIN crm_organizations organization
        ON organization.pipeline_id = record.pipeline_id
       AND organization.id = record.organization_id
      LEFT JOIN crm_contacts owner_contact
        ON owner_contact.pipeline_id = record.pipeline_id
       AND owner_contact.id = record.owner_contact_id
      WHERE record.pipeline_id = $1::uuid
      ORDER BY lower(record.name), record.id`
  }
  const result = await executor(sql, [pipelineId])
  return result.rows.map((row) => currentRecord(entity, row))
}

async function loadReferenceMaps(
  executor: QueryExecutor,
  pipelineId: string,
): Promise<ReferenceMaps> {
  async function load(
    table: string,
    nameColumn: string,
    additionalWhere = '',
  ) {
    const result = await executor(
      `SELECT id::text, reference_code, suitecrm_id,
         ${nameColumn} AS display_name
       FROM ${table} record
       WHERE pipeline_id = $1::uuid
         ${additionalWhere}
       ORDER BY reference_code`,
      [pipelineId],
    )
    return new Map(result.rows.map((row) => [
      clean(row.reference_code),
      {
        id: String(row.id),
        referenceCode: clean(row.reference_code),
        suiteCrmId: nullable(row.suitecrm_id),
        name: clean(row.display_name),
      },
    ]))
  }
  const [organizations, contacts, products] = await Promise.all([
    load(
      'crm_organizations',
      'name',
      `AND COALESCE(lower(record.source_payload->>'archived'), 'false')
        NOT IN ('true', '1', 'yes')`,
    ),
    load('crm_contacts', 'full_name'),
    load(
      'crm_products',
      'name',
      `AND COALESCE(lower(record.source_payload->>'archived'), 'false')
        NOT IN ('true', '1', 'yes')`,
    ),
  ])
  return { organizations, contacts, products }
}

function validateRelationships(
  entity: CrmWritableTransferEntity,
  fields: Record<string, unknown>,
  references: ReferenceMaps,
  rowNumber: number,
) {
  const errors: CrmTransferRowError[] = []
  function requireReference(
    map: Map<string, ReferenceRecord>,
    globalId: unknown,
    column: string,
    required: boolean,
  ) {
    const reference = clean(globalId)
    if (!reference && !required) return
    if (!reference || !map.has(reference)) {
      errors.push({
        rowNumber,
        column,
        code: 'CRM_CSV_RELATIONSHIP_NOT_FOUND',
        message: 'The related CRM record was not found in this pipeline',
      })
    }
  }
  if (entity === 'contacts' || entity === 'opportunities') {
    requireReference(
      references.organizations,
      fields.organizationGlobalId,
      'organization_global_id',
      true,
    )
  }
  if (entity === 'leads') {
    requireReference(
      references.organizations,
      fields.organizationGlobalId,
      'organization_global_id',
      false,
    )
  }
  if (entity === 'opportunities') {
    for (const globalId of fields.contactGlobalIds as string[]) {
      requireReference(
        references.contacts,
        globalId,
        'contact_global_ids',
        true,
      )
    }
    requireReference(
      references.contacts,
      fields.ownerContactGlobalId,
      'owner_contact_global_id',
      false,
    )
    for (const globalId of fields.productGlobalIds as string[]) {
      requireReference(
        references.products,
        globalId,
        'product_global_ids',
        true,
      )
    }
  }
  return errors
}

function displayName(
  entity: CrmWritableTransferEntity,
  fields: Record<string, unknown>,
) {
  if (entity === 'organizations' || entity === 'products' || entity === 'opportunities') {
    return clean(fields.name)
  }
  return clean(fields.fullName)
}

function classificationSummary(rows: CrmDataTransferPreviewRow[]) {
  return {
    total: rows.length,
    create: rows.filter((row) => row.classification === 'create').length,
    update: rows.filter((row) => row.classification === 'update').length,
    unchanged: rows.filter((row) => row.classification === 'unchanged').length,
    ambiguous: rows.filter((row) => row.classification === 'ambiguous').length,
    invalid: rows.filter((row) => row.classification === 'invalid').length,
  }
}

export async function createCrmDataTransferPreview(input: {
  pipelineId: string
  actorEmail: string
  entity: CrmWritableTransferEntity
  fileName: string
  csv: string
}): Promise<CrmDataTransferPreview> {
  const parsed = parseCrmDataTransferCsv({
    entity: input.entity,
    csv: input.csv,
  })
  const executor: QueryExecutor = (sql, values = []) => query(sql, values)
  const [currentRecords, references] = await Promise.all([
    loadWritableRecords(executor, input.pipelineId, input.entity),
    loadReferenceMaps(executor, input.pipelineId),
  ])
  const byReference = new Map(
    currentRecords.map((record) => [record.referenceCode, record]),
  )
  const currentByNaturalKey = new Map<string, CurrentTransferRecord[]>()
  for (const record of currentRecords) {
    const key = crmDataTransferNaturalKey(input.entity, record.fields)
    if (!key) continue
    const matches = currentByNaturalKey.get(key) || []
    matches.push(record)
    currentByNaturalKey.set(key, matches)
  }
  const globalIdCounts = new Map<string, number>()
  const naturalKeyCounts = new Map<string, number>()
  for (const row of parsed) {
    if (row.globalId) {
      globalIdCounts.set(
        row.globalId,
        (globalIdCounts.get(row.globalId) || 0) + 1,
      )
    } else {
      const key = crmDataTransferNaturalKey(input.entity, row.fields)
      naturalKeyCounts.set(key, (naturalKeyCounts.get(key) || 0) + 1)
    }
  }
  const eligibleProductRows = input.entity === 'products'
    ? parsed.filter((row) => {
        if (row.errors.length > 0) return false
        if (!row.globalId) return true
        const target = byReference.get(row.globalId)
        return Boolean(
          target
          && !target.systemManaged
          && target.recordVersion === row.recordVersion
          && (globalIdCounts.get(row.globalId) || 0) === 1,
        )
      }).map((row) => ({
        identity: `row:${row.rowNumber}`,
        fields: row.fields,
      }))
    : []
  const currentProductCandidates = input.entity === 'products'
    ? currentRecords.map((record) => ({
        identity: `record:${record.id}`,
        fields: record.fields,
      }))
    : []

  const previewRows: Array<CrmDataTransferPreviewRow & {
    targetId: string | null
    observedUpdatedAt: string | null
    observedSourceHash: string | null
    proposedFields: Record<string, unknown>
  }> = []
  for (const row of parsed) {
    const errors = [
      ...row.errors,
      ...validateRelationships(
        input.entity,
        row.fields,
        references,
        row.rowNumber,
      ),
    ]
    let classification: CrmTransferClassification = errors.length
      ? 'invalid'
      : 'create'
    let target: CurrentTransferRecord | null = null
    let diffs: CrmTransferFieldDiff[] = []
    if ((globalIdCounts.get(row.globalId) || 0) > 1 && row.globalId) {
      classification = 'ambiguous'
      errors.push({
        rowNumber: row.rowNumber,
        column: 'global_id',
        code: 'CRM_CSV_DUPLICATE_GLOBAL_ID',
        message: 'The same Global ID appears more than once in this CSV',
      })
    } else if (row.globalId) {
      target = byReference.get(row.globalId) || null
      if (!target) {
        classification = 'invalid'
        errors.push({
          rowNumber: row.rowNumber,
          column: 'global_id',
          code: 'CRM_CSV_GLOBAL_ID_NOT_FOUND',
          message: 'The CRM record was not found in this pipeline',
        })
      } else if (target.systemManaged) {
        classification = 'invalid'
        errors.push({
          rowNumber: row.rowNumber,
          column: 'global_id',
          code: 'CRM_CSV_SYSTEM_RECORD_READ_ONLY',
          message: 'This system-managed CRM record cannot be imported',
        })
      } else if (row.recordVersion !== target.recordVersion) {
        classification = 'invalid'
        errors.push({
          rowNumber: row.rowNumber,
          column: 'record_version',
          code: 'CRM_CSV_RECORD_VERSION_STALE',
          message: 'The record changed after this CSV was exported',
        })
      } else if (errors.length === 0) {
        const proposedValues = fieldsToValues(input.entity, row.fields)
        diffs = crmDataTransferFieldDiffs(
          target.values,
          proposedValues,
          input.entity,
        )
        classification = diffs.length > 0 ? 'update' : 'unchanged'
      }
    } else if (errors.length === 0 && input.entity !== 'products') {
      const key = crmDataTransferNaturalKey(input.entity, row.fields)
      const existing = currentByNaturalKey.get(key) || []
      if (existing.length > 0 || (naturalKeyCounts.get(key) || 0) > 1) {
        classification = 'ambiguous'
        errors.push({
          rowNumber: row.rowNumber,
          code: 'CRM_CSV_CREATE_IDENTITY_AMBIGUOUS',
          message: existing.length > 0
            ? 'A possible existing CRM record matches this new row'
            : 'More than one new row uses the same CRM identity',
        })
      }
    }
    if (
      input.entity === 'products'
      && (classification === 'create' || classification === 'update')
    ) {
      const conflicts = crmProductUniquenessConflicts({
        candidate: {
          identity: `row:${row.rowNumber}`,
          fields: row.fields,
        },
        others: [
          ...currentProductCandidates.filter((candidate) => (
            candidate.identity !== `record:${target?.id || ''}`
          )),
          ...eligibleProductRows,
        ],
      })
      for (const field of ['name', 'sku'] as const) {
        if (!conflicts.some((conflict) => conflict.field === field)) continue
        classification = 'ambiguous'
        errors.push({
          rowNumber: row.rowNumber,
          column: field,
          code: field === 'name'
            ? 'CRM_CSV_PRODUCT_NAME_CONFLICT'
            : 'CRM_CSV_PRODUCT_SKU_CONFLICT',
          message: field === 'name'
            ? 'Another Product already uses this name in the pipeline or CSV'
            : 'Another Product already uses this nonblank SKU in the pipeline or CSV',
        })
      }
    }
    previewRows.push({
      rowNumber: row.rowNumber,
      classification,
      globalId: row.globalId,
      displayName: displayName(input.entity, row.fields),
      diffs,
      errors,
      selected: classification === 'create',
      targetId: target?.id || null,
      observedUpdatedAt: target?.updatedAt || null,
      observedSourceHash: target?.sourceHash || null,
      proposedFields: {
        displayName: displayName(input.entity, row.fields),
        values: row.fields,
      },
    })
  }
  const summary = classificationSummary(previewRows)
  const sourceSha256 = crypto
    .createHash('sha256')
    .update(input.csv)
    .digest('hex')
  const stored = await withTransaction(async (client) => {
    const run = await client.query<{ id: string; expires_at: Date }>(
      `INSERT INTO crm_data_transfer_runs (
         pipeline_id, actor_email, entity, schema_version, file_name,
         source_sha256, status, row_count, create_count, update_count,
         unchanged_count, ambiguous_count, invalid_count
       )
       VALUES (
         $1::uuid, $2, $3, $4, $5, $6, 'previewed',
         $7, $8, $9, $10, $11, $12
       )
       RETURNING id::text, expires_at`,
      [
        input.pipelineId,
        input.actorEmail,
        input.entity,
        CRM_DATA_TRANSFER_SCHEMA_VERSION,
        clean(input.fileName).slice(0, 250) || `${input.entity}.csv`,
        sourceSha256,
        summary.total,
        summary.create,
        summary.update,
        summary.unchanged,
        summary.ambiguous,
        summary.invalid,
      ],
    )
    const runId = run.rows[0].id
    for (const row of previewRows) {
      await client.query(
        `INSERT INTO crm_data_transfer_rows (
           pipeline_id, run_id, row_number, classification,
           target_record_id, target_reference_code,
           observed_updated_at, observed_source_hash, proposed_fields,
           field_diffs, errors, selected
         )
         VALUES (
           $1::uuid, $2::uuid, $3, $4, $5::uuid, $6,
           $7::timestamptz, $8, $9::jsonb, $10::jsonb, $11::jsonb, $12
         )`,
        [
          input.pipelineId,
          runId,
          row.rowNumber,
          row.classification,
          row.targetId,
          row.globalId || null,
          row.observedUpdatedAt,
          row.observedSourceHash,
          JSON.stringify(row.proposedFields),
          JSON.stringify(row.diffs),
          JSON.stringify(row.errors),
          row.selected,
        ],
      )
    }
    await recordAuditEvent({
      actor: input.actorEmail,
      eventType: 'crm.data_transfer.previewed',
      aggregateType: 'crm_data_transfer',
      aggregateId: runId,
      eventKey: `crm-data-transfer-preview:${runId}`,
      payload: {
        pipelineId: input.pipelineId,
        entity: input.entity,
        sourceSha256,
        summary,
      },
    }, client)
    return {
      runId,
      expiresAt: isoTimestamp(run.rows[0].expires_at),
    }
  })
  return {
    runId: stored.runId,
    entity: input.entity,
    expiresAt: stored.expiresAt,
    summary,
    rows: previewRows.map((row) => ({
      rowNumber: row.rowNumber,
      classification: row.classification,
      globalId: row.globalId,
      displayName: row.displayName,
      diffs: row.diffs,
      errors: row.errors,
      selected: row.selected,
    })),
  }
}

function stageInputFor(
  entity: CrmWritableTransferEntity,
  input: {
    pipelineId: string
    actorEmail: string
    localId: string | null
    sourceKey: string
    sourcePayload: Record<string, unknown>
    fields: Record<string, unknown>
    references: ReferenceMaps
    customerParent: { id: string; suiteCrmId: string }
  },
): StageCrmRecordInput {
  const common = {
    pipelineId: input.pipelineId,
    localId: input.localId,
    sourceKey: input.sourceKey,
    actorEmail: input.actorEmail,
    sourcePayload: input.sourcePayload,
  }
  if (entity === 'organizations') {
    return {
      ...common,
      entity,
      fields: {
        parentOrganizationId: input.customerParent.id,
        parentOrganizationSuiteCrmId: input.customerParent.suiteCrmId,
        relationshipType: 'customer',
        name: clean(input.fields.name),
        accountType: clean(input.fields.accountType),
        priority: clean(input.fields.priority),
        accountManager: clean(input.fields.accountManager),
        website: clean(input.fields.website),
        linkedinUrl: clean(input.fields.linkedinUrl),
        phone: clean(input.fields.phone),
        email: clean(input.fields.email),
        emailOptOut: input.fields.emailOptOut === true,
        address: clean(input.fields.address),
        city: clean(input.fields.city),
        state: clean(input.fields.state),
        postalCode: clean(input.fields.postalCode),
        country: clean(input.fields.country),
        description: clean(input.fields.description),
      },
    }
  }
  const organization = input.references.organizations.get(
    clean(input.fields.organizationGlobalId),
  )
  if (entity === 'contacts') {
    if (!organization) throw new Error('A CRM import relationship changed after preview')
    return {
      ...common,
      entity,
      fields: {
        organizationId: organization.id,
        organizationSuiteCrmId: organization.suiteCrmId,
        fullName: clean(input.fields.fullName),
        firstName: clean(input.fields.firstName),
        lastName: clean(input.fields.lastName),
        priority: clean(input.fields.priority),
        contactType: clean(input.fields.contactType),
        accountManager: clean(input.fields.accountManager),
        jobTitle: clean(input.fields.jobTitle),
        email: clean(input.fields.email),
        linkedinUrl: clean(input.fields.linkedinUrl),
        phoneWork: clean(input.fields.phoneWork),
        phoneMobile: clean(input.fields.phoneMobile),
        address: clean(input.fields.address),
        city: clean(input.fields.city),
        state: clean(input.fields.state),
        postalCode: clean(input.fields.postalCode),
        country: clean(input.fields.country),
        description: clean(input.fields.description),
        emailOptOut: input.fields.emailOptOut === true,
      },
    }
  }
  if (entity === 'products') {
    return {
      ...common,
      entity,
      fields: {
        name: clean(input.fields.name),
        sku: clean(input.fields.sku),
        productType: clean(input.fields.productType),
        category: clean(input.fields.category),
        status: clean(input.fields.status),
        price: Number(input.fields.price) || 0,
        cost: Number(input.fields.cost) || 0,
        currency: clean(input.fields.currency),
        url: clean(input.fields.url),
        description: clean(input.fields.description),
        active: input.fields.active !== false,
      },
    }
  }
  if (entity === 'leads') {
    return {
      ...common,
      entity,
      fields: {
        organizationId: organization?.id || null,
        organizationSuiteCrmId: organization?.suiteCrmId || null,
        fullName: clean(input.fields.fullName),
        firstName: clean(input.fields.firstName),
        lastName: clean(input.fields.lastName),
        companyName: organization?.name || clean(input.fields.companyName),
        jobTitle: clean(input.fields.jobTitle),
        email: clean(input.fields.email),
        phoneWork: clean(input.fields.phoneWork),
        phoneMobile: clean(input.fields.phoneMobile),
        status: clean(input.fields.status),
        source: clean(input.fields.source),
        assignedTo: clean(input.fields.assignedTo),
        description: clean(input.fields.description),
        emailOptOut: input.fields.emailOptOut === true,
      },
    }
  }
  if (!organization) throw new Error('A CRM import relationship changed after preview')
  const contactIds = (input.fields.contactGlobalIds as string[])
    .map((globalId) => input.references.contacts.get(globalId)?.id)
    .filter((id): id is string => Boolean(id))
  const productIds = (input.fields.productGlobalIds as string[])
    .map((globalId) => input.references.products.get(globalId)?.id)
    .filter((id): id is string => Boolean(id))
  const ownerContactId = input.references.contacts.get(
    clean(input.fields.ownerContactGlobalId),
  )?.id || null
  return {
    ...common,
    entity,
    fields: {
      organizationId: organization.id,
      organizationSuiteCrmId: organization.suiteCrmId,
      contactIds,
      productIds,
      ownerContactId,
      name: clean(input.fields.name),
      organization: organization.name,
      priority: clean(input.fields.priority),
      owner: clean(input.fields.owner),
      status: clean(input.fields.status),
      stage: clean(input.fields.stage),
      lossReason: clean(input.fields.lossReason),
      source: clean(input.fields.source),
      value: Number(input.fields.value) || 0,
      probability: Number(input.fields.probability) || 0,
      expectedClose: nullable(input.fields.expectedClose),
      notes: clean(input.fields.notes),
    },
  }
}

export async function applyCrmDataTransferPreview(input: {
  pipelineId: string
  actorEmail: string
  runId: string
  rowNumbers: number[]
  confirmUpdates: boolean
  idempotencyKey: string
  customerParent: { id: string; suiteCrmId: string }
}) {
  const rowNumbers = [...new Set(input.rowNumbers)]
    .filter((row) => Number.isSafeInteger(row) && row >= 2)
    .sort((left, right) => left - right)
  if (rowNumbers.length === 0) throw new Error('Select at least one valid CRM row')
  const idempotencyKey = clean(input.idempotencyKey)
  if (!idempotencyKey || idempotencyKey.length > 200) {
    throw new Error('A valid CRM import idempotency key is required')
  }
  const requestHash = crypto
    .createHash('sha256')
    .update(JSON.stringify({
      runId: input.runId,
      rowNumbers,
      confirmUpdates: input.confirmUpdates,
    }))
    .digest('hex')
  const result = await withTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(
      client,
      `crm-data-transfer:${input.pipelineId}`,
    )
    const runResult = await client.query<Record<string, unknown>>(
      `SELECT *
       FROM crm_data_transfer_runs
       WHERE pipeline_id = $1::uuid
         AND id = $2::uuid
         AND actor_email = $3
       LIMIT 1
       FOR UPDATE`,
      [input.pipelineId, input.runId, input.actorEmail],
    )
    const run = runResult.rows[0]
    if (!run) throw new Error('CRM import preview was not found')
    if (
      clean(run.status) === 'applied'
      && clean(run.idempotency_key) === idempotencyKey
      && clean(run.apply_request_hash) === requestHash
    ) {
      return {
        runId: input.runId,
        entity: clean(run.entity) as CrmWritableTransferEntity,
        applied: Number(run.applied_count) || 0,
        idempotent: true,
      }
    }
    if (clean(run.status) !== 'previewed') {
      throw new Error('CRM import preview is no longer available')
    }
    if (new Date(String(run.expires_at)).getTime() <= Date.now()) {
      await client.query(
        `UPDATE crm_data_transfer_runs
         SET status = 'expired', updated_at = now()
         WHERE id = $1::uuid`,
        [input.runId],
      )
      throw new Error('CRM import preview expired; upload the file again')
    }
    const rowsResult = await client.query<Record<string, unknown>>(
      `SELECT *
       FROM crm_data_transfer_rows
       WHERE pipeline_id = $1::uuid
         AND run_id = $2::uuid
         AND row_number = ANY($3::integer[])
       ORDER BY row_number
       FOR UPDATE`,
      [input.pipelineId, input.runId, rowNumbers],
    )
    if (rowsResult.rows.length !== rowNumbers.length) {
      throw new Error('One or more selected CRM rows were not found')
    }
    const unsupported = rowsResult.rows.find((row) => (
      row.classification !== 'create' && row.classification !== 'update'
    ))
    if (unsupported) {
      throw new Error(`CRM row ${unsupported.row_number} cannot be applied`)
    }
    const updates = rowsResult.rows.filter((row) => row.classification === 'update')
    if (updates.length > 0 && !input.confirmUpdates) {
      throw new Error('Confirm that you reviewed changes to existing CRM records')
    }
    const entity = clean(run.entity) as CrmWritableTransferEntity
    const executor: QueryExecutor = (sql, values = []) => client.query(sql, values)
    const references = await loadReferenceMaps(executor, input.pipelineId)
    const currentRecords = await loadWritableRecords(
      executor,
      input.pipelineId,
      entity,
    )
    const naturalKeys = new Map<string, CurrentTransferRecord[]>()
    for (const record of currentRecords) {
      const key = crmDataTransferNaturalKey(entity, record.fields)
      const matches = naturalKeys.get(key) || []
      matches.push(record)
      naturalKeys.set(key, matches)
    }
    const selectedProductCandidates = entity === 'products'
      ? rowsResult.rows.map((row) => {
          const proposed = sourcePayload(row.proposed_fields)
          return {
            identity: `row:${row.row_number}`,
            fields: sourcePayload(proposed.values),
            targetId: row.target_record_id ? String(row.target_record_id) : null,
            rowNumber: Number(row.row_number),
          }
        })
      : []
    for (const row of updates) {
      const table = ENTITY_TABLE[entity]
      const currentResult = await client.query<Record<string, unknown>>(
        `SELECT id::text, reference_code, source_key, source_hash,
           source_payload, updated_at
         FROM ${table}
         WHERE pipeline_id = $1::uuid AND id = $2::uuid
         LIMIT 1
         FOR UPDATE`,
        [input.pipelineId, row.target_record_id],
      )
      const current = currentResult.rows[0]
      if (
        !current
        || isoTimestamp(current.updated_at) !== isoTimestamp(row.observed_updated_at)
        || clean(current.source_hash) !== clean(row.observed_source_hash)
      ) {
        throw new Error(
          `CRM row ${row.row_number} changed after preview; re-run preview`,
        )
      }
    }
    for (const row of rowsResult.rows.filter((item) => item.classification === 'create')) {
      const proposed = sourcePayload(row.proposed_fields)
      const fields = sourcePayload(proposed.values)
      if (entity === 'products') continue
      const key = crmDataTransferNaturalKey(entity, fields)
      if ((naturalKeys.get(key) || []).length > 0) {
        throw new Error(
          `CRM row ${row.row_number} now matches an existing record; re-run preview`,
        )
      }
    }
    if (entity === 'products') {
      const currentProductCandidates = currentRecords.map((record) => ({
        identity: `record:${record.id}`,
        fields: record.fields,
      }))
      for (const candidate of selectedProductCandidates) {
        const conflicts = crmProductUniquenessConflicts({
          candidate,
          others: [
            ...currentProductCandidates.filter((current) => (
              current.identity !== `record:${candidate.targetId || ''}`
            )),
            ...selectedProductCandidates,
          ],
        })
        const field = conflicts.find((conflict) => (
          conflict.field === 'name'
        ))
          ? 'name'
          : conflicts.find((conflict) => conflict.field === 'sku')
            ? 'sku'
            : null
        if (field) {
          throw new Error(
            `CRM row ${candidate.rowNumber} Product ${field} now conflicts with another record; re-run preview`,
          )
        }
      }
    }
    await client.query(
      `UPDATE crm_data_transfer_runs
       SET status = 'applying', idempotency_key = $2,
         apply_request_hash = $3, updated_at = now()
       WHERE id = $1::uuid`,
      [input.runId, idempotencyKey, requestHash],
    )
    let applied = 0
    for (const row of rowsResult.rows) {
      const proposed = sourcePayload(row.proposed_fields)
      const fields = sourcePayload(proposed.values)
      const current = row.target_record_id
        ? currentRecords.find((record) => record.id === String(row.target_record_id))
        : null
      const staged = await stageCrmRecordWithClient(
        client,
        stageInputFor(entity, {
          pipelineId: input.pipelineId,
          actorEmail: input.actorEmail,
          localId: current?.id || null,
          sourceKey: current?.sourceKey
            || `crm-csv:${input.runId}:${row.row_number}`,
          sourcePayload: {
            ...(current?.sourcePayload || {}),
            source: 'clawpilot_csv_import',
            lastImportRunId: input.runId,
            lastImportRowNumber: Number(row.row_number),
          },
          fields,
          references,
          customerParent: input.customerParent,
        }),
      )
      await client.query(
        `UPDATE crm_data_transfer_rows
         SET selected = true, outcome = $3, target_record_id = $4::uuid,
           target_reference_code = $5, updated_at = now()
         WHERE run_id = $1::uuid AND row_number = $2`,
        [
          input.runId,
          row.row_number,
          row.classification === 'create' ? 'created' : 'updated',
          staged.id,
          staged.referenceCode,
        ],
      )
      applied += 1
    }
    await client.query(
      `UPDATE crm_data_transfer_runs
       SET status = 'applied', applied_count = $2, applied_at = now(),
         updated_at = now()
       WHERE id = $1::uuid`,
      [input.runId, applied],
    )
    await recordAuditEvent({
      actor: input.actorEmail,
      eventType: 'crm.data_transfer.applied',
      aggregateType: 'crm_data_transfer',
      aggregateId: input.runId,
      eventKey: `crm-data-transfer-apply:${input.pipelineId}:${idempotencyKey}`,
      payload: {
        pipelineId: input.pipelineId,
        entity,
        applied,
        rowNumbers,
      },
    }, client)
    return {
      runId: input.runId,
      entity,
      applied,
      idempotent: false,
    }
  })
  if (result.entity === 'products') {
    try {
      await syncPipelineProductDropdownCatalogInPostgres({
        pipelineId: input.pipelineId,
        actorEmail: input.actorEmail,
      })
    } catch (error) {
      console.error('[crm-data-transfer] product dropdown refresh deferred', {
        pipelineId: input.pipelineId,
        runId: input.runId,
        error: error instanceof Error ? error.message : 'unknown error',
      })
      throw new Error(
        'CRM records were imported, but the product dropdown refresh failed. Retry Apply to finish safely.',
      )
    }
  }
  return result
}

function exportOnlyValues(
  entity: Exclude<CrmTransferEntity, CrmWritableTransferEntity>,
  row: Record<string, unknown>,
) {
  if (entity === 'meetings') {
    return {
      organization_global_id: clean(row.organization_reference_code),
      contact_global_id: clean(row.contact_reference_code),
      lead_global_id: clean(row.lead_reference_code),
      opportunity_global_id: clean(row.opportunity_reference_code),
      subject: clean(row.subject),
      description: clean(row.description),
      starts_at: isoTimestamp(row.starts_at),
      ends_at: isoTimestamp(row.ends_at),
      timezone: clean(row.timezone),
      location: clean(row.location),
      attendee_emails: Array.isArray(row.attendee_emails)
        ? row.attendee_emails.map(clean).filter(Boolean).join('|')
        : '',
      status: clean(row.status),
      provider: clean(row.provider),
    }
  }
  if (entity === 'interactions') {
    return {
      organization_global_id: clean(row.organization_reference_code),
      contact_global_ids: Array.isArray(row.contact_reference_codes)
        ? row.contact_reference_codes.map(clean).filter(Boolean).join('|')
        : '',
      lead_global_id: clean(row.lead_reference_code),
      opportunity_global_id: clean(row.opportunity_reference_code),
      meeting_global_id: clean(row.meeting_reference_code),
      campaign_global_id: clean(row.campaign_reference_code),
      interaction_type: clean(row.interaction_type),
      subject: clean(row.subject),
      agent_email: clean(row.agent_email),
      agent_name: clean(row.agent_name),
      occurred_at: row.occurred_at ? isoTimestamp(row.occurred_at) : '',
      description: clean(row.description),
      direction: clean(row.direction),
      delivery_status: clean(row.delivery_status),
    }
  }
  return {
    name: clean(row.name),
    status: clean(row.status),
    start_date: row.start_date
      ? new Date(String(row.start_date)).toISOString().slice(0, 10)
      : '',
    end_date: row.end_date
      ? new Date(String(row.end_date)).toISOString().slice(0, 10)
      : '',
    subject_template: clean(row.subject_template),
    body_template: clean(row.body_template),
    sender_email: clean(row.sender_email),
    description: clean(row.description),
  }
}

async function loadExportOnlyRows(
  pipelineId: string,
  entity: Exclude<CrmTransferEntity, CrmWritableTransferEntity>,
) {
  let sql = ''
  if (entity === 'meetings') {
    sql = `SELECT record.*, organization.reference_code AS organization_reference_code,
        contact.reference_code AS contact_reference_code,
        lead.reference_code AS lead_reference_code,
        opportunity.reference_code AS opportunity_reference_code
      FROM crm_meetings record
      LEFT JOIN crm_organizations organization
        ON organization.pipeline_id = record.pipeline_id
       AND organization.id = record.organization_id
      LEFT JOIN crm_contacts contact
        ON contact.pipeline_id = record.pipeline_id
       AND contact.id = record.contact_id
      LEFT JOIN crm_leads lead
        ON lead.pipeline_id = record.pipeline_id
       AND lead.id = record.lead_id
      LEFT JOIN crm_opportunities opportunity
        ON opportunity.pipeline_id = record.pipeline_id
       AND opportunity.id = record.opportunity_id
      WHERE record.pipeline_id = $1::uuid
      ORDER BY record.starts_at DESC, record.id`
  } else if (entity === 'interactions') {
    sql = `SELECT record.*, organization.reference_code AS organization_reference_code,
        lead.reference_code AS lead_reference_code,
        opportunity.reference_code AS opportunity_reference_code,
        meeting.reference_code AS meeting_reference_code,
        campaign.reference_code AS campaign_reference_code,
        COALESCE((
          SELECT array_agg(contact.reference_code ORDER BY relationship.sort_order, contact.reference_code)
          FROM crm_interaction_contacts relationship
          JOIN crm_contacts contact
            ON contact.pipeline_id = relationship.pipeline_id
           AND contact.id = relationship.contact_id
          WHERE relationship.pipeline_id = record.pipeline_id
            AND relationship.interaction_id = record.id
        ), ARRAY[]::text[]) AS contact_reference_codes
      FROM crm_interactions record
      LEFT JOIN crm_organizations organization
        ON organization.pipeline_id = record.pipeline_id
       AND organization.id = record.organization_id
      LEFT JOIN crm_leads lead
        ON lead.pipeline_id = record.pipeline_id
       AND lead.id = record.lead_id
      LEFT JOIN crm_opportunities opportunity
        ON opportunity.pipeline_id = record.pipeline_id
       AND opportunity.id = record.opportunity_id
      LEFT JOIN crm_meetings meeting
        ON meeting.pipeline_id = record.pipeline_id
       AND meeting.id = record.meeting_id
      LEFT JOIN crm_campaigns campaign
        ON campaign.pipeline_id = record.pipeline_id
       AND campaign.id = record.campaign_id
      WHERE record.pipeline_id = $1::uuid
        AND COALESCE(lower(record.source_payload->>'archived'), 'false')
          NOT IN ('true', '1', 'yes')
      ORDER BY record.occurred_at DESC NULLS LAST, record.id`
  } else {
    sql = `SELECT record.*
      FROM crm_campaigns record
      WHERE record.pipeline_id = $1::uuid
        AND COALESCE(lower(record.source_payload->>'archived'), 'false')
          NOT IN ('true', '1', 'yes')
      ORDER BY lower(record.name), record.id`
  }
  const result = await query<Record<string, unknown>>(sql, [pipelineId])
  return result.rows.map((row) => {
    const updatedAt = isoTimestamp(row.updated_at)
    return {
      schema_version: CRM_DATA_TRANSFER_SCHEMA_VERSION,
      global_id: clean(row.reference_code),
      record_version: versionFor(updatedAt, clean(row.source_hash)),
      ...exportOnlyValues(entity, row),
    }
  })
}

export async function exportCrmDataTransferCsv(input: {
  pipelineId: string
  entity: CrmTransferEntity
}) {
  if (
    input.entity === 'meetings'
    || input.entity === 'interactions'
    || input.entity === 'campaigns'
  ) {
    return buildCrmDataTransferCsv({
      entity: input.entity,
      rows: await loadExportOnlyRows(input.pipelineId, input.entity),
    })
  }
  const executor: QueryExecutor = (sql, values = []) => query(sql, values)
  const records = await loadWritableRecords(
    executor,
    input.pipelineId,
    input.entity,
  )
  return buildCrmDataTransferCsv({
    entity: input.entity,
    rows: records
      .filter((record) => !record.systemManaged)
      .map((record) => ({
        schema_version: CRM_DATA_TRANSFER_SCHEMA_VERSION,
        global_id: record.referenceCode,
        record_version: record.recordVersion,
        ...record.values,
      })),
  })
}

export async function exportCrmDataTransferCsvSegments(input: {
  pipelineId: string
  entity: CrmTransferEntity
}) {
  if (
    input.entity === 'meetings'
    || input.entity === 'interactions'
    || input.entity === 'campaigns'
  ) {
    return buildCrmDataTransferCsvSegments({
      entity: input.entity,
      rows: await loadExportOnlyRows(input.pipelineId, input.entity),
    })
  }
  const executor: QueryExecutor = (sql, values = []) => query(sql, values)
  const records = await loadWritableRecords(
    executor,
    input.pipelineId,
    input.entity,
  )
  return buildCrmDataTransferCsvSegments({
    entity: input.entity,
    rows: records
      .filter((record) => !record.systemManaged)
      .map((record) => ({
        schema_version: CRM_DATA_TRANSFER_SCHEMA_VERSION,
        global_id: record.referenceCode,
        record_version: record.recordVersion,
        ...record.values,
      })),
  })
}
