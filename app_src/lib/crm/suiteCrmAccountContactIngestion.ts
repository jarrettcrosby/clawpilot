import { reconcileCrmBoardProjectionsForPipeline } from '@/lib/crm/boardProjection'
import { decodeHtmlEntities } from '@/lib/htmlEntities.mjs'
import {
  listSuiteCrmAccountContactRecordsUpdatedSince,
  type SuiteCrmAccountContactModule,
  type SuiteCrmRecordSnapshot,
} from '@/lib/crm/suiteCrmClient'
import {
  stageCrmRecordInPostgres,
  type StageContactInput,
  type StageOrganizationInput,
} from '@/lib/persistence/crm'
import { query } from '@/lib/persistence/postgres'

const CURSOR_KEY = 'crm.suitecrm.account_contact_ingestion.cursor'
const INITIAL_LOOKBACK_MS = 24 * 60 * 60 * 1000
const POLL_OVERLAP_MS = 5 * 60 * 1000
const MAX_PAGES_PER_RUN = 10

type CursorState = {
  module: SuiteCrmAccountContactModule
  updatedSince: string
  pollStartedAt: string
  page: number
}

type CursorDocument = {
  state: CursorState | null
  lastPolledAt: string | null
  lastError: string | null
}

type CommonLocalRow = {
  id: string
  pipeline_id: string
  owner_email: string
  suitecrm_id: string | null
  reference_code: string
  source_key: string
  source_sheet_id: string | null
  source_row_number: number | null
  source_payload: Record<string, unknown> | null
}

type OrganizationRow = CommonLocalRow & {
  parent_organization_id: string | null
  parent_suitecrm_id: string | null
  workspace_organization_id: string | null
  workspace_organization_reference_code: string | null
  relationship_type: string
  priority: string | null
  name: string
  account_type: string | null
  account_manager: string | null
  website: string | null
  linkedin_url: string | null
  phone: string | null
  email: string | null
  email_opt_out: boolean
  billing_address_street: string | null
  billing_address_city: string | null
  billing_address_state: string | null
  billing_address_postal_code: string | null
  billing_address_country: string | null
  description: string | null
}

type ContactRow = CommonLocalRow & {
  organization_id: string
  organization_suitecrm_id: string | null
  app_user_email: string | null
  app_user_contact_reference_code: string | null
  priority: string | null
  first_name: string | null
  last_name: string | null
  full_name: string
  contact_type: string | null
  account_manager: string | null
  job_title: string | null
  email: string | null
  linkedin_url: string | null
  phone_work: string | null
  phone_mobile: string | null
  primary_address_street: string | null
  primary_address_city: string | null
  primary_address_state: string | null
  primary_address_postal_code: string | null
  primary_address_country: string | null
  description: string | null
  email_opt_out: boolean
}

type ReconcileResult = {
  matched: number
  staged: number
  unchanged: number
  stagedPipelineIds: string[]
}

export type SuiteCrmAccountContactIngestionCounts = {
  pagesPolled: number
  accountsListed: number
  contactsListed: number
  accountsMatched: number
  contactsMatched: number
  accountsStaged: number
  contactsStaged: number
  unchangedRecords: number
  unmatchedRecords: number
  deletedRecordsIgnored: number
  boundPipelines: number
  pipelineProjectionRuns: number
  pending: boolean
  errors: number
}

class SafeSuiteCrmAccountContactIngestionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SafeSuiteCrmAccountContactIngestionError'
  }
}

function validDate(value: unknown): Date | null {
  if (!value) return null
  const parsed = value instanceof Date ? value : new Date(String(value))
  return Number.isFinite(parsed.getTime()) ? parsed : null
}

function cleanString(value: unknown, maxLength: number, label: string): string {
  const normalized = decodeHtmlEntities(value)
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (normalized.length > maxLength) {
    throw new SafeSuiteCrmAccountContactIngestionError(`SuiteCRM ${label} is invalid`)
  }
  return normalized
}

function cleanMultiline(value: unknown, maxLength: number, label: string): string {
  const normalized = decodeHtmlEntities(value).replace(/\u0000/g, '').replace(/\r\n?/g, '\n').trim()
  if (normalized.length > maxLength || /[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(normalized)) {
    throw new SafeSuiteCrmAccountContactIngestionError(`SuiteCRM ${label} is invalid`)
  }
  return normalized
}

function hasAttribute(attributes: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(attributes, key)
}

function suiteString(
  attributes: Record<string, unknown>,
  key: string,
  currentValue: string,
  maxLength: number,
  label: string,
): string {
  return hasAttribute(attributes, key)
    ? cleanString(attributes[key], maxLength, label)
    : currentValue
}

function suiteMultiline(
  attributes: Record<string, unknown>,
  key: string,
  currentValue: string,
  maxLength: number,
  label: string,
): string {
  return hasAttribute(attributes, key)
    ? cleanMultiline(attributes[key], maxLength, label)
    : currentValue
}

function storedString(value: unknown): string {
  return String(value ?? '').trim()
}

function nullableStoredString(value: unknown): string | null {
  return storedString(value) || null
}

function sourcePayload(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function parseCursor(value: unknown): CursorDocument | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const document = value as Record<string, unknown>
  const lastPolledAt = validDate(document.lastPolledAt)?.toISOString() || null
  const rawState = document.state
  if (rawState === null) return { state: null, lastPolledAt, lastError: null }
  if (!rawState || typeof rawState !== 'object' || Array.isArray(rawState)) return null
  const state = rawState as Record<string, unknown>
  const moduleName = state.module
  const updatedSince = validDate(state.updatedSince)
  const pollStartedAt = validDate(state.pollStartedAt)
  const page = Number(state.page)
  if (
    (moduleName !== 'Accounts' && moduleName !== 'Contacts')
    || !updatedSince
    || !pollStartedAt
    || !Number.isSafeInteger(page)
    || page < 1
  ) return null
  return {
    state: {
      module: moduleName,
      updatedSince: updatedSince.toISOString(),
      pollStartedAt: pollStartedAt.toISOString(),
      page,
    },
    lastPolledAt,
    lastError: null,
  }
}

async function readCursor(): Promise<CursorDocument | null> {
  const result = await query<{ value: unknown }>(
    'SELECT value FROM app_settings WHERE key = $1 LIMIT 1',
    [CURSOR_KEY],
  )
  return parseCursor(result.rows[0]?.value)
}

async function writeCursor(document: CursorDocument): Promise<void> {
  await query(
    `INSERT INTO app_settings (key, value, updated_at)
     VALUES ($1, $2::jsonb, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [CURSOR_KEY, JSON.stringify(document)],
  )
}

function globalId(snapshot: SuiteCrmRecordSnapshot, moduleName: SuiteCrmAccountContactModule): string | null {
  const value = String(snapshot.attributes.global_id_c ?? '').trim().toLowerCase()
  const pattern = moduleName === 'Accounts'
    ? /^ga(?:[0-9]{7}|[0-9a-v]{12})$/
    : /^gc(?:[0-9]{7}|[0-9a-v]{12})$/
  return pattern.test(value) ? value : null
}

function suiteCrmSnapshotIsDeleted(snapshot: SuiteCrmRecordSnapshot): boolean {
  const value = snapshot.attributes.deleted
  if (value === true || value === 1) return true
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return normalized === 'true' || normalized === '1'
}

function suiteTimestamp(value: unknown, label: string): string {
  const parsed = validDate(value)
  if (!parsed) throw new SafeSuiteCrmAccountContactIngestionError(`SuiteCRM ${label} is invalid`)
  return parsed.toISOString()
}

function tenantScopedMatches<Row extends CommonLocalRow>(rows: Row[], label: string): Row[] {
  const byPipeline = new Map<string, Row>()
  for (const row of rows) {
    const existing = byPipeline.get(row.pipeline_id)
    if (existing && existing.id !== row.id) {
      throw new SafeSuiteCrmAccountContactIngestionError(
        `SuiteCRM ${label} matched multiple records in one pipeline`,
      )
    }
    byPipeline.set(row.pipeline_id, row)
  }
  return Array.from(byPipeline.values())
}

async function localOrganizations(snapshot: SuiteCrmRecordSnapshot): Promise<OrganizationRow[]> {
  const result = await query<OrganizationRow>(
    `SELECT organization.id::text, organization.pipeline_id::text, pipeline.owner_email,
       organization.suitecrm_id, organization.reference_code, organization.source_key,
       organization.source_sheet_id, organization.source_row_number, organization.source_payload,
       organization.parent_organization_id::text, parent.suitecrm_id AS parent_suitecrm_id,
       organization.workspace_organization_id::text,
       workspace.reference_code AS workspace_organization_reference_code,
       organization.relationship_type, organization.priority, organization.name,
       organization.account_type, organization.account_manager, organization.website,
       organization.linkedin_url, organization.phone, organization.email,
       organization.email_opt_out, organization.billing_address_street,
       organization.billing_address_city, organization.billing_address_state,
       organization.billing_address_postal_code, organization.billing_address_country,
       organization.description
     FROM crm_organizations organization
     JOIN pipeline_spaces pipeline ON pipeline.id = organization.pipeline_id
     LEFT JOIN crm_organizations parent
       ON parent.id = organization.parent_organization_id
       AND parent.pipeline_id = organization.pipeline_id
     LEFT JOIN workspace_organizations workspace ON workspace.id = organization.workspace_organization_id
     WHERE organization.suitecrm_id = $1
       OR ($2 <> '' AND organization.reference_code = $2)
     ORDER BY organization.pipeline_id, organization.id`,
    [snapshot.id, globalId(snapshot, 'Accounts') || ''],
  )
  return tenantScopedMatches(result.rows, 'account')
}

async function localContacts(snapshot: SuiteCrmRecordSnapshot): Promise<ContactRow[]> {
  const result = await query<ContactRow>(
    `SELECT contact.id::text, contact.pipeline_id::text, pipeline.owner_email,
       contact.suitecrm_id, contact.reference_code, contact.source_key,
       contact.source_sheet_id, contact.source_row_number, contact.source_payload,
       contact.organization_id::text, organization.suitecrm_id AS organization_suitecrm_id,
       contact.app_user_email, app_user.contact_reference_code AS app_user_contact_reference_code,
       contact.priority, contact.first_name, contact.last_name, contact.full_name,
       contact.contact_type, contact.account_manager, contact.job_title, contact.email,
       contact.linkedin_url, contact.phone_work, contact.phone_mobile,
       contact.primary_address_street, contact.primary_address_city,
       contact.primary_address_state, contact.primary_address_postal_code,
       contact.primary_address_country, contact.description, contact.email_opt_out
     FROM crm_contacts contact
     JOIN pipeline_spaces pipeline ON pipeline.id = contact.pipeline_id
     JOIN crm_organizations organization
       ON organization.id = contact.organization_id
       AND organization.pipeline_id = contact.pipeline_id
     LEFT JOIN app_users app_user ON app_user.email = contact.app_user_email
     WHERE contact.suitecrm_id = $1
       OR ($2 <> '' AND contact.reference_code = $2)
     ORDER BY contact.pipeline_id, contact.id`,
    [snapshot.id, globalId(snapshot, 'Contacts') || ''],
  )
  return tenantScopedMatches(result.rows, 'contact')
}

function relationshipType(value: unknown): NonNullable<StageOrganizationInput['fields']['relationshipType']> {
  if (value === 'workspace_root' || value === 'workspace_member' || value === 'customer') return value
  throw new SafeSuiteCrmAccountContactIngestionError('Stored CRM account relationship is invalid')
}

function organizationFields(
  snapshot: SuiteCrmRecordSnapshot,
  row: OrganizationRow,
): StageOrganizationInput['fields'] {
  const attributes = snapshot.attributes
  const currentName = cleanString(row.name, 300, 'stored account name')
  const name = suiteString(attributes, 'name', currentName, 300, 'account name') || currentName
  if (!name) throw new SafeSuiteCrmAccountContactIngestionError('SuiteCRM account name is invalid')
  return {
    parentOrganizationId: nullableStoredString(row.parent_organization_id),
    parentOrganizationSuiteCrmId: nullableStoredString(row.parent_suitecrm_id),
    workspaceOrganizationId: nullableStoredString(row.workspace_organization_id),
    workspaceOrganizationReferenceCode: nullableStoredString(row.workspace_organization_reference_code),
    relationshipType: relationshipType(row.relationship_type),
    priority: storedString(row.priority),
    name,
    accountType: suiteString(
      attributes,
      'account_type',
      cleanString(row.account_type, 100, 'stored account type'),
      100,
      'account type',
    ),
    accountManager: storedString(row.account_manager),
    website: suiteString(
      attributes,
      'website',
      cleanString(row.website, 2_048, 'stored account website'),
      2_048,
      'account website',
    ),
    linkedinUrl: storedString(row.linkedin_url),
    phone: suiteString(
      attributes,
      'phone_office',
      cleanString(row.phone, 100, 'stored account phone'),
      100,
      'account phone',
    ),
    email: suiteString(
      attributes,
      'email1',
      cleanString(row.email, 254, 'stored account email'),
      254,
      'account email',
    ),
    emailOptOut: row.email_opt_out === true,
    address: suiteString(
      attributes,
      'billing_address_street',
      cleanString(row.billing_address_street, 1_000, 'stored account address'),
      1_000,
      'account address',
    ),
    city: suiteString(
      attributes,
      'billing_address_city',
      cleanString(row.billing_address_city, 200, 'stored account city'),
      200,
      'account city',
    ),
    state: suiteString(
      attributes,
      'billing_address_state',
      cleanString(row.billing_address_state, 200, 'stored account state'),
      200,
      'account state',
    ),
    postalCode: suiteString(
      attributes,
      'billing_address_postalcode',
      cleanString(row.billing_address_postal_code, 100, 'stored account postal code'),
      100,
      'account postal code',
    ),
    country: suiteString(
      attributes,
      'billing_address_country',
      cleanString(row.billing_address_country, 200, 'stored account country'),
      200,
      'account country',
    ),
    description: suiteMultiline(
      attributes,
      'description',
      cleanMultiline(row.description, 10_000, 'stored account description'),
      10_000,
      'account description',
    ),
  }
}

function contactFields(
  snapshot: SuiteCrmRecordSnapshot,
  row: ContactRow,
): StageContactInput['fields'] {
  if (!row.organization_suitecrm_id) {
    throw new SafeSuiteCrmAccountContactIngestionError('Stored CRM contact account is invalid')
  }
  const attributes = snapshot.attributes
  const currentFirstName = cleanString(row.first_name, 200, 'stored contact first name')
  const currentLastName = cleanString(row.last_name, 200, 'stored contact last name')
  const currentFullName = cleanString(row.full_name, 300, 'stored contact full name')
  const firstName = suiteString(attributes, 'first_name', currentFirstName, 200, 'contact first name')
  const lastName = suiteString(attributes, 'last_name', currentLastName, 200, 'contact last name')
  let fullName = currentFullName
  if (firstName !== currentFirstName || lastName !== currentLastName || !fullName) {
    fullName = cleanString(`${firstName} ${lastName}`, 300, 'contact full name')
      || suiteString(attributes, 'name', currentFullName, 300, 'contact full name')
      || currentFullName
  }
  if (!fullName) throw new SafeSuiteCrmAccountContactIngestionError('SuiteCRM contact name is invalid')
  return {
    organizationId: row.organization_id,
    organizationSuiteCrmId: row.organization_suitecrm_id,
    appUserEmail: nullableStoredString(row.app_user_email),
    appUserContactReferenceCode: nullableStoredString(row.app_user_contact_reference_code),
    priority: storedString(row.priority),
    firstName,
    lastName,
    fullName,
    contactType: storedString(row.contact_type),
    accountManager: storedString(row.account_manager),
    jobTitle: suiteString(
      attributes,
      'title',
      cleanString(row.job_title, 300, 'stored contact title'),
      300,
      'contact title',
    ),
    email: suiteString(
      attributes,
      'email1',
      cleanString(row.email, 254, 'stored contact email'),
      254,
      'contact email',
    ),
    linkedinUrl: storedString(row.linkedin_url),
    phoneWork: suiteString(
      attributes,
      'phone_work',
      cleanString(row.phone_work, 100, 'stored contact work phone'),
      100,
      'contact work phone',
    ),
    phoneMobile: suiteString(
      attributes,
      'phone_mobile',
      cleanString(row.phone_mobile, 100, 'stored contact mobile phone'),
      100,
      'contact mobile phone',
    ),
    address: suiteString(
      attributes,
      'primary_address_street',
      cleanString(row.primary_address_street, 1_000, 'stored contact address'),
      1_000,
      'contact address',
    ),
    city: suiteString(
      attributes,
      'primary_address_city',
      cleanString(row.primary_address_city, 200, 'stored contact city'),
      200,
      'contact city',
    ),
    state: suiteString(
      attributes,
      'primary_address_state',
      cleanString(row.primary_address_state, 200, 'stored contact state'),
      200,
      'contact state',
    ),
    postalCode: suiteString(
      attributes,
      'primary_address_postalcode',
      cleanString(row.primary_address_postal_code, 100, 'stored contact postal code'),
      100,
      'contact postal code',
    ),
    country: suiteString(
      attributes,
      'primary_address_country',
      cleanString(row.primary_address_country, 200, 'stored contact country'),
      200,
      'contact country',
    ),
    description: suiteMultiline(
      attributes,
      'description',
      cleanMultiline(row.description, 10_000, 'stored contact description'),
      10_000,
      'contact description',
    ),
    emailOptOut: row.email_opt_out === true,
  }
}

function sameText(left: unknown, right: unknown): boolean {
  return storedString(left) === storedString(right)
}

function hasMeaningfulOrganizationChanges(
  row: OrganizationRow,
  fields: StageOrganizationInput['fields'],
): boolean {
  return ![
    [row.name, fields.name],
    [row.account_type, fields.accountType],
    [row.website, fields.website],
    [row.phone, fields.phone],
    [row.email, fields.email],
    [row.billing_address_street, fields.address],
    [row.billing_address_city, fields.city],
    [row.billing_address_state, fields.state],
    [row.billing_address_postal_code, fields.postalCode],
    [row.billing_address_country, fields.country],
    [row.description, fields.description],
  ].every(([left, right]) => sameText(left, right))
}

function hasMeaningfulContactChanges(
  row: ContactRow,
  fields: StageContactInput['fields'],
): boolean {
  return ![
    [row.first_name, fields.firstName],
    [row.last_name, fields.lastName],
    [row.full_name, fields.fullName],
    [row.job_title, fields.jobTitle],
    [row.email, fields.email],
    [row.phone_work, fields.phoneWork],
    [row.phone_mobile, fields.phoneMobile],
    [row.primary_address_street, fields.address],
    [row.primary_address_city, fields.city],
    [row.primary_address_state, fields.state],
    [row.primary_address_postal_code, fields.postalCode],
    [row.primary_address_country, fields.country],
    [row.description, fields.description],
  ].every(([left, right]) => sameText(left, right))
}

function suiteCrmInboundSourcePayload(
  row: CommonLocalRow,
  moduleName: SuiteCrmAccountContactModule,
  snapshot: SuiteCrmRecordSnapshot,
  dateModified: string,
): Record<string, unknown> {
  return {
    ...sourcePayload(row.source_payload),
    suiteCrmInbound: {
      module: moduleName,
      id: snapshot.id,
      dateModified,
    },
  }
}

async function reconcileAccount(snapshot: SuiteCrmRecordSnapshot): Promise<ReconcileResult> {
  const rows = await localOrganizations(snapshot)
  if (rows.length === 0) return { matched: 0, staged: 0, unchanged: 0, stagedPipelineIds: [] }
  let dateModified: string | null = null
  let staged = 0
  let unchanged = 0
  const stagedPipelineIds = new Set<string>()
  for (const row of rows) {
    const fields = organizationFields(snapshot, row)
    if (!hasMeaningfulOrganizationChanges(row, fields)) {
      unchanged += 1
      continue
    }
    dateModified ||= suiteTimestamp(snapshot.attributes.date_modified, 'account modified time')
    await stageCrmRecordInPostgres({
      entity: 'organizations',
      pipelineId: row.pipeline_id,
      localId: row.id,
      sourceKey: row.source_key,
      sourceSheetId: row.source_sheet_id,
      sourceRowNumber: row.source_row_number,
      sourcePayload: suiteCrmInboundSourcePayload(row, 'Accounts', snapshot, dateModified),
      actorEmail: row.owner_email,
      emitSuiteCrmOutbox: false,
      fields,
    })
    staged += 1
    stagedPipelineIds.add(row.pipeline_id)
  }
  return {
    matched: rows.length,
    staged,
    unchanged,
    stagedPipelineIds: Array.from(stagedPipelineIds),
  }
}

async function reconcileContact(snapshot: SuiteCrmRecordSnapshot): Promise<ReconcileResult> {
  const rows = await localContacts(snapshot)
  if (rows.length === 0) return { matched: 0, staged: 0, unchanged: 0, stagedPipelineIds: [] }
  let dateModified: string | null = null
  let staged = 0
  let unchanged = 0
  const stagedPipelineIds = new Set<string>()
  for (const row of rows) {
    const fields = contactFields(snapshot, row)
    if (!hasMeaningfulContactChanges(row, fields)) {
      unchanged += 1
      continue
    }
    dateModified ||= suiteTimestamp(snapshot.attributes.date_modified, 'contact modified time')
    await stageCrmRecordInPostgres({
      entity: 'contacts',
      pipelineId: row.pipeline_id,
      localId: row.id,
      sourceKey: row.source_key,
      sourceSheetId: row.source_sheet_id,
      sourceRowNumber: row.source_row_number,
      sourcePayload: suiteCrmInboundSourcePayload(row, 'Contacts', snapshot, dateModified),
      actorEmail: row.owner_email,
      emitSuiteCrmOutbox: false,
      fields,
    })
    staged += 1
    stagedPipelineIds.add(row.pipeline_id)
  }
  return {
    matched: rows.length,
    staged,
    unchanged,
    stagedPipelineIds: Array.from(stagedPipelineIds),
  }
}

async function boundCrmBoardPipelineIds(): Promise<string[]> {
  const result = await query<{ pipeline_id: string }>(
    `SELECT DISTINCT pipeline_id::text
     FROM crm_board_projections
     ORDER BY pipeline_id::text`,
  )
  return result.rows.map((row) => row.pipeline_id)
}

async function reconcilePendingCrmBoardPipelines(
  pipelineIds: Set<string>,
  counts: SuiteCrmAccountContactIngestionCounts,
): Promise<void> {
  for (const pipelineId of Array.from(pipelineIds).sort()) {
    await reconcileCrmBoardProjectionsForPipeline({ pipelineId })
    pipelineIds.delete(pipelineId)
    counts.pipelineProjectionRuns += 1
  }
}

export function sanitizeSuiteCrmAccountContactIngestionError(error: unknown): string {
  return error instanceof SafeSuiteCrmAccountContactIngestionError
    ? error.message.slice(0, 500)
    : 'SuiteCRM account/contact ingestion failed'
}

export async function processSuiteCrmAccountContactIngestion(): Promise<SuiteCrmAccountContactIngestionCounts> {
  const counts: SuiteCrmAccountContactIngestionCounts = {
    pagesPolled: 0,
    accountsListed: 0,
    contactsListed: 0,
    accountsMatched: 0,
    contactsMatched: 0,
    accountsStaged: 0,
    contactsStaged: 0,
    unchangedRecords: 0,
    unmatchedRecords: 0,
    deletedRecordsIgnored: 0,
    boundPipelines: 0,
    pipelineProjectionRuns: 0,
    pending: false,
    errors: 0,
  }
  const now = new Date()
  const cursor = await readCursor()
  let state: CursorState = cursor?.state || {
    module: 'Accounts',
    updatedSince: new Date(
      cursor?.lastPolledAt
        ? Date.parse(cursor.lastPolledAt) - POLL_OVERLAP_MS
        : now.getTime() - INITIAL_LOOKBACK_MS,
    ).toISOString(),
    pollStartedAt: now.toISOString(),
    page: 1,
  }
  const projectionPipelineIds = new Set(await boundCrmBoardPipelineIds())
  counts.boundPipelines = projectionPipelineIds.size

  try {
    await writeCursor({ state, lastPolledAt: now.toISOString(), lastError: null })
    for (let attempt = 0; attempt < MAX_PAGES_PER_RUN; attempt += 1) {
      const page = await listSuiteCrmAccountContactRecordsUpdatedSince({
        module: state.module,
        updatedSince: state.updatedSince,
        page: state.page,
      })
      counts.pagesPolled += 1
      if (state.module === 'Accounts') counts.accountsListed += page.records.length
      else counts.contactsListed += page.records.length

      for (const snapshot of page.records) {
        if (suiteCrmSnapshotIsDeleted(snapshot)) {
          counts.deletedRecordsIgnored += 1
          continue
        }
        const result = state.module === 'Accounts'
          ? await reconcileAccount(snapshot)
          : await reconcileContact(snapshot)
        if (result.matched === 0) counts.unmatchedRecords += 1
        if (state.module === 'Accounts') {
          counts.accountsMatched += result.matched
          counts.accountsStaged += result.staged
        } else {
          counts.contactsMatched += result.matched
          counts.contactsStaged += result.staged
        }
        counts.unchangedRecords += result.unchanged
        for (const pipelineId of result.stagedPipelineIds) projectionPipelineIds.add(pipelineId)
      }

      await reconcilePendingCrmBoardPipelines(projectionPipelineIds, counts)

      if (state.page < page.totalPages) {
        state = { ...state, page: state.page + 1 }
        await writeCursor({ state, lastPolledAt: new Date().toISOString(), lastError: null })
        continue
      }
      if (state.module === 'Accounts') {
        state = { ...state, module: 'Contacts', page: 1 }
        await writeCursor({ state, lastPolledAt: new Date().toISOString(), lastError: null })
        continue
      }
      await writeCursor({ state: null, lastPolledAt: state.pollStartedAt, lastError: null })
      return counts
    }
    counts.pending = true
    return counts
  } catch (error) {
    counts.errors += 1
    let recordedError = error
    try {
      await reconcilePendingCrmBoardPipelines(projectionPipelineIds, counts)
    } catch (projectionError) {
      recordedError = projectionError
    }
    await writeCursor({
      state,
      lastPolledAt: new Date().toISOString(),
      lastError: sanitizeSuiteCrmAccountContactIngestionError(recordedError),
    })
    return counts
  }
}
