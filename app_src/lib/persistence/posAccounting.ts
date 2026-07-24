import crypto from 'crypto'
import type { PoolClient } from 'pg'
import { recordAuditEvent } from '@/lib/auditWriter'
import {
  isToastProjectedOrderAccountingActive,
  isToastProjectedPaymentActive,
  summarizeToastProjectedChecks,
  type ToastProjectedCheck,
} from '@/lib/integrations/toastOrderProjection'
import { acquireTransactionAdvisoryLock, query, withTransaction } from '@/lib/persistence/postgres'

export const POS_POSTING_METHODS = [
  'itemized_sales_receipt',
  'summary_sales_receipt',
  'journal_entry',
] as const
export const POS_BREAKOUT_DIMENSIONS = [
  'revenue_center',
  'day_part',
  'dining_option',
  'order_source',
  'payment_type',
  'tax_treatment',
] as const
export const POS_MEMO_MODES = ['pos_date', 'store_date', 'location', 'custom'] as const
export const POS_SOURCE_KINDS = [
  'sales_item',
  'sales_category',
  'discount',
  'tax',
  'service_charge',
  'tender',
  'cash_drawer',
  'card_brand',
  'payout',
  'fee',
  'over_short',
  'payment_exception',
  'revenue_center',
  'day_part',
  'dining_option',
  'order_source',
  'payment_type',
  'tax_treatment',
] as const
export const POS_TARGET_TYPES = [
  'item',
  'account',
  'tax_code',
  'class',
  'department',
  'location',
  'customer',
  'vendor',
] as const
export const POS_OPEN_CHECK_POLICIES = ['hold', 'exclude', 'include'] as const
export const POS_BATCH_HOLD_POLICIES = ['hold_until_closed', 'hold_until_settled', 'do_not_hold'] as const
export const POS_ACCOUNTING_SCOPES = ['organization_default', 'location_override'] as const
export const POS_ACCOUNTING_POSTING_GATE_VERSION = 2

export type PosPostingMethod = typeof POS_POSTING_METHODS[number]
export type PosBreakoutDimension = typeof POS_BREAKOUT_DIMENSIONS[number]
export type PosMemoMode = typeof POS_MEMO_MODES[number]
export type PosSourceKind = typeof POS_SOURCE_KINDS[number]
export type PosTargetType = typeof POS_TARGET_TYPES[number]
export type PosOpenCheckPolicy = typeof POS_OPEN_CHECK_POLICIES[number]
export type PosBatchHoldPolicy = typeof POS_BATCH_HOLD_POLICIES[number]
export type PosAccountingScope = typeof POS_ACCOUNTING_SCOPES[number]
export type PosAccountingCommandType = 'reload_sales' | 'regenerate_accounting'
export type PosAccountingCommandStatus = 'queued' | 'running' | 'succeeded' | 'failed'
export type PosAccountingGenerationReason = 'automatic_sync' | PosAccountingCommandType

export class PosAccountingRequestError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
  ) {
    super(message)
  }
}

export type PosAccountingProfile = {
  exists: boolean
  id: string | null
  scope: PosAccountingScope
  profileRevision: number
  schemaVersion: number
  effectiveFrom: string | null
  effectiveTo: string | null
  quickBooksBindingStatus: 'unbound' | 'verified'
  quickBooksConnectionFingerprint: string | null
  quickBooksCompanyName: string | null
  quickBooksConnectionVerifiedAt: string | null
  quickBooksCatalogSyncedAt: string | null
  postingMethod: PosPostingMethod
  quickBooksClassId: string | null
  quickBooksClassName: string | null
  quickBooksDepartmentId: string | null
  quickBooksDepartmentName: string | null
  quickBooksCustomerId: string | null
  quickBooksCustomerName: string | null
  quickBooksClearingAccountId: string | null
  quickBooksClearingAccountName: string | null
  trackSalesTax: boolean
  breakoutDimensions: PosBreakoutDimension[]
  memoMode: PosMemoMode
  customMemo: string | null
  customTransactionNumber: boolean
  transactionNumberSuffix: string | null
  suppressZeroOverShort: boolean
  autoPayoutTips: boolean
  depositChecksWithCash: boolean
  openCheckPolicy: PosOpenCheckPolicy
  batchHoldPolicy: PosBatchHoldPolicy
  emailNotificationsEnabled: boolean
  emailNotificationsEnabledAt: string | null
  createdBy: string | null
  createdAt: string | null
}

export type PosAccountingMapping = {
  id: string
  scope: PosAccountingScope
  sourceKind: PosSourceKind
  sourceId: string
  sourceName: string
  targetType: PosTargetType
  targetId: string
  targetName: string
  active: boolean
  mappingRevision: number
  effectiveFrom: string
  effectiveTo: string | null
  validationStatus: 'unvalidated' | 'valid' | 'invalid' | 'stale' | 'missing_source' | 'missing_target'
  validationReason: string | null
  sourceCatalogRevision: number
  targetCatalogRevision: number
  lastValidatedAt: string | null
  createdBy: string | null
  createdAt: string
}

type JsonRecord = Record<string, unknown>
type TimestampValue = string | Date

type ProfileRow = {
  id: string
  restaurant_guid: string | null
  profile_revision: number
  schema_version: number
  effective_from: TimestampValue
  effective_to: TimestampValue | null
  quickbooks_binding_status: 'unbound' | 'verified'
  quickbooks_connection_fingerprint: string | null
  quickbooks_company_name: string | null
  quickbooks_connection_verified_at: TimestampValue | null
  quickbooks_catalog_synced_at: TimestampValue | null
  posting_method: PosPostingMethod
  quickbooks_class_id: string | null
  quickbooks_class_name: string | null
  quickbooks_department_id: string | null
  quickbooks_department_name: string | null
  quickbooks_customer_id: string | null
  quickbooks_customer_name: string | null
  quickbooks_clearing_account_id: string | null
  quickbooks_clearing_account_name: string | null
  track_sales_tax: boolean
  breakout_dimensions: PosBreakoutDimension[]
  memo_mode: PosMemoMode
  custom_memo: string | null
  custom_transaction_number: boolean
  transaction_number_suffix: string | null
  suppress_zero_over_short: boolean
  auto_payout_tips: boolean
  deposit_checks_with_cash: boolean
  open_check_policy: PosOpenCheckPolicy
  batch_hold_policy: PosBatchHoldPolicy
  email_notifications_enabled: boolean
  email_notifications_enabled_at: TimestampValue | null
  created_by: string | null
  created_at: TimestampValue
}

type MappingRow = {
  id: string
  restaurant_guid: string | null
  source_kind: PosSourceKind
  source_id: string
  source_name: string
  target_type: PosTargetType
  target_id: string
  target_name: string
  active: boolean
  mapping_revision: number
  effective_from: TimestampValue
  effective_to: TimestampValue | null
  validation_status: PosAccountingMapping['validationStatus']
  validation_reason: string | null
  source_catalog_revision: string | number
  target_catalog_revision: string | number
  last_validated_at: TimestampValue | null
  created_by: string | null
  created_at: TimestampValue
}

type SourceOrderRow = {
  order_guid?: string | null
  display_number?: string | null
  voided?: boolean
  deleted?: boolean
  business_date: TimestampValue
  fulfillment_business_date?: TimestampValue | null
  payment_business_dates?: TimestampValue[] | null
  created_at_source?: TimestampValue | null
  source?: string | null
  dining_option?: string | null
  gross_sales: string | number
  net_sales: string | number
  discounts: string | number
  tax: string | number
  service_charges: string | number
  tips: string | number
  refunds: string | number
  tendered: string | number
  total: string | number
  cash_tender: string | number
  card_tender: string | number
  other_tender: string | number
  details: unknown
  updated_at?: TimestampValue
}

type LocationRow = {
  restaurant_guid: string
  restaurant_name: string
  location_name: string | null
  timezone: string | null
  closeout_hour: number | null
  analytics_access: boolean
  standard_access: boolean
}

type DraftRow = {
  id: string
  status: string
  reconciliation_status: string
  approved_by: string | null
  approved_at: TimestampValue | null
  posted_at: TimestampValue | null
  quickbooks_transaction_id: string | null
  draft_revision: number
  generation_reason: PosAccountingGenerationReason
  generated_by: string | null
  source_revision: number
  supersedes_draft_id: string | null
  is_current: boolean
  last_error: string | null
  created_at: TimestampValue
  updated_at: TimestampValue
}

type CommandRow = {
  id: string
  command_type: PosAccountingCommandType
  status: PosAccountingCommandStatus
  requested_by: string
  expected_sync_kinds: string[]
  result_draft_id: string | null
  result_draft_revision: number | null
  last_error: string | null
  started_at: TimestampValue | null
  completed_at: TimestampValue | null
  created_at: TimestampValue
  updated_at: TimestampValue
}

const IDENTIFIER_PATTERN = /^[!-~]+$/
const SUFFIX_PATTERN = /^[A-Za-z0-9._-]+$/
const TARGETS_BY_SOURCE: Record<PosSourceKind, readonly PosTargetType[]> = {
  sales_item: ['item'],
  sales_category: ['item'],
  discount: ['item'],
  tax: ['tax_code'],
  service_charge: ['account'],
  tender: ['account'],
  cash_drawer: ['account'],
  card_brand: ['account'],
  payout: ['account'],
  fee: ['account'],
  over_short: ['account'],
  payment_exception: ['account'],
  revenue_center: ['class', 'department', 'location', 'customer', 'vendor'],
  day_part: ['class', 'department', 'location', 'customer', 'vendor'],
  dining_option: ['class', 'department', 'location', 'customer', 'vendor'],
  order_source: ['class', 'department', 'location', 'customer', 'vendor'],
  payment_type: ['class', 'department', 'location', 'customer', 'vendor'],
  tax_treatment: ['class', 'department', 'location', 'customer', 'vendor'],
}

function record(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {}
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function draftFromRow(row: DraftRow | undefined) {
  return row ? {
    id: row.id,
    status: row.status,
    reconciliationStatus: row.reconciliation_status,
    approvedBy: row.approved_by,
    approvedAt: iso(row.approved_at),
    postedAt: iso(row.posted_at),
    quickBooksTransactionId: row.quickbooks_transaction_id,
    draftRevision: row.draft_revision,
    generationReason: row.generation_reason,
    generatedBy: row.generated_by,
    sourceRevision: row.source_revision,
    supersedesDraftId: row.supersedes_draft_id,
    current: row.is_current,
    lastError: row.last_error,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  } : null
}

function commandFromRow(row: CommandRow | undefined) {
  return row ? {
    id: row.id,
    commandType: row.command_type,
    status: row.status,
    requestedBy: row.requested_by,
    expectedSyncKinds: row.expected_sync_kinds || [],
    resultDraftId: row.result_draft_id,
    resultDraftRevision: row.result_draft_revision,
    lastError: row.last_error,
    startedAt: iso(row.started_at),
    completedAt: iso(row.completed_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  } : null
}

function money(value: unknown) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.round(parsed * 100) / 100 : 0
}

function iso(value: TimestampValue | null | undefined) {
  return value ? new Date(value).toISOString() : null
}

function dateOnly(value: TimestampValue | null | undefined) {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value || '').slice(0, 10)
}

function normalizedBusinessDate(value: unknown) {
  const candidate = String(value || '').trim()
  const normalized = /^\d{8}$/.test(candidate)
    ? `${candidate.slice(0, 4)}-${candidate.slice(4, 6)}-${candidate.slice(6, 8)}`
    : candidate
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return null
  const parsed = new Date(`${normalized}T00:00:00.000Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === normalized
    ? normalized
    : null
}

function dateList(value: TimestampValue[] | null | undefined) {
  return Array.isArray(value) ? value.map(dateOnly).filter(Boolean) : []
}

const LEGACY_SAFE_TOAST_CLOSEOUT_HOUR = 12

function validIanaTimezone(value: unknown): value is string {
  const candidate = String(value || '').trim()
  if (!candidate) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: candidate }).format(new Date(0))
    return true
  } catch {
    return false
  }
}

function activeToastBusinessDate(value: unknown, timezone: string, closeoutHour: number) {
  const parsed = new Date(String(value || ''))
  if (Number.isNaN(parsed.getTime())) return null
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone || 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(parsed)
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))
    if (!values.year || !values.month || !values.day || values.hour === undefined) return null
    const localDate = `${values.year}-${values.month}-${values.day}`
    if (Number(values.hour) >= closeoutHour) return localDate
    const previous = new Date(`${localDate}T00:00:00.000Z`)
    previous.setUTCDate(previous.getUTCDate() - 1)
    return previous.toISOString().slice(0, 10)
  } catch {
    return null
  }
}

function inferredToastPaymentBusinessDate(value: unknown, timezone: string, closeoutHour: number | null | undefined) {
  if (Number.isInteger(closeoutHour) && Number(closeoutHour) >= 0 && Number(closeoutHour) <= 12) {
    return activeToastBusinessDate(value, timezone, Number(closeoutHour))
  }
  // Without an exact profile, accept an instant only when every valid Toast
  // cutoff (00:00 through 12:00) assigns it to the same business date.
  const earliestCutoffDate = activeToastBusinessDate(value, timezone, 0)
  const latestCutoffDate = activeToastBusinessDate(value, timezone, 12)
  return earliestCutoffDate && earliestCutoffDate === latestCutoffDate
    ? earliestCutoffDate
    : null
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], code: string, label: string): T {
  const candidate = String(value || '').trim() as T
  if (!allowed.includes(candidate)) throw new PosAccountingRequestError(code, `${label} is invalid`)
  return candidate
}

function booleanValue(value: unknown, code: string, label: string) {
  if (typeof value !== 'boolean') throw new PosAccountingRequestError(code, `${label} must be true or false`)
  return value
}

function boundedText(value: unknown, max: number, code: string, label: string) {
  const candidate = String(value || '').trim()
  if (!candidate || candidate.length > max || /[\u0000-\u001f\u007f]/.test(candidate)) {
    throw new PosAccountingRequestError(code, `${label} is invalid`)
  }
  return candidate
}

function identifier(value: unknown, code: string, label: string) {
  const candidate = boundedText(value, 200, code, label)
  if (!IDENTIFIER_PATTERN.test(candidate)) throw new PosAccountingRequestError(code, `${label} is invalid`)
  return candidate
}

function optionalPair(idValue: unknown, nameValue: unknown, code: string, label: string) {
  const hasId = idValue !== null && idValue !== undefined && String(idValue).trim() !== ''
  const hasName = nameValue !== null && nameValue !== undefined && String(nameValue).trim() !== ''
  if (hasId !== hasName) {
    throw new PosAccountingRequestError(code, `${label} id and name must be supplied together`)
  }
  return hasId
    ? {
        id: identifier(idValue, code, `${label} id`),
        name: boundedText(nameValue, 240, code, `${label} name`),
      }
    : { id: null, name: null }
}

export function validatePosAccountingProfile(value: unknown) {
  const input = record(value)
  const postingMethod = enumValue(input.postingMethod, POS_POSTING_METHODS, 'POS_POSTING_METHOD_INVALID', 'Posting method')
  const quickBooksClass = optionalPair(input.quickBooksClassId, input.quickBooksClassName, 'POS_QUICKBOOKS_CLASS_INVALID', 'QuickBooks class')
  const quickBooksDepartment = optionalPair(input.quickBooksDepartmentId, input.quickBooksDepartmentName, 'POS_QUICKBOOKS_DEPARTMENT_INVALID', 'QuickBooks department')
  const quickBooksCustomer = optionalPair(input.quickBooksCustomerId, input.quickBooksCustomerName, 'POS_QUICKBOOKS_CUSTOMER_INVALID', 'QuickBooks customer')
  const quickBooksClearing = optionalPair(
    input.quickBooksClearingAccountId,
    input.quickBooksClearingAccountName,
    'POS_QUICKBOOKS_CLEARING_INVALID',
    'QuickBooks clearing account',
  )
  if (!Array.isArray(input.breakoutDimensions)) {
    throw new PosAccountingRequestError('POS_BREAKOUT_DIMENSIONS_INVALID', 'Breakout dimensions must be a list')
  }
  const breakoutDimensions = input.breakoutDimensions.map((entry) => (
    enumValue(entry, POS_BREAKOUT_DIMENSIONS, 'POS_BREAKOUT_DIMENSIONS_INVALID', 'Breakout dimension')
  ))
  if (new Set(breakoutDimensions).size !== breakoutDimensions.length) {
    throw new PosAccountingRequestError('POS_BREAKOUT_DIMENSIONS_INVALID', 'Breakout dimensions cannot be repeated')
  }
  const memoMode = enumValue(input.memoMode, POS_MEMO_MODES, 'POS_MEMO_MODE_INVALID', 'Memo mode')
  const customMemo = memoMode === 'custom'
    ? boundedText(input.customMemo, 500, 'POS_CUSTOM_MEMO_INVALID', 'Custom memo')
    : null
  const customTransactionNumber = booleanValue(
    input.customTransactionNumber,
    'POS_TRANSACTION_NUMBER_INVALID',
    'Custom transaction number',
  )
  const transactionNumberSuffix = customTransactionNumber
    ? boundedText(input.transactionNumberSuffix, 32, 'POS_TRANSACTION_SUFFIX_INVALID', 'Transaction number suffix')
    : null
  if (transactionNumberSuffix && !SUFFIX_PATTERN.test(transactionNumberSuffix)) {
    throw new PosAccountingRequestError(
      'POS_TRANSACTION_SUFFIX_INVALID',
      'Transaction number suffix may only contain letters, numbers, periods, underscores, and hyphens',
    )
  }
  return {
    postingMethod,
    quickBooksClassId: quickBooksClass.id,
    quickBooksClassName: quickBooksClass.name,
    quickBooksDepartmentId: quickBooksDepartment.id,
    quickBooksDepartmentName: quickBooksDepartment.name,
    quickBooksCustomerId: quickBooksCustomer.id,
    quickBooksCustomerName: quickBooksCustomer.name,
    quickBooksClearingAccountId: quickBooksClearing.id,
    quickBooksClearingAccountName: quickBooksClearing.name,
    trackSalesTax: booleanValue(input.trackSalesTax, 'POS_TRACK_TAX_INVALID', 'Track sales tax'),
    breakoutDimensions,
    memoMode,
    customMemo,
    customTransactionNumber,
    transactionNumberSuffix,
    suppressZeroOverShort: booleanValue(input.suppressZeroOverShort, 'POS_OVER_SHORT_INVALID', 'Suppress zero over/short'),
    autoPayoutTips: booleanValue(input.autoPayoutTips, 'POS_AUTO_PAYOUT_TIPS_INVALID', 'Auto payout tips'),
    depositChecksWithCash: booleanValue(input.depositChecksWithCash, 'POS_DEPOSIT_CHECKS_INVALID', 'Deposit checks with cash'),
    openCheckPolicy: enumValue(input.openCheckPolicy, POS_OPEN_CHECK_POLICIES, 'POS_OPEN_CHECK_POLICY_INVALID', 'Open check policy'),
    batchHoldPolicy: enumValue(input.batchHoldPolicy, POS_BATCH_HOLD_POLICIES, 'POS_BATCH_HOLD_POLICY_INVALID', 'Batch hold policy'),
    emailNotificationsEnabled: booleanValue(
      input.emailNotificationsEnabled,
      'POS_EMAIL_NOTIFICATIONS_INVALID',
      'Email issue alerts',
    ),
  }
}

export function validatePosAccountingMappings(value: unknown) {
  if (!Array.isArray(value) || value.length > 250) {
    throw new PosAccountingRequestError('POS_MAPPINGS_INVALID', 'Mappings must be a list of 250 entries or fewer')
  }
  const seen = new Set<string>()
  return value.map((entry) => {
    const input = record(entry)
    const sourceKind = enumValue(input.sourceKind, POS_SOURCE_KINDS, 'POS_MAPPING_SOURCE_KIND_INVALID', 'Mapping source kind')
    const targetType = enumValue(input.targetType, POS_TARGET_TYPES, 'POS_MAPPING_TARGET_TYPE_INVALID', 'Mapping target type')
    if (!TARGETS_BY_SOURCE[sourceKind].includes(targetType)) {
      throw new PosAccountingRequestError(
        'POS_MAPPING_TARGET_TYPE_INVALID',
        `${sourceKind} cannot map to ${targetType}`,
      )
    }
    const sourceId = identifier(input.sourceId, 'POS_MAPPING_SOURCE_ID_INVALID', 'Mapping source id')
    const key = `${sourceKind}:${sourceId}`
    if (seen.has(key)) throw new PosAccountingRequestError('POS_MAPPING_DUPLICATE', 'A source can only be mapped once per request')
    seen.add(key)
    return {
      sourceKind,
      sourceId,
      sourceName: boundedText(input.sourceName, 240, 'POS_MAPPING_SOURCE_NAME_INVALID', 'Mapping source name'),
      targetType,
      targetId: identifier(input.targetId, 'POS_MAPPING_TARGET_ID_INVALID', 'Mapping target id'),
      targetName: boundedText(input.targetName, 240, 'POS_MAPPING_TARGET_NAME_INVALID', 'Mapping target name'),
      active: booleanValue(input.active, 'POS_MAPPING_ACTIVE_INVALID', 'Mapping active state'),
    }
  })
}

function defaultProfile(): PosAccountingProfile {
  return {
    exists: false,
    id: null,
    scope: 'organization_default',
    profileRevision: 0,
    schemaVersion: 1,
    effectiveFrom: null,
    effectiveTo: null,
    quickBooksBindingStatus: 'unbound',
    quickBooksConnectionFingerprint: null,
    quickBooksCompanyName: null,
    quickBooksConnectionVerifiedAt: null,
    quickBooksCatalogSyncedAt: null,
    postingMethod: 'itemized_sales_receipt',
    quickBooksClassId: null,
    quickBooksClassName: null,
    quickBooksDepartmentId: null,
    quickBooksDepartmentName: null,
    quickBooksCustomerId: null,
    quickBooksCustomerName: null,
    quickBooksClearingAccountId: null,
    quickBooksClearingAccountName: null,
    trackSalesTax: true,
    breakoutDimensions: [],
    memoMode: 'pos_date',
    customMemo: null,
    customTransactionNumber: false,
    transactionNumberSuffix: null,
    suppressZeroOverShort: false,
    autoPayoutTips: false,
    depositChecksWithCash: false,
    openCheckPolicy: 'hold',
    batchHoldPolicy: 'hold_until_closed',
    emailNotificationsEnabled: false,
    emailNotificationsEnabledAt: null,
    createdBy: null,
    createdAt: null,
  }
}

function profileFromRow(row: ProfileRow | undefined): PosAccountingProfile {
  if (!row) return defaultProfile()
  return {
    exists: true,
    id: row.id,
    scope: row.restaurant_guid ? 'location_override' : 'organization_default',
    profileRevision: row.profile_revision,
    schemaVersion: row.schema_version,
    effectiveFrom: iso(row.effective_from),
    effectiveTo: iso(row.effective_to),
    quickBooksBindingStatus: row.quickbooks_binding_status,
    quickBooksConnectionFingerprint: row.quickbooks_connection_fingerprint,
    quickBooksCompanyName: row.quickbooks_company_name,
    quickBooksConnectionVerifiedAt: iso(row.quickbooks_connection_verified_at),
    quickBooksCatalogSyncedAt: iso(row.quickbooks_catalog_synced_at),
    postingMethod: row.posting_method,
    quickBooksClassId: row.quickbooks_class_id,
    quickBooksClassName: row.quickbooks_class_name,
    quickBooksDepartmentId: row.quickbooks_department_id,
    quickBooksDepartmentName: row.quickbooks_department_name,
    quickBooksCustomerId: row.quickbooks_customer_id,
    quickBooksCustomerName: row.quickbooks_customer_name,
    quickBooksClearingAccountId: row.quickbooks_clearing_account_id,
    quickBooksClearingAccountName: row.quickbooks_clearing_account_name,
    trackSalesTax: row.track_sales_tax,
    breakoutDimensions: row.breakout_dimensions || [],
    memoMode: row.memo_mode,
    customMemo: row.custom_memo,
    customTransactionNumber: row.custom_transaction_number,
    transactionNumberSuffix: row.transaction_number_suffix,
    suppressZeroOverShort: row.suppress_zero_over_short,
    autoPayoutTips: row.auto_payout_tips,
    depositChecksWithCash: row.deposit_checks_with_cash,
    openCheckPolicy: row.open_check_policy,
    batchHoldPolicy: row.batch_hold_policy,
    emailNotificationsEnabled: row.email_notifications_enabled,
    emailNotificationsEnabledAt: iso(row.email_notifications_enabled_at),
    createdBy: row.created_by,
    createdAt: iso(row.created_at),
  }
}

function mappingFromRow(row: MappingRow): PosAccountingMapping {
  return {
    id: row.id,
    scope: row.restaurant_guid ? 'location_override' : 'organization_default',
    sourceKind: row.source_kind,
    sourceId: row.source_id,
    sourceName: row.source_name,
    targetType: row.target_type,
    targetId: row.target_id,
    targetName: row.target_name,
    active: row.active,
    mappingRevision: row.mapping_revision,
    effectiveFrom: iso(row.effective_from) || new Date(0).toISOString(),
    effectiveTo: iso(row.effective_to),
    validationStatus: row.validation_status,
    validationReason: row.validation_reason,
    sourceCatalogRevision: Number(row.source_catalog_revision || 0),
    targetCatalogRevision: Number(row.target_catalog_revision || 0),
    lastValidatedAt: iso(row.last_validated_at),
    createdBy: row.created_by,
    createdAt: iso(row.created_at) || new Date(0).toISOString(),
  }
}

export function posQuickBooksConnectionFingerprint(input: {
  connectionId: string
  companyName: string
  country: string | null
}) {
  return crypto.createHash('sha256')
    .update(['pos-accounting-binding-v1', input.connectionId, input.companyName, input.country || ''].join('\u0000'))
    .digest('hex')
}

function profileForQuickBooksConnection(profile: PosAccountingProfile, connectionFingerprint: string | null) {
  if (
    profile.quickBooksBindingStatus !== 'verified'
    || !connectionFingerprint
    || profile.quickBooksConnectionFingerprint !== connectionFingerprint
  ) {
    return {
      ...profile,
      quickBooksBindingStatus: 'unbound' as const,
      quickBooksConnectionFingerprint: null,
      quickBooksCompanyName: null,
      quickBooksConnectionVerifiedAt: null,
      quickBooksCatalogSyncedAt: null,
      quickBooksClassId: null,
      quickBooksClassName: null,
      quickBooksDepartmentId: null,
      quickBooksDepartmentName: null,
      quickBooksCustomerId: null,
      quickBooksCustomerName: null,
      quickBooksClearingAccountId: null,
      quickBooksClearingAccountName: null,
    }
  }
  return profile
}

function derivedSourceId(kind: PosSourceKind, name: string) {
  return `derived:${crypto.createHash('sha256').update(`${kind}\u0000${name}`).digest('hex').slice(0, 32)}`
}

function sourceIdentity(kind: PosSourceKind, providerId: unknown, name: string) {
  const candidate = String(providerId || '').trim()
  return candidate && candidate.length <= 200 && IDENTIFIER_PATTERN.test(candidate)
    ? candidate
    : derivedSourceId(kind, name)
}

function paymentLifecycleEvidenceKey(kind: 'order' | 'check' | 'payment', value: unknown) {
  return `link:${crypto.createHash('sha256')
    .update(['pos-payment-lifecycle-v1', kind, String(value || '')].join('\u0000'))
    .digest('hex')
    .slice(0, 32)}`
}

export type PosAccountingCatalogEntry = {
  sourceKind: PosSourceKind
  sourceId: string
  sourceName: string
  occurrenceCount: number
  quantity: number
  amount: number
  firstSeenDate: string
  lastSeenDate: string
  catalogOrigin: 'observed' | 'menu' | 'observed_and_menu'
  sku: string | null
  unitPrice: number | null
}

export type StableToastMenuCatalogItem = {
  itemGuid: string
  providerItemId: string
  name: string
  plu: string | null
  price: number | null
}

type QuickBooksCatalogItem = {
  quickbooks_item_id: string
  name: string
  fully_qualified_name: string
  item_type: string
  sku: string | null
  taxable: boolean
}

function safeSourceName(value: unknown, fallback: string) {
  const candidate = String(value || '').trim().replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 240)
  return candidate || fallback
}

function isOpenCheck(value: unknown) {
  const check = record(value)
  const status = String(check.paymentStatus || '').toLowerCase()
  return !check.paidAt && !check.closedAt && !/(paid|closed|complete)/.test(status)
}

function isFinalizedCheck(value: unknown) {
  const check = record(value)
  const closedAt = new Date(String(check.closedAt || ''))
  return String(check.paymentStatus || '').trim().toLowerCase() === 'closed'
    && !Number.isNaN(closedAt.getTime())
}

function orderWithChecks(order: SourceOrderRow, checks: JsonRecord[]): SourceOrderRow {
  const summary = summarizeToastProjectedChecks(checks as unknown as ToastProjectedCheck[])
  return {
    ...order,
    gross_sales: summary.grossSales,
    net_sales: summary.netSales,
    discounts: summary.discounts,
    tax: summary.tax,
    service_charges: summary.serviceCharges,
    tips: summary.tips,
    refunds: summary.refunds,
    tendered: summary.tendered,
    total: summary.total,
    cash_tender: summary.cashTender,
    card_tender: summary.cardTender,
    other_tender: summary.otherTender,
    details: { ...record(order.details), checks: summary.activeChecks },
  }
}

function applyOpenCheckPolicy(orders: SourceOrderRow[], policy: PosOpenCheckPolicy) {
  let openChecks = 0
  let excludedOpenChecks = 0
  const filtered: SourceOrderRow[] = []
  for (const order of orders) {
    const checks = list(record(order.details).checks).map(record)
    const activeChecks = checks.filter((check) => check.voided !== true && check.deleted !== true)
    if (checks.length > 0 && activeChecks.length === 0) continue
    const orderOpenChecks = activeChecks.filter(isOpenCheck)
    openChecks += orderOpenChecks.length
    if (policy !== 'exclude' || orderOpenChecks.length === 0) {
      filtered.push(order)
      continue
    }
    excludedOpenChecks += orderOpenChecks.length
    const closedChecks = activeChecks.filter((check) => !isOpenCheck(check))
    if (closedChecks.length > 0) filtered.push(orderWithChecks(order, closedChecks))
  }
  return { orders: filtered, openChecks, excludedOpenChecks }
}

export type PosAccountingBlocker = {
  code: string
  title: string
  detail: string
  action: string
  sourceKind?: PosSourceKind
  sourceId?: string
  affectedChecks?: number
}

function uniqueBlockers(blockers: PosAccountingBlocker[]) {
  return [...new Map(blockers.map((blocker) => [blocker.code, blocker])).values()]
    .sort((left, right) => left.code.localeCompare(right.code))
}

export function evaluatePosAccountingReadiness(input: {
  available: boolean
  balanced: boolean
  sourceReconciled: boolean
  mappingsComplete: boolean
  unallocatedSubtotal: number
  holdReasons: string[]
  blockers?: PosAccountingBlocker[]
}) {
  const allocationComplete = Math.abs(input.unallocatedSubtotal) < 0.01
  const blockers = uniqueBlockers([
    ...(input.blockers || []),
    ...(!input.balanced && !(input.blockers || []).some((entry) => entry.code === 'out_of_balance') ? [{
      code: 'out_of_balance',
      title: 'Balance the accounting journal',
      detail: 'The accounting journal debits and credits do not match.',
      action: 'Review journal',
    }] : []),
    ...(!input.sourceReconciled && !(input.blockers || []).some((entry) => entry.code === 'source_variance') ? [{
      code: 'source_variance',
      title: 'Resolve the Toast source variance',
      detail: 'The Toast order total does not reconcile to the proposed accounting documents.',
      action: 'Reload sales',
    }] : []),
    ...(!input.mappingsComplete && !(input.blockers || []).some((entry) =>
      entry.code === 'payment_exception_mapping_required' || entry.code.startsWith('missing_mapping:')) ? [{
      code: 'mapping_hold',
      title: 'Complete accounting mappings',
      detail: 'One or more Toast sources do not have a valid QuickBooks destination.',
      action: 'Map accounts',
    }] : []),
    ...(!allocationComplete && !(input.blockers || []).some((entry) => entry.code === 'sales_unallocated') ? [{
      code: 'sales_unallocated',
      title: 'Allocate all sales',
      detail: `${Math.abs(money(input.unallocatedSubtotal)).toFixed(2)} of sales is not allocated to mapped items.`,
      action: 'Map products',
    }] : []),
  ])
  const hold = blockers.length > 0 || input.holdReasons.length > 0
  return {
    readyForReview: input.available
      && input.balanced
      && input.sourceReconciled
      && input.mappingsComplete
      && allocationComplete
      && !hold,
    allocationComplete,
    hold,
    blockers,
  }
}

export function evaluateStoredPosAccountingReadiness(value: unknown) {
  const readiness = record(value)
  const blockers = list(readiness.blockers).map((entry): PosAccountingBlocker => {
    const blocker = record(entry)
    return {
      code: String(blocker.code || 'mapping_hold'),
      title: String(blocker.title || 'Accounting date is on hold'),
      detail: String(blocker.detail || 'Resolve the accounting hold before posting.'),
      action: String(blocker.action || 'Review accounting'),
      ...(blocker.sourceKind ? { sourceKind: blocker.sourceKind as PosSourceKind } : {}),
      ...(blocker.sourceId ? { sourceId: String(blocker.sourceId) } : {}),
      ...(Number(blocker.affectedChecks) > 0 ? { affectedChecks: Number(blocker.affectedChecks) } : {}),
    }
  })
  return evaluatePosAccountingReadiness({
    available: readiness.available !== false,
    balanced: readiness.balanced === true,
    sourceReconciled: readiness.sourceReconciled === true,
    mappingsComplete: readiness.mappingsComplete === true,
    unallocatedSubtotal: Number(readiness.unallocatedSubtotal || 0),
    holdReasons: list(readiness.holdReasons).map(String),
    blockers,
  })
}

export function discoverSafePosSourceCatalog(orders: SourceOrderRow[]): PosAccountingCatalogEntry[] {
  const catalog = new Map<string, PosAccountingCatalogEntry>()
  const add = (
    kind: PosSourceKind,
    providerId: unknown,
    sourceNameValue: unknown,
    amountValue: unknown,
    quantityValue: unknown,
    businessDate: string,
  ) => {
    const sourceName = safeSourceName(sourceNameValue, 'POS source')
    const sourceId = sourceIdentity(kind, providerId, sourceName)
    const key = `${kind}:${sourceId}`
    const current = catalog.get(key)
    const amount = money(amountValue)
    const quantity = Number(quantityValue)
    if (current) {
      current.occurrenceCount += 1
      current.quantity = Math.round((current.quantity + (Number.isFinite(quantity) ? quantity : 0)) * 1000) / 1000
      current.amount = money(current.amount + amount)
      current.firstSeenDate = current.firstSeenDate < businessDate ? current.firstSeenDate : businessDate
      current.lastSeenDate = current.lastSeenDate > businessDate ? current.lastSeenDate : businessDate
      return
    }
    catalog.set(key, {
      sourceKind: kind,
      sourceId,
      sourceName,
      occurrenceCount: 1,
      quantity: Number.isFinite(quantity) ? quantity : 0,
      amount,
      firstSeenDate: businessDate,
      lastSeenDate: businessDate,
      catalogOrigin: 'observed',
      sku: null,
      unitPrice: null,
    })
  }

  for (const order of orders) {
    if (order.voided === true || order.deleted === true) continue
    const businessDate = dateOnly(order.business_date)
    const fulfillmentDate = dateOnly(order.fulfillment_business_date || order.business_date)
    const offDatePayments = dateList(order.payment_business_dates)
      .filter((paymentDate) => paymentDate !== fulfillmentDate)
    if (offDatePayments.length > 0) {
      add(
        'payment_exception',
        'summary:payment_exceptions',
        'Payment Exceptions',
        money(order.tendered) + money(order.tips),
        offDatePayments.length,
        businessDate,
      )
    }
    let sawDiscount = false
    let sawTax = false
    let sawServiceCharge = false
    let sawTender = false
    const details = record(order.details)
    for (const checkValue of list(details.checks)) {
      const check = record(checkValue)
      if (check.voided === true || check.deleted === true) continue
      for (const selectionValue of list(check.selections)) {
        const selection = record(selectionValue)
        if (selection.voided === true || selection.deleted === true) continue
        const itemName = safeSourceName(selection.itemName ?? selection.name, 'POS item')
        add('sales_item', selection.itemGuid ?? selection.providerGuid, itemName, selection.net, selection.quantity, businessDate)
        const groupName = safeSourceName(selection.groupName, '')
        if (groupName) add('sales_category', selection.groupGuid, groupName, selection.net, selection.quantity, businessDate)
        for (const discountValue of list(selection.discounts)) {
          const discount = record(discountValue)
          add('discount', discount.providerGuid, discount.name, discount.amount, 1, businessDate)
          sawDiscount = true
        }
        for (const taxValue of list(selection.taxes)) {
          const tax = record(taxValue)
          add('tax', tax.providerGuid, tax.name, tax.amount, 1, businessDate)
          sawTax = true
        }
      }
      for (const discountValue of list(check.discounts)) {
        const discount = record(discountValue)
        add('discount', discount.providerGuid, discount.name, discount.amount, 1, businessDate)
        sawDiscount = true
      }
      for (const taxValue of list(check.taxes)) {
        const tax = record(taxValue)
        add('tax', tax.providerGuid, tax.name, tax.amount, 1, businessDate)
        sawTax = true
      }
      for (const chargeValue of list(check.serviceChargeLines)) {
        const charge = record(chargeValue)
        add('service_charge', charge.providerGuid, charge.name, charge.amount, 1, businessDate)
        sawServiceCharge = true
      }
      for (const paymentValue of list(check.payments)) {
        const payment = record(paymentValue)
        if (!isToastProjectedPaymentActive(payment)) continue
        const paymentType = safeSourceName(payment.type, 'Other tender')
        add('tender', null, paymentType, payment.amount, 1, businessDate)
        add('payment_type', null, paymentType, payment.amount, 1, businessDate)
        const cardBrand = safeSourceName(payment.cardBrand, '')
        if (cardBrand) add('card_brand', null, cardBrand, payment.amount, 1, businessDate)
        if (payment.processingFee !== null && payment.processingFee !== undefined) {
          add('fee', 'summary:processing_fees', 'Processing fees', payment.processingFee, 1, businessDate)
        }
        if (/cash/i.test(paymentType)) add('cash_drawer', 'summary:cash', 'Cash in drawer', payment.amount, 1, businessDate)
        sawTender = true
      }
    }
    if (order.source) add('order_source', null, order.source, order.net_sales, 1, businessDate)
    if (order.dining_option) add('dining_option', null, order.dining_option, order.net_sales, 1, businessDate)
    if (!sawDiscount && money(order.discounts) !== 0) {
      add('discount', 'summary:discounts', 'Discounts', order.discounts, 1, businessDate)
    }
    if (!sawTax && money(order.tax) !== 0) add('tax', 'summary:tax', 'Sales tax', order.tax, 1, businessDate)
    if (!sawServiceCharge && money(order.service_charges) !== 0) {
      add('service_charge', 'summary:service_charges', 'Service charges', order.service_charges, 1, businessDate)
    }
    if (money(order.tips) !== 0) add('service_charge', 'summary:tips', 'Credit tips', order.tips, 1, businessDate)
    if (!sawTender) {
      if (money(order.cash_tender) !== 0) {
        add('tender', 'summary:cash', 'Cash', order.cash_tender, 1, businessDate)
        add('cash_drawer', 'summary:cash', 'Cash in drawer', order.cash_tender, 1, businessDate)
      }
      if (money(order.card_tender) !== 0) add('tender', 'summary:card', 'Card', order.card_tender, 1, businessDate)
      if (money(order.other_tender) !== 0) add('tender', 'summary:other', 'Other tender', order.other_tender, 1, businessDate)
    }
  }
  const cardBrandEntries = [...catalog.values()].filter((entry) => entry.sourceKind === 'card_brand')
  if (cardBrandEntries.length > 1) {
    add(
      'card_brand',
      'summary:card_settlement',
      'Calculated card settlement',
      cardBrandEntries.reduce((sum, entry) => sum + entry.amount, 0),
      cardBrandEntries.reduce((sum, entry) => sum + entry.occurrenceCount, 0),
      cardBrandEntries.reduce((latest, entry) => latest > entry.lastSeenDate ? latest : entry.lastSeenDate, ''),
    )
  }
  return [...catalog.values()].map((entry) => ({
    ...entry,
    unitPrice: entry.quantity ? money(entry.amount / entry.quantity) : null,
  })).sort((left, right) => (
    left.sourceKind.localeCompare(right.sourceKind) || left.sourceName.localeCompare(right.sourceName)
  ))
}

export function mergeStableToastMenuCatalog(
  observed: PosAccountingCatalogEntry[],
  menuItems: StableToastMenuCatalogItem[],
) {
  const catalog = new Map(observed.map((entry) => [`${entry.sourceKind}:${entry.sourceId}`, { ...entry }]))
  for (const menuItem of menuItems) {
    const sourceName = safeSourceName(menuItem.name, 'POS item')
    const sourceId = sourceIdentity('sales_item', menuItem.itemGuid || menuItem.providerItemId, sourceName)
    const key = `sales_item:${sourceId}`
    const current = catalog.get(key)
    if (current) {
      current.catalogOrigin = 'observed_and_menu'
      current.sku = menuItem.plu || current.sku
      current.unitPrice = menuItem.price === null ? current.unitPrice : money(menuItem.price)
      continue
    }
    catalog.set(key, {
      sourceKind: 'sales_item',
      sourceId,
      sourceName,
      occurrenceCount: 0,
      quantity: 0,
      amount: 0,
      firstSeenDate: '',
      lastSeenDate: '',
      catalogOrigin: 'menu',
      sku: menuItem.plu,
      unitPrice: menuItem.price === null ? null : money(menuItem.price),
    })
  }
  return [...catalog.values()].sort((left, right) => (
    left.sourceKind.localeCompare(right.sourceKind) || left.sourceName.localeCompare(right.sourceName)
  ))
}

function normalizedCatalogName(value: string) {
  return value.normalize('NFKC').toLocaleLowerCase('en-US').replace(/[^a-z0-9]+/g, ' ').trim()
}

export function suggestQuickBooksItemForPosSource(
  source: PosAccountingCatalogEntry,
  items: QuickBooksCatalogItem[],
) {
  if (source.sourceKind !== 'sales_item') return null
  const products = items.filter((item) => item.item_type.trim().toLocaleLowerCase('en-US') !== 'category')
  const exact = products.filter((item) => item.name.trim().toLocaleLowerCase('en-US') === source.sourceName.trim().toLocaleLowerCase('en-US'))
  const normalized = exact.length
    ? exact
    : products.filter((item) => normalizedCatalogName(item.name) === normalizedCatalogName(source.sourceName))
  if (normalized.length !== 1) return null
  const item = normalized[0]
  return {
    type: 'item' as const,
    id: item.quickbooks_item_id,
    name: item.fully_qualified_name || item.name,
    confidence: exact.length === 1 ? 'exact' as const : 'normalized' as const,
  }
}

function mappingKey(kind: PosSourceKind, sourceId: string, targetType: PosTargetType) {
  return `${kind}:${sourceId}:${targetType}`
}

function target(mapping: PosAccountingMapping | undefined) {
  return mapping && mapping.active
    ? { type: mapping.targetType, id: mapping.targetId, name: mapping.targetName }
    : null
}

export function buildPosAccountingPreview(input: {
  businessDate: string
  restaurantName: string
  locationTimezone?: string | null
  locationCloseoutHour?: number | null
  asOf?: TimestampValue
  standardOnly: boolean
  profile: PosAccountingProfile
  mappings: PosAccountingMapping[]
  orders: SourceOrderRow[]
  draftEvidence?: {
    status: string
    reconciliationStatus: string
    approvedBy: string | null
    approvedAt: string | null
    postedAt: string | null
    quickBooksTransactionId: string | null
    lastError?: string | null
    updatedAt: string | null
  } | null
}) {
  const activeInputOrders = input.orders.filter(isToastProjectedOrderAccountingActive)
  const batch = applyOpenCheckPolicy(activeInputOrders, input.profile.openCheckPolicy)
  const orders = batch.orders
  const fulfillmentOrders = orders.filter((order) =>
    dateOnly(order.fulfillment_business_date || order.business_date) === input.businessDate)
  const mappingBySource = new Map(
    input.mappings
      .filter((entry) => entry.active && entry.validationStatus === 'valid')
      .map((entry) => [mappingKey(entry.sourceKind, entry.sourceId, entry.targetType), entry]),
  )
  const totals = fulfillmentOrders.reduce((sum, order) => ({
    grossSales: money(sum.grossSales + money(order.gross_sales)),
    subtotal: money(sum.subtotal + money(order.net_sales)),
    discounts: money(sum.discounts + money(order.discounts)),
    tax: money(sum.tax + money(order.tax)),
    serviceCharges: money(sum.serviceCharges + money(order.service_charges)),
    tips: money(sum.tips + money(order.tips)),
    refunds: money(sum.refunds + money(order.refunds)),
    tender: money(sum.tender + money(order.tendered)),
    total: money(sum.total + money(order.total)),
  }), {
    grossSales: 0,
    subtotal: 0,
    discounts: 0,
    tax: 0,
    serviceCharges: 0,
    tips: 0,
    refunds: 0,
    tender: 0,
    total: 0,
  })
  const catalog = discoverSafePosSourceCatalog(orders)
  const missing = new Map<string, { sourceKind: PosSourceKind; sourceId: string; sourceName: string; targetType: PosTargetType }>()
  const itemLines = new Map<string, {
    sourceKind: 'sales_item'
    sourceId: string
    sourceName: string
    categoryId: string | null
    categoryName: string | null
    quantity: number
    amount: number
  }>()
  for (const order of fulfillmentOrders) {
    for (const checkValue of list(record(order.details).checks)) {
      const check = record(checkValue)
      if (check.voided === true || check.deleted === true) continue
      for (const selectionValue of list(check.selections)) {
        const selection = record(selectionValue)
        if (selection.voided === true || selection.deleted === true) continue
        const sourceName = safeSourceName(selection.itemName ?? selection.name, 'POS item')
        const sourceId = sourceIdentity('sales_item', selection.itemGuid ?? selection.providerGuid, sourceName)
        const categoryName = safeSourceName(selection.groupName, '') || null
        const categoryId = categoryName ? sourceIdentity('sales_category', selection.groupGuid, categoryName) : null
        const key = mappingKey('sales_item', sourceId, 'item')
        const current = itemLines.get(key)
        if (current) {
          current.quantity = Math.round((current.quantity + Number(selection.quantity || 0)) * 1000) / 1000
          current.amount = money(current.amount + money(selection.net))
        } else {
          itemLines.set(key, {
            sourceKind: 'sales_item',
            sourceId,
            sourceName,
            categoryId,
            categoryName,
            quantity: Number(selection.quantity || 0),
            amount: money(selection.net),
          })
        }
      }
    }
  }
  const lineItems = [...itemLines.values()].map((line) => {
    const direct = mappingBySource.get(mappingKey('sales_item', line.sourceId, 'item'))
    const category = line.categoryId
      ? mappingBySource.get(mappingKey('sales_category', line.categoryId, 'item'))
      : undefined
    const applied = direct || category
    if (!applied) {
      missing.set(mappingKey('sales_item', line.sourceId, 'item'), {
        sourceKind: 'sales_item',
        sourceId: line.sourceId,
        sourceName: line.sourceName,
        targetType: 'item',
      })
    }
    return {
      ...line,
      unitPrice: line.quantity ? money(line.amount / line.quantity) : 0,
      mappingSource: direct ? 'item' : category ? 'category' : null,
      target: target(applied),
    }
  })
  const requireCatalogMappings = (kind: PosSourceKind, targetType: PosTargetType, enabled: boolean) => {
    if (!enabled) return
    for (const source of catalog.filter((entry) => entry.sourceKind === kind)) {
      if (!mappingBySource.has(mappingKey(kind, source.sourceId, targetType))) {
        missing.set(mappingKey(kind, source.sourceId, targetType), {
          sourceKind: kind,
          sourceId: source.sourceId,
          sourceName: source.sourceName,
          targetType,
        })
      }
    }
  }
  requireCatalogMappings('tax', 'tax_code', input.profile.trackSalesTax && totals.tax !== 0)
  requireCatalogMappings('service_charge', 'account', totals.serviceCharges !== 0 || totals.tips !== 0)

  const clearingTarget = input.profile.quickBooksClearingAccountId
    ? {
        type: 'account' as const,
        id: input.profile.quickBooksClearingAccountId,
        name: input.profile.quickBooksClearingAccountName || 'Clearing account',
      }
    : null
  type PaymentFact = {
    orderKey: string
    checkKey: string
    paymentKey: string
    type: string
    status: string | null
    paidEvidence: boolean
    cardBrand: string | null
    amount: number
    tip: number
    processingFee: number | null
    paymentDate: string
    fulfillmentDate: string
  }
  const paymentFacts: PaymentFact[] = []
  const paymentDateUnknownCheckKeys = new Set<string>()
  const locationTimezoneValid = validIanaTimezone(input.locationTimezone)
  const timezone = locationTimezoneValid ? String(input.locationTimezone) : 'UTC'
  const configuredCloseoutHour = input.locationCloseoutHour
  // A legacy row may represent any valid Toast cutoff. Noon is the conservative
  // upper bound, so a missing profile can never permit posting before its real
  // configured closeout hour. Standard location verification stores the exact value.
  const closeoutHour = Number.isInteger(configuredCloseoutHour)
    && Number(configuredCloseoutHour) >= 0
    && Number(configuredCloseoutHour) <= 12
    ? Number(configuredCloseoutHour)
    : LEGACY_SAFE_TOAST_CLOSEOUT_HOUR
  const closeoutHourSource = closeoutHour === configuredCloseoutHour ? 'restaurant' : 'legacy_safe_fallback'
  const asOfInstant = new Date(input.asOf ?? new Date())
  const asOfBusinessDate = locationTimezoneValid
    ? activeToastBusinessDate(asOfInstant, timezone, closeoutHour)
    : null
  const unfinalizedFulfillmentCheckKeys = new Set<string>()
  for (const [orderIndex, order] of activeInputOrders.entries()) {
    if (dateOnly(order.fulfillment_business_date || order.business_date) !== input.businessDate) continue
    const orderIdentity = String(order.order_guid || order.display_number || `order:${orderIndex}`)
    const checkEvidence = record(order.details).checks
    const checks = list(checkEvidence).map(record)
    const activeChecks = checks
      .filter((check) => check.voided !== true && check.deleted !== true)
    if (checks.length > 0 && activeChecks.length === 0) continue
    if (activeChecks.length === 0) {
      unfinalizedFulfillmentCheckKeys.add(paymentLifecycleEvidenceKey('check', `${orderIdentity}:unavailable`))
      continue
    }
    for (const [checkIndex, check] of activeChecks.entries()) {
      if (isFinalizedCheck(check)) continue
      const checkIdentity = String(check.providerGuid || check.displayNumber || `${orderIdentity}:${checkIndex}`)
      unfinalizedFulfillmentCheckKeys.add(paymentLifecycleEvidenceKey('check', checkIdentity))
    }
  }
  for (const order of orders) {
    const fulfillmentDate = dateOnly(order.fulfillment_business_date || order.business_date)
    const orderIdentity = String(order.order_guid || order.display_number || 'order')
    const orderKey = paymentLifecycleEvidenceKey('order', orderIdentity)
    for (const [checkIndex, checkValue] of list(record(order.details).checks).entries()) {
      const check = record(checkValue)
      if (check.voided === true || check.deleted === true) continue
      for (const [paymentIndex, paymentValue] of list(check.payments).entries()) {
        const payment = record(paymentValue)
        if (!isToastProjectedPaymentActive(payment)) continue
        const authoritativePaymentDate = normalizedBusinessDate(payment.paidBusinessDate)
        const inferredPaymentDate = authoritativePaymentDate
          ? null
          : inferredToastPaymentBusinessDate(
            payment.paidAt ?? check.paidAt,
            timezone,
            configuredCloseoutHour,
          )
        const explicitPaymentDate = authoritativePaymentDate || inferredPaymentDate
        const paymentDate = explicitPaymentDate
        const checkIdentity = String(check.providerGuid || check.displayNumber || `${orderIdentity}:${checkIndex}`)
        const checkKey = paymentLifecycleEvidenceKey('check', checkIdentity)
        if (!paymentDate) {
          paymentDateUnknownCheckKeys.add(checkKey)
          continue
        }
        paymentFacts.push({
          orderKey,
          checkKey,
          paymentKey: paymentLifecycleEvidenceKey(
            'payment',
            safeSourceName(payment.providerGuid, '') || `${checkIdentity}:${paymentIndex}`,
          ),
          type: safeSourceName(payment.type, 'OTHER'),
          status: safeSourceName(payment.status, '') || null,
          paidEvidence: Boolean(
            payment.paidAt
            || check.paidAt
            || /^(paid|closed)$/i.test(String(check.paymentStatus || '').trim()),
          ),
          cardBrand: safeSourceName(payment.cardBrand, '') || null,
          amount: money(payment.amount),
          tip: money(payment.tip),
          processingFee: payment.processingFee === null || payment.processingFee === undefined
            ? null
            : Math.abs(money(payment.processingFee)),
          paymentDate,
          fulfillmentDate,
        })
      }
    }
  }
  const sameDayPayments = paymentFacts.filter((payment) =>
    payment.paymentDate === input.businessDate && payment.fulfillmentDate === input.businessDate)
  const capturePayments = paymentFacts.filter((payment) =>
    payment.paymentDate === input.businessDate && payment.fulfillmentDate !== input.businessDate)
  const releasePayments = paymentFacts.filter((payment) =>
    payment.fulfillmentDate === input.businessDate && payment.paymentDate !== input.businessDate)
  const settlementPayments = [...sameDayPayments, ...capturePayments]
  const unfinalizedPayments = settlementPayments.filter((payment) => {
    const cardPayment = /credit|debit|card/i.test(payment.type) || Boolean(payment.cardBrand)
    return cardPayment
      ? payment.status?.trim().toUpperCase() !== 'CAPTURED'
      : !payment.paidEvidence
  })
  const uncapturedPaymentCheckKeys = new Set(
    unfinalizedPayments
      .map((payment) => payment.checkKey),
  )
  const legacyPaymentFallback = settlementPayments.length === 0
    && paymentFacts.length === 0
    && fulfillmentOrders.some((order) => order.payment_business_dates === undefined)
  const cardPayments = settlementPayments.filter((payment) =>
    /credit|debit|card/i.test(payment.type) || Boolean(payment.cardBrand))
  const cashPayments = paymentFacts.filter((payment) => /cash/i.test(payment.type))
    .filter((payment) => settlementPayments.includes(payment))
  const otherPayments = settlementPayments.filter((payment) => !cardPayments.includes(payment) && !cashPayments.includes(payment))
  const feeEvidenceComplete = cardPayments.length === 0 || cardPayments.every((payment) => payment.processingFee !== null)
  const processingFees = money(cardPayments.reduce((sum, payment) => sum + money(payment.processingFee), 0))
  const cardAmount = settlementPayments.length > 0
    ? money(cardPayments.reduce((sum, payment) => sum + payment.amount, 0))
    : legacyPaymentFallback ? money(fulfillmentOrders.reduce((sum, order) => sum + money(order.card_tender), 0)) : 0
  const cashAmount = settlementPayments.length > 0
    ? money(cashPayments.reduce((sum, payment) => sum + payment.amount, 0))
    : legacyPaymentFallback ? money(fulfillmentOrders.reduce((sum, order) => sum + money(order.cash_tender), 0)) : 0
  const otherAmount = settlementPayments.length > 0
    ? money(otherPayments.reduce((sum, payment) => sum + payment.amount, 0))
    : legacyPaymentFallback ? money(fulfillmentOrders.reduce((sum, order) => sum + money(order.other_tender), 0)) : 0
  const cardTips = money(cardPayments.reduce((sum, payment) => sum + payment.tip, 0))
  const cashTips = money(cashPayments.reduce((sum, payment) => sum + payment.tip, 0))
  const otherTips = settlementPayments.length > 0
    ? money(otherPayments.reduce((sum, payment) => sum + payment.tip, 0))
    : legacyPaymentFallback ? money(totals.tips - cardTips - cashTips) : 0
  const calculatedNetCardSettlement = money(cardAmount + cardTips - processingFees)
  const cardBrands = [...new Set(cardPayments.map((payment) => payment.cardBrand).filter(Boolean))] as string[]
  const cardSettlementSourceId = cardBrands.length === 1
    ? sourceIdentity('card_brand', null, cardBrands[0])
    : 'summary:card_settlement'
  const cardBrandMapping = mappingBySource.get(mappingKey('card_brand', cardSettlementSourceId, 'account'))
    || mappingBySource.get(mappingKey('card_brand', 'summary:card_settlement', 'account'))
  const feeMapping = mappingBySource.get(mappingKey('fee', 'summary:processing_fees', 'account'))
  const cashMapping = mappingBySource.get(mappingKey('cash_drawer', 'summary:cash', 'account'))
  const tipsMapping = mappingBySource.get(mappingKey('service_charge', 'summary:tips', 'account'))
  const paymentExceptionSourceId = 'summary:payment_exceptions'
  const paymentExceptionMapping = mappingBySource.get(mappingKey('payment_exception', paymentExceptionSourceId, 'account'))
  const paymentExceptionTarget = target(paymentExceptionMapping)
  const capturedExceptionAmount = money(capturePayments.reduce((sum, payment) => sum + payment.amount + payment.tip, 0))
  const releasedExceptionAmount = money(releasePayments.reduce((sum, payment) => sum + payment.amount + payment.tip, 0))
  const sameDayTender = legacyPaymentFallback
    ? totals.tender
    : money(sameDayPayments.reduce((sum, payment) => sum + payment.amount, 0))
  const sameDayTips = legacyPaymentFallback
    ? totals.tips
    : money(sameDayPayments.reduce((sum, payment) => sum + payment.tip, 0))
  const releasedTender = money(releasePayments.reduce((sum, payment) => sum + payment.amount, 0))
  const releasedTips = money(releasePayments.reduce((sum, payment) => sum + payment.tip, 0))
  const debitLines = [
    ...(cardAmount !== 0 || cardTips !== 0 ? [{
      side: 'debit' as const,
      code: 'calculated_net_card_settlement',
      label: 'Calculated net card settlement',
      amount: calculatedNetCardSettlement,
      sourceKind: 'card_brand' as const,
      sourceId: cardSettlementSourceId,
      target: target(cardBrandMapping),
      verifiedBankDeposit: false,
    }] : []),
    ...(feeEvidenceComplete && processingFees !== 0 ? [{
      side: 'debit' as const,
      code: 'processing_fees',
      label: 'Processing fees',
      amount: processingFees,
      sourceKind: 'fee' as const,
      sourceId: 'summary:processing_fees',
      target: target(feeMapping),
      verifiedBankDeposit: false,
    }] : []),
    ...(cashAmount !== 0 || cashTips !== 0 ? [{
      side: 'debit' as const,
      code: 'cash_in_drawer',
      label: 'Cash in drawer',
      amount: money(cashAmount + cashTips),
      sourceKind: 'cash_drawer' as const,
      sourceId: 'summary:cash',
      target: target(cashMapping),
      verifiedBankDeposit: false,
    }] : []),
    ...(otherAmount !== 0 || otherTips !== 0 ? [{
      side: 'debit' as const,
      code: 'other_tender',
      label: 'Other tender',
      amount: money(otherAmount + otherTips),
      sourceKind: 'tender' as const,
      sourceId: 'summary:other',
      target: target(mappingBySource.get(mappingKey('tender', 'summary:other', 'account'))) || clearingTarget,
      verifiedBankDeposit: false,
    }] : []),
    ...(releasedExceptionAmount !== 0 ? [{
      side: 'debit' as const,
      code: 'payment_exception_release',
      label: 'Payment Exceptions',
      amount: releasedExceptionAmount,
      sourceKind: 'payment_exception' as const,
      sourceId: paymentExceptionSourceId,
      target: paymentExceptionTarget,
      verifiedBankDeposit: false,
    }] : []),
  ]
  const creditLines = [
    ...(money(sameDayTender + releasedTender) !== 0 ? [{
      side: 'credit' as const,
      code: 'pos_clearing',
      label: 'POS clearing',
      amount: money(sameDayTender + releasedTender),
      sourceKind: 'tender' as const,
      sourceId: 'summary:clearing',
      target: clearingTarget,
      verifiedBankDeposit: false,
    }] : []),
    ...(money(sameDayTips + releasedTips) !== 0 ? [{
      side: 'credit' as const,
      code: 'tips_payable',
      label: 'Credit tips',
      amount: money(sameDayTips + releasedTips),
      sourceKind: 'service_charge' as const,
      sourceId: 'summary:tips',
      target: target(tipsMapping),
      verifiedBankDeposit: false,
    }] : []),
    ...(capturedExceptionAmount !== 0 ? [{
      side: 'credit' as const,
      code: 'payment_exception_capture',
      label: 'Payment Exceptions',
      amount: capturedExceptionAmount,
      sourceKind: 'payment_exception' as const,
      sourceId: paymentExceptionSourceId,
      target: paymentExceptionTarget,
      verifiedBankDeposit: false,
    }] : []),
  ]
  const debits = money(debitLines.reduce((sum, line) => sum + line.amount, 0))
  const credits = money(creditLines.reduce((sum, line) => sum + line.amount, 0))
  const balance = money(debits - credits)
  for (const line of [...debitLines, ...creditLines]) {
    if (!line.target) {
      missing.set(mappingKey(line.sourceKind, line.sourceId, 'account'), {
        sourceKind: line.sourceKind,
        sourceId: line.sourceId,
        sourceName: line.label,
        targetType: 'account',
      })
    }
  }
  const salesReceiptTotal = money(totals.subtotal + totals.tax)
  const sourceVariance = money(totals.total - salesReceiptTotal - totals.tips)
  const itemizedTotal = money(lineItems.reduce((sum, line) => sum + line.amount, 0))
  const hasSettlementActivity = settlementPayments.length > 0 || legacyPaymentFallback
  const hasAccountingActivity = hasSettlementActivity
    || fulfillmentOrders.length > 0
    || releasePayments.length > 0
  const sourceRefreshInstants = activeInputOrders.map((order) => {
    const candidate = new Date(String(order.updated_at || ''))
    return Number.isNaN(candidate.getTime()) || candidate.getTime() > asOfInstant.getTime()
      ? null
      : candidate
  })
  const sourceRefreshedAt = sourceRefreshInstants.length > 0
    && sourceRefreshInstants.every((value): value is Date => value !== null)
    ? sourceRefreshInstants.reduce((earliest, value) => (
        value.getTime() < earliest.getTime() ? value : earliest
      ))
    : null
  const sourceRefreshBusinessDate = locationTimezoneValid && sourceRefreshedAt
    ? activeToastBusinessDate(sourceRefreshedAt, timezone, closeoutHour)
    : null
  const businessDayWallClockComplete = !hasAccountingActivity
    || Boolean(asOfBusinessDate && input.businessDate < asOfBusinessDate)
  const sourceFreshAfterCloseout = !hasAccountingActivity
    || Boolean(sourceRefreshBusinessDate && input.businessDate < sourceRefreshBusinessDate)
  const paymentBusinessDayComplete = businessDayWallClockComplete && sourceFreshAfterCloseout
  const payoutEvidenceUnavailable = hasSettlementActivity && (cardAmount !== 0 || cardTips !== 0)
  const unavailableInputs = [...(payoutEvidenceUnavailable ? [{
      key: 'payout_deposit',
      status: 'unavailable' as const,
      reason: input.standardOnly
        ? 'Toast Standard Orders does not verify the bank payout deposit.'
        : 'No Analytics payout evidence is available for this preview.',
    }] : []), ...(!feeEvidenceComplete ? [{
      key: 'processing_fees',
      status: 'unavailable' as const,
      reason: 'One or more Standard payments did not include originalProcessingFee.',
    }] : [])]
  const protectedEvidence = Boolean(input.draftEvidence && ['approved', 'posting', 'posted', 'failed'].includes(input.draftEvidence.status))
  const unallocatedSubtotal = money(totals.subtotal - itemizedTotal)
  const paymentDateUnknownChecks = paymentDateUnknownCheckKeys.size
  const affectedExceptionChecks = new Set(
    [...capturePayments, ...releasePayments].map((payment) => payment.checkKey),
  ).size
  const captureChecks = new Set(capturePayments.map((payment) => payment.checkKey)).size
  const releaseChecks = new Set(releasePayments.map((payment) => payment.checkKey)).size
  const paymentExceptionClearingConflict = Boolean(
    paymentExceptionTarget
    && clearingTarget
    && paymentExceptionTarget.id === clearingTarget.id
    && (capturedExceptionAmount !== 0 || releasedExceptionAmount !== 0),
  )
  const paymentExceptionLinks = [...capturePayments.map((payment) => ({
    kind: 'capture' as const,
    orderKey: payment.orderKey,
    checkKey: payment.checkKey,
    paymentKey: payment.paymentKey,
    paymentBusinessDate: payment.paymentDate,
    fulfillmentBusinessDate: payment.fulfillmentDate,
    amount: payment.amount,
    tip: payment.tip,
    total: money(payment.amount + payment.tip),
  })), ...releasePayments.map((payment) => ({
    kind: 'release' as const,
    orderKey: payment.orderKey,
    checkKey: payment.checkKey,
    paymentKey: payment.paymentKey,
    paymentBusinessDate: payment.paymentDate,
    fulfillmentBusinessDate: payment.fulfillmentDate,
    amount: payment.amount,
    tip: payment.tip,
    total: money(payment.amount + payment.tip),
  }))]
  const missingMappings = [...missing.values()]
  const blockers: PosAccountingBlocker[] = [
    ...missingMappings.map((entry): PosAccountingBlocker => entry.sourceKind === 'payment_exception'
      ? {
          code: 'payment_exception_mapping_required',
          title: 'Map Payment Exceptions',
          detail: `${affectedExceptionChecks} prepaid or late-paid checks require a QuickBooks Payment Exceptions account.`,
          action: 'Map account',
          sourceKind: 'payment_exception',
          sourceId: paymentExceptionSourceId,
          affectedChecks: affectedExceptionChecks,
        }
      : {
          code: `missing_mapping:${entry.sourceKind}:${entry.sourceId}:${entry.targetType}`,
          title: `Map ${entry.sourceName}`,
          detail: `${entry.sourceKind.replaceAll('_', ' ')} needs a QuickBooks ${entry.targetType.replaceAll('_', ' ')} mapping.`,
          action: entry.targetType === 'item' ? 'Map product' : 'Map account',
          sourceKind: entry.sourceKind,
          sourceId: entry.sourceId,
        }),
    ...(paymentExceptionClearingConflict ? [{
      code: 'payment_exception_clearing_conflict',
      title: 'Separate Payment Exceptions from POS clearing',
      detail: 'Payment Exceptions and POS clearing use the same QuickBooks account. Choose a dedicated Payment Exceptions clearing account before posting.',
      action: 'Map account',
      sourceKind: 'payment_exception' as const,
      sourceId: paymentExceptionSourceId,
      affectedChecks: affectedExceptionChecks,
    }] : []),
    ...(input.profile.quickBooksBindingStatus !== 'verified' ? [{
      code: 'quickbooks_company_unbound',
      title: 'Verify the QuickBooks company',
      detail: 'The accounting profile is not bound to the active organization QuickBooks company.',
      action: 'Verify company',
    }] : []),
    ...(Math.abs(balance) >= 0.01 ? [{
      code: 'out_of_balance',
      title: 'Review the out-of-balance journal',
      detail: `The Payments Journal differs by ${Math.abs(balance).toFixed(2)}.`,
      action: 'Review journal',
    }] : []),
    ...(Math.abs(sourceVariance) >= 0.01 ? [{
      code: 'source_variance',
      title: 'Resolve the Toast source variance',
      detail: `Toast sales and proposed accounting documents differ by ${Math.abs(sourceVariance).toFixed(2)}.`,
      action: 'Reload sales',
    }] : []),
    ...(Math.abs(unallocatedSubtotal) >= 0.01 ? [{
      code: 'sales_unallocated',
      title: 'Allocate all sales',
      detail: `${Math.abs(unallocatedSubtotal).toFixed(2)} of sales is not allocated to mapped items.`,
      action: 'Map products',
    }] : []),
    ...(input.profile.openCheckPolicy === 'hold' && batch.openChecks > 0 ? [{
      code: 'open_check',
      title: 'Close or exclude open checks',
      detail: `${batch.openChecks} open checks keep this business date on hold.`,
      action: 'View checks',
      affectedChecks: batch.openChecks,
    }] : []),
    ...(hasAccountingActivity && !locationTimezoneValid ? [{
      code: 'toast_location_timezone_unavailable',
      title: 'Verify the Toast location timezone',
      detail: 'The restaurant timezone is missing or invalid, so ClawPilot cannot determine when the Toast business day closes. Refresh the Standard API location in Settings before regenerating.',
      action: 'Fix configuration',
    }] : []),
    ...(hasAccountingActivity && locationTimezoneValid && !businessDayWallClockComplete ? [{
      code: 'payment_business_day_open',
      title: 'Wait for the payment business day to close',
      detail: `${input.businessDate} is still the active payment business day in ${timezone} `
        + `(closeout ${closeoutHour}:00${closeoutHourSource === 'legacy_safe_fallback' ? ' conservative fallback; refresh the Toast location profile' : ''}). `
        + 'Regenerate after the business day closes before posting its payment journal.',
      action: 'Reload sales',
      affectedChecks: new Set(settlementPayments.map((payment) => payment.checkKey)).size,
    }] : []),
    ...(hasAccountingActivity
      && locationTimezoneValid
      && businessDayWallClockComplete
      && !sourceFreshAfterCloseout ? [{
        code: 'toast_source_refresh_required',
        title: 'Reload Toast after closeout',
        detail: `The stored Toast orders were not refreshed after the ${closeoutHour}:00 closeout for ${input.businessDate}. Reload sales before posting so late payments, tips, voids, and closed checks are included.`,
        action: 'Reload sales',
      }] : []),
    ...(uncapturedPaymentCheckKeys.size > 0 ? [{
      code: 'payment_not_captured',
      title: 'Wait for captured payments',
      detail: `${uncapturedPaymentCheckKeys.size} checks include card payments that are not CAPTURED or non-card payments without final paid evidence in Toast. Regenerate after every included payment is final.`,
      action: 'Reload sales',
      affectedChecks: uncapturedPaymentCheckKeys.size,
    }] : []),
    ...(unfinalizedFulfillmentCheckKeys.size > 0 ? [{
      code: 'fulfillment_checks_not_closed',
      title: 'Wait for finalized Toast checks',
      detail: `${unfinalizedFulfillmentCheckKeys.size} fulfillment checks are not CLOSED with a Toast closeout timestamp. Regenerate after Toast finalizes them before posting the Sales Receipt and release journal.`,
      action: 'Reload sales',
      affectedChecks: unfinalizedFulfillmentCheckKeys.size,
    }] : []),
    ...(input.profile.batchHoldPolicy === 'hold_until_settled' && payoutEvidenceUnavailable ? [{
      code: 'batch_hold_payout',
      title: 'Await verified settlement',
      detail: 'Verified payout evidence is unavailable; calculated settlement cannot be treated as a bank deposit.',
      action: 'Reload settlement',
    }] : []),
    ...(input.profile.batchHoldPolicy !== 'do_not_hold' && !feeEvidenceComplete ? [{
      code: 'batch_hold_fee_detail',
      title: 'Await processing-fee detail',
      detail: 'One or more card payments do not include original processing-fee evidence.',
      action: 'Reload settlement',
    }] : []),
    ...(paymentDateUnknownChecks > 0 ? [{
      code: 'payment_date_unavailable',
      title: 'Resolve payment timing',
      detail: `${paymentDateUnknownChecks} paid checks do not include enough timing evidence to choose the payment journal date.`,
      action: 'Reload sales',
      affectedChecks: paymentDateUnknownChecks,
    }] : []),
    ...(protectedEvidence && input.draftEvidence?.status !== 'failed' ? [{
      code: 'update_hold',
      title: 'Review protected posting evidence',
      detail: 'Approved or posted evidence is immutable and cannot be replaced by a regenerated preview.',
      action: 'Review posting',
    }] : []),
    ...(input.draftEvidence?.status === 'failed' || input.draftEvidence?.lastError ? [{
      code: 'provider_failure',
      title: 'Retry the failed accounting post',
      detail: safeSourceName(input.draftEvidence?.lastError, 'QuickBooks rejected or failed the accounting post.'),
      action: 'Review failure',
    }] : []),
  ]
  const finalHoldReasons = uniqueBlockers(blockers).map((blocker) => blocker.detail)
  const available = fulfillmentOrders.length > 0
    || settlementPayments.length > 0
    || releasePayments.length > 0
    || legacyPaymentFallback
  const readiness = evaluatePosAccountingReadiness({
    available,
    balanced: Math.abs(balance) < 0.01,
    sourceReconciled: Math.abs(sourceVariance) < 0.01,
    mappingsComplete: missing.size === 0,
    unallocatedSubtotal,
    holdReasons: finalHoldReasons,
    blockers,
  })
  return {
    businessDate: input.businessDate,
    restaurantName: input.restaurantName,
    available,
    standardOnly: input.standardOnly,
    containsPii: false,
    postingSideEffect: false,
    evidence: {
      existingDraft: input.draftEvidence || null,
      protected: protectedEvidence,
      overwritten: false,
    },
    salesReceipt: {
      postingMethod: input.profile.postingMethod,
      memo: input.profile.memoMode === 'custom'
        ? input.profile.customMemo
        : input.profile.memoMode === 'store_date'
          ? `${input.restaurantName} ${input.businessDate}`
          : input.profile.memoMode === 'location'
            ? input.restaurantName
            : `POS ${input.businessDate}`,
      subtotal: totals.subtotal,
      discounts: totals.discounts,
      tax: totals.tax,
      tender: totals.tender,
      tips: totals.tips,
      total: salesReceiptTotal,
      lineItems,
      itemizedTotal,
      unallocatedSubtotal,
    },
    journal: {
      kind: capturePayments.length > 0 || releasePayments.length > 0
        ? 'payment_exception'
        : 'payment_settlement',
      lines: [...debitLines, ...creditLines],
      debits,
      credits,
      balance,
      variance: balance,
      balanced: Math.abs(balance) < 0.01,
      calculatedNetCardSettlement,
      verifiedBankDeposit: false,
      processingFees: feeEvidenceComplete ? processingFees : null,
      feeEvidenceComplete,
      unavailableInputs,
    },
    paymentExceptions: {
      affectedChecks: affectedExceptionChecks,
      captureChecks,
      releaseChecks,
      captureAmount: capturedExceptionAmount,
      releaseAmount: releasedExceptionAmount,
      links: paymentExceptionLinks,
    },
    readiness: {
      postingGateVersion: POS_ACCOUNTING_POSTING_GATE_VERSION,
      readyForReview: readiness.readyForReview,
      available,
      balanced: Math.abs(balance) < 0.01,
      sourceReconciled: Math.abs(sourceVariance) < 0.01,
      mappingsComplete: missing.size === 0,
      allocationComplete: readiness.allocationComplete,
      unallocatedSubtotal,
      missingMappings,
      hold: readiness.hold,
      holdReasons: finalHoldReasons,
      blockers: readiness.blockers,
      paymentExceptions: {
        affectedChecks: affectedExceptionChecks,
        captureChecks,
        releaseChecks,
        captureAmount: capturedExceptionAmount,
        releaseAmount: releasedExceptionAmount,
        links: paymentExceptionLinks,
      },
      closeout: {
        asOfBusinessDate,
        timezone,
        timezoneValid: locationTimezoneValid,
        closeoutHour,
        closeoutHourSource,
        sourceRefreshedAt: sourceRefreshedAt?.toISOString() || null,
        sourceFreshAfterCloseout,
        paymentBusinessDayComplete,
        uncapturedPayments: unfinalizedPayments.length,
        unfinalizedFulfillmentChecks: unfinalizedFulfillmentCheckKeys.size,
      },
      openChecks: batch.openChecks,
      excludedOpenChecks: batch.excludedOpenChecks,
      postingEnabled: false,
    },
  }
}

async function resolveLocation(organizationId: string, restaurantGuid: string | null) {
  const result = await query<LocationRow>(
    `SELECT restaurant_guid::text, restaurant_name, location_name, timezone, closeout_hour,
       analytics_access, standard_access
     FROM toast_locations
     WHERE organization_id = $1::uuid
       AND active = true AND archived = false
       AND ($2::uuid IS NULL OR restaurant_guid = $2::uuid)
     ORDER BY CASE WHEN restaurant_guid = $2::uuid THEN 0 WHEN selected THEN 1 ELSE 2 END,
       restaurant_name
     LIMIT 1`,
    [organizationId, restaurantGuid],
  )
  if (!result.rows[0]) {
    throw new PosAccountingRequestError('POS_LOCATION_NOT_FOUND', 'The selected Toast location was not found', 404)
  }
  return result.rows[0]
}

async function requireLocation(client: PoolClient, organizationId: string, restaurantGuid: string | null) {
  if (!restaurantGuid) return
  const result = await client.query<{ restaurant_guid: string }>(
    `SELECT restaurant_guid::text
     FROM toast_locations
     WHERE organization_id = $1::uuid AND restaurant_guid = $2::uuid
       AND active = true AND archived = false
     FOR UPDATE`,
    [organizationId, restaurantGuid],
  )
  if (!result.rows[0]) {
    throw new PosAccountingRequestError('POS_LOCATION_NOT_FOUND', 'The selected Toast location was not found', 404)
  }
}

const PROFILE_SELECT = `id::text, restaurant_guid::text, profile_revision, schema_version,
  effective_from, effective_to, quickbooks_binding_status, quickbooks_connection_fingerprint,
  quickbooks_company_name, quickbooks_connection_verified_at, quickbooks_catalog_synced_at,
  posting_method, quickbooks_class_id, quickbooks_class_name,
  quickbooks_department_id, quickbooks_department_name, quickbooks_customer_id,
  quickbooks_customer_name, quickbooks_clearing_account_id, quickbooks_clearing_account_name,
  track_sales_tax, breakout_dimensions, memo_mode, custom_memo, custom_transaction_number,
  transaction_number_suffix, suppress_zero_over_short, auto_payout_tips,
  deposit_checks_with_cash, open_check_policy, batch_hold_policy,
  email_notifications_enabled, email_notifications_enabled_at, created_by, created_at`

const MAPPING_SELECT = `id::text, restaurant_guid::text, source_kind, source_id, source_name,
  target_type, target_id, target_name, active, mapping_revision, effective_from, effective_to,
  validation_status, validation_reason, source_catalog_revision, target_catalog_revision,
  last_validated_at, created_by, created_at`

const SOURCE_ORDER_SELECT = `order_guid, display_number, voided, deleted, business_date, fulfillment_business_date,
  payment_business_dates, created_at_source, gross_sales::text, net_sales::text, discounts::text,
  tax::text, service_charges::text, tips::text, refunds::text, tendered::text, total::text,
  cash_tender::text, card_tender::text, other_tender::text, source, dining_option, details, updated_at`

function catalogRevision(rows: SourceOrderRow[]) {
  return rows.reduce((latest, row) => {
    const timestamp = row.updated_at ? new Date(row.updated_at).getTime() : 0
    return Number.isFinite(timestamp) ? Math.max(latest, timestamp) : latest
  }, 0)
}

function effectiveMappings(rows: MappingRow[]) {
  const defaults = rows.filter((row) => !row.restaurant_guid).map(mappingFromRow)
  const overrides = rows.filter((row) => Boolean(row.restaurant_guid)).map(mappingFromRow)
  const merged = new Map(defaults.map((entry) => [`${entry.sourceKind}:${entry.sourceId}`, entry]))
  for (const entry of overrides) {
    merged.set(`${entry.sourceKind}:${entry.sourceId}`, entry)
  }
  return { defaults, overrides, effective: [...merged.values()] }
}

export function invalidateUnavailableQuickBooksItemTargets(
  mappings: PosAccountingMapping[],
  activeProductItemIds: Iterable<string>,
) {
  const productItemIds = new Set(activeProductItemIds)
  return mappings.map((mapping) => (
    mapping.targetType === 'item' && !productItemIds.has(mapping.targetId)
      ? {
          ...mapping,
          validationStatus: 'missing_target' as const,
          validationReason: 'The target must be an active QuickBooks product or service; categories cannot be used as POS transaction items.',
        }
      : mapping
  ))
}

export async function readPosAccountingWorkspaceFromPostgres(input: {
  organizationId: string
  restaurantGuid: string | null
  businessDate: string
  includeProtectedDraftEvidence?: boolean
}) {
  const location = await resolveLocation(input.organizationId, input.restaurantGuid)
  const params = [input.organizationId, location.restaurant_guid]
  const [
    profileResult,
    mappingResult,
    sourceResult,
    previewResult,
    accountResult,
    itemResult,
    activeProductItemResult,
    menuItemResult,
    customerResult,
    vendorResult,
    taxCodeResult,
    classResult,
    departmentResult,
    quickBooksConnectionResult,
    draftResult,
    commandResult,
  ] = await Promise.all([
    query<ProfileRow>(
      `SELECT ${PROFILE_SELECT}
       FROM pos_accounting_profiles
       WHERE organization_id = $1::uuid
         AND effective_from <= now() AND effective_to IS NULL
         AND (restaurant_guid IS NULL OR restaurant_guid = $2::uuid)
       ORDER BY restaurant_guid NULLS FIRST, profile_revision DESC`,
      params,
    ),
    query<MappingRow>(
      `SELECT ${MAPPING_SELECT}
       FROM pos_accounting_catalog_mappings
       WHERE organization_id = $1::uuid
         AND effective_from <= now() AND effective_to IS NULL
         AND (restaurant_guid IS NULL OR restaurant_guid = $2::uuid)
       ORDER BY restaurant_guid NULLS FIRST, source_kind, source_name, source_id, target_type`,
      params,
    ),
    query<SourceOrderRow>(
      `SELECT ${SOURCE_ORDER_SELECT}
       FROM toast_pos_orders
       WHERE organization_id = $1::uuid AND restaurant_guid = $2::uuid
         AND deleted = false
       ORDER BY business_date DESC, updated_at DESC
       LIMIT 5000`,
      params,
    ),
    query<SourceOrderRow>(
      `SELECT ${SOURCE_ORDER_SELECT}
       FROM toast_pos_orders
       WHERE organization_id = $1::uuid AND restaurant_guid = $2::uuid
         AND (
           fulfillment_business_date = $3::date
           OR $3::date = ANY(payment_business_dates)
         )
         AND deleted = false
       ORDER BY order_guid
       LIMIT 5000`,
      [...params, input.businessDate],
    ),
    query<{
      quickbooks_account_id: string; name: string; fully_qualified_name: string
      classification: string | null; account_type: string | null; account_sub_type: string | null
    }>(
      `SELECT quickbooks_account_id, name, fully_qualified_name, classification, account_type, account_sub_type
       FROM quickbooks_accounts
       WHERE organization_id = $1::uuid AND active = true
       ORDER BY fully_qualified_name, quickbooks_account_id
       LIMIT 5000`,
      [input.organizationId],
    ),
    query<{
      quickbooks_item_id: string; name: string; fully_qualified_name: string
      item_type: string; sku: string | null; taxable: boolean
    }>(
      `SELECT quickbooks_item_id, name, fully_qualified_name, item_type, sku, taxable
       FROM quickbooks_items
       WHERE organization_id = $1::uuid AND active = true
      ORDER BY fully_qualified_name, quickbooks_item_id
       LIMIT 5000`,
      [input.organizationId],
    ),
    query<{ id: string }>(
      `SELECT quickbooks_item_id AS id
       FROM quickbooks_items
       WHERE organization_id = $1::uuid AND active = true
         AND lower(COALESCE(item_type, '')) <> 'category'`,
      [input.organizationId],
    ),
    query<{
      item_guid: string; provider_item_id: string; name: string; plu: string | null
      price: string | null
    }>(
      `SELECT DISTINCT ON (item_guid) item_guid::text, provider_item_id, name, plu, price::text
       FROM toast_menu_catalog_items
       WHERE organization_id = $1::uuid AND restaurant_guid = $2::uuid
         AND active = true AND archived = false
       ORDER BY item_guid, source_revision DESC, updated_at DESC, menu_guid, group_guid
       LIMIT 5000`,
      params,
    ),
    query<{ quickbooks_customer_id: string; display_name: string; company_name: string | null }>(
      `SELECT quickbooks_customer_id, display_name, company_name
       FROM quickbooks_customers
       WHERE organization_id = $1::uuid AND active = true
       ORDER BY display_name, quickbooks_customer_id
       LIMIT 5000`,
      [input.organizationId],
    ),
    query<{ quickbooks_vendor_id: string; display_name: string; company_name: string | null }>(
      `SELECT quickbooks_vendor_id, display_name, company_name
       FROM quickbooks_vendors
       WHERE organization_id = $1::uuid AND active = true
       ORDER BY display_name, quickbooks_vendor_id
       LIMIT 5000`,
      [input.organizationId],
    ),
    query<{ quickbooks_tax_code_id: string; name: string; description: string | null; taxable: boolean }>(
      `SELECT quickbooks_tax_code_id, name, description, taxable
       FROM quickbooks_tax_codes
       WHERE organization_id = $1::uuid AND active = true
       ORDER BY name, quickbooks_tax_code_id
       LIMIT 5000`,
      [input.organizationId],
    ),
    query<{ quickbooks_class_id: string; name: string; fully_qualified_name: string }>(
      `SELECT quickbooks_class_id, name, fully_qualified_name
       FROM quickbooks_classes
       WHERE organization_id = $1::uuid AND active = true
       ORDER BY fully_qualified_name, quickbooks_class_id
       LIMIT 5000`,
      [input.organizationId],
    ),
    query<{ quickbooks_department_id: string; name: string; fully_qualified_name: string }>(
      `SELECT quickbooks_department_id, name, fully_qualified_name
       FROM quickbooks_departments
       WHERE organization_id = $1::uuid AND active = true
       ORDER BY fully_qualified_name, quickbooks_department_id
       LIMIT 5000`,
      [input.organizationId],
    ),
    query<{
      maton_connection_id: string; company_name: string; country: string | null; status: string
      verified_at: TimestampValue; last_catalog_synced_at: TimestampValue | null
    }>(
      `SELECT maton_connection_id, company_name, country, status, verified_at, last_catalog_synced_at
       FROM organization_quickbooks_connections
       WHERE organization_id = $1::uuid
      LIMIT 1`,
      [input.organizationId],
    ),
    query<DraftRow>(
      `SELECT id::text, status, reconciliation_status, approved_by, approved_at, posted_at,
         quickbooks_transaction_id, draft_revision, generation_reason, generated_by,
         source_revision, supersedes_draft_id::text, is_current, last_error, created_at, updated_at
       FROM toast_accounting_export_drafts
       WHERE organization_id = $1::uuid AND restaurant_guid = $2::uuid
         AND business_date = $3::date
       ORDER BY draft_revision DESC, created_at DESC
       LIMIT 20`,
      [...params, input.businessDate],
    ),
    query<CommandRow>(
      `SELECT id::text, command_type, status, requested_by, expected_sync_kinds,
         result_draft_id::text, result_draft_revision, last_error,
         started_at, completed_at, created_at, updated_at
       FROM pos_accounting_commands
       WHERE organization_id = $1::uuid AND restaurant_guid = $2::uuid
         AND business_date = $3::date
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
      [...params, input.businessDate],
    ),
  ])
  const defaultProfileRow = profileResult.rows.find((row) => !row.restaurant_guid)
  const overrideProfileRow = profileResult.rows.find((row) => Boolean(row.restaurant_guid))
  const connection = quickBooksConnectionResult.rows[0]
  const currentConnectionFingerprint = connection?.status === 'active'
    ? posQuickBooksConnectionFingerprint({
        connectionId: connection.maton_connection_id,
        companyName: connection.company_name,
        country: connection.country,
      })
    : null
  const organizationDefault = profileForQuickBooksConnection(profileFromRow(defaultProfileRow), currentConnectionFingerprint)
  const locationOverride = overrideProfileRow
    ? profileForQuickBooksConnection(profileFromRow(overrideProfileRow), currentConnectionFingerprint)
    : null
  const profile = locationOverride || organizationDefault
  const rawMappingScopes = effectiveMappings(mappingResult.rows)
  const activeProductItemIds = activeProductItemResult.rows.map((item) => item.id)
  const scopedMappings = {
    defaults: invalidateUnavailableQuickBooksItemTargets(rawMappingScopes.defaults, activeProductItemIds),
    overrides: invalidateUnavailableQuickBooksItemTargets(rawMappingScopes.overrides, activeProductItemIds),
    effective: invalidateUnavailableQuickBooksItemTargets(rawMappingScopes.effective, activeProductItemIds),
  }
  const mappings = scopedMappings.effective
  const sourceCatalog = mergeStableToastMenuCatalog(
    discoverSafePosSourceCatalog(sourceResult.rows),
    menuItemResult.rows.map((row) => ({
      itemGuid: row.item_guid,
      providerItemId: row.provider_item_id,
      name: row.name,
      plu: row.plu,
      price: row.price === null ? null : money(row.price),
    })),
  ).map((entry) => {
    const sourceMappings = mappings.filter((mapping) => (
      mapping.sourceKind === entry.sourceKind && mapping.sourceId === entry.sourceId
    ))
    const hasActiveMapping = sourceMappings.some((mapping) => mapping.active)
    const suggestedTarget = hasActiveMapping ? null : suggestQuickBooksItemForPosSource(entry, itemResult.rows)
    return {
      ...entry,
      mappings: sourceMappings,
      suggestedTarget,
      productCreationSuggestion: entry.sourceKind === 'sales_item' && !hasActiveMapping && !suggestedTarget
        ? {
            name: entry.sourceName,
            itemType: 'NonInventory' as const,
            sku: entry.sku,
            description: `Toast menu item from ${location.location_name || location.restaurant_name}`,
            unitPrice: entry.unitPrice || 0,
            purchaseCost: 0,
            taxable: true,
          }
        : null,
    }
  })
  const targetRevision = connection?.last_catalog_synced_at
    ? new Date(connection.last_catalog_synced_at).getTime()
    : 0
  const currentDraftRow = draftResult.rows.find((row) => row.is_current)
  const currentDraft = draftFromRow(currentDraftRow)
  const draftHistory = draftResult.rows.map(draftFromRow).filter((draft) => draft !== null)
  const draftEvidence = input.includeProtectedDraftEvidence === false ? null : currentDraft
  return {
    organizationId: input.organizationId,
    location: {
      restaurantGuid: location.restaurant_guid,
      restaurantName: location.restaurant_name,
      locationName: location.location_name,
      standardAccess: location.standard_access,
      analyticsAccess: location.analytics_access,
    },
    profile,
    profiles: {
      organizationDefault,
      locationOverride,
      effective: profile,
    },
    quickBooks: {
      configured: Boolean(connection),
      bound: connection?.status === 'active',
      companyName: connection?.company_name || null,
      country: connection?.country || null,
      status: connection?.status || 'unbound',
      verifiedAt: iso(connection?.verified_at),
      lastCatalogSyncedAt: iso(connection?.last_catalog_synced_at),
      catalogRevision: Number.isFinite(targetRevision) ? targetRevision : 0,
      catalog: {
        accounts: accountResult.rows.length,
        items: itemResult.rows.length,
        customers: customerResult.rows.length,
        vendors: vendorResult.rows.length,
        taxCodes: taxCodeResult.rows.length,
        classes: classResult.rows.length,
        departments: departmentResult.rows.length,
      },
      profileBindingEvidence: {
        status: profile.quickBooksBindingStatus,
        current: profile.quickBooksBindingStatus === 'verified',
        companyName: profile.quickBooksCompanyName,
        connectionFingerprint: profile.quickBooksConnectionFingerprint,
        verifiedAt: profile.quickBooksConnectionVerifiedAt,
        catalogSyncedAt: profile.quickBooksCatalogSyncedAt,
      },
    },
    sourceCatalogRevision: catalogRevision(sourceResult.rows),
    sourceCatalog,
    mappings,
    mappingScopes: {
      organizationDefault: scopedMappings.defaults,
      locationOverride: scopedMappings.overrides,
      effective: mappings,
    },
    draft: currentDraft,
    draftHistory,
    latestCommand: commandFromRow(commandResult.rows[0]),
    targets: {
      accounts: accountResult.rows.map((row) => ({
        id: row.quickbooks_account_id,
        name: row.name,
        fullyQualifiedName: row.fully_qualified_name,
        classification: row.classification,
        accountType: row.account_type,
        accountSubType: row.account_sub_type,
      })),
      items: itemResult.rows.map((row) => ({
        id: row.quickbooks_item_id,
        name: row.name,
        fullyQualifiedName: row.fully_qualified_name,
        itemType: row.item_type,
        sku: row.sku,
        taxable: row.taxable,
      })),
      customers: customerResult.rows.map((row) => ({
        id: row.quickbooks_customer_id,
        displayName: row.display_name,
        companyName: row.company_name,
      })),
      vendors: vendorResult.rows.map((row) => ({
        id: row.quickbooks_vendor_id,
        displayName: row.display_name,
        companyName: row.company_name,
      })),
      taxCodes: taxCodeResult.rows.map((row) => ({
        id: row.quickbooks_tax_code_id,
        name: row.name,
        description: row.description,
        taxable: row.taxable,
      })),
      classes: classResult.rows.map((row) => ({
        id: row.quickbooks_class_id,
        name: row.name,
        fullyQualifiedName: row.fully_qualified_name,
      })),
      departments: departmentResult.rows.map((row) => ({
        id: row.quickbooks_department_id,
        name: row.name,
        fullyQualifiedName: row.fully_qualified_name,
      })),
      locations: departmentResult.rows.map((row) => ({
        id: row.quickbooks_department_id,
        name: row.name,
        fullyQualifiedName: row.fully_qualified_name,
      })),
    },
    preview: buildPosAccountingPreview({
      businessDate: input.businessDate,
      restaurantName: location.location_name || location.restaurant_name,
      locationTimezone: location.timezone,
      locationCloseoutHour: location.closeout_hour,
      standardOnly: location.standard_access && !location.analytics_access,
      profile,
      mappings,
      orders: previewResult.rows,
      draftEvidence,
    }),
  }
}

type DailySalesRow = {
  gross_sales: string
  net_sales: string
  discounts: string
  voids: string
  refunds: string
  orders_count: number
  standard_orders_count: number
  standard_gross_sales: string
  standard_net_sales: string
  standard_discounts: string
  standard_voids: string
  standard_refunds: string
  standard_tax: string
  standard_tips: string
  standard_service_charges: string
  standard_tendered: string
  standard_total: string
  standard_cash: string
  standard_card: string
  standard_other_tender: string
  source_revision: number
  updated_at: TimestampValue
}

const PROTECTED_DRAFT_STATUSES = new Set(['approved', 'posting', 'posted', 'failed'])
const POSTED_OR_IN_FLIGHT_DRAFT_STATUSES = new Set(['approved', 'posting', 'posted'])

function hasDailySalesActivity(sales: DailySalesRow | undefined) {
  if (!sales) return false
  const counts = [sales.orders_count, sales.standard_orders_count]
  const amounts = [
    sales.gross_sales,
    sales.net_sales,
    sales.discounts,
    sales.voids,
    sales.refunds,
    sales.standard_gross_sales,
    sales.standard_net_sales,
    sales.standard_discounts,
    sales.standard_voids,
    sales.standard_refunds,
    sales.standard_tax,
    sales.standard_tips,
    sales.standard_service_charges,
    sales.standard_tendered,
    sales.standard_total,
    sales.standard_cash,
    sales.standard_card,
    sales.standard_other_tender,
  ]
  return counts.some((value) => Number(value) !== 0)
    || amounts.some((value) => Number(value) !== 0)
}

function sourceSummaryForDraft(input: {
  sales: DailySalesRow | undefined
  workspace: Awaited<ReturnType<typeof readPosAccountingWorkspaceFromPostgres>>
  generationReason: PosAccountingGenerationReason
  reconciliationStatus: string
  protectedPostingHistory: boolean
}) {
  const sales = input.sales
  const previewReadiness = input.workspace.preview.readiness
  const sourceReady = ['ready', 'orders_only'].includes(input.reconciliationStatus)
  const accountingBlockers: PosAccountingBlocker[] = [
    ...previewReadiness.blockers.filter((blocker) =>
      blocker.code !== 'update_hold' && blocker.code !== 'provider_failure'),
    ...(input.protectedPostingHistory ? [{
      code: 'update_hold',
      title: 'Review the previously posted date',
      detail: 'This date already has protected approval or posting evidence. Review the change before creating a QuickBooks update.',
      action: 'Review posting',
    }] : []),
  ]
  const canonicalReadiness = evaluatePosAccountingReadiness({
    available: previewReadiness.available,
    balanced: previewReadiness.balanced,
    sourceReconciled: previewReadiness.sourceReconciled && sourceReady,
    mappingsComplete: previewReadiness.mappingsComplete,
    unallocatedSubtotal: previewReadiness.unallocatedSubtotal,
    holdReasons: accountingBlockers.map((blocker) => blocker.detail),
    blockers: accountingBlockers,
  })
  return {
    grossSales: Number(sales?.gross_sales || 0),
    netSales: Number(sales?.net_sales || 0),
    discounts: Number(sales?.discounts || 0),
    voids: Number(sales?.voids || 0),
    refunds: Number(sales?.refunds || 0),
    analyticsOrders: Number(sales?.orders_count || 0),
    standardOrders: Number(sales?.standard_orders_count || 0),
    standard: {
      grossSales: Number(sales?.standard_gross_sales || 0),
      netSales: Number(sales?.standard_net_sales || 0),
      discounts: Number(sales?.standard_discounts || 0),
      voids: Number(sales?.standard_voids || 0),
      refunds: Number(sales?.standard_refunds || 0),
      tax: Number(sales?.standard_tax || 0),
      tips: Number(sales?.standard_tips || 0),
      serviceCharges: Number(sales?.standard_service_charges || 0),
      tendered: Number(sales?.standard_tendered || 0),
      total: Number(sales?.standard_total || 0),
      cash: Number(sales?.standard_cash || 0),
      card: Number(sales?.standard_card || 0),
      otherTender: Number(sales?.standard_other_tender || 0),
    },
    canonical: {
      generatedFrom: 'stored_pos_sales',
      generationReason: input.generationReason,
      sourceRevision: Number(sales?.source_revision || 0),
      sourceUpdatedAt: iso(sales?.updated_at),
      profileId: input.workspace.profile.id,
      profileRevision: input.workspace.profile.profileRevision,
      mappingRevisions: input.workspace.mappings.map((mapping) => ({
        id: mapping.id,
        sourceKind: mapping.sourceKind,
        sourceId: mapping.sourceId,
        targetType: mapping.targetType,
        mappingRevision: mapping.mappingRevision,
      })),
      readiness: {
        ...previewReadiness,
        ...canonicalReadiness,
        holdReasons: accountingBlockers.map((blocker) => blocker.detail),
        sourceReconciled: previewReadiness.sourceReconciled && sourceReady,
        reconciliationStatus: input.reconciliationStatus,
      },
      accounting: {
        salesReceipt: {
          subtotal: input.workspace.preview.salesReceipt.subtotal,
          discounts: input.workspace.preview.salesReceipt.discounts,
          tax: input.workspace.preview.salesReceipt.tax,
          tender: input.workspace.preview.salesReceipt.tender,
          tips: input.workspace.preview.salesReceipt.tips,
          total: input.workspace.preview.salesReceipt.total,
        },
        journal: {
          kind: input.workspace.preview.journal.kind,
          debits: input.workspace.preview.journal.debits,
          credits: input.workspace.preview.journal.credits,
          balance: input.workspace.preview.journal.balance,
        },
      },
      paymentExceptions: input.workspace.preview.paymentExceptions,
      updateRequired: input.protectedPostingHistory,
    },
  }
}

function proposedLinesForPreview(preview: Awaited<ReturnType<typeof readPosAccountingWorkspaceFromPostgres>>['preview']) {
  return [
    ...preview.salesReceipt.lineItems.map((line) => ({ document: 'sales_receipt', ...line })),
    ...preview.journal.lines.map((line) => ({ document: 'payments_journal', ...line })),
  ]
}

export function reconciliationStatusForDraft(
  sales: DailySalesRow | undefined,
  completedKinds: Set<string>,
  preview: Awaited<ReturnType<typeof readPosAccountingWorkspaceFromPostgres>>['preview'],
) {
  const analyticsReady = completedKinds.has('analytics_sales')
  // Modified-order polling can discover a future fulfillment date while the
  // claimed outbox job is keyed to the payment date. Persisted Standard rows
  // are evidence for that affected date even when it has no separate outbox row.
  const standardReady = completedKinds.has('standard_orders')
    || Number(sales?.standard_orders_count || 0) > 0
  if (!analyticsReady && !standardReady && preview.available) return 'orders_only'
  if (!analyticsReady && !standardReady) return 'pending'
  if (!analyticsReady) return 'orders_only'
  if (!standardReady) return 'analytics_only'
  const analyticsNet = Number(sales?.net_sales || 0)
  const standardNet = Number(sales?.standard_net_sales || 0)
  const tolerance = Math.max(1, Math.abs(analyticsNet) * 0.005)
  return Math.abs(analyticsNet - standardNet) > tolerance ? 'variance' : 'ready'
}

export async function regeneratePosAccountingDraftInPostgres(input: {
  organizationId: string
  restaurantGuid: string
  businessDate: string
  actorEmail?: string | null
  generationReason: PosAccountingGenerationReason
  forceNewRevision?: boolean
  commandId?: string | null
}) {
  const location = await resolveLocation(input.organizationId, input.restaurantGuid)
  return withTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(
      client,
      `pos-accounting-draft:${input.organizationId}:${location.restaurant_guid}:${input.businessDate}`,
    )
    await acquireTransactionAdvisoryLock(client, `quickbooks-binding:${input.organizationId}`)
    const workspace = await readPosAccountingWorkspaceFromPostgres({
      organizationId: input.organizationId,
      restaurantGuid: location.restaurant_guid,
      businessDate: input.businessDate,
      includeProtectedDraftEvidence: false,
    })
    const [salesResult, jobResult, draftResult] = await Promise.all([
      client.query<DailySalesRow>(
        `SELECT gross_sales::text, net_sales::text, discounts::text, voids::text, refunds::text,
           orders_count, standard_orders_count,
           standard_gross_sales::text, standard_net_sales::text, standard_discounts::text,
           standard_voids::text, standard_refunds::text, standard_tax::text, standard_tips::text,
           standard_service_charges::text, standard_tendered::text, standard_total::text,
           standard_cash::text, standard_card::text, standard_other_tender::text,
           source_revision, updated_at
         FROM toast_daily_sales
         WHERE organization_id = $1::uuid AND restaurant_guid = $2::uuid
           AND business_date = $3::date`,
        [input.organizationId, location.restaurant_guid, input.businessDate],
      ),
      client.query<{ sync_kind: string; status: string }>(
        `SELECT sync_kind, status
         FROM toast_sync_outbox
         WHERE organization_id = $1::uuid AND restaurant_guid = $2::uuid
           AND business_date = $3::date`,
        [input.organizationId, location.restaurant_guid, input.businessDate],
      ),
      client.query<DraftRow>(
        `SELECT id::text, status, reconciliation_status, approved_by, approved_at, posted_at,
           quickbooks_transaction_id, draft_revision, generation_reason, generated_by,
           source_revision, supersedes_draft_id::text, is_current, last_error, created_at, updated_at
         FROM toast_accounting_export_drafts
         WHERE organization_id = $1::uuid AND restaurant_guid = $2::uuid
           AND business_date = $3::date
         ORDER BY draft_revision DESC, created_at DESC
         FOR UPDATE`,
        [input.organizationId, location.restaurant_guid, input.businessDate],
      ),
    ])
    const sales = salesResult.rows[0]
    const current = draftResult.rows.find((row) => row.is_current)
    const protectedHistory = draftResult.rows.some((row) => PROTECTED_DRAFT_STATUSES.has(row.status))
    const postedOrInFlightHistory = draftResult.rows.some((row) =>
      POSTED_OR_IN_FLIGHT_DRAFT_STATUSES.has(row.status))
    const hasActivity = hasDailySalesActivity(sales) || workspace.preview.available
    const shouldRetainCorrection = protectedHistory && !hasActivity
    const completedKinds = new Set(
      jobResult.rows.filter((row) => row.status === 'succeeded').map((row) => row.sync_kind),
    )
    const reconciliationStatus = reconciliationStatusForDraft(sales, completedKinds, workspace.preview)
    const commandType = input.generationReason === 'automatic_sync' ? null : input.generationReason

    if (!hasActivity && !shouldRetainCorrection) {
      await client.query(
        `DELETE FROM toast_accounting_export_drafts
         WHERE organization_id = $1::uuid AND restaurant_guid = $2::uuid
           AND business_date = $3::date
           AND status NOT IN ('approved', 'posting', 'posted', 'failed')`,
        [input.organizationId, location.restaurant_guid, input.businessDate],
      )
      let command = null
      if (input.commandId) {
        const commandResult = await client.query<CommandRow>(
          `UPDATE pos_accounting_commands
           SET status = 'succeeded', result_draft_id = NULL, result_draft_revision = NULL,
             last_error = NULL, completed_at = now(), updated_at = now()
           WHERE id = $1::uuid AND organization_id = $2::uuid
             AND restaurant_guid = $3::uuid AND business_date = $4::date
           RETURNING id::text, command_type, status, requested_by, expected_sync_kinds,
             result_draft_id::text, result_draft_revision, last_error,
             started_at, completed_at, created_at, updated_at`,
          [input.commandId, input.organizationId, location.restaurant_guid, input.businessDate],
        )
        command = commandFromRow(commandResult.rows[0])
      }
      if (commandType && input.actorEmail) {
        await recordAuditEvent({
          actor: input.actorEmail,
          subject: input.actorEmail,
          organizationId: input.organizationId,
          eventType: commandType === 'reload_sales'
            ? 'pos.accounting.sales_reload.completed'
            : 'pos.accounting.regenerated',
          aggregateType: 'pos_accounting_command',
          aggregateId: input.commandId || `${location.restaurant_guid}:${input.businessDate}`,
          payload: {
            message: 'Regenerated POS accounting from stored sales; no sales-backed draft was required',
            commandType,
            commandId: input.commandId || null,
            restaurantGuid: location.restaurant_guid,
            restaurantName: location.location_name || location.restaurant_name,
            businessDate: input.businessDate,
            sourceRevision: Number(sales?.source_revision || 0),
          },
        }, client)
      }
      return { draft: null, command, createdRevision: false, noSales: true }
    }

    const sourceSummary = sourceSummaryForDraft({
      sales,
      workspace,
      generationReason: input.generationReason,
      reconciliationStatus,
      protectedPostingHistory: postedOrInFlightHistory,
    })
    const proposedLines = proposedLinesForPreview(workspace.preview)
    const status = record(record(sourceSummary.canonical).readiness).readyForReview === true
      ? 'needs_review'
      : 'needs_mapping'
    const forceNewRevision = input.forceNewRevision === true || Boolean(current && PROTECTED_DRAFT_STATUSES.has(current.status))
    let storedDraft: DraftRow
    let createdRevision = false

    if (current && !forceNewRevision) {
      const updated = await client.query<DraftRow>(
        `UPDATE toast_accounting_export_drafts
         SET status = $2, reconciliation_status = $3, source_summary = $4::jsonb,
           proposed_lines = $5::jsonb, generation_reason = $6, generated_by = $7,
           source_revision = $8, last_error = NULL, updated_at = now()
         WHERE id = $1::uuid AND is_current
           AND status NOT IN ('approved', 'posting', 'posted', 'failed')
         RETURNING id::text, status, reconciliation_status, approved_by, approved_at, posted_at,
           quickbooks_transaction_id, draft_revision, generation_reason, generated_by,
           source_revision, supersedes_draft_id::text, is_current, last_error, created_at, updated_at`,
        [
          current.id,
          status,
          reconciliationStatus,
          JSON.stringify(sourceSummary),
          JSON.stringify(proposedLines),
          input.generationReason,
          input.actorEmail || null,
          Number(sales?.source_revision || 0),
        ],
      )
      if (!updated.rows[0]) throw new Error('The current POS accounting draft changed during regeneration')
      storedDraft = updated.rows[0]
    } else {
      const nextRevision = (draftResult.rows[0]?.draft_revision || 0) + 1
      if (current) {
        await client.query(
          `UPDATE toast_accounting_export_drafts
           SET is_current = false, superseded_at = now()
           WHERE id = $1::uuid AND is_current`,
          [current.id],
        )
      }
      const idempotencyKey = crypto.createHash('sha256')
        .update(`clawpilot:pos-accounting:v2:${input.organizationId}:${location.restaurant_guid}:${input.businessDate}:${nextRevision}`)
        .digest('hex')
      const inserted = await client.query<DraftRow>(
        `INSERT INTO toast_accounting_export_drafts (
           organization_id, restaurant_guid, business_date, idempotency_key,
           status, reconciliation_status, source_summary, proposed_lines,
           draft_revision, generation_reason, generated_by, source_revision,
           supersedes_draft_id, is_current, created_at, updated_at
         ) VALUES (
           $1::uuid, $2::uuid, $3::date, $4, $5, $6, $7::jsonb, $8::jsonb,
           $9, $10, $11, $12, $13::uuid, true, now(), now()
         )
         RETURNING id::text, status, reconciliation_status, approved_by, approved_at, posted_at,
           quickbooks_transaction_id, draft_revision, generation_reason, generated_by,
           source_revision, supersedes_draft_id::text, is_current, last_error, created_at, updated_at`,
        [
          input.organizationId,
          location.restaurant_guid,
          input.businessDate,
          idempotencyKey,
          status,
          reconciliationStatus,
          JSON.stringify(sourceSummary),
          JSON.stringify(proposedLines),
          nextRevision,
          input.generationReason,
          input.actorEmail || null,
          Number(sales?.source_revision || 0),
          current?.id || null,
        ],
      )
      storedDraft = inserted.rows[0]
      createdRevision = true
    }

    let command = null
    if (input.commandId) {
      const commandResult = await client.query<CommandRow>(
        `UPDATE pos_accounting_commands
         SET status = 'succeeded', result_draft_id = $2::uuid,
           result_draft_revision = $3, last_error = NULL,
           completed_at = now(), updated_at = now()
         WHERE id = $1::uuid AND organization_id = $4::uuid
           AND restaurant_guid = $5::uuid AND business_date = $6::date
         RETURNING id::text, command_type, status, requested_by, expected_sync_kinds,
           result_draft_id::text, result_draft_revision, last_error,
           started_at, completed_at, created_at, updated_at`,
        [
          input.commandId,
          storedDraft.id,
          storedDraft.draft_revision,
          input.organizationId,
          location.restaurant_guid,
          input.businessDate,
        ],
      )
      command = commandFromRow(commandResult.rows[0])
    }
    if (commandType && input.actorEmail) {
      await recordAuditEvent({
        actor: input.actorEmail,
        subject: input.actorEmail,
        organizationId: input.organizationId,
        eventType: commandType === 'reload_sales'
          ? 'pos.accounting.sales_reload.completed'
          : 'pos.accounting.regenerated',
        aggregateType: 'pos_accounting_draft',
        aggregateId: storedDraft.id,
        payload: {
          message: commandType === 'reload_sales'
            ? `Reloaded Toast sales and generated POS accounting revision ${storedDraft.draft_revision}`
            : `Regenerated POS accounting revision ${storedDraft.draft_revision} from stored sales`,
          commandType,
          commandId: input.commandId || null,
          restaurantGuid: location.restaurant_guid,
          restaurantName: location.location_name || location.restaurant_name,
          businessDate: input.businessDate,
          draftId: storedDraft.id,
          draftRevision: storedDraft.draft_revision,
          sourceRevision: storedDraft.source_revision,
          supersedesDraftId: storedDraft.supersedes_draft_id,
        },
      }, client)
    }
    return {
      draft: draftFromRow(storedDraft),
      command,
      createdRevision,
      noSales: !hasActivity,
    }
  })
}

export async function runPosAccountingRegenerationCommandInPostgres(input: {
  organizationId: string
  restaurantGuid: string
  businessDate: string
  actorEmail: string
}) {
  const location = await resolveLocation(input.organizationId, input.restaurantGuid)
  const command = await withTransaction(async (client) => {
    await client.query(
      `UPDATE pos_accounting_commands
       SET status = 'failed', last_error = 'Accounting command was interrupted before completion',
         completed_at = now(), updated_at = now()
       WHERE organization_id = $1::uuid AND restaurant_guid = $2::uuid
         AND business_date = $3::date AND status = 'running'
         AND updated_at < now() - interval '15 minutes'`,
      [input.organizationId, location.restaurant_guid, input.businessDate],
    )
    const activeReload = await client.query(
      `SELECT id
       FROM pos_accounting_commands
       WHERE organization_id = $1::uuid AND restaurant_guid = $2::uuid
         AND business_date = $3::date AND command_type = 'reload_sales'
         AND status IN ('queued', 'running')
       LIMIT 1
       FOR UPDATE`,
      [input.organizationId, location.restaurant_guid, input.businessDate],
    )
    if (activeReload.rowCount) {
      throw new PosAccountingRequestError(
        'POS_ACCOUNTING_RELOAD_IN_PROGRESS',
        'Wait for the active sales reload to finish before regenerating accounting',
        409,
      )
    }
    const result = await client.query<CommandRow>(
      `INSERT INTO pos_accounting_commands (
         organization_id, restaurant_guid, business_date, command_type,
         status, requested_by, started_at, created_at, updated_at
       ) VALUES (
         $1::uuid, $2::uuid, $3::date, 'regenerate_accounting',
         'running', $4, now(), now(), now()
       )
       ON CONFLICT DO NOTHING
       RETURNING id::text, command_type, status, requested_by, expected_sync_kinds,
         result_draft_id::text, result_draft_revision, last_error,
         started_at, completed_at, created_at, updated_at`,
      [input.organizationId, location.restaurant_guid, input.businessDate, input.actorEmail],
    )
    if (!result.rows[0]) {
      throw new PosAccountingRequestError(
        'POS_ACCOUNTING_COMMAND_IN_PROGRESS',
        'An accounting command is already running for this location and business date',
        409,
      )
    }
    await recordAuditEvent({
      actor: input.actorEmail,
      subject: input.actorEmail,
      organizationId: input.organizationId,
      eventType: 'pos.accounting.regeneration.requested',
      aggregateType: 'pos_accounting_command',
      aggregateId: result.rows[0].id,
      payload: {
        message: 'POS accounting regeneration requested from stored sales',
        commandType: 'regenerate_accounting',
        commandId: result.rows[0].id,
        restaurantGuid: location.restaurant_guid,
        restaurantName: location.location_name || location.restaurant_name,
        businessDate: input.businessDate,
      },
    }, client)
    return result.rows[0]
  })
  try {
    return await regeneratePosAccountingDraftInPostgres({
      ...input,
      restaurantGuid: location.restaurant_guid,
      generationReason: 'regenerate_accounting',
      forceNewRevision: true,
      commandId: command.id,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 1000) : 'POS accounting regeneration failed'
    await withTransaction(async (client) => {
      await client.query(
        `UPDATE pos_accounting_commands
         SET status = 'failed', last_error = $2, completed_at = now(), updated_at = now()
         WHERE id = $1::uuid AND status = 'running'`,
        [command.id, message],
      )
      await recordAuditEvent({
        actor: input.actorEmail,
        subject: input.actorEmail,
        organizationId: input.organizationId,
        eventType: 'pos.accounting.regeneration.failed',
        aggregateType: 'pos_accounting_command',
        aggregateId: command.id,
        payload: {
          message: 'POS accounting regeneration from stored sales failed',
          commandType: 'regenerate_accounting',
          commandId: command.id,
          restaurantGuid: location.restaurant_guid,
          restaurantName: location.location_name || location.restaurant_name,
          businessDate: input.businessDate,
          reason: message,
        },
      }, client)
    })
    throw error
  }
}

export async function finalizePosAccountingReloadForDateInPostgres(input: {
  organizationId: string
  restaurantGuid: string
  businessDate: string
}) {
  const commandResult = await query<CommandRow>(
    `SELECT id::text, command_type, status, requested_by, expected_sync_kinds,
       result_draft_id::text, result_draft_revision, last_error,
       started_at, completed_at, created_at, updated_at
     FROM pos_accounting_commands
     WHERE organization_id = $1::uuid AND restaurant_guid = $2::uuid
       AND business_date = $3::date AND command_type = 'reload_sales'
       AND status IN ('queued', 'running')
     ORDER BY created_at
     LIMIT 1`,
    [input.organizationId, input.restaurantGuid, input.businessDate],
  )
  let command = commandResult.rows[0]
  if (!command) return { pending: false, finalized: false, failed: false }
  if (command.status === 'running') {
    const stale = new Date(command.updated_at).getTime() < Date.now() - 15 * 60 * 1000
    if (!stale) return { pending: true, finalized: false, failed: false }
    const reset = await query<CommandRow>(
      `UPDATE pos_accounting_commands
       SET status = 'queued', started_at = NULL,
         last_error = 'Retrying an interrupted accounting regeneration', updated_at = now()
       WHERE id = $1::uuid AND status = 'running'
         AND updated_at < now() - interval '15 minutes'
       RETURNING id::text, command_type, status, requested_by, expected_sync_kinds,
         result_draft_id::text, result_draft_revision, last_error,
         started_at, completed_at, created_at, updated_at`,
      [command.id],
    )
    if (!reset.rows[0]) return { pending: true, finalized: false, failed: false }
    command = reset.rows[0]
  }

  const jobResult = await query<{
    sync_kind: string
    status: string
    completed_at: TimestampValue | null
    updated_at: TimestampValue
    last_error: string | null
  }>(
    `SELECT sync_kind, status, completed_at, updated_at, last_error
     FROM toast_sync_outbox
     WHERE organization_id = $1::uuid AND restaurant_guid = $2::uuid
       AND business_date = $3::date AND sync_kind = ANY($4::text[])`,
    [input.organizationId, input.restaurantGuid, input.businessDate, command.expected_sync_kinds],
  )
  const jobs = new Map(jobResult.rows.map((row) => [row.sync_kind, row]))
  const requestedAt = new Date(command.created_at).getTime()
  const terminalFailure = command.expected_sync_kinds
    .map((kind) => jobs.get(kind))
    .find((job) => job?.status === 'dead' && new Date(job.updated_at).getTime() >= requestedAt)
  if (terminalFailure) {
    const message = String(terminalFailure.last_error || 'Toast sales reload reached a terminal failure').slice(0, 1000)
    await withTransaction(async (client) => {
      await client.query(
        `UPDATE pos_accounting_commands
         SET status = 'failed', last_error = $2, completed_at = now(), updated_at = now()
         WHERE id = $1::uuid AND status = 'queued'`,
        [command.id, message],
      )
      await recordAuditEvent({
        actor: command.requested_by,
        subject: command.requested_by,
        organizationId: input.organizationId,
        eventType: 'pos.accounting.sales_reload.failed',
        aggregateType: 'pos_accounting_command',
        aggregateId: command.id,
        payload: {
          message: 'Toast sales reload failed before accounting could be regenerated',
          commandType: command.command_type,
          commandId: command.id,
          restaurantGuid: input.restaurantGuid,
          businessDate: input.businessDate,
          reason: message,
        },
      }, client)
    })
    return { pending: false, finalized: false, failed: true }
  }

  const allComplete = command.expected_sync_kinds.every((kind) => {
    const job = jobs.get(kind)
    return job?.status === 'succeeded'
      && Boolean(job.completed_at)
      && new Date(job.completed_at!).getTime() >= requestedAt
  })
  if (!allComplete) return { pending: true, finalized: false, failed: false }

  const claimed = await query<CommandRow>(
    `UPDATE pos_accounting_commands
     SET status = 'running', started_at = now(), updated_at = now()
     WHERE id = $1::uuid AND status = 'queued'
     RETURNING id::text, command_type, status, requested_by, expected_sync_kinds,
       result_draft_id::text, result_draft_revision, last_error,
       started_at, completed_at, created_at, updated_at`,
    [command.id],
  )
  if (!claimed.rows[0]) return { pending: true, finalized: false, failed: false }
  try {
    await regeneratePosAccountingDraftInPostgres({
      ...input,
      actorEmail: command.requested_by,
      generationReason: 'reload_sales',
      forceNewRevision: true,
      commandId: command.id,
    })
    return { pending: false, finalized: true, failed: false }
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 1000) : 'POS accounting regeneration failed'
    await withTransaction(async (client) => {
      await client.query(
        `UPDATE pos_accounting_commands
         SET status = 'failed', last_error = $2, completed_at = now(), updated_at = now()
         WHERE id = $1::uuid AND status = 'running'`,
        [command.id, message],
      )
      await recordAuditEvent({
        actor: command.requested_by,
        subject: command.requested_by,
        organizationId: input.organizationId,
        eventType: 'pos.accounting.sales_reload.failed',
        aggregateType: 'pos_accounting_command',
        aggregateId: command.id,
        payload: {
          message: 'Toast sales reloaded, but accounting regeneration failed',
          commandType: command.command_type,
          commandId: command.id,
          restaurantGuid: input.restaurantGuid,
          businessDate: input.businessDate,
          reason: message,
        },
      }, client)
    })
    return { pending: false, finalized: false, failed: true }
  }
}

export async function savePosAccountingProfileInPostgres(input: {
  organizationId: string
  restaurantGuid: string | null
  scope: PosAccountingScope
  actorEmail: string
  profile: ReturnType<typeof validatePosAccountingProfile>
}) {
  return withTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(client, `quickbooks-binding:${input.organizationId}`)
    const restaurantGuid = input.scope === 'location_override' ? input.restaurantGuid : null
    if (input.scope === 'location_override' && !restaurantGuid) {
      throw new PosAccountingRequestError('POS_LOCATION_REQUIRED', 'A Toast location is required for a location override')
    }
    const profile = input.profile
    const connectionResult = await client.query<{
      maton_connection_id: string; company_name: string; country: string | null; status: string
      verified_at: TimestampValue; last_catalog_synced_at: TimestampValue | null
    }>(
      `SELECT maton_connection_id, company_name, country, status, verified_at, last_catalog_synced_at
       FROM organization_quickbooks_connections
       WHERE organization_id = $1::uuid
       LIMIT 1
       FOR SHARE`,
      [input.organizationId],
    )
    const connection = connectionResult.rows[0]
    const bindingVerified = connection?.status === 'active'
    if (!bindingVerified && [
      profile.quickBooksClassId,
      profile.quickBooksDepartmentId,
      profile.quickBooksCustomerId,
      profile.quickBooksClearingAccountId,
    ].some(Boolean)) {
      throw new PosAccountingRequestError(
        'POS_QUICKBOOKS_CONNECTION_REQUIRED',
        'Connect and verify QuickBooks before saving QuickBooks profile targets',
        409,
      )
    }
    const bindingFingerprint = bindingVerified
      ? posQuickBooksConnectionFingerprint({
          connectionId: connection.maton_connection_id,
          companyName: connection.company_name,
          country: connection.country,
        })
      : null
    await requireLocation(client, input.organizationId, restaurantGuid)
    const currentResult = await client.query<{
      id: string
      profile_revision: number
      email_notifications_enabled: boolean
      email_notifications_enabled_at: TimestampValue | null
    }>(
      `SELECT id::text, profile_revision,
         email_notifications_enabled, email_notifications_enabled_at
       FROM pos_accounting_profiles
       WHERE organization_id = $1::uuid
         AND restaurant_guid IS NOT DISTINCT FROM $2::uuid
         AND effective_to IS NULL
       FOR UPDATE`,
      [input.organizationId, restaurantGuid],
    )
    const revisionResult = await client.query<{ next_revision: number }>(
      `SELECT COALESCE(MAX(profile_revision), 0)::integer + 1 AS next_revision
       FROM pos_accounting_profiles
       WHERE organization_id = $1::uuid
         AND restaurant_guid IS NOT DISTINCT FROM $2::uuid`,
      [input.organizationId, restaurantGuid],
    )
    if (currentResult.rows[0]) {
      await client.query(
        `UPDATE pos_accounting_profiles SET effective_to = clock_timestamp()
         WHERE id = $1::uuid AND effective_to IS NULL`,
        [currentResult.rows[0].id],
      )
    }
    const result = await client.query<ProfileRow>(
      `INSERT INTO pos_accounting_profiles (
         organization_id, restaurant_guid, profile_revision,
         quickbooks_binding_status, quickbooks_connection_fingerprint,
         quickbooks_company_name, quickbooks_connection_verified_at, quickbooks_catalog_synced_at,
         posting_method,
         quickbooks_class_id, quickbooks_class_name,
         quickbooks_department_id, quickbooks_department_name,
         quickbooks_customer_id, quickbooks_customer_name,
         quickbooks_clearing_account_id, quickbooks_clearing_account_name,
         track_sales_tax, breakout_dimensions, memo_mode, custom_memo,
         custom_transaction_number, transaction_number_suffix,
         suppress_zero_over_short, auto_payout_tips, deposit_checks_with_cash,
         open_check_policy, batch_hold_policy,
         email_notifications_enabled, email_notifications_enabled_at, created_by
       ) VALUES (
         $1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8,
         $9, $10, $11, $12, $13, $14, $15, $16, $17,
         $18, $19::text[], $20, $21, $22, $23, $24, $25, $26, $27, $28,
         $29, $30, $31
       )
       RETURNING ${PROFILE_SELECT}`,
      [
        input.organizationId,
        restaurantGuid,
        revisionResult.rows[0]?.next_revision || 1,
        bindingVerified ? 'verified' : 'unbound',
        bindingFingerprint,
        bindingVerified ? connection.company_name : null,
        bindingVerified ? connection.verified_at : null,
        bindingVerified ? connection.last_catalog_synced_at : null,
        profile.postingMethod,
        profile.quickBooksClassId,
        profile.quickBooksClassName,
        profile.quickBooksDepartmentId,
        profile.quickBooksDepartmentName,
        profile.quickBooksCustomerId,
        profile.quickBooksCustomerName,
        profile.quickBooksClearingAccountId,
        profile.quickBooksClearingAccountName,
        profile.trackSalesTax,
        profile.breakoutDimensions,
        profile.memoMode,
        profile.customMemo,
        profile.customTransactionNumber,
        profile.transactionNumberSuffix,
        profile.suppressZeroOverShort,
        profile.autoPayoutTips,
        profile.depositChecksWithCash,
        profile.openCheckPolicy,
        profile.batchHoldPolicy,
        profile.emailNotificationsEnabled,
        profile.emailNotificationsEnabled
          ? currentResult.rows[0]?.email_notifications_enabled === true
            ? currentResult.rows[0].email_notifications_enabled_at
            : new Date()
          : null,
        input.actorEmail,
      ],
    )
    await recordAuditEvent({
      actor: input.actorEmail,
      subject: input.actorEmail,
      organizationId: input.organizationId,
      eventType: 'pos.accounting.profile.updated',
      aggregateType: 'pos_accounting_profile',
      aggregateId: restaurantGuid || `${input.organizationId}:default`,
      payload: {
        scope: input.scope,
        restaurantGuid,
        profileRevision: revisionResult.rows[0]?.next_revision || 1,
        postingMethod: profile.postingMethod,
        breakoutDimensions: profile.breakoutDimensions,
        trackSalesTax: profile.trackSalesTax,
        quickBooksBindingStatus: bindingVerified ? 'verified' : 'unbound',
        emailNotificationsEnabled: profile.emailNotificationsEnabled,
      },
    }, client)
    return profileFromRow(result.rows[0])
  })
}

export async function savePosAccountingMappingsInPostgres(input: {
  organizationId: string
  restaurantGuid: string | null
  scope: PosAccountingScope
  actorEmail: string
  mappings: ReturnType<typeof validatePosAccountingMappings>
}) {
  return withTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(client, `quickbooks-binding:${input.organizationId}`)
    const restaurantGuid = input.scope === 'location_override' ? input.restaurantGuid : null
    if (input.scope === 'location_override' && !restaurantGuid) {
      throw new PosAccountingRequestError('POS_LOCATION_REQUIRED', 'A Toast location is required for a location override')
    }
    await requireLocation(client, input.organizationId, restaurantGuid)
    const [sourceResult, menuItemSourceResult] = await Promise.all([
      client.query<SourceOrderRow>(
        `SELECT ${SOURCE_ORDER_SELECT}
         FROM toast_pos_orders
         WHERE organization_id = $1::uuid
           AND ($2::uuid IS NULL OR restaurant_guid = $2::uuid)
           AND deleted = false
         ORDER BY business_date DESC, updated_at DESC
         LIMIT 10000`,
        [input.organizationId, restaurantGuid],
      ),
      client.query<{ provider_item_id: string; name: string; source_revision: TimestampValue }>(
        `SELECT DISTINCT ON (provider_item_id) provider_item_id, name, source_revision
         FROM toast_menu_catalog_items
         WHERE organization_id = $1::uuid
           AND ($2::uuid IS NULL OR restaurant_guid = $2::uuid)
           AND source_provider = 'toast'
           AND active = true AND archived = false
         ORDER BY provider_item_id, source_revision DESC, updated_at DESC, restaurant_guid, menu_guid, group_guid`,
        [input.organizationId, restaurantGuid],
      ),
    ])
    const observedSources = discoverSafePosSourceCatalog(sourceResult.rows)
    const canonicalSourceNames = new Map(observedSources.map((entry) => [
      `${entry.sourceKind}:${entry.sourceId}`,
      entry.sourceName,
    ]))
    for (const item of menuItemSourceResult.rows) {
      canonicalSourceNames.set(`sales_item:${item.provider_item_id}`, item.name)
    }
    const sourceRevision = menuItemSourceResult.rows.reduce((latest, item) => {
      const timestamp = item.source_revision ? new Date(item.source_revision).getTime() : 0
      return Number.isFinite(timestamp) ? Math.max(latest, timestamp) : latest
    }, catalogRevision(sourceResult.rows))
    const sourceKeys = new Set(canonicalSourceNames.keys())
    const [
      itemResult,
      accountResult,
      customerResult,
      vendorResult,
      taxCodeResult,
      classResult,
      departmentResult,
      connectionResult,
    ] = await Promise.all([
      client.query<{ id: string }>(
        `SELECT quickbooks_item_id AS id FROM quickbooks_items
         WHERE organization_id = $1::uuid AND active = true
           AND lower(COALESCE(item_type, '')) <> 'category'`,
        [input.organizationId],
      ),
      client.query<{ id: string }>(
        `SELECT quickbooks_account_id AS id FROM quickbooks_accounts
         WHERE organization_id = $1::uuid AND active = true`,
        [input.organizationId],
      ),
      client.query<{ id: string }>(
        `SELECT quickbooks_customer_id AS id FROM quickbooks_customers
         WHERE organization_id = $1::uuid AND active = true`,
        [input.organizationId],
      ),
      client.query<{ id: string }>(
        `SELECT quickbooks_vendor_id AS id FROM quickbooks_vendors
         WHERE organization_id = $1::uuid AND active = true`,
        [input.organizationId],
      ),
      client.query<{ id: string }>(
        `SELECT quickbooks_tax_code_id AS id FROM quickbooks_tax_codes
         WHERE organization_id = $1::uuid AND active = true`,
        [input.organizationId],
      ),
      client.query<{ id: string }>(
        `SELECT quickbooks_class_id AS id FROM quickbooks_classes
         WHERE organization_id = $1::uuid AND active = true`,
        [input.organizationId],
      ),
      client.query<{ id: string }>(
        `SELECT quickbooks_department_id AS id FROM quickbooks_departments
         WHERE organization_id = $1::uuid AND active = true`,
        [input.organizationId],
      ),
      client.query<{ status: string; last_catalog_synced_at: TimestampValue | null }>(
        `SELECT status, last_catalog_synced_at
         FROM organization_quickbooks_connections
         WHERE organization_id = $1::uuid
         LIMIT 1`,
        [input.organizationId],
      ),
    ])
    const targetCatalogs: Partial<Record<PosTargetType, Set<string>>> = {
      item: new Set(itemResult.rows.map((row) => row.id)),
      account: new Set(accountResult.rows.map((row) => row.id)),
      customer: new Set(customerResult.rows.map((row) => row.id)),
      vendor: new Set(vendorResult.rows.map((row) => row.id)),
      tax_code: new Set(taxCodeResult.rows.map((row) => row.id)),
      class: new Set(classResult.rows.map((row) => row.id)),
      department: new Set(departmentResult.rows.map((row) => row.id)),
      location: new Set(departmentResult.rows.map((row) => row.id)),
    }
    const targetCatalogRevision = connectionResult.rows[0]?.last_catalog_synced_at
      ? new Date(connectionResult.rows[0].last_catalog_synced_at).getTime()
      : 0
    if (input.mappings.some((mapping) => mapping.active) && connectionResult.rows[0]?.status !== 'active') {
      throw new PosAccountingRequestError(
        'POS_QUICKBOOKS_CONNECTION_REQUIRED',
        'Connect and verify QuickBooks before saving active POS accounting mappings',
        409,
      )
    }
    const saved: PosAccountingMapping[] = []
    const changed: PosAccountingMapping[] = []
    for (const mapping of input.mappings) {
      const sourceName = canonicalSourceNames.get(`${mapping.sourceKind}:${mapping.sourceId}`) || mapping.sourceName
      let validationStatus: PosAccountingMapping['validationStatus'] = 'unvalidated'
      let validationReason: string | null = null
      let lastValidatedAt: Date | null = null
      if (!mapping.active) {
        validationReason = 'Inactive mappings are retained but are not used by previews.'
      } else if (!sourceKeys.has(`${mapping.sourceKind}:${mapping.sourceId}`)) {
        validationStatus = 'missing_source'
        validationReason = 'The source was not present in the current tenant-scoped POS catalog.'
        lastValidatedAt = new Date()
      } else if (!targetCatalogs[mapping.targetType]) {
        validationReason = `The cached QuickBooks ${mapping.targetType} catalog is not available for automated validation.`
      } else if (!targetCatalogs[mapping.targetType]!.has(mapping.targetId)) {
        validationStatus = 'missing_target'
        validationReason = 'The target was not present in the current tenant-scoped QuickBooks catalog.'
        lastValidatedAt = new Date()
      } else {
        validationStatus = 'valid'
        lastValidatedAt = new Date()
      }
      const historyResult = await client.query<MappingRow>(
        `SELECT ${MAPPING_SELECT}
         FROM pos_accounting_catalog_mappings
         WHERE organization_id = $1::uuid
           AND restaurant_guid IS NOT DISTINCT FROM $2::uuid
           AND source_kind = $3 AND source_id = $4
         ORDER BY mapping_revision DESC, created_at DESC
         FOR UPDATE`,
        [input.organizationId, restaurantGuid, mapping.sourceKind, mapping.sourceId],
      )
      const currentMapping = historyResult.rows.find((entry) => !entry.effective_to)
      if (
        currentMapping
        && currentMapping.source_name === sourceName
        && currentMapping.target_type === mapping.targetType
        && currentMapping.target_id === mapping.targetId
        && currentMapping.target_name === mapping.targetName
        && currentMapping.active === mapping.active
        && currentMapping.validation_status === validationStatus
        && currentMapping.validation_reason === validationReason
      ) {
        saved.push(mappingFromRow(currentMapping))
        continue
      }
      const previousRevision = historyResult.rows.find((entry) => entry.target_type === mapping.targetType)?.mapping_revision || 0
      const currentIds = historyResult.rows.filter((entry) => !entry.effective_to).map((entry) => entry.id)
      if (currentIds.length > 0) {
        await client.query(
          `UPDATE pos_accounting_catalog_mappings SET effective_to = clock_timestamp()
           WHERE id = ANY($1::uuid[]) AND effective_to IS NULL`,
          [currentIds],
        )
      }
      const result = await client.query<MappingRow>(
        `INSERT INTO pos_accounting_catalog_mappings (
           organization_id, restaurant_guid, source_kind, source_id, source_name,
           target_type, target_id, target_name, active, mapping_revision,
           validation_status, validation_reason, source_catalog_revision,
           target_catalog_revision, last_validated_at, created_by
         ) VALUES (
           $1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10,
           $11, $12, $13, $14, $15, $16
         )
         RETURNING ${MAPPING_SELECT}`,
        [
          input.organizationId,
          restaurantGuid,
          mapping.sourceKind,
          mapping.sourceId,
          sourceName,
          mapping.targetType,
          mapping.targetId,
          mapping.targetName,
          mapping.active,
          previousRevision + 1,
          validationStatus,
          validationReason,
          sourceRevision,
          Number.isFinite(targetCatalogRevision) ? targetCatalogRevision : 0,
          lastValidatedAt,
          input.actorEmail,
        ],
      )
      const savedMapping = mappingFromRow(result.rows[0])
      saved.push(savedMapping)
      changed.push(savedMapping)
    }
    const changedCount = changed.length
    if (changedCount > 0) {
      await recordAuditEvent({
        actor: input.actorEmail,
        subject: input.actorEmail,
        organizationId: input.organizationId,
        eventType: 'pos.accounting.mappings.updated',
        aggregateType: 'pos_accounting_profile',
        aggregateId: restaurantGuid || `${input.organizationId}:default`,
        payload: {
          scope: input.scope,
          restaurantGuid,
          mappingCount: changedCount,
          activeCount: changed.filter((entry) => entry.active).length,
          sourceKinds: [...new Set(changed.map((entry) => entry.sourceKind))],
          sourceCatalogRevision: sourceRevision,
          targetCatalogRevision: Number.isFinite(targetCatalogRevision) ? targetCatalogRevision : 0,
          validationStatuses: changed.reduce<Record<string, number>>((summary, mapping) => {
            summary[mapping.validationStatus] = (summary[mapping.validationStatus] || 0) + 1
            return summary
          }, {}),
        },
      }, client)
    }
    return { mappings: saved, changedCount }
  })
}
