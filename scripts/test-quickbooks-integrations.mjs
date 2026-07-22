#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import vm from 'node:vm'
import {
  parseQuickBooksAccounts,
  parseQuickBooksAttachments,
  parseQuickBooksCompanyInfo,
  parseQuickBooksClasses,
  parseQuickBooksCustomers,
  parseQuickBooksDepartments,
  parseQuickBooksFinancialReport,
  parseQuickBooksInvoiceDetail,
  parseQuickBooksItems,
  parseQuickBooksTaxCodes,
  parseQuickBooksTransactions,
  parseQuickBooksVendors,
} from '../app_src/lib/integrations/quickBooksCatalog.mjs'

const root = process.cwd()
const nodeRequire = createRequire(import.meta.url)
const requireFromApp = createRequire(new URL('../app_src/package.json', import.meta.url))
const ts = requireFromApp('typescript')

function read(path) {
  return readFileSync(resolve(root, path), 'utf8')
}

function includes(source, fragment, label) {
  assert.ok(source.includes(fragment), `${label} missing ${fragment}`)
}

function loadTypeScriptModule(path, mocks = {}) {
  const output = ts.transpileModule(read(path), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: path,
  }).outputText
  const module = { exports: {} }
  const sandbox = {
    Buffer,
    console,
    exports: module.exports,
    module,
    process,
    require(specifier) {
      if (Object.prototype.hasOwnProperty.call(mocks, specifier)) return mocks[specifier]
      return nodeRequire(specifier)
    },
  }
  vm.runInNewContext(output, sandbox, { filename: path })
  return module.exports
}

const quickBooksWritePersistenceMocks = {
  '@/lib/persistence/posAccountingPosting': {
    synchronizePosAccountingPostingBatchForRequest: async () => null,
  },
}

assert.deepEqual(
  parseQuickBooksCompanyInfo({ CompanyInfo: { CompanyName: ' Example Co ', Country: 'US' } }),
  {
    companyName: 'Example Co',
    country: 'US',
    legalName: null,
    email: null,
    phone: null,
    address: { lines: [], city: null, region: null, postalCode: null, country: null },
  },
)
assert.throws(() => parseQuickBooksCompanyInfo({ CompanyInfo: {} }), /company name/)

const accounts = parseQuickBooksAccounts({
  QueryResponse: {
    Account: [
      { Id: '1', Name: 'Sales', FullyQualifiedName: 'Income:Sales', Active: true, AccountType: 'Income' },
      { Id: '', Name: 'Invalid' },
    ],
  },
})
assert.equal(accounts.length, 1)
assert.equal(accounts[0].fullyQualifiedName, 'Income:Sales')
assert.equal(accounts[0].sourcePayload.Id, '1')

const items = parseQuickBooksItems({
  QueryResponse: {
    Item: [
      {
        Id: '10', Name: 'Consulting', Type: 'Service', UnitPrice: 125,
        IncomeAccountRef: { value: '1' }, Active: true,
      },
      { Id: '11', Name: 'Negative price', Type: 'Service', UnitPrice: -1 },
      { Id: '12', Name: 'Breakfast Sandwiches', FullyQualifiedName: 'Breakfast:Breakfast Sandwiches', Type: 'Category', Active: true },
      { Name: 'Invalid' },
    ],
  },
})
assert.equal(items.length, 3)
assert.equal(items[0].incomeAccountId, '1')
assert.equal(items[1].unitPrice, 0)
assert.equal(items[2].itemType, 'Category')
assert.equal(items[2].fullyQualifiedName, 'Breakfast:Breakfast Sandwiches')

const customers = parseQuickBooksCustomers({
  QueryResponse: {
    Customer: [{
      Id: '20', DisplayName: 'Acme Buyer', CompanyName: 'Acme', Balance: 250,
      PrimaryEmailAddr: { Address: 'buyer@example.com' }, Active: true,
    }],
  },
})
assert.equal(customers[0].displayName, 'Acme Buyer')
assert.equal(customers[0].balance, 250)

const vendors = parseQuickBooksVendors({
  QueryResponse: { Vendor: [{ Id: '30', DisplayName: 'Supply Co', Balance: 80 }] },
})
assert.equal(vendors[0].displayName, 'Supply Co')

const classes = parseQuickBooksClasses({
  QueryResponse: { Class: [{ Id: '31', Name: 'Food truck', FullyQualifiedName: 'Operations:Food truck', SubClass: true, ParentRef: { value: '30' } }] },
})
assert.equal(classes[0].fullyQualifiedName, 'Operations:Food truck')
assert.equal(classes[0].parentId, '30')

const departments = parseQuickBooksDepartments({
  QueryResponse: { Department: [{ Id: '32', Name: 'Hartford', Active: true }] },
})
assert.equal(departments[0].name, 'Hartford')
assert.equal(departments[0].active, true)

const taxCodes = parseQuickBooksTaxCodes({
  QueryResponse: { TaxCode: [{ Id: '33', Name: 'CT Meals', Description: 'Connecticut meals tax', Taxable: true }] },
})
assert.equal(taxCodes[0].taxable, true)
assert.equal(taxCodes[0].description, 'Connecticut meals tax')

const invoices = parseQuickBooksTransactions({
  QueryResponse: {
    Invoice: [{
      Id: '40', DocNumber: '1001', TxnDate: '2026-07-18', DueDate: '2026-08-18',
      CustomerRef: { value: '20', name: 'Acme Buyer' }, TotalAmt: 500, Balance: 200,
      CurrencyRef: { value: 'USD' },
    }],
  },
}, 'Invoice')
assert.equal(invoices[0].entityType, 'Invoice')
assert.equal(invoices[0].partyName, 'Acme Buyer')
assert.equal(invoices[0].status, 'Open')

const journalEntries = parseQuickBooksTransactions({
  QueryResponse: {
    JournalEntry: [{
      Id: '41', DocNumber: '260718POS-JE', TxnDate: '2026-07-18', PrivateNote: 'Toast 2026-07-18',
      Line: [{
        Id: '1', Amount: 592.32, DetailType: 'JournalEntryLineDetail',
        JournalEntryLineDetail: { PostingType: 'Debit', AccountRef: { value: '100', name: 'Clearing Account' } },
      }, {
        Id: '2', Amount: 592.32, DetailType: 'JournalEntryLineDetail',
        JournalEntryLineDetail: { PostingType: 'Credit', AccountRef: { value: '101', name: 'POS Sales' } },
      }],
    }],
  },
}, 'JournalEntry')
assert.equal(journalEntries[0].entityType, 'JournalEntry')
assert.equal(journalEntries[0].documentNumber, '260718POS-JE')
assert.equal(journalEntries[0].transactionDate, '2026-07-18')
assert.equal(journalEntries[0].memo, 'Toast 2026-07-18')
assert.equal(journalEntries[0].totalAmount, 592.32)
assert.equal(journalEntries[0].accountName, 'Clearing Account')
assert.equal(journalEntries[0].sourcePayload.Line.length, 2)

const invoiceDetail = parseQuickBooksInvoiceDetail({
  Id: '40', DocNumber: '1001', TxnDate: '2026-07-18', DueDate: '2026-08-18',
  CustomerRef: { value: '20', name: 'Acme Buyer' }, TotalAmt: 527.5, Balance: 527.5,
  CurrencyRef: { value: 'USD' }, BillEmail: { Address: 'buyer@example.com' },
  BillAddr: { Line1: '100 Main St', City: 'Boston', CountrySubDivisionCode: 'MA', PostalCode: '02110' },
  TxnTaxDetail: { TotalTax: 27.5 },
  Line: [
    {
      Id: '1', DetailType: 'SalesItemLineDetail', Description: 'Implementation services', Amount: 500,
      SalesItemLineDetail: { ItemRef: { value: '10', name: 'Consulting' }, Qty: 4, UnitPrice: 125 },
    },
    { Id: '2', DetailType: 'SubTotalLineDetail', Amount: 500, SubTotalLineDetail: {} },
  ],
})
assert.equal(invoiceDetail.lines[0].itemName, 'Consulting')
assert.equal(invoiceDetail.lines[0].quantity, 4)
assert.equal(invoiceDetail.lines[0].unitPrice, 125)
assert.equal(invoiceDetail.subtotal, 500)
assert.equal(invoiceDetail.totalTax, 27.5)

const financialReport = parseQuickBooksFinancialReport({
  Header: {
    ReportName: 'ProfitAndLoss', ReportBasis: 'Accrual', StartPeriod: '2026-01-01',
    EndPeriod: '2026-07-18', Currency: 'USD', Time: '2026-07-18T12:00:00Z',
    Option: [{ Name: 'NoReportData', Value: 'false' }],
  },
  Columns: { Column: [{ ColTitle: 'Account', ColType: 'Account' }, { ColTitle: 'Total', ColType: 'Money' }] },
  Rows: {
    Row: [{
      type: 'Section', group: 'Income', Header: { ColData: [{ value: 'Income' }] },
      Rows: { Row: [{ type: 'Data', ColData: [{ value: 'Sales' }, { value: '500.00' }] }] },
      Summary: { ColData: [{ value: 'Total Income' }, { value: '500.00' }] },
    }],
  },
})
assert.equal(financialReport.reportBasis, 'Accrual')
assert.equal(financialReport.rows.length, 3)
assert.deepEqual(financialReport.rows.map((row) => row.kind), ['section', 'data', 'summary'])

const attachments = parseQuickBooksAttachments({
  QueryResponse: {
    Attachable: [{
      Id: '50', FileName: 'receipt.pdf', ContentType: 'application/pdf', Size: 1024,
      AttachableRef: [{ EntityRef: { value: '40', type: 'Invoice', name: '1001' } }],
    }],
  },
})
assert.equal(attachments[0].fileName, 'receipt.pdf')
assert.equal(attachments[0].entityReferences[0].type, 'Invoice')

const migration = read('db/migrations/0061_quickbooks_organization_connector.sql')
for (const fragment of [
  'CREATE TABLE IF NOT EXISTS organization_quickbooks_connections',
  'maton_connection_id text NOT NULL UNIQUE',
  'CREATE TABLE IF NOT EXISTS quickbooks_accounts',
  'CREATE TABLE IF NOT EXISTS quickbooks_items',
  'CREATE TABLE IF NOT EXISTS quickbooks_sync_outbox',
  'REFERENCES organization_quickbooks_connections(organization_id) ON DELETE CASCADE',
  'UNIQUE (organization_id, sync_kind)',
  "status IN ('pending', 'processing', 'succeeded', 'failed', 'dead')",
]) includes(migration, fragment, 'QuickBooks migration')

const explorerMigration = read('db/migrations/0062_quickbooks_financial_explorer.sql')
for (const fragment of [
  'CREATE TABLE IF NOT EXISTS quickbooks_customers',
  'CREATE TABLE IF NOT EXISTS quickbooks_vendors',
  'CREATE TABLE IF NOT EXISTS quickbooks_transactions',
  'CREATE TABLE IF NOT EXISTS quickbooks_attachments',
  'idx_quickbooks_transactions_open',
]) includes(explorerMigration, fragment, 'QuickBooks explorer migration')

const accountingCatalogMigration = read('db/migrations/0071_quickbooks_accounting_reference_catalogs.sql')
for (const fragment of [
  'CREATE TABLE IF NOT EXISTS quickbooks_tax_codes',
  'CREATE TABLE IF NOT EXISTS quickbooks_classes',
  'CREATE TABLE IF NOT EXISTS quickbooks_departments',
  'REFERENCES organization_quickbooks_connections(organization_id) ON DELETE CASCADE',
]) includes(accountingCatalogMigration, fragment, 'QuickBooks accounting reference catalogs migration')

const reportMigration = read('db/migrations/0063_quickbooks_financial_reports.sql')
for (const fragment of [
  "ADD COLUMN IF NOT EXISTS company_profile jsonb",
  'CREATE TABLE IF NOT EXISTS quickbooks_financial_reports',
  "report_key IN ('profit_loss', 'balance_sheet', 'cash_flow', 'ar_aging', 'ap_aging')",
  'PRIMARY KEY (organization_id, report_key, period_key)',
]) includes(reportMigration, fragment, 'QuickBooks financial report migration')

const writeMigration = read('db/migrations/0064_quickbooks_write_control.sql')
for (const fragment of [
  "write_mode IN ('sandbox', 'production')",
  'write_verified_at IS NOT NULL',
  'write_verified_by IS NOT NULL',
  'CREATE TABLE IF NOT EXISTS quickbooks_write_requests',
  "operation_kind IN ('customer.create', 'item.create', 'invoice.create')",
  "status IN ('draft', 'pending_approval', 'approved', 'processing', 'succeeded', 'failed', 'dead', 'cancelled')",
  'REFERENCES workspace_organizations(id) ON DELETE CASCADE',
  'UNIQUE (organization_id, client_request_id)',
  'UNIQUE (organization_id, provider_request_id)',
  "request_fingerprint ~ '^[0-9a-f]{64}$'",
  'attempt_count <= max_attempts',
  'idx_quickbooks_write_requests_due',
]) includes(writeMigration, fragment, 'QuickBooks write-control migration')

const writeBindingMigration = read('db/migrations/0068_quickbooks_write_connection_binding.sql')
for (const fragment of [
  'ADD COLUMN IF NOT EXISTS reviewed_maton_connection_id text',
  'DROP CONSTRAINT IF EXISTS quickbooks_write_reviewed_connection_required',
  "SET status = 'cancelled'",
  "RAISE EXCEPTION 'Cannot bind QuickBooks write requests while a legacy write is processing'",
  "reviewed_maton_connection_id IS NOT NULL OR status IN ('succeeded', 'cancelled')",
  'idx_quickbooks_write_requests_reviewed_connection',
]) includes(writeBindingMigration, fragment, 'QuickBooks write connection-binding migration')

const writeBindingCompatibilityMigration = read('db/migrations/0075_quickbooks_write_binding_compatibility.sql')
includes(
  writeBindingCompatibilityMigration,
  'DROP CONSTRAINT IF EXISTS quickbooks_write_reviewed_connection_required',
  'QuickBooks write connection-binding compatibility migration',
)

const posPostingMigration = read('db/migrations/0079_pos_accounting_posting_outcomes.sql')
for (const fragment of [
  "'sales_receipt.create', 'journal_entry.create'",
  'CREATE TABLE IF NOT EXISTS pos_accounting_posting_batches',
  'sales_receipt_request_id uuid NOT NULL UNIQUE',
  'journal_entry_request_id uuid NOT NULL UNIQUE',
  "review_outcome IN ('shogo_posted', 'clawpilot_post', 'needs_correction', 'skipped')",
  "status IN ('pending_approval', 'approved', 'posting', 'posted', 'partial_failed', 'failed', 'cancelled')",
]) includes(posPostingMigration, fragment, 'POS accounting posting migration')

const crmReconciliationMigration = read('db/migrations/0065_demo_and_quickbooks_crm_reconciliation.sql')
for (const fragment of [
  'crm_pipeline_id uuid REFERENCES pipeline_spaces(id) ON DELETE SET NULL',
  'crm_customer_sync_enabled boolean NOT NULL DEFAULT false',
  'crm_product_sync_enabled boolean NOT NULL DEFAULT false',
  'CREATE TABLE IF NOT EXISTS quickbooks_crm_links',
  "provider_entity_type IN ('customer', 'item')",
  "crm_entity_type IN ('organization', 'contact', 'product')",
]) includes(crmReconciliationMigration, fragment, 'QuickBooks CRM reconciliation migration')

const crmReconciliation = read('app_src/lib/persistence/quickBooksCrmSync.ts')
for (const fragment of [
  'configureQuickBooksCrmSyncInPostgres',
  'reconcileQuickBooksCatalogToCrmInPostgres',
  'quickbooks:customer:',
  'quickbooks:item:',
  'quickbooks_crm_links',
  'parentOrganizationId: workspaceRoot.rows[0].id',
  "relationship_type = 'workspace_root'",
  'const describesPerson = Boolean(givenName || familyName)',
  'syncPipelineProductDropdownCatalogInPostgres',
]) includes(crmReconciliation, fragment, 'QuickBooks CRM reconciliation adapter')

const client = read('app_src/lib/integrations/quickBooksClient.ts')
for (const fragment of [
  "app: 'quickbooks'",
  'boundConnectionId: connectionId',
  '/quickbooks/v3/company/:realmId/query',
  'STARTPOSITION ${startPosition} MAXRESULTS ${pageSize}',
  'TRANSACTION_PAGE_SIZE',
  'MAX_CATALOG_RECORDS',
  'MAX_RESPONSE_BYTES',
  'RETRYABLE_STATUSES',
  "response.headers.get('retry-after')",
  'for (const entity of TRANSACTION_ENTITIES)',
  "cache: 'no-store'",
  "'Invoice'",
  "'Attachable'",
  "'Class'",
  "'Department'",
  "'TaxCode'",
  "'JournalEntry'",
  'parseQuickBooksClasses',
  'parseQuickBooksDepartments',
  'parseQuickBooksTaxCodes',
  'parseQuickBooksTransactions',
  '/reports/${reportRequest.endpoint}',
  "'ProfitAndLoss'",
  "'CashFlow'",
  "'AgedReceivables'",
  "'attachable-thumbnail'",
  "SELECT * FROM Attachable WHERE Id = '${escapedAttachmentId}'",
  'ThumbnailTempDownloadUri',
  "Fall through to Maton's dedicated download resource.",
  'validatedAttachmentUrl',
  'readQuickBooksAttachmentDownloadUrl',
  'createQuickBooksEntity',
  'requestid: input.providerRequestId',
  "method: 'POST'",
  'buildQuickBooksProviderPayload',
  'QuickBooksProviderWriteError',
]) includes(client + read('app_src/lib/maton.ts'), fragment, 'QuickBooks client')
assert.ok(!client.includes('TRANSACTION_ENTITIES.map'), 'QuickBooks entity reads must remain paced')

const writePayloads = read('app_src/lib/integrations/quickBooksWritePayloads.ts')
for (const fragment of [
  'validateQuickBooksWriteDraft',
  'buildQuickBooksProviderPayload',
  "'customer.create', 'item.create', 'invoice.create'",
  "itemType !== 'Service' && itemType !== 'NonInventory'",
  "lower(item_type) = 'category'",
  'QUICKBOOKS_WRITE_PARENT_CATEGORY_INVALID',
  'Line ${index + 1} requires an active QuickBooks product or service',
  'Due date cannot be before the invoice date',
  "crypto.createHash('sha256')",
  "DetailType: 'SalesItemLineDetail'",
]) includes(writePayloads, fragment, 'QuickBooks write payload validation')

const writeOrganizationId = '11111111-1111-4111-8111-111111111111'
const toastRestaurantGuid = '22222222-2222-4222-8222-222222222222'
const toastSourceId = '14351ea1-ad68-4f2c-85e6-da00661bab4e'
const writePayloadModule = loadTypeScriptModule('app_src/lib/integrations/quickBooksWritePayloads.ts', {
  '@/lib/persistence/postgres': {
    query: async (sql, params = []) => {
      const source = String(sql)
      if (source.includes('FROM quickbooks_accounts')) {
        return { rows: (params[1] || []).map((id) => ({
          quickbooks_account_id: id,
          fully_qualified_name: id === 'income-1' ? 'Sales' : 'Cost of goods sold',
          classification: id === 'income-1' ? 'Revenue' : 'Expense',
          account_type: id === 'income-1' ? 'Income' : 'Cost of Goods Sold',
        })) }
      }
      if (source.includes('FROM quickbooks_customers')) {
        return { rows: params[1] === 'customer-1' ? [{ display_name: 'Acme Buyer', email: 'buyer@example.com' }] : [] }
      }
      if (source.includes('FROM quickbooks_items')) {
        if (source.includes("lower(item_type) = 'category'")) {
          return { rows: params[0] === writeOrganizationId && params[1] === 'category-1' ? [{
            quickbooks_item_id: 'category-1',
            fully_qualified_name: 'Breakfast:Breakfast Sandwiches',
          }] : [] }
        }
        return { rows: (params[1] || []).map((id) => ({ quickbooks_item_id: id, name: 'Consulting', item_type: 'Service' })) }
      }
      if (source.includes('FROM toast_menu_catalog_items')) {
        return {
          rows: params[0] === writeOrganizationId && params[1] === toastRestaurantGuid && params[2] === toastSourceId
            ? [{ provider_item_id: toastSourceId, name: 'Saratoga Springs - Sparkling Water' }]
            : [],
        }
      }
      return { rows: [] }
    },
  },
})

const customerDraft = await writePayloadModule.validateQuickBooksWriteDraft({
  organizationId: writeOrganizationId,
  operationKind: 'customer.create',
  payload: { displayName: ' Acme Buyer ', email: 'buyer@example.com', billingAddress: { city: 'Boston' } },
})
assert.equal(customerDraft.payload.displayName, 'Acme Buyer')
assert.match(customerDraft.requestFingerprint, /^[0-9a-f]{64}$/)
assert.deepEqual(
  JSON.parse(JSON.stringify(writePayloadModule.buildQuickBooksProviderPayload('customer.create', customerDraft.payload))),
  { DisplayName: 'Acme Buyer', PrimaryEmailAddr: { Address: 'buyer@example.com' }, BillAddr: { City: 'Boston' } },
)

const itemDraft = await writePayloadModule.validateQuickBooksWriteDraft({
  organizationId: writeOrganizationId,
  operationKind: 'item.create',
  payload: {
    name: 'Consulting', itemType: 'Service', unitPrice: 125, purchaseCost: 25,
    incomeAccountId: 'income-1', expenseAccountId: 'expense-1', parentCategoryId: 'category-1', taxable: false,
  },
})
assert.equal(itemDraft.payload.incomeAccountName, 'Sales')
assert.equal(itemDraft.payload.parentCategoryName, 'Breakfast:Breakfast Sandwiches')
const providerItem = writePayloadModule.buildQuickBooksProviderPayload('item.create', itemDraft.payload)
assert.equal(providerItem.Type, 'Service')
assert.equal(providerItem.SubItem, true)
assert.equal(providerItem.ParentRef.value, 'category-1')
const uncategorizedProviderItem = writePayloadModule.buildQuickBooksProviderPayload('item.create', {
  ...itemDraft.payload,
  parentCategoryId: null,
  parentCategoryName: null,
})
assert.equal(Object.hasOwn(uncategorizedProviderItem, 'SubItem'), false)
assert.equal(Object.hasOwn(uncategorizedProviderItem, 'ParentRef'), false)

const mappedItemPayload = {
  name: 'Saratoga Sparkling 12 oz', itemType: 'NonInventory', unitPrice: 3.5,
  incomeAccountId: 'income-1', taxable: true,
  sourceKind: 'sales_item', sourceId: toastSourceId, sourceName: 'Untrusted client label',
  sourceRestaurantGuid: toastRestaurantGuid, mappingScope: 'location_override',
}
const mappedItemDraft = await writePayloadModule.validateQuickBooksWriteDraft({
  organizationId: writeOrganizationId,
  operationKind: 'item.create',
  payload: mappedItemPayload,
})
assert.equal(mappedItemDraft.payload.sourceName, 'Saratoga Springs - Sparkling Water')
assert.equal(mappedItemDraft.payload.sourceId, toastSourceId)
assert.equal(mappedItemDraft.payload.sourceRestaurantGuid, toastRestaurantGuid)
assert.equal(mappedItemDraft.payload.mappingScope, 'location_override')
const mappedProviderItem = writePayloadModule.buildQuickBooksProviderPayload('item.create', mappedItemDraft.payload)
for (const metadataField of ['sourceKind', 'sourceId', 'sourceName', 'sourceRestaurantGuid', 'mappingScope']) {
  assert.equal(Object.hasOwn(mappedProviderItem, metadataField), false, `provider item payload leaked ${metadataField}`)
}
const mappedItemRetry = await writePayloadModule.validateQuickBooksWriteDraft({
  organizationId: writeOrganizationId,
  operationKind: 'item.create',
  payload: { ...mappedItemPayload, sourceName: 'A different untrusted label' },
})
assert.equal(mappedItemRetry.requestFingerprint, mappedItemDraft.requestFingerprint)
const organizationMappingDraft = await writePayloadModule.validateQuickBooksWriteDraft({
  organizationId: writeOrganizationId,
  operationKind: 'item.create',
  payload: { ...mappedItemPayload, mappingScope: 'organization_default' },
})
assert.notEqual(
  organizationMappingDraft.requestFingerprint,
  mappedItemDraft.requestFingerprint,
  'mapping scope must participate in QuickBooks write idempotency',
)
await assert.rejects(
  writePayloadModule.validateQuickBooksWriteDraft({
    organizationId: '99999999-9999-4999-8999-999999999999',
    operationKind: 'item.create',
    payload: mappedItemPayload,
  }),
  (error) => error.code === 'QUICKBOOKS_WRITE_TOAST_SOURCE_INVALID',
  'a Toast menu item owned by another organization must be rejected',
)
await assert.rejects(
  writePayloadModule.validateQuickBooksWriteDraft({
    organizationId: writeOrganizationId,
    operationKind: 'item.create',
    payload: { ...mappedItemPayload, sourceId: `derived:${'a'.repeat(32)}` },
  }),
  (error) => error.code === 'QUICKBOOKS_WRITE_TOAST_SOURCE_DERIVED',
)
await assert.rejects(
  writePayloadModule.validateQuickBooksWriteDraft({
    organizationId: '11111111-1111-4111-8111-111111111111',
    operationKind: 'item.create',
    payload: {
      name: 'Consulting', itemType: 'Service', unitPrice: 125,
      incomeAccountId: 'income-1', parentCategoryId: 'stale-category',
    },
  }),
  /active QuickBooks product category/,
)
await assert.rejects(
  writePayloadModule.validateQuickBooksWriteDraft({
    organizationId: '22222222-2222-4222-8222-222222222222',
    operationKind: 'item.create',
    payload: {
      name: 'Consulting', itemType: 'Service', unitPrice: 125,
      incomeAccountId: 'income-1', parentCategoryId: 'category-1',
    },
  }),
  /active QuickBooks product category/,
  'a category owned by another organization must not be accepted',
)

const invoiceDraft = await writePayloadModule.validateQuickBooksWriteDraft({
  organizationId: '11111111-1111-4111-8111-111111111111',
  operationKind: 'invoice.create',
  payload: {
    customerId: 'customer-1', transactionDate: '2026-07-19', dueDate: '2026-08-19',
    lines: [{ itemId: 'item-1', quantity: 2, unitPrice: 125, description: 'Implementation' }],
  },
})
assert.equal(invoiceDraft.payload.totalAmount, 250)
const providerInvoice = writePayloadModule.buildQuickBooksProviderPayload('invoice.create', invoiceDraft.payload)
assert.equal(providerInvoice.CustomerRef.value, 'customer-1')
assert.equal(providerInvoice.Line[0].SalesItemLineDetail.ItemRef.value, 'item-1')
assert.equal(providerInvoice.Line[0].Amount, 250)

const salesReceiptPayload = {
  transactionDate: '2026-07-18',
  customerId: 'customer-1',
  customerName: 'Toast clearing customer',
  depositToAccountId: 'clearing-1',
  depositToAccountName: 'POS clearing',
  taxCodeId: 'tax-code-1',
  taxCodeName: 'Sales Tax Meals',
  taxAmount: 4.06,
  memo: 'Toast 2026-07-18 - ClawPilot POS accounting',
  lines: [{
    itemId: 'item-breakfast', itemName: 'Breakfast Sandwich', description: 'B.E.C',
    quantity: 8, unitPrice: 10, amount: 80, taxable: true,
  }],
  totalAmount: 84.06,
}
const providerSalesReceipt = writePayloadModule.buildQuickBooksProviderPayload(
  'sales_receipt.create',
  salesReceiptPayload,
)
assert.equal(providerSalesReceipt.TxnDate, '2026-07-18')
assert.equal(providerSalesReceipt.PrivateNote, salesReceiptPayload.memo)
assert.equal(providerSalesReceipt.DepositToAccountRef.value, 'clearing-1')
assert.equal(providerSalesReceipt.Line.length, 1)
assert.equal(providerSalesReceipt.Line[0].SalesItemLineDetail.ItemRef.value, 'item-breakfast')
assert.equal(providerSalesReceipt.Line[0].SalesItemLineDetail.TaxCodeRef.value, 'TAX')
assert.equal(providerSalesReceipt.TxnTaxDetail.TxnTaxCodeRef.value, 'tax-code-1')
assert.equal(writePayloadModule.quickBooksProviderEntity('sales_receipt.create').path, 'salesreceipt')

const journalEntryPayload = {
  transactionDate: '2026-07-18',
  memo: 'Toast 2026-07-18 - ClawPilot POS accounting',
  lines: [{
    accountId: 'deposit-1', accountName: 'Bank deposit', description: 'Toast card deposit',
    postingType: 'Debit', amount: 81,
  }, {
    accountId: 'clearing-1', accountName: 'POS clearing', description: 'Toast card settlement',
    postingType: 'Credit', amount: 81,
  }],
  debitAmount: 81,
  creditAmount: 81,
}
const providerJournalEntry = writePayloadModule.buildQuickBooksProviderPayload(
  'journal_entry.create',
  journalEntryPayload,
)
assert.equal(providerJournalEntry.TxnDate, '2026-07-18')
assert.equal(providerJournalEntry.PrivateNote, journalEntryPayload.memo)
assert.equal(providerJournalEntry.Line.length, 2)
assert.equal(providerJournalEntry.Line[0].JournalEntryLineDetail.PostingType, 'Debit')
assert.equal(providerJournalEntry.Line[1].JournalEntryLineDetail.PostingType, 'Credit')
assert.equal(writePayloadModule.quickBooksProviderEntity('journal_entry.create').path, 'journalentry')
assert.notEqual(
  writePayloadModule.fingerprintQuickBooksWritePayload(salesReceiptPayload),
  writePayloadModule.fingerprintQuickBooksWritePayload(journalEntryPayload),
)
await assert.rejects(
  writePayloadModule.validateQuickBooksWriteDraft({
    organizationId: writeOrganizationId,
    operationKind: 'sales_receipt.create',
    payload: salesReceiptPayload,
  }),
  /operation is not supported/,
  'generic client-authored writes must not prepare internal POS posting operations',
)
await assert.rejects(
  writePayloadModule.validateQuickBooksWriteDraft({
    organizationId: '11111111-1111-4111-8111-111111111111',
    operationKind: 'invoice.create',
    payload: { customerId: 'customer-1', transactionDate: '2026-07-19', dueDate: '2026-07-18', lines: [{ itemId: 'item-1', quantity: 1, unitPrice: 1 }] },
  }),
  /Due date cannot be before/,
)
await assert.rejects(
  writePayloadModule.validateQuickBooksWriteDraft({
    organizationId: '11111111-1111-4111-8111-111111111111',
    operationKind: 'invoice.create',
    payload: { customerId: 'customer-1', transactionDate: '2026-02-31', lines: [{ itemId: 'item-1', quantity: 1, unitPrice: 1 }] },
  }),
  /must be a valid date/,
)

const preparedQuickBooksWrites = []
const actionsRouteCapabilities = { canView: true, canManage: false, canPrepare: true, canApprove: false }
const quickBooksActionsRoute = loadTypeScriptModule('app_src/app/api/accounting/quickbooks/actions/route.ts', {
  'next/server': {
    NextResponse: { json: (payload, init) => ({ status: init.status, json: async () => payload }) },
  },
  '@/lib/accountingAuthorization': {
    accountingCapabilities: () => actionsRouteCapabilities,
    activeAccountingOrganizationId: () => writeOrganizationId,
    canConfigureAccountingScope: (capabilities, scope) => capabilities.canManage || (capabilities.canPrepare && scope === 'location_override'),
  },
  '@/lib/integrations/quickBooksWritePayloads': {
    QuickBooksWriteValidationError: writePayloadModule.QuickBooksWriteValidationError,
    validateQuickBooksWriteDraft: async (input) => ({
      operationKind: input.operationKind,
      payload: input.payload,
      requestFingerprint: 'f'.repeat(64),
    }),
  },
  '@/lib/persistence/config': { isPostgresStorageEnabled: () => true },
  '@/lib/persistence/quickBooksWrites': {
    QuickBooksWriteRequestError: class QuickBooksWriteRequestError extends Error {
      constructor(code, message, status = 400) {
        super(message)
        this.code = code
        this.status = status
      }
    },
    createQuickBooksWriteRequestInPostgres: async (input) => {
      preparedQuickBooksWrites.push(input)
      return { id: '77777777-7777-4777-8777-777777777777' }
    },
    readQuickBooksWriteWorkspaceInPostgres: async () => ({}),
    transitionQuickBooksWriteRequestInPostgres: async () => ({}),
  },
  '@/lib/requestUser': { requireRequestUser: async () => ({ email: 'preparer@example.test' }) },
})
function quickBooksActionRequest(mappingScope) {
  const body = JSON.stringify({
    clientRequestId: '88888888-8888-4888-8888-888888888888',
    operationKind: 'item.create',
    payload: { ...mappedItemDraft.payload, mappingScope },
  })
  return {
    headers: { get: (name) => name === 'content-type' ? 'application/json' : String(Buffer.byteLength(body)) },
    text: async () => body,
  }
}
const deniedOrganizationMapping = await quickBooksActionsRoute.POST(quickBooksActionRequest('organization_default'))
assert.equal(deniedOrganizationMapping.status, 403)
assert.equal((await deniedOrganizationMapping.json()).code, 'POS_ACCOUNTING_ORGANIZATION_CONFIG_REQUIRED')
assert.equal(preparedQuickBooksWrites.length, 0)
const allowedLocationMapping = await quickBooksActionsRoute.POST(quickBooksActionRequest('location_override'))
assert.equal(allowedLocationMapping.status, 201)
assert.equal(preparedQuickBooksWrites.length, 1)

const persistence = read('app_src/lib/persistence/quickBooksIntegrations.ts')
for (const fragment of [
  'WHERE organization_id = $1::uuid',
  'FOR UPDATE SKIP LOCKED',
  "eventType: 'quickbooks.connection.bound'",
  "eventType: 'quickbooks.catalog.succeeded'",
  'quickbooks_account_id = NULL',
  "WHEN quickbooks_sync_outbox.status = 'dead' THEN 'dead'",
  "result_summary = '{}'::jsonb",
  'if (!failed.rowCount) return false',
  "status = 'needs_mapping'",
  'readQuickBooksWorkerHeartbeatFromPostgres',
  'quickbooks_transactions',
  'quickbooks_financial_reports',
  'reportsReady',
  'jsonb_to_recordset',
  'write_mode = CASE',
  'write_verified_at = CASE',
  'write_verified_by = CASE',
  "reason: 'connection_rebound'",
  "reason: 'connection_disconnected'",
  'invalidatePosAccountingQuickBooksBinding',
  'acquireTransactionAdvisoryLock',
  'FROM pos_accounting_profiles',
  "'unbound', NULL, NULL, NULL, NULL",
  'UPDATE pos_accounting_catalog_mappings SET effective_to = clock_timestamp()',
  "status IN ('draft', 'pending_approval', 'approved', 'failed', 'dead')",
  "status = 'processing'",
]) includes(persistence, fragment, 'QuickBooks persistence')
assert.ok(!persistence.includes('console.'), 'QuickBooks persistence must not log credentials or source payloads')

const writePersistence = read('app_src/lib/persistence/quickBooksWrites.ts')
for (const fragment of [
  'readQuickBooksWriteWorkspaceInPostgres',
  'createQuickBooksWriteRequestInPostgres',
  'transitionQuickBooksWriteRequestInPostgres',
  'claimQuickBooksWriteJobsInPostgres',
  'completeQuickBooksWriteJobInPostgres',
  'failQuickBooksWriteJobInPostgres',
  'FOR UPDATE OF request, connection SKIP LOCKED',
  "status = 'processing'",
  'request.attempt_count < request.max_attempts',
  'connection.write_verified_at IS NOT NULL',
  "eventType: 'quickbooks.write.drafted'",
  "eventType: 'quickbooks.write.succeeded'",
  'request_fingerprint',
  "'cp-' || $3::text",
  'reviewed_maton_connection_id',
  'connection.maton_connection_id = request.reviewed_maton_connection_id',
  'AND reviewed_maton_connection_id = $7',
  'AND reviewed_maton_connection_id = $6',
]) includes(writePersistence, fragment, 'QuickBooks write persistence')
assert.ok(!writePersistence.includes('console.'), 'QuickBooks write persistence must not log accounting payloads')

const organizationId = '11111111-1111-4111-8111-111111111111'
const actorEmail = 'manager@example.com'
const company = {
  companyName: 'Replacement Books',
  country: 'US',
  legalName: null,
  email: null,
  phone: null,
  address: { lines: [], city: null, region: null, postalCode: null, country: null },
}
const integrationSqlCalls = []
const integrationAuditEvents = []
let integrationScenario = 'rebind'
const integrationPersistenceModule = loadTypeScriptModule('app_src/lib/persistence/quickBooksIntegrations.ts', {
  '@/lib/auditWriter': {
    recordAuditEvent: async (event) => { integrationAuditEvents.push(event) },
  },
  '@/lib/persistence/postgres': {
    acquireTransactionAdvisoryLock: async (client, key) => client.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))',
      [key],
    ),
    query: async () => ({ rows: [], rowCount: 0 }),
    withTransaction: async (work) => work({
      query: async (sql, params = []) => {
        const source = String(sql)
        integrationSqlCalls.push({ source, params })
        if (source.includes('SELECT maton_connection_id, company_name, country')) {
          return {
            rows: [{ maton_connection_id: 'connection-old', company_name: 'Original Books', country: 'US' }],
            rowCount: 1,
          }
        }
        if (source.includes('SELECT EXISTS') && source.includes("status = 'processing'")) {
          const exists = integrationScenario === 'processing'
          return { rows: [{ exists }], rowCount: 1 }
        }
        if (source.includes('FROM pos_accounting_profiles') && source.includes('FOR UPDATE')) {
          return {
            rows: [{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }],
            rowCount: 1,
          }
        }
        if (source.includes('WITH cancellable AS')) {
          return {
            rows: integrationScenario === 'rebind' ? [{
              id: '22222222-2222-4222-8222-222222222222',
              operation_kind: 'customer.create',
              previous_status: 'approved',
              provider_request_id: 'cp-22222222-2222-4222-8222-222222222222',
              request_fingerprint: 'a'.repeat(64),
            }] : [],
            rowCount: integrationScenario === 'rebind' ? 1 : 0,
          }
        }
        if (source.includes('organization_id <> $2::uuid')) return { rows: [], rowCount: 0 }
        if (source.includes('DELETE FROM organization_quickbooks_connections')) {
          return { rows: [{ company_name: 'Original Books' }], rowCount: 1 }
        }
        return { rows: [], rowCount: 1 }
      },
    }),
  },
})

await integrationPersistenceModule.bindQuickBooksConnectionInPostgres({
  organizationId,
  ownerEmail: 'owner@example.com',
  connectionId: 'connection-new',
  company,
  actorEmail,
})
assert.ok(integrationSqlCalls[0].source.includes('pg_advisory_xact_lock'))
assert.equal(integrationSqlCalls[0].params[0], `quickbooks-binding:${organizationId}`)
const rebindUpsert = integrationSqlCalls.find((call) => call.source.includes('INSERT INTO organization_quickbooks_connections'))
assert.ok(rebindUpsert)
includes(rebindUpsert.source, "THEN 'disabled'", 'QuickBooks rebind write-mode reset')
assert.equal((integrationAuditEvents.find((event) => event.eventType === 'quickbooks.connection.bound')).payload.writeVerificationReset, true)
assert.equal((integrationAuditEvents.find((event) => event.eventType === 'quickbooks.write.cancelled')).payload.reason, 'connection_rebound')
const rebindProfileClose = integrationSqlCalls.find((call) => call.source.includes('UPDATE pos_accounting_profiles SET effective_to'))
const rebindProfileReplacement = integrationSqlCalls.find((call) => call.source.includes('INSERT INTO pos_accounting_profiles'))
const rebindMappingInvalidation = integrationSqlCalls.find((call) => call.source.includes('UPDATE pos_accounting_catalog_mappings SET effective_to'))
assert.ok(rebindProfileClose, 'QuickBooks rebind must close the old fingerprinted profile revision')
assert.ok(rebindProfileReplacement, 'QuickBooks rebind must create an unbound profile revision')
assert.ok(rebindMappingInvalidation, 'QuickBooks rebind must invalidate current POS catalog mappings')
includes(rebindProfileReplacement.source, "'unbound', NULL, NULL, NULL, NULL", 'QuickBooks rebind profile fingerprint reset')
assert.equal(
  integrationAuditEvents.find((event) => event.eventType === 'quickbooks.connection.bound').payload.invalidatedPosAccountingProfileCount,
  1,
)

integrationScenario = 'processing'
const sqlCountBeforeBlockedRebind = integrationSqlCalls.length
await assert.rejects(
  integrationPersistenceModule.bindQuickBooksConnectionInPostgres({
    organizationId,
    ownerEmail: 'owner@example.com',
    connectionId: 'connection-newer',
    company: { ...company, companyName: 'Blocked Replacement' },
    actorEmail,
  }),
  /in-progress QuickBooks write/,
)
assert.equal(
  integrationSqlCalls.slice(sqlCountBeforeBlockedRebind).some((call) => call.source.includes('INSERT INTO organization_quickbooks_connections')),
  false,
)
await assert.rejects(
  integrationPersistenceModule.disconnectQuickBooksConnectionInPostgres({ organizationId, actorEmail }),
  /in-progress QuickBooks write/,
)

integrationScenario = 'disconnect'
const sqlCountBeforeDisconnect = integrationSqlCalls.length
await integrationPersistenceModule.disconnectQuickBooksConnectionInPostgres({ organizationId, actorEmail })
const disconnectCancellation = integrationSqlCalls.find((call) => (
  call.source.includes('WITH cancellable AS') && call.params[2] === 'QUICKBOOKS_WRITE_CONNECTION_DISCONNECTED'
))
assert.ok(disconnectCancellation)
includes(disconnectCancellation.source, "status IN ('draft', 'pending_approval', 'approved', 'failed', 'dead')", 'QuickBooks disconnect cancellation states')
assert.ok(!disconnectCancellation.source.includes("'succeeded'"), 'QuickBooks disconnect must preserve posted writes')
const disconnectSql = integrationSqlCalls.slice(sqlCountBeforeDisconnect)
assert.ok(disconnectSql.some((call) => call.source.includes('UPDATE pos_accounting_profiles SET effective_to')))
assert.ok(disconnectSql.some((call) => call.source.includes('INSERT INTO pos_accounting_profiles')))
assert.ok(disconnectSql.some((call) => call.source.includes('UPDATE pos_accounting_catalog_mappings SET effective_to')))

function writeRequestRow(overrides = {}) {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    reviewed_maton_connection_id: 'connection-reviewed',
    operation_kind: 'customer.create',
    status: 'draft',
    client_request_id: '44444444-4444-4444-8444-444444444444',
    provider_request_id: 'cp-44444444-4444-4444-8444-444444444444',
    request_payload: { displayName: 'Acme Buyer' },
    result_payload: {},
    request_fingerprint: 'b'.repeat(64),
    provider_entity_type: null,
    provider_entity_id: null,
    provider_sync_token: null,
    requested_by: actorEmail,
    requested_by_name: null,
    submitted_by: null,
    approved_by: null,
    approved_by_name: null,
    cancelled_by: null,
    approval_note: null,
    attempt_count: 0,
    max_attempts: 5,
    last_error_code: null,
    last_error_message: null,
    created_at: '2026-07-19T12:00:00.000Z',
    submitted_at: null,
    approved_at: null,
    posted_at: null,
    cancelled_at: null,
    updated_at: '2026-07-19T12:00:00.000Z',
    ...overrides,
  }
}

const writeSqlCalls = []
const writeAuditEvents = []
let writeScenario = 'create'
let writeReadScenario = 'off'
let writeMappingScenario = 'none'
let existingWriteMapping = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  source_name: 'Saratoga Springs - Sparkling Water',
  target_id: 'existing-item-9',
  target_name: 'Existing Saratoga Item',
  active: true,
  mapping_revision: 4,
}
let currentReviewedConnectionId = 'connection-reviewed'
const recentWriteRequestId = '33333333-3333-4333-8333-333333333333'
const targetedWriteRequestId = '77777777-7777-4777-8777-777777777777'
const writePersistenceModule = loadTypeScriptModule('app_src/lib/persistence/quickBooksWrites.ts', {
  ...quickBooksWritePersistenceMocks,
  '@/lib/auditWriter': { recordAuditEvent: async (event) => { writeAuditEvents.push(event) } },
  '@/lib/quickBooksWritePolicy': {
    configuredQuickBooksWritePolicy: () => ({ enabled: true, mode: 'sandbox', allowedOperations: ['item.create'] }),
  },
  '@/lib/persistence/postgres': {
    acquireTransactionAdvisoryLock: async (client, key) => client.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))',
      [key],
    ),
    query: async (sql, params = []) => {
      if (writeReadScenario === 'off') return { rows: [], rowCount: 0 }
      const source = String(sql)
      if (source.includes('FROM organization_quickbooks_connections connection')) {
        return { rows: [{ write_mode: 'sandbox', write_verified_at: '2026-07-19T12:00:00.000Z', company_name: 'Acme Books', currency_code: 'USD' }], rowCount: 1 }
      }
      if (source.includes('SELECT count(*)::text AS count FROM quickbooks_write_requests')) {
        return { rows: [{ count: '101' }], rowCount: 1 }
      }
      if (source.includes("request.id = NULLIF($2, '')::uuid")) {
        return params[0] === organizationId && params[1] === targetedWriteRequestId
          ? { rows: [writeRequestRow({ id: targetedWriteRequestId })], rowCount: 1 }
          : { rows: [], rowCount: 0 }
      }
      if (source.includes('ORDER BY request.created_at DESC, request.id DESC')) {
        const id = writeReadScenario === 'dedupe' ? targetedWriteRequestId : recentWriteRequestId
        return { rows: [writeRequestRow({ id })], rowCount: 1 }
      }
      return { rows: [], rowCount: 0 }
    },
    withTransaction: async (work) => work({
      query: async (sql, params = []) => {
        const source = String(sql)
        writeSqlCalls.push({ source, params })
        if (source.includes('SELECT maton_connection_id') && source.includes('FOR SHARE')) {
          return { rows: [{ maton_connection_id: currentReviewedConnectionId }], rowCount: 1 }
        }
        if (source.includes('INSERT INTO quickbooks_write_requests')) {
          return writeScenario === 'idempotency-conflict'
            ? { rows: [], rowCount: 0 }
            : { rows: [writeRequestRow()], rowCount: 1 }
        }
        if (source.includes('request.client_request_id = $2::uuid')) {
          return { rows: [writeRequestRow()], rowCount: 1 }
        }
        if (source.includes('WITH candidate AS')) return { rows: [], rowCount: 0 }
        if (source.includes('SELECT approved_by') && source.includes("status = 'processing'")) {
          return { rows: [{ approved_by: 'approver@example.com' }], rowCount: 1 }
        }
        if (source.includes('FROM pos_accounting_catalog_mappings') && source.includes('effective_to IS NULL')) {
          return writeMappingScenario === 'existing'
            ? {
                rows: [existingWriteMapping],
                rowCount: 1,
              }
            : { rows: [], rowCount: 0 }
        }
        if (source.includes('COALESCE(max(mapping_revision)')) {
          return { rows: [{ revision: 0 }], rowCount: 1 }
        }
        if (source.includes('INSERT INTO pos_accounting_catalog_mappings')) {
          return {
            rows: [{
              id: '99999999-9999-4999-8999-999999999999',
              source_name: params[3],
              target_id: params[4],
              target_name: params[5],
              active: true,
              mapping_revision: params[6],
            }],
            rowCount: 1,
          }
        }
        if (source.includes("status = 'succeeded'") || source.includes('status = $3')) {
          return { rows: [], rowCount: 1 }
        }
        return { rows: [], rowCount: 0 }
      },
    }),
  },
})

writeReadScenario = 'target'
const targetedWriteWorkspace = await writePersistenceModule.readQuickBooksWriteWorkspaceInPostgres({
  organizationId,
  pageSize: 100,
  requestId: targetedWriteRequestId,
})
assert.equal(targetedWriteWorkspace.requests.length, 2)
assert.equal(targetedWriteWorkspace.requests[0].id, targetedWriteRequestId)
assert.equal(targetedWriteWorkspace.requests[1].id, recentWriteRequestId)
writeReadScenario = 'dedupe'
const deduplicatedWriteWorkspace = await writePersistenceModule.readQuickBooksWriteWorkspaceInPostgres({
  organizationId,
  pageSize: 100,
  requestId: targetedWriteRequestId,
})
assert.equal(deduplicatedWriteWorkspace.requests.length, 1)
assert.equal(deduplicatedWriteWorkspace.requests[0].id, targetedWriteRequestId)
writeReadScenario = 'target'
const crossTenantWriteWorkspace = await writePersistenceModule.readQuickBooksWriteWorkspaceInPostgres({
  organizationId: '99999999-9999-4999-8999-999999999999',
  pageSize: 100,
  requestId: targetedWriteRequestId,
})
assert.equal(crossTenantWriteWorkspace.requests.some((request) => request.id === targetedWriteRequestId), false)
writeReadScenario = 'off'

await writePersistenceModule.createQuickBooksWriteRequestInPostgres({
  organizationId,
  operationKind: 'customer.create',
  clientRequestId: '44444444-4444-4444-8444-444444444444',
  payload: { displayName: 'Acme Buyer' },
  requestFingerprint: 'b'.repeat(64),
  actorEmail,
})
const createWriteCall = writeSqlCalls.find((call) => call.source.includes('INSERT INTO quickbooks_write_requests'))
assert.equal(createWriteCall.params[6], 'connection-reviewed')

writeScenario = 'idempotency-conflict'
currentReviewedConnectionId = 'connection-replacement'
await assert.rejects(
  writePersistenceModule.createQuickBooksWriteRequestInPostgres({
    organizationId,
    operationKind: 'customer.create',
    clientRequestId: '44444444-4444-4444-8444-444444444444',
    payload: { displayName: 'Acme Buyer' },
    requestFingerprint: 'b'.repeat(64),
    actorEmail,
  }),
  (error) => error.code === 'QUICKBOOKS_WRITE_CONNECTION_CONFLICT',
)

writeScenario = 'claim'
await writePersistenceModule.claimQuickBooksWriteJobsInPostgres({
  limit: 2,
  workerId: 'worker-1',
  writeMode: 'sandbox',
  allowedOperations: ['item.create'],
})
const claimWriteCall = writeSqlCalls.find((call) => call.source.includes('WITH candidate AS'))
includes(claimWriteCall.source, 'connection.maton_connection_id = request.reviewed_maton_connection_id', 'QuickBooks claim reviewed binding')
includes(claimWriteCall.source, 'request.operation_kind = ANY($4::text[])', 'QuickBooks claim operation allowlist')
includes(claimWriteCall.source, 'FOR UPDATE OF request, connection SKIP LOCKED', 'QuickBooks claim connection lock')
assert.deepEqual(claimWriteCall.params[3], ['item.create'])

const writeJob = {
  id: '33333333-3333-4333-8333-333333333333',
  organizationId,
  ownerEmail: 'owner@example.com',
  connectionId: 'connection-reviewed',
  operationKind: 'customer.create',
  requestPayload: { displayName: 'Acme Buyer' },
  providerRequestId: 'cp-44444444-4444-4444-8444-444444444444',
  requestFingerprint: 'b'.repeat(64),
  attemptCount: 1,
  maxAttempts: 5,
  lockToken: '55555555-5555-4555-8555-555555555555',
  writeMode: 'sandbox',
}
await writePersistenceModule.completeQuickBooksWriteJobInPostgres({
  job: writeJob,
  providerEntityType: 'Customer',
  providerEntityId: 'customer-1',
  providerSyncToken: '0',
})
await writePersistenceModule.failQuickBooksWriteJobInPostgres({ job: writeJob, errorCode: 'TEMPORARY', error: 'retry' })
const completeWriteCall = writeSqlCalls.find((call) => call.source.includes("status = 'succeeded'"))
const failWriteCall = writeSqlCalls.find((call) => call.source.includes('status = $3'))
assert.equal(completeWriteCall.params[6], 'connection-reviewed')
assert.equal(failWriteCall.params[5], 'connection-reviewed')

const mappedWriteJob = {
  ...writeJob,
  id: '12121212-1212-4212-8212-121212121212',
  operationKind: 'item.create',
  requestPayload: mappedItemDraft.payload,
  providerRequestId: 'cp-13131313-1313-4313-8313-131313131313',
  requestFingerprint: mappedItemDraft.requestFingerprint,
  lockToken: '14141414-1414-4414-8414-141414141414',
}
writeMappingScenario = 'create'
const createMappingCallStart = writeSqlCalls.length
const mappedWriteResult = await writePersistenceModule.completeQuickBooksWriteJobInPostgres({
  job: mappedWriteJob,
  providerEntityType: 'Item',
  providerEntityId: '35',
  providerSyncToken: '0',
})
assert.equal(mappedWriteResult.posAccountingMapping.status, 'created')
assert.equal(mappedWriteResult.posAccountingMapping.sourceId, toastSourceId)
assert.equal(mappedWriteResult.posAccountingMapping.sourceName, 'Saratoga Springs - Sparkling Water')
assert.equal(mappedWriteResult.posAccountingMapping.targetId, '35')
assert.equal(mappedWriteResult.posAccountingMapping.mappingRestaurantGuid, toastRestaurantGuid)
const createMappingCalls = writeSqlCalls.slice(createMappingCallStart)
const mappingLock = createMappingCalls.find((call) => call.source.includes('pg_advisory_xact_lock'))
assert.ok(mappingLock)
assert.equal(mappingLock.params[0], `quickbooks-binding:${organizationId}`)
const mappingInsert = createMappingCalls.find((call) => call.source.includes('INSERT INTO pos_accounting_catalog_mappings'))
assert.ok(mappingInsert)
assert.deepEqual(
  Array.from(mappingInsert.params),
  [organizationId, toastRestaurantGuid, toastSourceId, 'Saratoga Springs - Sparkling Water', '35', 'Saratoga Sparkling 12 oz', 1, 'approver@example.com'],
)
const mappedCompletion = createMappingCalls.find((call) => call.source.includes("status = 'succeeded'"))
const mappedCompletionResult = JSON.parse(mappedCompletion.params[5])
assert.equal(mappedCompletionResult.posAccountingMapping.status, 'created')
assert.equal(mappedCompletionResult.posAccountingMapping.targetId, '35')
const mappedAudit = writeAuditEvents.find((event) => (
  event.eventType === 'quickbooks.write.succeeded' && event.aggregateId === mappedWriteJob.id
))
assert.equal(mappedAudit.payload.posAccountingMapping.status, 'created')

writeMappingScenario = 'existing'
existingWriteMapping = {
  id: '99999999-9999-4999-8999-999999999999',
  source_name: 'Saratoga Springs - Sparkling Water',
  target_id: '35',
  target_name: 'Saratoga Sparkling 12 oz',
  active: true,
  mapping_revision: 1,
}
const retryMappingCallStart = writeSqlCalls.length
const retriedMappedWriteResult = await writePersistenceModule.completeQuickBooksWriteJobInPostgres({
  job: { ...mappedWriteJob, attemptCount: 2, lockToken: '15151515-1515-4515-8515-151515151515' },
  providerEntityType: 'Item',
  providerEntityId: '35',
  providerSyncToken: '0',
})
assert.equal(retriedMappedWriteResult.posAccountingMapping.status, 'skipped_existing')
assert.equal(
  writeSqlCalls.slice(retryMappingCallStart).some((call) => call.source.includes('INSERT INTO pos_accounting_catalog_mappings')),
  false,
  'an idempotent provider retry must not create another current mapping',
)

existingWriteMapping = {
  ...existingWriteMapping,
  id: '16161616-1616-4616-8616-161616161616',
  target_id: 'legacy-item-7',
  target_name: 'Manually mapped Saratoga item',
  mapping_revision: 3,
}
const preserveMappingCallStart = writeSqlCalls.length
const preservedMappingResult = await writePersistenceModule.completeQuickBooksWriteJobInPostgres({
  job: {
    ...mappedWriteJob,
    id: '17171717-1717-4717-8717-171717171717',
    providerRequestId: 'cp-17171717-1717-4717-8717-171717171717',
    lockToken: '18181818-1818-4818-8818-181818181818',
  },
  providerEntityType: 'Item',
  providerEntityId: 'new-item-99',
  providerSyncToken: '0',
})
assert.equal(preservedMappingResult.posAccountingMapping.status, 'skipped_existing')
assert.equal(preservedMappingResult.posAccountingMapping.targetId, 'legacy-item-7')
assert.equal(preservedMappingResult.posAccountingMapping.createdQuickBooksItemId, 'new-item-99')
assert.equal(
  writeSqlCalls.slice(preserveMappingCallStart).some((call) => call.source.includes('INSERT INTO pos_accounting_catalog_mappings')),
  false,
  'an existing current mapping must never be overwritten',
)

const service = read('app_src/lib/integrations/quickBooksIntegrations.ts')
for (const fragment of [
  'resolveUserMatonGatewayCredential',
  "app: 'quickbooks'",
  'QUICKBOOKS_COMPANY_ALREADY_BOUND',
  'itemIds.length > 100',
  "item.itemType.toLowerCase() !== 'category'",
  "sourceKey = `quickbooks:item:${item.id}`",
  'syncPipelineProductDropdownCatalogInPostgres',
]) includes(service, fragment, 'QuickBooks service')
assert.ok(!service.includes("currency: 'USD'"), 'QuickBooks import must not force USD for every organization')

const route = read('app_src/app/api/integrations/quickbooks/route.ts')
for (const fragment of [
  'requireRequestUser',
  'requireManager(actor)',
  'requireResourceEditor(pipeline)',
  'pipeline.workspaceOrganizationId !== actor.organizationId',
  "action === 'bind-selected-connection'",
  "action === 'save-mappings'",
  "action === 'import-products'",
  "'Cache-Control': 'no-store'",
  'MAX_REQUEST_BYTES',
]) includes(route, fragment, 'QuickBooks API')

const worker = read('app_src/lib/quickBooksSyncWorker.ts')
for (const fragment of [
  'queueAutomaticQuickBooksCatalogSyncsInPostgres',
  'claimQuickBooksSyncJobsInPostgres',
  'completeQuickBooksCatalogSyncInPostgres',
  'failQuickBooksSyncJobInPostgres',
]) includes(worker, fragment, 'QuickBooks worker')

const writeWorker = read('app_src/lib/quickBooksWriteWorker.ts')
for (const fragment of [
  'configuredQuickBooksWritePolicy',
  'allowedOperations: policy.allowedOperations',
  'claimQuickBooksWriteJobsInPostgres',
  'createQuickBooksEntity',
  'completeQuickBooksWriteJobInPostgres',
  'failQuickBooksWriteJobInPostgres',
  'queueQuickBooksCatalogSyncInPostgres',
  'catalogSyncWarnings',
]) includes(writeWorker, fragment, 'QuickBooks write worker')

const posPostingPersistence = read('app_src/lib/persistence/posAccountingPosting.ts')
for (const fragment of [
  'preparePosAccountingPostingBatchInPostgres',
  'approvePosAccountingPostingBatchInPostgres',
  'recordMatchedShogoResultsInPostgres',
  'synchronizePosAccountingPostingBatchForRequest',
  "operationKind: 'sales_receipt.create'",
  "operationKind: 'journal_entry.create'",
  "'partial_failed'",
  "receipt.actual?.postingOrigin === 'shogo'",
  "journal.actual?.postingOrigin === 'shogo'",
  'quickbooks_sales_receipt_id',
  'quickbooks_journal_entry_id',
]) includes(posPostingPersistence, fragment, 'POS accounting posting persistence')

const posPostingRoute = read('app_src/app/api/accounting/quickbooks/pos-posting/route.ts')
for (const fragment of [
  "action === 'record-shogo-range'",
  "action === 'prepare-clawpilot'",
  "action === 'approve-clawpilot'",
  'capabilities.canPrepare',
  'capabilities.canApprove',
  'confirmFingerprint',
  'MAX_REQUEST_BYTES',
]) includes(posPostingRoute, fragment, 'POS accounting posting API')

const writePolicyModule = loadTypeScriptModule('app_src/lib/quickBooksWritePolicy.ts')
const productOnlyPolicy = writePolicyModule.configuredQuickBooksWritePolicy({
  QUICKBOOKS_WRITES_ENABLED: '1',
  QUICKBOOKS_WRITE_MODE: 'production',
  QUICKBOOKS_WRITE_OPERATIONS: 'item.create,item.create,unsupported',
})
assert.equal(productOnlyPolicy.enabled, true)
assert.equal(productOnlyPolicy.mode, 'production')
assert.equal(JSON.stringify(productOnlyPolicy.allowedOperations), JSON.stringify(['item.create']))
assert.equal(writePolicyModule.configuredQuickBooksWritePolicy({
  QUICKBOOKS_WRITES_ENABLED: '1',
  QUICKBOOKS_WRITE_MODE: 'production',
}).enabled, false)

const processRoute = read('app_src/app/api/integrations/quickbooks/process/route.ts')
for (const fragment of [
  'PIPELINE_OUTBOX_WORKER_SECRET',
  'crypto.timingSafeEqual',
  'recordQuickBooksWorkerHeartbeatInPostgres',
  'processQuickBooksWriteOutbox',
  'writes, catalog',
]) includes(processRoute, fragment, 'QuickBooks worker route')

const authProxy = read('app_src/proxy.ts')
includes(authProxy, '/api/integrations/quickbooks/process', 'QuickBooks worker proxy allowlist')
includes(authProxy, "'/api/accounting/'", 'QuickBooks impersonation mutation boundary')

const explorerPersistence = read('app_src/lib/persistence/quickBooksExplorer.ts')
for (const fragment of [
  'readQuickBooksExplorerOverviewInPostgres',
  'readQuickBooksExplorerListInPostgres',
  'readQuickBooksFinancialReportInPostgres',
  'readQuickBooksInvoiceDetailInPostgres',
  'readQuickBooksAttachmentAccessInPostgres',
  'readQuickBooksTransactionAttachmentsInPostgres',
  'parseQuickBooksInvoiceDetail',
  "'Overdue'",
  'organization_id = $1::uuid',
  'LIMIT $6 OFFSET $7',
]) includes(explorerPersistence, fragment, 'QuickBooks explorer persistence')

const explorerRoute = read('app_src/app/api/accounting/quickbooks/route.ts')
for (const fragment of [
  'accountingCapabilities',
  'activeAccountingOrganizationId',
  'ACCOUNTING_VIEW_REQUIRED',
  'readQuickBooksExplorerOverviewInPostgres',
  'readQuickBooksExplorerListInPostgres',
  "viewValue === 'reports'",
  "viewValue === 'invoice'",
  "viewValue === 'transaction-attachments'",
  "'Cache-Control': 'no-store'",
]) includes(explorerRoute, fragment, 'QuickBooks explorer API')

const actionsRoute = read('app_src/app/api/accounting/quickbooks/actions/route.ts')
for (const fragment of [
  'capabilities.canPrepare',
  'capabilities.canApprove',
  'validateQuickBooksWriteDraft',
  'createQuickBooksWriteRequestInPostgres',
  'transitionQuickBooksWriteRequestInPostgres',
  'confirmFingerprint',
  "uuidValue(requestIdValue, 'Accounting request id')",
  'MAX_REQUEST_BYTES',
  "'Cache-Control': 'no-store'",
]) includes(actionsRoute, fragment, 'QuickBooks write API')

let routeCapabilities = { canView: true, canManage: false, canPrepare: true, canApprove: false }
let transitioned = null
let workspaceReadInput = null
const actionsRouteModule = loadTypeScriptModule('app_src/app/api/accounting/quickbooks/actions/route.ts', {
  'next/server': { NextResponse: { json: (body, init = {}) => ({ body, status: init.status || 200, headers: init.headers || {} }) } },
  '@/lib/accountingAuthorization': {
    accountingCapabilities: () => routeCapabilities,
    activeAccountingOrganizationId: () => '11111111-1111-4111-8111-111111111111',
  },
  '@/lib/integrations/quickBooksWritePayloads': {
    QuickBooksWriteValidationError: class extends Error {},
    validateQuickBooksWriteDraft: async () => ({
      operationKind: 'customer.create', payload: { displayName: 'Acme Buyer' }, requestFingerprint: 'a'.repeat(64),
    }),
  },
  '@/lib/persistence/config': { isPostgresStorageEnabled: () => true },
  '@/lib/persistence/quickBooksWrites': {
    QuickBooksWriteRequestError: class extends Error {},
    readQuickBooksWriteWorkspaceInPostgres: async (input) => { workspaceReadInput = input; return { requests: [] } },
    createQuickBooksWriteRequestInPostgres: async (input) => ({ id: 'write-1', ...input }),
    transitionQuickBooksWriteRequestInPostgres: async (input) => { transitioned = input; return { id: input.requestId } },
  },
  '@/lib/requestUser': { requireRequestUser: async () => ({ email: 'member@example.com' }) },
})

function jsonRequest(body) {
  const raw = JSON.stringify(body)
  return { headers: new Headers({ 'content-length': String(Buffer.byteLength(raw)), 'content-type': 'application/json' }), text: async () => raw }
}

const targetedGetResponse = await actionsRouteModule.GET({
  nextUrl: new URL(`https://clawpilot.test/api/accounting/quickbooks/actions?pageSize=100&requestId=${targetedWriteRequestId}`),
})
assert.equal(targetedGetResponse.status, 200)
assert.equal(workspaceReadInput.requestId, targetedWriteRequestId)

const draftResponse = await actionsRouteModule.POST(jsonRequest({
  clientRequestId: '11111111-1111-4111-8111-111111111111', operationKind: 'customer.create', payload: { displayName: 'Acme Buyer' },
}))
assert.equal(draftResponse.status, 201)
assert.equal(draftResponse.body.ok, true)

const deniedApproval = await actionsRouteModule.PATCH(jsonRequest({
  requestId: '22222222-2222-4222-8222-222222222222', action: 'approve', confirmFingerprint: 'a'.repeat(64),
}))
assert.equal(deniedApproval.status, 403)
assert.equal(deniedApproval.body.code, 'ACCOUNTING_APPROVAL_REQUIRED')

routeCapabilities = { ...routeCapabilities, canApprove: true }
const approvedResponse = await actionsRouteModule.PATCH(jsonRequest({
  requestId: '22222222-2222-4222-8222-222222222222', action: 'approve', confirmFingerprint: 'a'.repeat(64),
}))
assert.equal(approvedResponse.status, 200)
assert.equal(transitioned.action, 'approve')
assert.equal(transitioned.confirmFingerprint, 'a'.repeat(64))

let writeClaims = 0
const writeWorkerModule = loadTypeScriptModule('app_src/lib/quickBooksWriteWorker.ts', {
  '@/lib/integrations/quickBooksClient': { QuickBooksProviderWriteError: class extends Error {}, createQuickBooksEntity: async () => ({}) },
  '@/lib/persistence/quickBooksWrites': {
    claimQuickBooksWriteJobsInPostgres: async () => { writeClaims += 1; return [] },
    completeQuickBooksWriteJobInPostgres: async () => undefined,
    failQuickBooksWriteJobInPostgres: async () => false,
  },
  '@/lib/persistence/quickBooksIntegrations': { queueQuickBooksCatalogSyncInPostgres: async () => undefined },
  '@/lib/quickBooksWritePolicy': {
    configuredQuickBooksWritePolicy: () => ({ enabled: false, mode: null, allowedOperations: [] }),
  },
})
const gatedWrites = await writeWorkerModule.processQuickBooksWriteOutbox({ workerId: 'test-worker' })
assert.equal(gatedWrites.enabled, false)
assert.equal(writeClaims, 0)

let failedJobs = 0
const retryWorkerModule = loadTypeScriptModule('app_src/lib/quickBooksWriteWorker.ts', {
  '@/lib/integrations/quickBooksClient': {
    QuickBooksProviderWriteError: class extends Error {},
    createQuickBooksEntity: async () => { throw new Error('temporary provider failure') },
  },
  '@/lib/persistence/quickBooksWrites': {
    claimQuickBooksWriteJobsInPostgres: async () => [{
      id: 'write-1', organizationId: '11111111-1111-4111-8111-111111111111',
      ownerEmail: 'owner@example.com', connectionId: 'connection-1',
      operationKind: 'customer.create', requestPayload: { displayName: 'Acme Buyer' },
      providerRequestId: 'cp-11111111-1111-4111-8111-111111111111',
      requestFingerprint: 'a'.repeat(64), attemptCount: 1, maxAttempts: 5,
      lockToken: '33333333-3333-4333-8333-333333333333', writeMode: 'sandbox',
    }],
    completeQuickBooksWriteJobInPostgres: async () => undefined,
    failQuickBooksWriteJobInPostgres: async () => { failedJobs += 1; return false },
  },
  '@/lib/persistence/quickBooksIntegrations': { queueQuickBooksCatalogSyncInPostgres: async () => undefined },
  '@/lib/quickBooksWritePolicy': {
    configuredQuickBooksWritePolicy: () => ({ enabled: true, mode: 'sandbox', allowedOperations: ['customer.create'] }),
  },
})
const retryResult = await retryWorkerModule.processQuickBooksWriteOutbox({ workerId: 'test-worker' })
assert.equal(retryResult.failed, 1)
assert.equal(retryResult.dead, 0)
assert.equal(failedJobs, 1)

const attachmentRoute = read('app_src/app/api/accounting/quickbooks/attachments/[attachmentId]/route.ts')
for (const fragment of [
  'requireRequestUser',
  'permissions.viewAccounting',
  'readQuickBooksAttachmentAccessInPostgres',
  'readQuickBooksAttachmentDownloadUrl',
  "'Cache-Control': 'private, no-store'",
  "'Referrer-Policy': 'no-referrer'",
]) includes(attachmentRoute, fragment, 'QuickBooks attachment API')

const explorer = read('app_src/components/accounting/AccountingSection.tsx')
for (const fragment of [
  'Accounting',
  'Products & services',
  'Chart of accounts',
  'All transactions',
  'Financial reports',
  'FinancialReportPanel',
  'InvoiceDocument',
  'Invoice line items',
  'AttachmentPreview',
  'Receipt evidence',
  'authoritative QuickBooks statements',
  '/api/accounting/quickbooks',
  'QuickBooksActionsPanel',
  'Approval controlled',
]) includes(explorer, fragment, 'QuickBooks explorer UI')

const actionsUi = read('app_src/components/accounting/QuickBooksActionsPanel.tsx')
for (const fragment of [
  'Accounting actions',
  'Provider posting disabled',
  'Create draft',
  'Invoice line items',
  'Request fingerprint',
  "action === 'approve' ? request.requestFingerprint",
  '/api/accounting/quickbooks/actions',
]) includes(actionsUi, fragment, 'QuickBooks actions UI')

includes(read('app_src/components/Navigation.tsx'), "{ id: 'accounting'", 'Accounting navigation')
includes(read('app_src/lib/users.ts'), 'viewAccounting: boolean', 'Accounting permission')
includes(read('app_src/lib/users.ts'), 'prepareAccounting: boolean', 'Accounting preparation permission')
includes(read('app_src/lib/users.ts'), 'approveAccounting: boolean', 'Accounting approval permission')

const panel = read('app_src/components/settings/QuickBooksIntegrationPanel.tsx')
for (const fragment of [
  'Connect selected QuickBooks',
  'Daily QuickBooks refresh',
  'Product and service catalog',
  'Toast accounting mappings',
  'Import only selected active items',
  'Customers, products, and invoices can be prepared in Accounting as immutable review drafts',
  'Disconnect QuickBooks?',
]) includes(panel, fragment, 'QuickBooks settings panel')

const integrationSettings = read('app_src/components/settings/IntegrationSettingsPanel.tsx')
includes(integrationSettings, "{ key: 'quickbooks' as const", 'integration navigation')

const poller = read('scripts/pipeline-outbox-poller.mjs')
includes(poller, "runLoop('quickbooks-sync'", 'worker poller')

const health = read('app_src/app/api/health/route.ts')
for (const fragment of [
  "filename = '0061_quickbooks_organization_connector.sql'",
  "filename = '0062_quickbooks_financial_explorer.sql'",
  "filename = '0063_quickbooks_financial_reports.sql'",
  "filename = '0064_quickbooks_write_control.sql'",
  "filename = '0065_demo_and_quickbooks_crm_reconciliation.sql'",
  "filename = '0079_pos_accounting_posting_outcomes.sql'",
  'readQuickBooksWorkerHeartbeatFromPostgres',
  'QuickBooks sync worker heartbeat is missing or stale.',
  'QuickBooks sync queue has terminal failed jobs.',
  'QuickBooks sync queue has stale processing jobs.',
  "WHERE organization.is_demo = false",
  'quickBooks: true',
]) includes(health, fragment, 'QuickBooks health contract')

console.log('PASS QuickBooks organization connector, financial statements, controlled writes, invoice documents, receipt previews, Toast mappings, and worker contracts')
