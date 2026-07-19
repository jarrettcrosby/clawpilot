#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  parseQuickBooksAccounts,
  parseQuickBooksAttachments,
  parseQuickBooksCompanyInfo,
  parseQuickBooksCustomers,
  parseQuickBooksItems,
  parseQuickBooksTransactions,
  parseQuickBooksVendors,
} from '../app_src/lib/integrations/quickBooksCatalog.mjs'

const root = process.cwd()

function read(path) {
  return readFileSync(resolve(root, path), 'utf8')
}

function includes(source, fragment, label) {
  assert.ok(source.includes(fragment), `${label} missing ${fragment}`)
}

assert.deepEqual(
  parseQuickBooksCompanyInfo({ CompanyInfo: { CompanyName: ' Example Co ', Country: 'US' } }),
  { companyName: 'Example Co', country: 'US' },
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
      { Name: 'Invalid' },
    ],
  },
})
assert.equal(items.length, 2)
assert.equal(items[0].incomeAccountId, '1')
assert.equal(items[1].unitPrice, 0)

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
  'parseQuickBooksTransactions',
]) includes(client + read('app_src/lib/maton.ts'), fragment, 'QuickBooks client')
assert.ok(!client.includes("method: 'POST'"), 'QuickBooks catalog client must remain read-only')
assert.ok(!client.includes('TRANSACTION_ENTITIES.map'), 'QuickBooks entity reads must remain paced')

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
  'jsonb_to_recordset',
]) includes(persistence, fragment, 'QuickBooks persistence')
assert.ok(!persistence.includes('console.'), 'QuickBooks persistence must not log credentials or source payloads')

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

const processRoute = read('app_src/app/api/integrations/quickbooks/process/route.ts')
for (const fragment of [
  'PIPELINE_OUTBOX_WORKER_SECRET',
  'crypto.timingSafeEqual',
  'recordQuickBooksWorkerHeartbeatInPostgres',
]) includes(processRoute, fragment, 'QuickBooks worker route')

const authProxy = read('app_src/proxy.ts')
includes(authProxy, '/api/integrations/quickbooks/process', 'QuickBooks worker proxy allowlist')

const explorerPersistence = read('app_src/lib/persistence/quickBooksExplorer.ts')
for (const fragment of [
  'readQuickBooksExplorerOverviewInPostgres',
  'readQuickBooksExplorerListInPostgres',
  "'Overdue'",
  'organization_id = $1::uuid',
  'LIMIT $6 OFFSET $7',
]) includes(explorerPersistence, fragment, 'QuickBooks explorer persistence')

const explorerRoute = read('app_src/app/api/accounting/quickbooks/route.ts')
for (const fragment of [
  'permissions.viewAccounting',
  'ACCOUNTING_VIEW_REQUIRED',
  'readQuickBooksExplorerOverviewInPostgres',
  'readQuickBooksExplorerListInPostgres',
  "'Cache-Control': 'no-store'",
]) includes(explorerRoute, fragment, 'QuickBooks explorer API')

const explorer = read('app_src/components/accounting/AccountingSection.tsx')
for (const fragment of [
  'Accounting',
  'Products & services',
  'Chart of accounts',
  'All transactions',
  'Activity totals are operational views',
  '/api/accounting/quickbooks',
]) includes(explorer, fragment, 'QuickBooks explorer UI')

includes(read('app_src/components/Navigation.tsx'), "{ id: 'accounting'", 'Accounting navigation')
includes(read('app_src/lib/users.ts'), 'viewAccounting: boolean', 'Accounting permission')

const panel = read('app_src/components/settings/QuickBooksIntegrationPanel.tsx')
for (const fragment of [
  'Connect selected QuickBooks',
  'Daily QuickBooks refresh',
  'Product and service catalog',
  'Toast accounting mappings',
  'Import only selected active items',
  'QuickBooks access is read-only in this release',
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
  'readQuickBooksWorkerHeartbeatFromPostgres',
  'QuickBooks sync worker heartbeat is missing or stale.',
  'quickBooks: true',
]) includes(health, fragment, 'QuickBooks health contract')

console.log('PASS QuickBooks organization connector, read-only explorer, Toast mappings, and worker contracts')
