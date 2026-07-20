import crypto from 'crypto'
import type { PoolClient } from 'pg'
import { recordAuditEvent } from '@/lib/auditWriter'
import { summarizeToastProjectedChecks, type ToastProjectedCheck } from '@/lib/integrations/toastOrderProjection'
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

export type PosPostingMethod = typeof POS_POSTING_METHODS[number]
export type PosBreakoutDimension = typeof POS_BREAKOUT_DIMENSIONS[number]
export type PosMemoMode = typeof POS_MEMO_MODES[number]
export type PosSourceKind = typeof POS_SOURCE_KINDS[number]
export type PosTargetType = typeof POS_TARGET_TYPES[number]
export type PosOpenCheckPolicy = typeof POS_OPEN_CHECK_POLICIES[number]
export type PosBatchHoldPolicy = typeof POS_BATCH_HOLD_POLICIES[number]
export type PosAccountingScope = typeof POS_ACCOUNTING_SCOPES[number]

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
  business_date: TimestampValue
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
  analytics_access: boolean
  standard_access: boolean
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

type CatalogEntry = {
  sourceKind: PosSourceKind
  sourceId: string
  sourceName: string
  occurrenceCount: number
  quantity: number
  amount: number
  firstSeenDate: string
  lastSeenDate: string
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

export function evaluatePosAccountingReadiness(input: {
  available: boolean
  balanced: boolean
  sourceReconciled: boolean
  mappingsComplete: boolean
  unallocatedSubtotal: number
  holdReasons: string[]
}) {
  const allocationComplete = Math.abs(input.unallocatedSubtotal) < 0.01
  const hold = input.holdReasons.length > 0
  return {
    readyForReview: input.available
      && input.balanced
      && input.sourceReconciled
      && input.mappingsComplete
      && allocationComplete
      && !hold,
    allocationComplete,
    hold,
  }
}

export function discoverSafePosSourceCatalog(orders: SourceOrderRow[]): CatalogEntry[] {
  const catalog = new Map<string, CatalogEntry>()
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
    })
  }

  for (const order of orders) {
    const businessDate = dateOnly(order.business_date)
    let sawDiscount = false
    let sawTax = false
    let sawServiceCharge = false
    let sawTender = false
    const details = record(order.details)
    for (const checkValue of list(details.checks)) {
      const check = record(checkValue)
      for (const selectionValue of list(check.selections)) {
        const selection = record(selectionValue)
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
  return [...catalog.values()].sort((left, right) => (
    left.sourceKind.localeCompare(right.sourceKind) || left.sourceName.localeCompare(right.sourceName)
  ))
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
    updatedAt: string | null
  } | null
}) {
  const batch = applyOpenCheckPolicy(input.orders, input.profile.openCheckPolicy)
  const orders = batch.orders
  const mappingBySource = new Map(
    input.mappings
      .filter((entry) => entry.active && entry.validationStatus === 'valid')
      .map((entry) => [mappingKey(entry.sourceKind, entry.sourceId, entry.targetType), entry]),
  )
  const totals = orders.reduce((sum, order) => ({
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
  for (const order of orders) {
    for (const checkValue of list(record(order.details).checks)) {
      for (const selectionValue of list(record(checkValue).selections)) {
        const selection = record(selectionValue)
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
  requireCatalogMappings('discount', 'item', totals.discounts !== 0)
  requireCatalogMappings('tax', 'tax_code', input.profile.trackSalesTax && totals.tax !== 0)
  requireCatalogMappings('service_charge', 'account', totals.serviceCharges !== 0 || totals.tips !== 0)

  const clearingTarget = input.profile.quickBooksClearingAccountId
    ? {
        type: 'account' as const,
        id: input.profile.quickBooksClearingAccountId,
        name: input.profile.quickBooksClearingAccountName || 'Clearing account',
      }
    : null
  const paymentFacts: Array<{
    type: string
    cardBrand: string | null
    amount: number
    tip: number
    processingFee: number | null
  }> = []
  for (const order of orders) {
    for (const checkValue of list(record(order.details).checks)) {
      const check = record(checkValue)
      for (const paymentValue of list(check.payments)) {
        const payment = record(paymentValue)
        paymentFacts.push({
          type: safeSourceName(payment.type, 'OTHER'),
          cardBrand: safeSourceName(payment.cardBrand, '') || null,
          amount: money(payment.amount),
          tip: money(payment.tip),
          processingFee: payment.processingFee === null || payment.processingFee === undefined
            ? null
            : Math.abs(money(payment.processingFee)),
        })
      }
    }
  }
  const cardPayments = paymentFacts.filter((payment) => /credit|debit|card/i.test(payment.type) || Boolean(payment.cardBrand))
  const cashPayments = paymentFacts.filter((payment) => /cash/i.test(payment.type))
  const otherPayments = paymentFacts.filter((payment) => !cardPayments.includes(payment) && !cashPayments.includes(payment))
  const feeEvidenceComplete = cardPayments.length > 0 && cardPayments.every((payment) => payment.processingFee !== null)
  const processingFees = money(cardPayments.reduce((sum, payment) => sum + money(payment.processingFee), 0))
  const cardAmount = paymentFacts.length > 0
    ? money(cardPayments.reduce((sum, payment) => sum + payment.amount, 0))
    : money(orders.reduce((sum, order) => sum + money(order.card_tender), 0))
  const cashAmount = paymentFacts.length > 0
    ? money(cashPayments.reduce((sum, payment) => sum + payment.amount, 0))
    : money(orders.reduce((sum, order) => sum + money(order.cash_tender), 0))
  const otherAmount = paymentFacts.length > 0
    ? money(otherPayments.reduce((sum, payment) => sum + payment.amount, 0))
    : money(orders.reduce((sum, order) => sum + money(order.other_tender), 0))
  const cardTips = money(cardPayments.reduce((sum, payment) => sum + payment.tip, 0))
  const cashTips = money(cashPayments.reduce((sum, payment) => sum + payment.tip, 0))
  const otherTips = paymentFacts.length > 0
    ? money(otherPayments.reduce((sum, payment) => sum + payment.tip, 0))
    : money(totals.tips - cardTips - cashTips)
  const calculatedNetCardSettlement = money(cardAmount + cardTips - processingFees)
  const cardBrands = [...new Set(cardPayments.map((payment) => payment.cardBrand).filter(Boolean))] as string[]
  const cardSettlementSourceId = cardBrands.length === 1
    ? sourceIdentity('card_brand', null, cardBrands[0])
    : 'summary:card_settlement'
  const cardBrandMapping = mappingBySource.get(mappingKey('card_brand', cardSettlementSourceId, 'account'))
  const feeMapping = mappingBySource.get(mappingKey('fee', 'summary:processing_fees', 'account'))
  const cashMapping = mappingBySource.get(mappingKey('cash_drawer', 'summary:cash', 'account'))
  const tipsMapping = mappingBySource.get(mappingKey('service_charge', 'summary:tips', 'account'))
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
  ]
  const creditLines = [
    ...(totals.tender !== 0 ? [{
      side: 'credit' as const,
      code: 'pos_clearing',
      label: 'POS clearing',
      amount: totals.tender,
      sourceKind: 'tender' as const,
      sourceId: 'summary:clearing',
      target: clearingTarget,
      verifiedBankDeposit: false,
    }] : []),
    ...(totals.tips !== 0 ? [{
      side: 'credit' as const,
      code: 'tips_payable',
      label: 'Credit tips',
      amount: totals.tips,
      sourceKind: 'service_charge' as const,
      sourceId: 'summary:tips',
      target: target(tipsMapping),
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
  const sourceVariance = money(totals.total - totals.subtotal - totals.tax - totals.tips)
  const itemizedTotal = money(lineItems.reduce((sum, line) => sum + line.amount, 0))
  const unavailableInputs = [{
      key: 'payout_deposit',
      status: 'unavailable' as const,
      reason: input.standardOnly
        ? 'Toast Standard Orders does not verify the bank payout deposit.'
        : 'No Analytics payout evidence is available for this preview.',
    }, ...(!feeEvidenceComplete ? [{
      key: 'processing_fees',
      status: 'unavailable' as const,
      reason: 'One or more Standard payments did not include originalProcessingFee.',
    }] : [])]
  const holdReasons = [
    'Verified payout evidence is unavailable; calculated settlement cannot be treated as a bank deposit.',
    ...(!feeEvidenceComplete ? ['Processing fee evidence is incomplete.'] : []),
    ...(input.profile.quickBooksBindingStatus !== 'verified' ? ['No verified QuickBooks company is bound to this profile revision.'] : []),
    ...(input.profile.openCheckPolicy === 'hold' && batch.openChecks > 0 ? [`${batch.openChecks} open checks require this batch to remain on hold.`] : []),
  ]
  const protectedEvidence = Boolean(input.draftEvidence && ['approved', 'posting', 'posted'].includes(input.draftEvidence.status))
  const finalHoldReasons = [
    ...holdReasons,
    ...(protectedEvidence ? ['Approved or posted evidence is immutable and cannot be replaced by a preview.'] : []),
  ]
  const unallocatedSubtotal = money(totals.subtotal - itemizedTotal)
  const readiness = evaluatePosAccountingReadiness({
    available: orders.length > 0,
    balanced: Math.abs(balance) < 0.01,
    sourceReconciled: Math.abs(sourceVariance) < 0.01,
    mappingsComplete: missing.size === 0,
    unallocatedSubtotal,
    holdReasons: finalHoldReasons,
  })
  return {
    businessDate: input.businessDate,
    restaurantName: input.restaurantName,
    available: orders.length > 0,
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
      total: totals.total,
      lineItems,
      itemizedTotal,
      unallocatedSubtotal,
    },
    journal: {
      kind: 'payment_settlement',
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
    readiness: {
      readyForReview: readiness.readyForReview,
      mappingsComplete: missing.size === 0,
      allocationComplete: readiness.allocationComplete,
      missingMappings: [...missing.values()],
      hold: readiness.hold,
      holdReasons: finalHoldReasons,
      openChecks: batch.openChecks,
      excludedOpenChecks: batch.excludedOpenChecks,
      postingEnabled: false,
    },
  }
}

async function resolveLocation(organizationId: string, restaurantGuid: string | null) {
  const result = await query<LocationRow>(
    `SELECT restaurant_guid::text, restaurant_name, location_name, analytics_access, standard_access
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

const SOURCE_ORDER_SELECT = `business_date, gross_sales::text, net_sales::text, discounts::text,
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

export async function readPosAccountingWorkspaceFromPostgres(input: {
  organizationId: string
  restaurantGuid: string | null
  businessDate: string
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
    customerResult,
    vendorResult,
    taxCodeResult,
    classResult,
    departmentResult,
    quickBooksConnectionResult,
    draftResult,
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
         AND business_date = $3::date AND deleted = false
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
    query<{
      status: string; reconciliation_status: string; approved_by: string | null
      approved_at: TimestampValue | null; posted_at: TimestampValue | null
      quickbooks_transaction_id: string | null; updated_at: TimestampValue
    }>(
      `SELECT status, reconciliation_status, approved_by, approved_at, posted_at,
         quickbooks_transaction_id, updated_at
       FROM toast_accounting_export_drafts
       WHERE organization_id = $1::uuid AND restaurant_guid = $2::uuid
         AND business_date = $3::date
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
  const scopedMappings = effectiveMappings(mappingResult.rows)
  const mappings = scopedMappings.effective
  const sourceCatalog = discoverSafePosSourceCatalog(sourceResult.rows).map((entry) => ({
    ...entry,
    mappings: mappings.filter((mapping) => (
      mapping.sourceKind === entry.sourceKind && mapping.sourceId === entry.sourceId
    )),
  }))
  const targetRevision = connection?.last_catalog_synced_at
    ? new Date(connection.last_catalog_synced_at).getTime()
    : 0
  const draft = draftResult.rows[0]
  const draftEvidence = draft ? {
    status: draft.status,
    reconciliationStatus: draft.reconciliation_status,
    approvedBy: draft.approved_by,
    approvedAt: iso(draft.approved_at),
    postedAt: iso(draft.posted_at),
    quickBooksTransactionId: draft.quickbooks_transaction_id,
    updatedAt: iso(draft.updated_at),
  } : null
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
      standardOnly: location.standard_access && !location.analytics_access,
      profile,
      mappings,
      orders: previewResult.rows,
      draftEvidence,
    }),
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
    const sourceResult = await client.query<SourceOrderRow>(
      `SELECT ${SOURCE_ORDER_SELECT}
       FROM toast_pos_orders
       WHERE organization_id = $1::uuid
         AND ($2::uuid IS NULL OR restaurant_guid = $2::uuid)
         AND deleted = false
       ORDER BY business_date DESC, updated_at DESC
       LIMIT 10000`,
      [input.organizationId, restaurantGuid],
    )
    const sourceRevision = catalogRevision(sourceResult.rows)
    const sourceKeys = new Set(discoverSafePosSourceCatalog(sourceResult.rows).map((entry) => (
      `${entry.sourceKind}:${entry.sourceId}`
    )))
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
         WHERE organization_id = $1::uuid AND active = true`,
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
    for (const mapping of input.mappings) {
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
      const historyResult = await client.query<{
        id: string; target_type: PosTargetType; mapping_revision: number; effective_to: TimestampValue | null
      }>(
        `SELECT id::text, target_type, mapping_revision, effective_to
         FROM pos_accounting_catalog_mappings
         WHERE organization_id = $1::uuid
           AND restaurant_guid IS NOT DISTINCT FROM $2::uuid
           AND source_kind = $3 AND source_id = $4
         ORDER BY mapping_revision DESC, created_at DESC
         FOR UPDATE`,
        [input.organizationId, restaurantGuid, mapping.sourceKind, mapping.sourceId],
      )
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
          mapping.sourceName,
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
      saved.push(mappingFromRow(result.rows[0]))
    }
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
        mappingCount: input.mappings.length,
        activeCount: input.mappings.filter((entry) => entry.active).length,
        sourceKinds: [...new Set(input.mappings.map((entry) => entry.sourceKind))],
        sourceCatalogRevision: sourceRevision,
        targetCatalogRevision: Number.isFinite(targetCatalogRevision) ? targetCatalogRevision : 0,
        validationStatuses: saved.reduce<Record<string, number>>((summary, mapping) => {
          summary[mapping.validationStatus] = (summary[mapping.validationStatus] || 0) + 1
          return summary
        }, {}),
      },
    }, client)
    return saved
  })
}
