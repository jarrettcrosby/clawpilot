import { parse } from 'csv-parse/sync'
// Node's focused strip-types tests need the explicit extension.
// @ts-expect-error TypeScript extension imports are intentionally used for Node tests.
import { isIso4217CurrencyCode } from '../currency.ts'

export const CRM_DATA_TRANSFER_SCHEMA_VERSION = '1'
export const CRM_DATA_TRANSFER_MAX_BYTES = 1_048_576
export const CRM_DATA_TRANSFER_MAX_ROWS = 500

export const CRM_WRITABLE_TRANSFER_ENTITIES = [
  'organizations',
  'contacts',
  'products',
  'leads',
  'opportunities',
] as const

export const CRM_EXPORT_ONLY_TRANSFER_ENTITIES = [
  'meetings',
  'interactions',
  'campaigns',
] as const

export type CrmWritableTransferEntity =
  (typeof CRM_WRITABLE_TRANSFER_ENTITIES)[number]
export type CrmExportOnlyTransferEntity =
  (typeof CRM_EXPORT_ONLY_TRANSFER_ENTITIES)[number]
export type CrmTransferEntity =
  | CrmWritableTransferEntity
  | CrmExportOnlyTransferEntity
export type CrmTransferClassification =
  | 'create'
  | 'update'
  | 'unchanged'
  | 'ambiguous'
  | 'invalid'

export type CrmTransferRowError = {
  rowNumber: number
  column?: string
  code: string
  message: string
}

export type CrmTransferFieldDiff = {
  field: string
  before: string
  after: string
}

export type CrmProductUniquenessCandidate = {
  identity: string
  fields: Record<string, unknown>
}

export type CrmProductUniquenessConflict = {
  field: 'name' | 'sku'
  conflictingIdentity: string
}

export type ParsedCrmTransferRow = {
  rowNumber: number
  globalId: string
  recordVersion: string
  values: Record<string, string>
  fields: Record<string, unknown>
  errors: CrmTransferRowError[]
}

export class CrmDataTransferCsvError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'CrmDataTransferCsvError'
    this.code = code
  }
}

const COMMON_HEADERS = ['schema_version', 'global_id', 'record_version'] as const
const CRM_DATA_TRANSFER_HEADERS: Record<CrmTransferEntity, readonly string[]> = {
  organizations: [
    ...COMMON_HEADERS,
    'name',
    'account_type',
    'priority',
    'account_manager',
    'website',
    'linkedin_url',
    'phone',
    'email',
    'email_opt_out',
    'address',
    'city',
    'state',
    'postal_code',
    'country',
    'description',
  ],
  contacts: [
    ...COMMON_HEADERS,
    'organization_global_id',
    'full_name',
    'first_name',
    'last_name',
    'priority',
    'contact_type',
    'account_manager',
    'job_title',
    'email',
    'linkedin_url',
    'phone_work',
    'phone_mobile',
    'address',
    'city',
    'state',
    'postal_code',
    'country',
    'description',
    'email_opt_out',
  ],
  products: [
    ...COMMON_HEADERS,
    'name',
    'sku',
    'product_type',
    'category',
    'status',
    'price',
    'cost',
    'currency',
    'url',
    'description',
    'active',
  ],
  leads: [
    ...COMMON_HEADERS,
    'organization_global_id',
    'full_name',
    'first_name',
    'last_name',
    'company_name',
    'job_title',
    'email',
    'phone_work',
    'phone_mobile',
    'status',
    'source',
    'assigned_to',
    'description',
    'email_opt_out',
  ],
  opportunities: [
    ...COMMON_HEADERS,
    'organization_global_id',
    'contact_global_ids',
    'owner_contact_global_id',
    'product_global_ids',
    'name',
    'priority',
    'owner',
    'status',
    'stage',
    'loss_reason',
    'source',
    'value',
    'probability',
    'expected_close',
    'notes',
  ],
  meetings: [
    ...COMMON_HEADERS,
    'organization_global_id',
    'contact_global_id',
    'lead_global_id',
    'opportunity_global_id',
    'subject',
    'description',
    'starts_at',
    'ends_at',
    'timezone',
    'location',
    'attendee_emails',
    'status',
    'provider',
  ],
  interactions: [
    ...COMMON_HEADERS,
    'organization_global_id',
    'contact_global_ids',
    'lead_global_id',
    'opportunity_global_id',
    'meeting_global_id',
    'campaign_global_id',
    'interaction_type',
    'subject',
    'agent_email',
    'agent_name',
    'occurred_at',
    'description',
    'direction',
    'delivery_status',
  ],
  campaigns: [
    ...COMMON_HEADERS,
    'name',
    'status',
    'start_date',
    'end_date',
    'subject_template',
    'body_template',
    'sender_email',
    'description',
  ],
}

const GLOBAL_ID_PATTERNS: Record<CrmTransferEntity, RegExp> = {
  organizations: /^ga(?:[0-9]{7}|[0-9a-v]{12})$/,
  contacts: /^gc(?:[0-9]{7}|[0-9a-v]{12})$/,
  products: /^gp(?:[0-9]{7}|[0-9a-v]{12})$/,
  leads: /^gl(?:[0-9]{7}|[0-9a-v]{12})$/,
  opportunities: /^go(?:[0-9]{7}|[0-9a-v]{12})$/,
  meetings: /^gm(?:[0-9]{7}|[0-9a-v]{12})$/,
  interactions: /^gi(?:[0-9]{7}|[0-9a-v]{12})$/,
  campaigns: /^gk(?:[0-9]{7}|[0-9a-v]{12})$/,
}

const RELATIONSHIP_PATTERNS: Record<string, RegExp> = {
  organization_global_id: GLOBAL_ID_PATTERNS.organizations,
  contact_global_id: GLOBAL_ID_PATTERNS.contacts,
  contact_global_ids: GLOBAL_ID_PATTERNS.contacts,
  owner_contact_global_id: GLOBAL_ID_PATTERNS.contacts,
  product_global_ids: GLOBAL_ID_PATTERNS.products,
  lead_global_id: GLOBAL_ID_PATTERNS.leads,
  opportunity_global_id: GLOBAL_ID_PATTERNS.opportunities,
  meeting_global_id: GLOBAL_ID_PATTERNS.meetings,
  campaign_global_id: GLOBAL_ID_PATTERNS.campaigns,
}

const SPREADSHEET_FORMULA_PATTERN =
  /^[\u0009\u000a\u000d\u0020]*[=+\-@]/
const UNSAFE_CONTROL_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/
const EMAIL_PATTERN =
  /^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i

function text(value: unknown) {
  return String(value ?? '')
}

function clean(value: unknown) {
  return text(value).trim()
}

function importCell(value: unknown) {
  const raw = text(value)
  return raw.startsWith("'") && SPREADSHEET_FORMULA_PATTERN.test(raw.slice(1))
    ? raw.slice(1)
    : raw
}

function isHardenedFormulaCell(value: unknown) {
  const raw = text(value)
  return raw.startsWith("'")
    && SPREADSHEET_FORMULA_PATTERN.test(raw.slice(1))
}

function rowError(
  rowNumber: number,
  column: string,
  code: string,
  message: string,
): CrmTransferRowError {
  return { rowNumber, column, code, message }
}

function booleanField(
  value: string,
  rowNumber: number,
  column: string,
  errors: CrmTransferRowError[],
  fallback = false,
) {
  const normalized = clean(value).toLowerCase()
  if (!normalized) return fallback
  if (['true', 'yes', '1'].includes(normalized)) return true
  if (['false', 'no', '0'].includes(normalized)) return false
  errors.push(rowError(
    rowNumber,
    column,
    'CRM_CSV_BOOLEAN_INVALID',
    'Use yes or no for this field',
  ))
  return fallback
}

function numberField(
  value: string,
  rowNumber: number,
  column: string,
  errors: CrmTransferRowError[],
  options: { min?: number; max?: number; decimals?: number } = {},
) {
  const normalized = clean(value)
  if (!normalized) return 0
  if (!/^\d+(?:\.\d+)?$/.test(normalized)) {
    errors.push(rowError(
      rowNumber,
      column,
      'CRM_CSV_NUMBER_INVALID',
      'Use a non-negative number without separators',
    ))
    return 0
  }
  const decimalPlaces = normalized.split('.')[1]?.length || 0
  if (
    options.decimals !== undefined
    && decimalPlaces > options.decimals
  ) {
    errors.push(rowError(
      rowNumber,
      column,
      'CRM_CSV_NUMBER_PRECISION_INVALID',
      `Use no more than ${options.decimals} decimal places`,
    ))
  }
  const parsed = Number(normalized)
  if (
    !Number.isFinite(parsed)
    || parsed < (options.min ?? 0)
    || parsed > (options.max ?? Number.MAX_SAFE_INTEGER)
  ) {
    errors.push(rowError(
      rowNumber,
      column,
      'CRM_CSV_NUMBER_RANGE_INVALID',
      'The number is outside the supported range',
    ))
    return 0
  }
  return parsed
}

function dateField(
  value: string,
  rowNumber: number,
  column: string,
  errors: CrmTransferRowError[],
) {
  const normalized = clean(value)
  if (!normalized) return null
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    errors.push(rowError(
      rowNumber,
      column,
      'CRM_CSV_DATE_INVALID',
      'Use an ISO date in YYYY-MM-DD format',
    ))
    return null
  }
  const parsed = new Date(`${normalized}T00:00:00.000Z`)
  if (
    Number.isNaN(parsed.getTime())
    || parsed.toISOString().slice(0, 10) !== normalized
  ) {
    errors.push(rowError(
      rowNumber,
      column,
      'CRM_CSV_DATE_INVALID',
      'The date is not valid',
    ))
    return null
  }
  return normalized
}

function emailField(
  value: string,
  rowNumber: number,
  column: string,
  errors: CrmTransferRowError[],
) {
  const normalized = clean(value).toLowerCase()
  if (normalized && !EMAIL_PATTERN.test(normalized)) {
    errors.push(rowError(
      rowNumber,
      column,
      'CRM_CSV_EMAIL_INVALID',
      'Enter a valid email address',
    ))
  }
  return normalized
}

function urlField(
  value: string,
  rowNumber: number,
  column: string,
  errors: CrmTransferRowError[],
) {
  const normalized = clean(value)
  if (normalized && !/^https?:\/\//i.test(normalized)) {
    errors.push(rowError(
      rowNumber,
      column,
      'CRM_CSV_URL_INVALID',
      'URLs must use http or https',
    ))
  }
  return normalized
}

function requiredText(
  values: Record<string, string>,
  column: string,
  rowNumber: number,
  errors: CrmTransferRowError[],
  max = 250,
) {
  const value = clean(values[column])
  if (!value) {
    errors.push(rowError(
      rowNumber,
      column,
      'CRM_CSV_REQUIRED',
      `${column.replaceAll('_', ' ')} is required`,
    ))
  } else if (value.length > max) {
    errors.push(rowError(
      rowNumber,
      column,
      'CRM_CSV_TEXT_TOO_LONG',
      `${column.replaceAll('_', ' ')} is too long`,
    ))
  }
  return value
}

function optionalText(
  values: Record<string, string>,
  column: string,
  rowNumber: number,
  errors: CrmTransferRowError[],
  max = 500,
) {
  const value = clean(values[column])
  if (value.length > max) {
    errors.push(rowError(
      rowNumber,
      column,
      'CRM_CSV_TEXT_TOO_LONG',
      `${column.replaceAll('_', ' ')} is too long`,
    ))
  }
  return value
}

function relationshipField(
  values: Record<string, string>,
  column: string,
  rowNumber: number,
  errors: CrmTransferRowError[],
  required = false,
) {
  const value = clean(values[column]).toLowerCase()
  if (!value && required) {
    errors.push(rowError(
      rowNumber,
      column,
      'CRM_CSV_RELATIONSHIP_REQUIRED',
      `${column.replaceAll('_', ' ')} is required`,
    ))
  } else if (value && !RELATIONSHIP_PATTERNS[column]?.test(value)) {
    errors.push(rowError(
      rowNumber,
      column,
      'CRM_CSV_RELATIONSHIP_INVALID',
      `${column.replaceAll('_', ' ')} must use a valid CRM Global ID`,
    ))
  }
  return value
}

function relationshipListField(
  values: Record<string, string>,
  column: string,
  rowNumber: number,
  errors: CrmTransferRowError[],
) {
  const ids = clean(values[column])
    .split('|')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
  if (ids.some((value) => !RELATIONSHIP_PATTERNS[column]?.test(value))) {
    errors.push(rowError(
      rowNumber,
      column,
      'CRM_CSV_RELATIONSHIP_INVALID',
      `${column.replaceAll('_', ' ')} must contain valid Global IDs separated by |`,
    ))
  }
  if (new Set(ids).size !== ids.length) {
    errors.push(rowError(
      rowNumber,
      column,
      'CRM_CSV_RELATIONSHIP_DUPLICATE',
      `${column.replaceAll('_', ' ')} contains a duplicate Global ID`,
    ))
  }
  return ids
}

function canonicalFields(
  entity: CrmWritableTransferEntity,
  values: Record<string, string>,
  rowNumber: number,
  errors: CrmTransferRowError[],
) {
  if (entity === 'organizations') {
    return {
      name: requiredText(values, 'name', rowNumber, errors),
      accountType: optionalText(values, 'account_type', rowNumber, errors, 100),
      priority: optionalText(values, 'priority', rowNumber, errors, 50),
      accountManager: optionalText(values, 'account_manager', rowNumber, errors, 200),
      website: urlField(values.website, rowNumber, 'website', errors),
      linkedinUrl: urlField(values.linkedin_url, rowNumber, 'linkedin_url', errors),
      phone: optionalText(values, 'phone', rowNumber, errors, 100),
      email: emailField(values.email, rowNumber, 'email', errors),
      emailOptOut: booleanField(values.email_opt_out, rowNumber, 'email_opt_out', errors),
      address: optionalText(values, 'address', rowNumber, errors),
      city: optionalText(values, 'city', rowNumber, errors, 150),
      state: optionalText(values, 'state', rowNumber, errors, 150),
      postalCode: optionalText(values, 'postal_code', rowNumber, errors, 50),
      country: optionalText(values, 'country', rowNumber, errors, 100),
      description: optionalText(values, 'description', rowNumber, errors, 10_000),
    }
  }
  if (entity === 'contacts') {
    const fullName = requiredText(values, 'full_name', rowNumber, errors)
    return {
      organizationGlobalId: relationshipField(
        values,
        'organization_global_id',
        rowNumber,
        errors,
        true,
      ),
      fullName,
      firstName: optionalText(values, 'first_name', rowNumber, errors, 100),
      lastName: optionalText(values, 'last_name', rowNumber, errors, 150),
      priority: optionalText(values, 'priority', rowNumber, errors, 50),
      contactType: optionalText(values, 'contact_type', rowNumber, errors, 100),
      accountManager: optionalText(values, 'account_manager', rowNumber, errors, 200),
      jobTitle: optionalText(values, 'job_title', rowNumber, errors, 250),
      email: emailField(values.email, rowNumber, 'email', errors),
      linkedinUrl: urlField(values.linkedin_url, rowNumber, 'linkedin_url', errors),
      phoneWork: optionalText(values, 'phone_work', rowNumber, errors, 100),
      phoneMobile: optionalText(values, 'phone_mobile', rowNumber, errors, 100),
      address: optionalText(values, 'address', rowNumber, errors),
      city: optionalText(values, 'city', rowNumber, errors, 150),
      state: optionalText(values, 'state', rowNumber, errors, 150),
      postalCode: optionalText(values, 'postal_code', rowNumber, errors, 50),
      country: optionalText(values, 'country', rowNumber, errors, 100),
      description: optionalText(values, 'description', rowNumber, errors, 10_000),
      emailOptOut: booleanField(values.email_opt_out, rowNumber, 'email_opt_out', errors),
    }
  }
  if (entity === 'products') {
    const currency = clean(values.currency).toUpperCase()
    if (!isIso4217CurrencyCode(currency)) {
      errors.push(rowError(
        rowNumber,
        'currency',
        'CRM_CSV_CURRENCY_INVALID',
        'Currency must be a supported ISO 4217 code',
      ))
    }
    const sku = optionalText(values, 'sku', rowNumber, errors, 25)
    return {
      name: requiredText(values, 'name', rowNumber, errors),
      sku,
      productType: optionalText(values, 'product_type', rowNumber, errors, 100) || 'Good',
      category: optionalText(values, 'category', rowNumber, errors, 100),
      status: optionalText(values, 'status', rowNumber, errors, 100) || 'Active',
      price: numberField(values.price, rowNumber, 'price', errors, { decimals: 6 }),
      cost: numberField(values.cost, rowNumber, 'cost', errors, { decimals: 6 }),
      currency,
      url: urlField(values.url, rowNumber, 'url', errors),
      description: optionalText(values, 'description', rowNumber, errors, 10_000),
      active: booleanField(values.active, rowNumber, 'active', errors, true),
    }
  }
  if (entity === 'leads') {
    const fullName = requiredText(values, 'full_name', rowNumber, errors)
    return {
      organizationGlobalId: relationshipField(
        values,
        'organization_global_id',
        rowNumber,
        errors,
      ),
      fullName,
      firstName: optionalText(values, 'first_name', rowNumber, errors, 100),
      lastName: optionalText(values, 'last_name', rowNumber, errors, 150),
      companyName: optionalText(values, 'company_name', rowNumber, errors, 250),
      jobTitle: optionalText(values, 'job_title', rowNumber, errors, 250),
      email: emailField(values.email, rowNumber, 'email', errors),
      phoneWork: optionalText(values, 'phone_work', rowNumber, errors, 100),
      phoneMobile: optionalText(values, 'phone_mobile', rowNumber, errors, 100),
      status: optionalText(values, 'status', rowNumber, errors, 100),
      source: optionalText(values, 'source', rowNumber, errors, 150),
      assignedTo: optionalText(values, 'assigned_to', rowNumber, errors, 200),
      description: optionalText(values, 'description', rowNumber, errors, 10_000),
      emailOptOut: booleanField(values.email_opt_out, rowNumber, 'email_opt_out', errors),
    }
  }
  return {
    organizationGlobalId: relationshipField(
      values,
      'organization_global_id',
      rowNumber,
      errors,
      true,
    ),
    contactGlobalIds: relationshipListField(
      values,
      'contact_global_ids',
      rowNumber,
      errors,
    ),
    ownerContactGlobalId: relationshipField(
      values,
      'owner_contact_global_id',
      rowNumber,
      errors,
    ),
    productGlobalIds: relationshipListField(
      values,
      'product_global_ids',
      rowNumber,
      errors,
    ),
    name: requiredText(values, 'name', rowNumber, errors),
    priority: optionalText(values, 'priority', rowNumber, errors, 50),
    owner: optionalText(values, 'owner', rowNumber, errors, 200),
    status: optionalText(values, 'status', rowNumber, errors, 100),
    stage: optionalText(values, 'stage', rowNumber, errors, 100),
    lossReason: optionalText(values, 'loss_reason', rowNumber, errors, 250),
    source: optionalText(values, 'source', rowNumber, errors, 150),
    value: numberField(values.value, rowNumber, 'value', errors, { decimals: 2 }),
    probability: numberField(values.probability, rowNumber, 'probability', errors, {
      min: 0,
      max: 100,
      decimals: 2,
    }),
    expectedClose: dateField(
      values.expected_close,
      rowNumber,
      'expected_close',
      errors,
    ),
    notes: optionalText(values, 'notes', rowNumber, errors, 10_000),
  }
}

export function isCrmWritableTransferEntity(
  value: unknown,
): value is CrmWritableTransferEntity {
  return CRM_WRITABLE_TRANSFER_ENTITIES.includes(
    String(value) as CrmWritableTransferEntity,
  )
}

export function isCrmTransferEntity(
  value: unknown,
): value is CrmTransferEntity {
  const normalized = String(value)
  return isCrmWritableTransferEntity(normalized)
    || CRM_EXPORT_ONLY_TRANSFER_ENTITIES.includes(
      normalized as CrmExportOnlyTransferEntity,
    )
}

export function crmDataTransferHeaders(entity: CrmTransferEntity) {
  return CRM_DATA_TRANSFER_HEADERS[entity]
}

export function crmDataTransferGlobalIdPattern(entity: CrmTransferEntity) {
  return GLOBAL_ID_PATTERNS[entity]
}

export function hardenCrmCsvCell(value: unknown) {
  const raw = text(value)
  return SPREADSHEET_FORMULA_PATTERN.test(raw) ? `'${raw}` : raw
}

function csvCell(value: unknown) {
  return `"${hardenCrmCsvCell(value).replace(/"/g, '""')}"`
}

function renderCrmDataTransferCsv(input: {
  entity: CrmTransferEntity
  rows: readonly Record<string, unknown>[]
}) {
  const headers = crmDataTransferHeaders(input.entity)
  return [
    headers,
    ...input.rows.map((row) => headers.map((header) => row[header] ?? '')),
  ]
    .map((row) => row.map(csvCell).join(','))
    .join('\r\n')
    .concat('\r\n')
}

function csvByteLength(csv: string) {
  return new TextEncoder().encode(csv).byteLength
}

export function buildCrmDataTransferCsv(input: {
  entity: CrmTransferEntity
  rows: readonly Record<string, unknown>[]
}) {
  if (input.rows.length > CRM_DATA_TRANSFER_MAX_ROWS) {
    throw new CrmDataTransferCsvError(
      'CRM_CSV_ROW_LIMIT_EXCEEDED',
      `CRM CSV exports are limited to ${CRM_DATA_TRANSFER_MAX_ROWS} records`,
    )
  }
  const csv = renderCrmDataTransferCsv(input)
  if (csvByteLength(csv) > CRM_DATA_TRANSFER_MAX_BYTES) {
    throw new CrmDataTransferCsvError(
      'CRM_CSV_BYTE_LIMIT_EXCEEDED',
      'CRM CSV exports are limited to 1 MB',
    )
  }
  return csv
}

export function buildCrmDataTransferCsvSegments(input: {
  entity: CrmTransferEntity
  rows: readonly Record<string, unknown>[]
}) {
  const headers = crmDataTransferHeaders(input.entity)
  const headerCsv = headers.map(csvCell).join(',').concat('\r\n')
  const headerBytes = csvByteLength(headerCsv)
  if (input.rows.length === 0) return [headerCsv]
  const segments: string[] = []
  let pendingLines: string[] = []
  let pendingBytes = headerBytes
  for (const row of input.rows) {
    const line = headers
      .map((header) => csvCell(row[header] ?? ''))
      .join(',')
      .concat('\r\n')
    const lineBytes = csvByteLength(line)
    if (headerBytes + lineBytes > CRM_DATA_TRANSFER_MAX_BYTES) {
      throw new CrmDataTransferCsvError(
        'CRM_CSV_RECORD_TOO_LARGE',
        'One CRM record is too large to export safely',
      )
    }
    if (
      pendingLines.length >= CRM_DATA_TRANSFER_MAX_ROWS
      || pendingBytes + lineBytes > CRM_DATA_TRANSFER_MAX_BYTES
    ) {
      segments.push(headerCsv.concat(...pendingLines))
      pendingLines = []
      pendingBytes = headerBytes
    }
    pendingLines.push(line)
    pendingBytes += lineBytes
  }
  if (pendingLines.length > 0) {
    segments.push(headerCsv.concat(...pendingLines))
  }
  return segments
}

export function parseCrmDataTransferCsv(input: {
  entity: CrmWritableTransferEntity
  csv: string
}): ParsedCrmTransferRow[] {
  if (
    new TextEncoder().encode(input.csv).byteLength
    > CRM_DATA_TRANSFER_MAX_BYTES
  ) {
    throw new CrmDataTransferCsvError(
      'CRM_CSV_BYTE_LIMIT_EXCEEDED',
      'CRM CSV imports are limited to 1 MB',
    )
  }
  let rows: string[][]
  try {
    rows = parse(input.csv, {
      bom: true,
      relax_column_count: true,
      skip_empty_lines: true,
    }) as string[][]
  } catch {
    throw new CrmDataTransferCsvError(
      'CRM_CSV_SYNTAX_INVALID',
      'The CSV is malformed or contains an unclosed quoted value',
    )
  }
  if (rows.length === 0) {
    throw new CrmDataTransferCsvError(
      'CRM_CSV_EMPTY',
      'The CSV does not contain a header row',
    )
  }
  const expectedHeaders = crmDataTransferHeaders(input.entity)
  const actualHeaders = rows[0].map((header) => clean(header))
  if (
    actualHeaders.length !== expectedHeaders.length
    || expectedHeaders.some((header, index) => header !== actualHeaders[index])
  ) {
    throw new CrmDataTransferCsvError(
      'CRM_CSV_HEADERS_INVALID',
      `Use the exact ${input.entity} template headers in their original order`,
    )
  }
  const dataRows = rows.slice(1)
  if (dataRows.length > CRM_DATA_TRANSFER_MAX_ROWS) {
    throw new CrmDataTransferCsvError(
      'CRM_CSV_ROW_LIMIT_EXCEEDED',
      `CRM CSV imports are limited to ${CRM_DATA_TRANSFER_MAX_ROWS} records`,
    )
  }
  return dataRows.map((row, index) => {
    const rowNumber = index + 2
    const errors: CrmTransferRowError[] = []
    if (row.length !== expectedHeaders.length) {
      errors.push(rowError(
        rowNumber,
        '',
        'CRM_CSV_COLUMN_COUNT_INVALID',
        `Expected ${expectedHeaders.length} columns`,
      ))
    }
    const rawValues = Object.fromEntries(expectedHeaders.map((
      header,
      columnIndex,
    ) => [header, row[columnIndex] ?? ''])) as Record<string, string>
    const values = Object.fromEntries(expectedHeaders.map((
      header,
    ) => [header, importCell(rawValues[header])])) as Record<string, string>
    for (const [column, value] of Object.entries(values)) {
      if (UNSAFE_CONTROL_PATTERN.test(value)) {
        errors.push(rowError(
          rowNumber,
          column,
          'CRM_CSV_CONTROL_CHARACTER_INVALID',
          'The value contains an unsupported control character',
        ))
      }
      if (
        SPREADSHEET_FORMULA_PATTERN.test(value)
        && !isHardenedFormulaCell(rawValues[column])
      ) {
        errors.push(rowError(
          rowNumber,
          column,
          'CRM_CSV_FORMULA_INVALID',
          'Spreadsheet formulas are not allowed in CRM imports',
        ))
      }
    }
    if (clean(values.schema_version) !== CRM_DATA_TRANSFER_SCHEMA_VERSION) {
      errors.push(rowError(
        rowNumber,
        'schema_version',
        'CRM_CSV_SCHEMA_VERSION_INVALID',
        `Schema version must be ${CRM_DATA_TRANSFER_SCHEMA_VERSION}`,
      ))
    }
    const globalId = clean(values.global_id).toLowerCase()
    const recordVersion = clean(values.record_version)
    if (globalId && !crmDataTransferGlobalIdPattern(input.entity).test(globalId)) {
      errors.push(rowError(
        rowNumber,
        'global_id',
        'CRM_CSV_GLOBAL_ID_INVALID',
        `Global ID does not identify a ${input.entity} record`,
      ))
    }
    if (globalId && !recordVersion) {
      errors.push(rowError(
        rowNumber,
        'record_version',
        'CRM_CSV_RECORD_VERSION_REQUIRED',
        'Existing records require the record version from a fresh export',
      ))
    }
    if (!globalId && recordVersion) {
      errors.push(rowError(
        rowNumber,
        'record_version',
        'CRM_CSV_RECORD_VERSION_UNEXPECTED',
        'New records must leave record version blank',
      ))
    }
    const fields = canonicalFields(input.entity, values, rowNumber, errors)
    return { rowNumber, globalId, recordVersion, values, fields, errors }
  })
}

export function crmDataTransferFieldDiffs(
  current: Record<string, string>,
  proposed: Record<string, string>,
  entity: CrmTransferEntity,
) {
  return crmDataTransferHeaders(entity)
    .filter((field) => !COMMON_HEADERS.includes(field as typeof COMMON_HEADERS[number]))
    .flatMap((field): CrmTransferFieldDiff[] => (
      clean(current[field]) === clean(proposed[field])
        ? []
        : [{
            field,
            before: current[field] ?? '',
            after: proposed[field] ?? '',
          }]
    ))
}

export function crmDataTransferNaturalKey(
  entity: CrmWritableTransferEntity,
  fields: Record<string, unknown>,
) {
  const normalized = (value: unknown) => clean(value)
    .toLowerCase()
    .replace(/\s+/g, ' ')
  if (entity === 'organizations') return normalized(fields.name)
  if (entity === 'contacts') {
    const email = normalized(fields.email)
    return email
      ? `email:${email}`
      : `name:${normalized(fields.fullName)}|org:${normalized(fields.organizationGlobalId)}`
  }
  if (entity === 'products') {
    const sku = normalized(fields.sku)
    return sku ? `sku:${sku}` : `name:${normalized(fields.name)}`
  }
  if (entity === 'leads') {
    const email = normalized(fields.email)
    return email
      ? `email:${email}`
      : `name:${normalized(fields.fullName)}|company:${normalized(fields.companyName)}`
  }
  return `name:${normalized(fields.name)}|org:${normalized(fields.organizationGlobalId)}`
}

export function crmProductUniquenessKeys(fields: Record<string, unknown>) {
  return {
    name: clean(fields.name).toLowerCase(),
    sku: clean(fields.sku).toLowerCase(),
  }
}

export function crmProductUniquenessConflicts(input: {
  candidate: CrmProductUniquenessCandidate
  others: readonly CrmProductUniquenessCandidate[]
}): CrmProductUniquenessConflict[] {
  const candidateKeys = crmProductUniquenessKeys(input.candidate.fields)
  const conflicts: CrmProductUniquenessConflict[] = []
  for (const other of input.others) {
    if (other.identity === input.candidate.identity) continue
    const otherKeys = crmProductUniquenessKeys(other.fields)
    if (candidateKeys.name && candidateKeys.name === otherKeys.name) {
      conflicts.push({
        field: 'name',
        conflictingIdentity: other.identity,
      })
    }
    if (
      candidateKeys.sku
      && candidateKeys.sku === otherKeys.sku
    ) {
      conflicts.push({
        field: 'sku',
        conflictingIdentity: other.identity,
      })
    }
  }
  return conflicts
}
