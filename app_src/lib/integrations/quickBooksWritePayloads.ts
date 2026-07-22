import crypto from 'crypto'
import { query } from '@/lib/persistence/postgres'

export const QUICKBOOKS_WRITE_OPERATIONS = [
  'customer.create', 'item.create', 'invoice.create',
  'sales_receipt.create', 'journal_entry.create',
] as const

export type QuickBooksWriteOperationKind = typeof QUICKBOOKS_WRITE_OPERATIONS[number]

export type QuickBooksCustomerDraft = {
  displayName: string
  companyName: string | null
  givenName: string | null
  familyName: string | null
  email: string | null
  phone: string | null
  notes: string | null
  billingAddress: {
    line1: string | null
    line2: string | null
    city: string | null
    region: string | null
    postalCode: string | null
    country: string | null
  }
}

export type QuickBooksItemMappingScope = 'organization_default' | 'location_override'

export type QuickBooksItemDraft = {
  name: string
  itemType: 'Service' | 'NonInventory'
  sku: string | null
  description: string | null
  unitPrice: number
  purchaseCost: number
  incomeAccountId: string
  incomeAccountName: string
  expenseAccountId: string | null
  expenseAccountName: string | null
  parentCategoryId: string | null
  parentCategoryName: string | null
  taxable: boolean
  sourceKind: 'sales_item' | null
  sourceId: string | null
  sourceName: string | null
  sourceRestaurantGuid: string | null
  mappingScope: QuickBooksItemMappingScope | null
}

type QuickBooksItemSourceContext = Pick<
  QuickBooksItemDraft,
  'sourceKind' | 'sourceId' | 'sourceName' | 'sourceRestaurantGuid' | 'mappingScope'
>

export type QuickBooksInvoiceDraft = {
  customerId: string
  customerName: string
  transactionDate: string
  dueDate: string | null
  billingEmail: string | null
  customerMemo: string | null
  lines: Array<{
    itemId: string
    itemName: string
    description: string | null
    quantity: number
    unitPrice: number
    amount: number
  }>
  totalAmount: number
}

export type QuickBooksSalesReceiptDraft = {
  transactionDate: string
  customerId: string | null
  customerName: string | null
  depositToAccountId: string
  depositToAccountName: string
  taxCodeId: string | null
  taxCodeName: string | null
  taxAmount: number
  memo: string
  lines: Array<{
    itemId: string
    itemName: string
    description: string | null
    quantity: number
    unitPrice: number
    amount: number
    taxable: boolean
  }>
  totalAmount: number
}

export type QuickBooksJournalEntryDraft = {
  transactionDate: string
  memo: string
  lines: Array<{
    accountId: string
    accountName: string
    description: string | null
    postingType: 'Debit' | 'Credit'
    amount: number
  }>
  debitAmount: number
  creditAmount: number
}

export type QuickBooksWriteDraftPayload =
  | QuickBooksCustomerDraft
  | QuickBooksItemDraft
  | QuickBooksInvoiceDraft
  | QuickBooksSalesReceiptDraft
  | QuickBooksJournalEntryDraft

export class QuickBooksWriteValidationError extends Error {
  code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'QuickBooksWriteValidationError'
    this.code = code
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const ITEM_SOURCE_CONTEXT_FIELDS = [
  'sourceKind', 'sourceId', 'sourceName', 'sourceRestaurantGuid', 'mappingScope',
] as const

function objectValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new QuickBooksWriteValidationError('QUICKBOOKS_WRITE_PAYLOAD_INVALID', 'A valid accounting draft is required')
  }
  return value as Record<string, unknown>
}

function cleanText(value: unknown, label: string, maxLength: number, required = false): string | null {
  const cleaned = String(value || '').trim()
  if (!cleaned) {
    if (required) throw new QuickBooksWriteValidationError('QUICKBOOKS_WRITE_FIELD_REQUIRED', `${label} is required`)
    return null
  }
  if (cleaned.length > maxLength || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(cleaned)) {
    throw new QuickBooksWriteValidationError('QUICKBOOKS_WRITE_FIELD_INVALID', `${label} is invalid`)
  }
  return cleaned
}

function emailValue(value: unknown, label: string): string | null {
  const email = cleanText(value, label, 254)
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new QuickBooksWriteValidationError('QUICKBOOKS_WRITE_EMAIL_INVALID', `${label} must be a valid email address`)
  }
  return email
}

function numberValue(value: unknown, label: string, options: { min: number; max: number; required?: boolean }): number {
  if ((value === '' || value === null || value === undefined) && !options.required) return 0
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < options.min || parsed > options.max) {
    throw new QuickBooksWriteValidationError('QUICKBOOKS_WRITE_NUMBER_INVALID', `${label} is outside the supported range`)
  }
  return Math.round((parsed + Number.EPSILON) * 1_000_000) / 1_000_000
}

function dateValue(value: unknown, label: string, required = false): string | null {
  const date = cleanText(value, label, 10, required)
  if (!date) return null
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  const year = Number(match?.[1])
  const month = Number(match?.[2])
  const day = Number(match?.[3])
  const parsed = new Date(Date.UTC(year, month - 1, day))
  const valid = Boolean(match)
    && parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day
  if (!valid) {
    throw new QuickBooksWriteValidationError('QUICKBOOKS_WRITE_DATE_INVALID', `${label} must be a valid date`)
  }
  return date
}

function operationValue(value: unknown): QuickBooksWriteOperationKind {
  const operation = String(value || '') as QuickBooksWriteOperationKind
  if (!(['customer.create', 'item.create', 'invoice.create'] as const).includes(
    operation as 'customer.create' | 'item.create' | 'invoice.create',
  )) {
    throw new QuickBooksWriteValidationError('QUICKBOOKS_WRITE_OPERATION_INVALID', 'The accounting operation is not supported')
  }
  return operation
}

async function validateItemSourceContext(
  organizationId: string,
  raw: Record<string, unknown>,
): Promise<QuickBooksItemSourceContext> {
  const requested = ITEM_SOURCE_CONTEXT_FIELDS.some((field) => (
    raw[field] !== undefined && raw[field] !== null && String(raw[field]).trim() !== ''
  ))
  if (!requested) {
    return {
      sourceKind: null,
      sourceId: null,
      sourceName: null,
      sourceRestaurantGuid: null,
      mappingScope: null,
    }
  }

  const sourceKind = cleanText(raw.sourceKind, 'POS source kind', 80, true)
  if (sourceKind !== 'sales_item') {
    throw new QuickBooksWriteValidationError(
      'QUICKBOOKS_WRITE_TOAST_SOURCE_KIND_INVALID',
      'QuickBooks product mapping requires a Toast sales item source',
    )
  }
  const requestedSourceId = cleanText(raw.sourceId, 'Toast source item ID', 200, true)!
  if (requestedSourceId.startsWith('derived:')) {
    throw new QuickBooksWriteValidationError(
      'QUICKBOOKS_WRITE_TOAST_SOURCE_DERIVED',
      'A derived POS source cannot be mapped automatically; select an exact Toast menu item',
    )
  }
  if (!UUID_PATTERN.test(requestedSourceId)) {
    throw new QuickBooksWriteValidationError(
      'QUICKBOOKS_WRITE_TOAST_SOURCE_INVALID',
      'Select an exact Toast menu item before preparing a mapped QuickBooks product',
    )
  }
  const sourceRestaurantGuid = cleanText(raw.sourceRestaurantGuid, 'Toast restaurant', 36, true)!
  if (!UUID_PATTERN.test(sourceRestaurantGuid)) {
    throw new QuickBooksWriteValidationError(
      'QUICKBOOKS_WRITE_TOAST_RESTAURANT_INVALID',
      'Select a valid Toast location before preparing a mapped QuickBooks product',
    )
  }
  const mappingScopeValue = cleanText(raw.mappingScope, 'POS accounting mapping scope', 32, true)
  if (mappingScopeValue !== 'organization_default' && mappingScopeValue !== 'location_override') {
    throw new QuickBooksWriteValidationError(
      'QUICKBOOKS_WRITE_MAPPING_SCOPE_INVALID',
      'POS accounting mapping scope must be an organization default or location override',
    )
  }
  const mappingScope: QuickBooksItemMappingScope = mappingScopeValue

  const sourceId = requestedSourceId.toLowerCase()
  const restaurantGuid = sourceRestaurantGuid.toLowerCase()
  const sourceResult = await query<{ provider_item_id: string; name: string }>(
    `SELECT provider_item_id, name
     FROM toast_menu_catalog_items
     WHERE organization_id = $1::uuid
       AND restaurant_guid = $2::uuid
       AND source_provider = 'toast'
       AND provider_item_id = $3
       AND active = true AND archived = false
     ORDER BY source_revision DESC, updated_at DESC, menu_guid, group_guid
     LIMIT 1`,
    [organizationId, restaurantGuid, sourceId],
  )
  const source = sourceResult.rows[0]
  if (!source || source.provider_item_id.toLowerCase() !== sourceId) {
    throw new QuickBooksWriteValidationError(
      'QUICKBOOKS_WRITE_TOAST_SOURCE_INVALID',
      'The Toast menu item was not found in the selected organization and location',
    )
  }
  return {
    sourceKind: 'sales_item' as const,
    sourceId,
    sourceName: cleanText(source.name, 'Toast source item name', 240, true)!,
    sourceRestaurantGuid: restaurantGuid,
    mappingScope,
  }
}

async function validateCustomerDraft(organizationId: string, raw: Record<string, unknown>): Promise<QuickBooksCustomerDraft> {
  void organizationId
  const address = raw.billingAddress ? objectValue(raw.billingAddress) : {}
  return {
    displayName: cleanText(raw.displayName, 'Customer display name', 100, true)!,
    companyName: cleanText(raw.companyName, 'Company name', 100),
    givenName: cleanText(raw.givenName, 'First name', 100),
    familyName: cleanText(raw.familyName, 'Last name', 100),
    email: emailValue(raw.email, 'Customer email'),
    phone: cleanText(raw.phone, 'Customer phone', 30),
    notes: cleanText(raw.notes, 'Customer notes', 1_000),
    billingAddress: {
      line1: cleanText(address.line1, 'Address line 1', 255),
      line2: cleanText(address.line2, 'Address line 2', 255),
      city: cleanText(address.city, 'City', 100),
      region: cleanText(address.region, 'State or region', 100),
      postalCode: cleanText(address.postalCode, 'Postal code', 30),
      country: cleanText(address.country, 'Country', 100),
    },
  }
}

async function validateItemDraft(organizationId: string, raw: Record<string, unknown>): Promise<QuickBooksItemDraft> {
  const itemType = String(raw.itemType || '')
  if (itemType !== 'Service' && itemType !== 'NonInventory') {
    throw new QuickBooksWriteValidationError('QUICKBOOKS_WRITE_ITEM_TYPE_INVALID', 'Product type must be Service or Non-inventory')
  }
  const incomeAccountId = cleanText(raw.incomeAccountId, 'Income account', 200, true)!
  const expenseAccountId = cleanText(raw.expenseAccountId, 'Expense account', 200)
  const parentCategoryId = cleanText(raw.parentCategoryId, 'QuickBooks category', 200)
  const ids = [incomeAccountId, expenseAccountId].filter(Boolean) as string[]
  const accounts = await query<{
    quickbooks_account_id: string
    fully_qualified_name: string
    classification: string | null
    account_type: string | null
  }>(
    `SELECT quickbooks_account_id, fully_qualified_name, classification, account_type
     FROM quickbooks_accounts
     WHERE organization_id = $1::uuid AND quickbooks_account_id = ANY($2::text[]) AND active = true`,
    [organizationId, ids],
  )
  const byId = new Map(accounts.rows.map((account) => [account.quickbooks_account_id, account]))
  const income = byId.get(incomeAccountId)
  if (!income || (income.classification !== 'Revenue' && !/income/i.test(income.account_type || ''))) {
    throw new QuickBooksWriteValidationError('QUICKBOOKS_WRITE_INCOME_ACCOUNT_INVALID', 'Select an active QuickBooks income account')
  }
  const expense = expenseAccountId ? byId.get(expenseAccountId) : null
  if (expenseAccountId && (!expense || (expense.classification !== 'Expense' && !/expense|cost of goods sold/i.test(expense.account_type || '')))) {
    throw new QuickBooksWriteValidationError('QUICKBOOKS_WRITE_EXPENSE_ACCOUNT_INVALID', 'Select an active QuickBooks expense account')
  }
  const categoryResult = parentCategoryId
    ? await query<{ quickbooks_item_id: string; fully_qualified_name: string }>(
        `SELECT quickbooks_item_id, fully_qualified_name
         FROM quickbooks_items
         WHERE organization_id = $1::uuid AND quickbooks_item_id = $2
           AND active = true AND lower(item_type) = 'category'
         LIMIT 1`,
        [organizationId, parentCategoryId],
      )
    : { rows: [] }
  const parentCategory = categoryResult.rows[0]
  if (parentCategoryId && !parentCategory) {
    throw new QuickBooksWriteValidationError('QUICKBOOKS_WRITE_PARENT_CATEGORY_INVALID', 'Select an active QuickBooks product category')
  }
  const sourceContext = await validateItemSourceContext(organizationId, raw)
  return {
    name: cleanText(raw.name, 'Product or service name', 100, true)!,
    itemType,
    sku: cleanText(raw.sku, 'SKU', 100),
    description: cleanText(raw.description, 'Description', 1_000),
    unitPrice: numberValue(raw.unitPrice, 'Sales price', { min: 0, max: 1_000_000_000 }),
    purchaseCost: numberValue(raw.purchaseCost, 'Purchase cost', { min: 0, max: 1_000_000_000 }),
    incomeAccountId,
    incomeAccountName: income.fully_qualified_name,
    expenseAccountId,
    expenseAccountName: expense?.fully_qualified_name || null,
    parentCategoryId,
    parentCategoryName: parentCategory?.fully_qualified_name || null,
    taxable: raw.taxable === true,
    ...sourceContext,
  }
}

async function validateInvoiceDraft(organizationId: string, raw: Record<string, unknown>): Promise<QuickBooksInvoiceDraft> {
  const customerId = cleanText(raw.customerId, 'Customer', 200, true)!
  const customerResult = await query<{ display_name: string; email: string | null }>(
    `SELECT display_name, email FROM quickbooks_customers
     WHERE organization_id = $1::uuid AND quickbooks_customer_id = $2 AND active = true LIMIT 1`,
    [organizationId, customerId],
  )
  const customer = customerResult.rows[0]
  if (!customer) throw new QuickBooksWriteValidationError('QUICKBOOKS_WRITE_CUSTOMER_INVALID', 'Select an active QuickBooks customer')

  const transactionDate = dateValue(raw.transactionDate, 'Invoice date', true)!
  const dueDate = dateValue(raw.dueDate, 'Due date')
  if (dueDate && dueDate < transactionDate) {
    throw new QuickBooksWriteValidationError('QUICKBOOKS_WRITE_DUE_DATE_INVALID', 'Due date cannot be before the invoice date')
  }
  if (!Array.isArray(raw.lines) || raw.lines.length < 1 || raw.lines.length > 100) {
    throw new QuickBooksWriteValidationError('QUICKBOOKS_WRITE_LINES_INVALID', 'Invoice requires between 1 and 100 line items')
  }
  const requestedLines = raw.lines.map((line) => objectValue(line))
  const itemIds = [...new Set(requestedLines.map((line) => cleanText(line.itemId, 'Line item', 200, true)!))]
  const itemResult = await query<{ quickbooks_item_id: string; name: string; item_type: string }>(
    `SELECT quickbooks_item_id, name, item_type FROM quickbooks_items
     WHERE organization_id = $1::uuid AND quickbooks_item_id = ANY($2::text[]) AND active = true`,
    [organizationId, itemIds],
  )
  const byId = new Map(itemResult.rows.map((item) => [item.quickbooks_item_id, item]))
  const lines = requestedLines.map((line, index) => {
    const itemId = cleanText(line.itemId, `Line ${index + 1} item`, 200, true)!
    const item = byId.get(itemId)
    if (!item || item.item_type.toLowerCase() === 'category') {
      throw new QuickBooksWriteValidationError('QUICKBOOKS_WRITE_ITEM_INVALID', `Line ${index + 1} requires an active QuickBooks product or service`)
    }
    const quantity = numberValue(line.quantity, `Line ${index + 1} quantity`, { min: 0.000001, max: 1_000_000, required: true })
    const unitPrice = numberValue(line.unitPrice, `Line ${index + 1} unit price`, { min: 0, max: 1_000_000_000, required: true })
    const amount = Math.round((quantity * unitPrice + Number.EPSILON) * 100) / 100
    return {
      itemId,
      itemName: item.name,
      description: cleanText(line.description, `Line ${index + 1} description`, 1_000),
      quantity,
      unitPrice,
      amount,
    }
  })
  const totalAmount = Math.round((lines.reduce((sum, line) => sum + line.amount, 0) + Number.EPSILON) * 100) / 100
  if (totalAmount <= 0 || totalAmount > 1_000_000_000_000) {
    throw new QuickBooksWriteValidationError('QUICKBOOKS_WRITE_TOTAL_INVALID', 'Invoice total must be greater than zero and within the supported range')
  }
  return {
    customerId,
    customerName: customer.display_name,
    transactionDate,
    dueDate,
    billingEmail: emailValue(raw.billingEmail || customer.email, 'Billing email'),
    customerMemo: cleanText(raw.customerMemo, 'Customer memo', 1_000),
    lines,
    totalAmount,
  }
}

export async function validateQuickBooksWriteDraft(input: {
  organizationId: string
  operationKind: unknown
  payload: unknown
}) {
  const operationKind = operationValue(input.operationKind)
  const raw = objectValue(input.payload)
  const payload = operationKind === 'customer.create'
    ? await validateCustomerDraft(input.organizationId, raw)
    : operationKind === 'item.create'
      ? await validateItemDraft(input.organizationId, raw)
      : await validateInvoiceDraft(input.organizationId, raw)
  const serialized = JSON.stringify(payload)
  return {
    operationKind,
    payload,
    requestFingerprint: crypto.createHash('sha256').update(serialized).digest('hex'),
  }
}

export function fingerprintQuickBooksWritePayload(payload: QuickBooksWriteDraftPayload) {
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex')
}

function compactObject(value: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(value).filter(([, candidate]) => candidate !== null && candidate !== undefined && candidate !== ''))
}

export function buildQuickBooksProviderPayload(
  operationKind: QuickBooksWriteOperationKind,
  payload: QuickBooksWriteDraftPayload,
): Record<string, unknown> {
  if (operationKind === 'customer.create') {
    const customer = payload as QuickBooksCustomerDraft
    const address = compactObject({
      Line1: customer.billingAddress.line1,
      Line2: customer.billingAddress.line2,
      City: customer.billingAddress.city,
      CountrySubDivisionCode: customer.billingAddress.region,
      PostalCode: customer.billingAddress.postalCode,
      Country: customer.billingAddress.country,
    })
    return compactObject({
      DisplayName: customer.displayName,
      CompanyName: customer.companyName,
      GivenName: customer.givenName,
      FamilyName: customer.familyName,
      PrimaryEmailAddr: customer.email ? { Address: customer.email } : null,
      PrimaryPhone: customer.phone ? { FreeFormNumber: customer.phone } : null,
      Notes: customer.notes,
      BillAddr: Object.keys(address).length ? address : null,
    })
  }
  if (operationKind === 'item.create') {
    const item = payload as QuickBooksItemDraft
    return compactObject({
      Name: item.name,
      Type: item.itemType,
      Sku: item.sku,
      Description: item.description,
      UnitPrice: item.unitPrice,
      PurchaseCost: item.purchaseCost,
      IncomeAccountRef: { value: item.incomeAccountId },
      ExpenseAccountRef: item.expenseAccountId ? { value: item.expenseAccountId } : null,
      SubItem: item.parentCategoryId ? true : null,
      ParentRef: item.parentCategoryId ? { value: item.parentCategoryId } : null,
      Taxable: item.taxable,
    })
  }
  if (operationKind === 'sales_receipt.create') {
    const receipt = payload as QuickBooksSalesReceiptDraft
    const taxable = Boolean(receipt.taxCodeId && receipt.taxAmount > 0)
    return compactObject({
      CustomerRef: receipt.customerId ? { value: receipt.customerId } : null,
      DepositToAccountRef: { value: receipt.depositToAccountId },
      TxnDate: receipt.transactionDate,
      PrivateNote: receipt.memo,
      CustomerMemo: { value: receipt.memo },
      Line: receipt.lines.map((line) => compactObject({
        Amount: line.amount,
        DetailType: 'SalesItemLineDetail',
        Description: line.description,
        SalesItemLineDetail: compactObject({
          ItemRef: { value: line.itemId },
          Qty: line.quantity,
          UnitPrice: line.unitPrice,
          TaxCodeRef: taxable && line.taxable ? { value: 'TAX' } : { value: 'NON' },
        }),
      })),
      TxnTaxDetail: taxable ? {
        TxnTaxCodeRef: { value: receipt.taxCodeId },
      } : null,
    })
  }
  if (operationKind === 'journal_entry.create') {
    const journal = payload as QuickBooksJournalEntryDraft
    return {
      TxnDate: journal.transactionDate,
      PrivateNote: journal.memo,
      Line: journal.lines.map((line) => ({
        Amount: line.amount,
        DetailType: 'JournalEntryLineDetail',
        Description: line.description,
        JournalEntryLineDetail: {
          PostingType: line.postingType,
          AccountRef: { value: line.accountId },
        },
      })),
    }
  }
  const invoice = payload as QuickBooksInvoiceDraft
  return compactObject({
    CustomerRef: { value: invoice.customerId },
    TxnDate: invoice.transactionDate,
    DueDate: invoice.dueDate,
    BillEmail: invoice.billingEmail ? { Address: invoice.billingEmail } : null,
    CustomerMemo: invoice.customerMemo ? { value: invoice.customerMemo } : null,
    Line: invoice.lines.map((line) => compactObject({
      Amount: line.amount,
      DetailType: 'SalesItemLineDetail',
      Description: line.description,
      SalesItemLineDetail: {
        ItemRef: { value: line.itemId },
        Qty: line.quantity,
        UnitPrice: line.unitPrice,
      },
    })),
  })
}

export function quickBooksProviderEntity(operationKind: QuickBooksWriteOperationKind) {
  if (operationKind === 'customer.create') return { path: 'customer', responseKey: 'Customer' }
  if (operationKind === 'item.create') return { path: 'item', responseKey: 'Item' }
  if (operationKind === 'sales_receipt.create') return { path: 'salesreceipt', responseKey: 'SalesReceipt' }
  if (operationKind === 'journal_entry.create') return { path: 'journalentry', responseKey: 'JournalEntry' }
  return { path: 'invoice', responseKey: 'Invoice' }
}
