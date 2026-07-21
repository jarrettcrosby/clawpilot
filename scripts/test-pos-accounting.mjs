#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import vm from 'node:vm'

const root = process.cwd()
const nodeRequire = createRequire(import.meta.url)
const requireFromApp = createRequire(new URL('../app_src/package.json', import.meta.url))
const ts = requireFromApp('typescript')

function read(path) {
  return readFileSync(resolve(root, path), 'utf8')
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
  const localRequire = (specifier) => {
    if (Object.prototype.hasOwnProperty.call(mocks, specifier)) return mocks[specifier]
    try {
      return requireFromApp(specifier)
    } catch {
      return nodeRequire(specifier)
    }
  }
  vm.runInNewContext(output, {
    Buffer,
    console,
    Date,
    Error,
    URL,
    URLSearchParams,
    exports: module.exports,
    module,
    process,
    require: localRequire,
  }, { filename: path })
  return module.exports
}

const migration = read('db/migrations/0069_pos_accounting_profiles_and_catalog_mappings.sql')
for (const fragment of [
  'profile_revision integer NOT NULL',
  'effective_from timestamptz NOT NULL',
  'quickbooks_connection_fingerprint text',
  'WHERE restaurant_guid IS NULL AND effective_to IS NULL',
  "'card_brand', 'payout', 'fee', 'over_short'",
  "'item', 'account', 'tax_code', 'class', 'department', 'location', 'customer', 'vendor'",
  'validation_status text NOT NULL',
  'source_catalog_revision bigint NOT NULL',
  'target_catalog_revision bigint NOT NULL',
  'ON pos_accounting_catalog_mappings (organization_id, source_kind, source_id)',
  'deposit_checks_with_cash boolean NOT NULL',
  'open_check_policy text NOT NULL',
  'batch_hold_policy text NOT NULL',
  'clawpilot_close_immutable_pos_accounting_revision',
  'clawpilot_preserve_protected_toast_export_evidence',
  "OLD.status IN ('approved', 'posting', 'posted')",
  'NEW.source_summary := OLD.source_summary',
  'NEW.proposed_lines := OLD.proposed_lines',
  'NEW.quickbooks_payload := OLD.quickbooks_payload',
  'NEW.updated_at := OLD.updated_at',
]) {
  assert.ok(migration.includes(fragment), `POS accounting migration missing ${fragment}`)
}

const quickBooksReferenceMigration = read('db/migrations/0071_quickbooks_accounting_reference_catalogs.sql')
for (const fragment of [
  'quickbooks_tax_codes',
  'quickbooks_classes',
  'quickbooks_departments',
]) {
  assert.ok(quickBooksReferenceMigration.includes(fragment), `QuickBooks reference migration missing ${fragment}`)
}

const persistenceSource = read('app_src/lib/persistence/posAccounting.ts')
for (const fragment of [
  'WHERE organization_id = $1::uuid',
  'restaurant_guid IS NOT DISTINCT FROM $2::uuid',
  'effective_to = clock_timestamp()',
  "quickbooks_binding_status",
  "connectionFingerprint",
  "verifiedBankDeposit: false",
  "label: 'Calculated net card settlement'",
  "payment.processingFee",
  "toast_accounting_export_drafts",
  'evaluatePosAccountingReadiness',
  "entry.active && entry.validationStatus === 'valid'",
  'excludedOpenChecks',
  'id = ANY($1::uuid[])',
  'FROM quickbooks_tax_codes',
  'FROM quickbooks_classes',
  'FROM quickbooks_departments',
  'acquireTransactionAdvisoryLock',
  'summarizeToastProjectedChecks',
  'FROM toast_menu_catalog_items',
  'mergeStableToastMenuCatalog',
  'suggestQuickBooksItemForPosSource',
  'invalidateUnavailableQuickBooksItemTargets',
  "lower(COALESCE(item_type, '')) <> 'category'",
  'productCreationSuggestion',
]) {
  assert.ok(persistenceSource.includes(fragment), `POS accounting persistence missing ${fragment}`)
}
assert.equal(persistenceSource.includes('ON CONFLICT (organization_id, restaurant_guid)'), false)

const route = read('app_src/app/api/pos/accounting/route.ts')
for (const fragment of [
  'requireRequestUser',
  'activeAccountingOrganizationId(actor)',
  'capabilities.canManage && !capabilities.canPrepare',
  'canConfigureAccountingScope(capabilities, scope)',
  'POS_ACCOUNTING_ORGANIZATION_CONFIG_REQUIRED',
  "action === 'save-profile'",
  "action === 'save-mappings'",
  'PROFILE_FIELDS',
  'MAPPING_FIELDS',
  'MAX_REQUEST_BYTES',
  "'Cache-Control': 'private, no-store'",
]) {
  assert.ok(route.includes(fragment), `POS accounting route missing ${fragment}`)
}
assert.equal(route.includes('export async function POST'), false, 'Accounting route must not expose a posting endpoint')

const panel = read('app_src/components/pos/PosAccountingPanel.tsx')
for (const fragment of [
  "capabilities.canPrepare === true && scope === 'location_override'",
  'disabled={capabilities.canManage !== true}',
  'mapping.active',
  ": { targetId: '', targetName: '', active: false }",
  "operationKind: 'item.create'",
  'Prepare QuickBooks product',
  'parentCategoryId',
  'QuickBooks category (optional)',
  "entry.itemType.toLowerCase() !== 'category'",
  'const hasCurrent = Boolean(current)',
  "['valid', 'unvalidated'].includes(text(current.validationStatus, 'unvalidated'))",
  'active: hasCurrent ? currentIsUsable : suggested',
  '.map(mappingPayload)',
  'sourceKind: mapping.sourceKind',
  'active: mapping.active',
  'hasAccountingDraft ? (',
  'No sales-backed accounting draft is available in this date range.',
]) {
  assert.ok(panel.includes(fragment), `POS accounting panel missing ${fragment}`)
}

const posSection = read('app_src/components/pos/PosSection.tsx')
for (const fragment of [
  "const accountingBusinessDate = textValue(record(accountingDrafts[0]), ['businessDate', 'date'])",
  'businessDate={accountingBusinessDate || to}',
  'hasAccountingDraft={Boolean(accountingBusinessDate)}',
]) {
  assert.ok(posSection.includes(fragment), `POS section missing ${fragment}`)
}

const authorization = loadTypeScriptModule('app_src/lib/accountingAuthorization.ts', {
  '@/lib/users': {
    effectiveAuthorizationRole: () => 'member',
    effectiveUserPermissions: () => ({}),
  },
})
const prepareOnlyCapabilities = { canView: true, canManage: false, canPrepare: true, canApprove: false }
assert.equal(authorization.canConfigureAccountingScope(prepareOnlyCapabilities, 'organization_default'), false)
assert.equal(authorization.canConfigureAccountingScope(prepareOnlyCapabilities, 'location_override'), true)
assert.equal(authorization.canConfigureAccountingScope({ ...prepareOnlyCapabilities, canManage: true }, 'organization_default'), true)

let unauthorizedProfileSaveCalls = 0
const accountingRoute = loadTypeScriptModule('app_src/app/api/pos/accounting/route.ts', {
  'next/server': {
    NextResponse: {
      json: (payload, init) => ({ status: init.status, headers: init.headers, json: async () => payload }),
    },
  },
  '@/lib/accountingAuthorization': {
    accountingCapabilities: () => prepareOnlyCapabilities,
    activeAccountingOrganizationId: () => '11111111-1111-4111-8111-111111111111',
    canConfigureAccountingScope: authorization.canConfigureAccountingScope,
  },
  '@/lib/persistence/config': { isPostgresStorageEnabled: () => true },
  '@/lib/persistence/posAccountingNotifications': {
    reconcilePosAccountingIssueForDateInPostgres: async () => ({ status: 'resolved' }),
  },
  '@/lib/persistence/posAccounting': {
    POS_ACCOUNTING_SCOPES: ['organization_default', 'location_override'],
    PosAccountingRequestError: class PosAccountingRequestError extends Error {},
    readPosAccountingWorkspaceFromPostgres: async () => ({}),
    savePosAccountingMappingsInPostgres: async () => [],
    savePosAccountingProfileInPostgres: async () => { unauthorizedProfileSaveCalls += 1 },
    validatePosAccountingMappings: (value) => value,
    validatePosAccountingProfile: (value) => value,
  },
  '@/lib/requestUser': { requireRequestUser: async () => ({ email: 'preparer@example.test' }) },
})
const organizationConfigBody = JSON.stringify({
  action: 'save-profile',
  scope: 'organization_default',
  restaurantGuid: null,
  profile: {},
})
const organizationConfigResponse = await accountingRoute.PATCH({
  headers: { get: (name) => name === 'content-type' ? 'application/json' : String(Buffer.byteLength(organizationConfigBody)) },
  text: async () => organizationConfigBody,
})
assert.equal(organizationConfigResponse.status, 403)
assert.equal((await organizationConfigResponse.json()).code, 'POS_ACCOUNTING_ORGANIZATION_CONFIG_REQUIRED')
assert.equal(unauthorizedProfileSaveCalls, 0)

const projection = loadTypeScriptModule('app_src/lib/integrations/toastOrderProjection.ts')
const accounting = loadTypeScriptModule('app_src/lib/persistence/posAccounting.ts', {
  '@/lib/auditWriter': { recordAuditEvent: async () => {} },
  '@/lib/integrations/toastOrderProjection': projection,
  '@/lib/persistence/postgres': {
    acquireTransactionAdvisoryLock: async () => {},
    query: async () => { throw new Error('database access is not expected in focused unit tests') },
    withTransaction: async () => { throw new Error('database access is not expected in focused unit tests') },
  },
})
const companyFingerprint = accounting.posQuickBooksConnectionFingerprint({
  connectionId: 'connection-1', companyName: 'Suburbia Sandwich Co', country: 'US',
})
assert.match(companyFingerprint, /^[0-9a-f]{64}$/)
assert.equal(companyFingerprint, accounting.posQuickBooksConnectionFingerprint({
  connectionId: 'connection-1', companyName: 'Suburbia Sandwich Co', country: 'US',
}))
assert.notEqual(companyFingerprint, accounting.posQuickBooksConnectionFingerprint({
  connectionId: 'connection-1', companyName: 'Replacement Books', country: 'US',
}))

const profileInput = {
  postingMethod: 'itemized_sales_receipt',
  quickBooksClassId: null,
  quickBooksClassName: null,
  quickBooksDepartmentId: null,
  quickBooksDepartmentName: null,
  quickBooksCustomerId: null,
  quickBooksCustomerName: null,
  quickBooksClearingAccountId: '35',
  quickBooksClearingAccountName: 'Clearing Account',
  trackSalesTax: true,
  breakoutDimensions: ['order_source', 'payment_type'],
  memoMode: 'pos_date',
  customMemo: null,
  customTransactionNumber: true,
  transactionNumberSuffix: 'POS',
  suppressZeroOverShort: false,
  autoPayoutTips: false,
  depositChecksWithCash: false,
  openCheckPolicy: 'hold',
  batchHoldPolicy: 'hold_until_settled',
  emailNotificationsEnabled: false,
}
const validatedProfile = accounting.validatePosAccountingProfile(profileInput)
assert.equal(validatedProfile.transactionNumberSuffix, 'POS')
assert.throws(
  () => accounting.validatePosAccountingProfile({ ...profileInput, breakoutDimensions: ['guest_email'] }),
  /Breakout dimension is invalid/,
)
assert.throws(
  () => accounting.validatePosAccountingProfile({ ...profileInput, openCheckPolicy: 'post_anyway' }),
  /Open check policy is invalid/,
)
assert.throws(
  () => accounting.validatePosAccountingMappings([{
    sourceKind: 'fee', sourceId: 'fee-1', sourceName: 'Fee',
    targetType: 'item', targetId: '1', targetName: 'Wrong target', active: true,
  }]),
  /fee cannot map to item/,
)
assert.throws(
  () => accounting.validatePosAccountingMappings([{
    sourceKind: 'order_source', sourceId: 'source-1', sourceName: 'In Store',
    targetType: 'class', targetId: '1', targetName: 'In Store', active: true,
  }, {
    sourceKind: 'order_source', sourceId: 'source-1', sourceName: 'In Store',
    targetType: 'department', targetId: '2', targetName: 'Restaurant', active: true,
  }]),
  /source can only be mapped once/i,
)

const readyInputs = {
  available: true,
  balanced: true,
  sourceReconciled: true,
  mappingsComplete: true,
  unallocatedSubtotal: 0,
  holdReasons: [],
}
assert.equal(accounting.evaluatePosAccountingReadiness(readyInputs).readyForReview, true)
assert.equal(accounting.evaluatePosAccountingReadiness({ ...readyInputs, mappingsComplete: false }).readyForReview, false)
assert.equal(accounting.evaluatePosAccountingReadiness({ ...readyInputs, unallocatedSubtotal: 0.01 }).readyForReview, false)
assert.equal(accounting.evaluatePosAccountingReadiness({ ...readyInputs, holdReasons: ['Manual hold'] }).readyForReview, false)

const profile = {
  exists: true,
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  scope: 'organization_default',
  profileRevision: 2,
  schemaVersion: 1,
  effectiveFrom: '2026-07-18T00:00:00.000Z',
  effectiveTo: null,
  quickBooksBindingStatus: 'verified',
  quickBooksConnectionFingerprint: 'a'.repeat(64),
  quickBooksCompanyName: 'Suburbia Sandwich Co',
  quickBooksConnectionVerifiedAt: '2026-07-18T00:00:00.000Z',
  quickBooksCatalogSyncedAt: '2026-07-18T00:00:00.000Z',
  ...validatedProfile,
  createdBy: 'accounting@example.test',
  createdAt: '2026-07-18T00:00:00.000Z',
}
const july18Order = {
  business_date: '2026-07-18',
  source: 'In Store',
  dining_option: 'TAKE_OUT',
  gross_sales: 551.74,
  net_sales: 551.74,
  discounts: 0,
  tax: 40.58,
  service_charges: 0,
  tips: 65.42,
  refunds: 0,
  tendered: 592.32,
  total: 657.74,
  cash_tender: 0,
  card_tender: 592.32,
  other_tender: 0,
  updated_at: '2026-07-18T23:59:00.000Z',
  details: {
    checks: [{
      paymentStatus: 'PAID',
      paidAt: '2026-07-18T22:00:00.000Z',
      selections: [{
        itemGuid: '11111111-1111-4111-8111-111111111111',
        itemName: 'Daily sales',
        name: 'Daily sales',
        quantity: 1,
        net: 551.74,
        discounts: [],
        taxes: [{ providerGuid: '22222222-2222-4222-8222-222222222222', name: 'CT STATE TAX', amount: 40.58 }],
      }],
      payments: [{
        type: 'CREDIT', cardBrand: 'VISA', status: 'CAPTURED',
        amount: 592.32, tip: 65.42, processingFee: 28.21,
      }],
      discounts: [],
      taxes: [],
      serviceChargeLines: [],
    }],
  },
}
const preview = accounting.buildPosAccountingPreview({
  businessDate: '2026-07-18',
  restaurantName: 'Suburbia Sandwich Co',
  standardOnly: true,
  profile,
  mappings: [],
  orders: [july18Order],
})
assert.equal(preview.salesReceipt.subtotal, 551.74)
assert.equal(preview.salesReceipt.tax, 40.58)
assert.equal(preview.salesReceipt.tender, 592.32)
assert.equal(preview.salesReceipt.tips, 65.42)
assert.equal(preview.salesReceipt.total, 657.74)
assert.equal(preview.journal.calculatedNetCardSettlement, 629.53)
assert.equal(preview.journal.processingFees, 28.21)
assert.equal(preview.journal.feeEvidenceComplete, true)
assert.equal(preview.journal.debits, 657.74)
assert.equal(preview.journal.credits, 657.74)
assert.equal(preview.journal.balance, 0)
assert.equal(preview.journal.balanced, true)
assert.equal(preview.journal.verifiedBankDeposit, false)
assert.deepEqual(
  Array.from(preview.journal.unavailableInputs, (entry) => entry.key),
  ['payout_deposit'],
)
assert.equal(preview.containsPii, false)
assert.equal(preview.postingSideEffect, false)
assert.equal(preview.readiness.hold, true)
assert.equal(preview.readiness.readyForReview, false)
assert.equal(preview.readiness.mappingsComplete, false)

const legacyReadyPreview = accounting.buildPosAccountingPreview({
  businessDate: '2026-07-18',
  restaurantName: 'Suburbia Sandwich Co',
  standardOnly: true,
  profile,
  mappings: [],
  orders: [july18Order],
  draftEvidence: {
    status: 'needs_review', reconciliationStatus: 'ready', approvedBy: null,
    approvedAt: null, postedAt: null, quickBooksTransactionId: null, updatedAt: '2026-07-18T23:59:00.000Z',
  },
})
assert.equal(legacyReadyPreview.readiness.readyForReview, false, 'legacy draft readiness must not bypass canonical mappings')
assert.equal(legacyReadyPreview.evidence.protected, false)

const mixedCheckOrder = {
  ...july18Order,
  gross_sales: 150,
  net_sales: 150,
  tax: 9.53,
  tendered: 159.53,
  total: 159.53,
  card_tender: 159.53,
  tips: 0,
  details: {
    checks: [{
      paymentStatus: 'PAID', paidAt: '2026-07-18T20:00:00.000Z', closedAt: '2026-07-18T20:00:00.000Z',
      amount: 100, tax: 6.35, total: 106.35, serviceCharges: 0,
      selections: [{ itemGuid: 'closed-item', itemName: 'Closed item', quantity: 1, gross: 100, net: 100, discounts: [], taxes: [] }],
      payments: [{ type: 'CREDIT', cardBrand: 'VISA', amount: 106.35, tip: 0, processingFee: 3 }],
      discounts: [], taxes: [], serviceChargeLines: [],
    }, {
      paymentStatus: 'OPEN', paidAt: null, closedAt: null,
      amount: 50, tax: 3.18, total: 53.18, serviceCharges: 0,
      selections: [{ itemGuid: 'open-item', itemName: 'Open item', quantity: 1, gross: 50, net: 50, discounts: [], taxes: [] }],
      payments: [{ type: 'CREDIT', cardBrand: 'VISA', amount: 53.18, tip: 0, processingFee: 1.5 }],
      discounts: [], taxes: [], serviceChargeLines: [],
    }],
  },
}
const exclusionPreview = accounting.buildPosAccountingPreview({
  businessDate: '2026-07-18',
  restaurantName: 'Suburbia Sandwich Co',
  standardOnly: true,
  profile: { ...profile, openCheckPolicy: 'exclude' },
  mappings: [],
  orders: [mixedCheckOrder],
})
assert.equal(exclusionPreview.salesReceipt.subtotal, 100)
assert.equal(exclusionPreview.salesReceipt.tax, 6.35)
assert.equal(exclusionPreview.salesReceipt.total, 106.35)
assert.equal(exclusionPreview.salesReceipt.lineItems.length, 1)
assert.equal(exclusionPreview.salesReceipt.lineItems[0].sourceName, 'Closed item')
assert.equal(exclusionPreview.readiness.openChecks, 1)
assert.equal(exclusionPreview.readiness.excludedOpenChecks, 1)

const mappingSqlCalls = []
let mappingConnectionStatus = 'active'
const accountingPersistence = loadTypeScriptModule('app_src/lib/persistence/posAccounting.ts', {
  '@/lib/auditWriter': { recordAuditEvent: async () => {} },
  '@/lib/integrations/toastOrderProjection': projection,
  '@/lib/persistence/postgres': {
    acquireTransactionAdvisoryLock: async (client, key) => client.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))',
      [key],
    ),
    query: async () => { throw new Error('top-level query is not expected while saving mappings') },
    withTransaction: async (work) => work({
      query: async (sql, params = []) => {
        const source = String(sql)
        mappingSqlCalls.push({ source, params })
        if (source.includes('FROM toast_pos_orders')) return { rows: [july18Order], rowCount: 1 }
        if (source.includes('FROM organization_quickbooks_connections')) {
          return {
            rows: [{ status: mappingConnectionStatus, last_catalog_synced_at: '2026-07-18T23:00:00.000Z' }],
            rowCount: 1,
          }
        }
        if (source.includes('SELECT id::text, target_type, mapping_revision, effective_to')) {
          return {
            rows: [{
              id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
              target_type: 'account',
              mapping_revision: 1,
              effective_to: null,
            }],
            rowCount: 1,
          }
        }
        if (source.includes('INSERT INTO pos_accounting_catalog_mappings')) {
          return {
            rows: [{
              id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', restaurant_guid: null,
              source_kind: 'fee', source_id: 'summary:processing_fees', source_name: 'Processing fees',
              target_type: 'account', target_id: 'fee-account', target_name: 'Merchant fees',
              active: false, mapping_revision: 2,
              effective_from: '2026-07-19T00:00:00.000Z', effective_to: null,
              validation_status: 'unvalidated',
              validation_reason: 'Inactive mappings are retained but are not used by previews.',
              source_catalog_revision: 1, target_catalog_revision: 1, last_validated_at: null,
              created_by: 'manager@example.test', created_at: '2026-07-19T00:00:00.000Z',
            }],
            rowCount: 1,
          }
        }
        return { rows: [], rowCount: 1 }
      },
    }),
  },
})
const clearedMappings = await accountingPersistence.savePosAccountingMappingsInPostgres({
  organizationId: '11111111-1111-4111-8111-111111111111',
  restaurantGuid: null,
  scope: 'organization_default',
  actorEmail: 'manager@example.test',
  mappings: accountingPersistence.validatePosAccountingMappings([{
    sourceKind: 'fee', sourceId: 'summary:processing_fees', sourceName: 'Processing fees',
    targetType: 'account', targetId: 'fee-account', targetName: 'Merchant fees', active: false,
  }]),
})
assert.ok(
  mappingSqlCalls[0].source.includes('pg_advisory_xact_lock'),
  'POS mapping validation must serialize against QuickBooks rebinding',
)
assert.equal(mappingSqlCalls[0].params[0], 'quickbooks-binding:11111111-1111-4111-8111-111111111111')
assert.equal(clearedMappings[0].active, false)
assert.equal(clearedMappings[0].mappingRevision, 2)
const closePriorMapping = mappingSqlCalls.find((call) => call.source.includes('id = ANY($1::uuid[])'))
const insertClearedMapping = mappingSqlCalls.find((call) => call.source.includes('INSERT INTO pos_accounting_catalog_mappings'))
assert.deepEqual(Array.from(closePriorMapping.params[0]), ['cccccccc-cccc-4ccc-8ccc-cccccccccccc'])
assert.equal(insertClearedMapping.params[8], false)
assert.equal(insertClearedMapping.params[9], 2)

mappingConnectionStatus = 'disconnected'
await assert.rejects(
  accountingPersistence.savePosAccountingMappingsInPostgres({
    organizationId: '11111111-1111-4111-8111-111111111111',
    restaurantGuid: null,
    scope: 'organization_default',
    actorEmail: 'manager@example.test',
    mappings: accountingPersistence.validatePosAccountingMappings([{
      sourceKind: 'fee', sourceId: 'summary:processing_fees', sourceName: 'Processing fees',
      targetType: 'account', targetId: 'fee-account', targetName: 'Merchant fees', active: true,
    }]),
  }),
  (error) => error.code === 'POS_QUICKBOOKS_CONNECTION_REQUIRED' && error.status === 409,
)

const amexOrder = structuredClone(july18Order)
amexOrder.details.checks[0].payments[0].cardBrand = 'AMEX'
const multiBrandCatalog = accounting.discoverSafePosSourceCatalog([july18Order, amexOrder])
assert.ok(multiBrandCatalog.some((entry) => (
  entry.sourceKind === 'card_brand'
  && entry.sourceId === 'summary:card_settlement'
  && entry.sourceName === 'Calculated card settlement'
)))
const multiBrandPreview = accounting.buildPosAccountingPreview({
  businessDate: '2026-07-18',
  restaurantName: 'Suburbia Sandwich Co',
  standardOnly: true,
  profile,
  mappings: [{
    id: 'mapping-card-settlement',
    scope: 'organization_default',
    sourceKind: 'card_brand',
    sourceId: 'summary:card_settlement',
    sourceName: 'Calculated card settlement',
    targetType: 'account',
    targetId: '1000',
    targetName: 'Operating Checking',
    active: true,
    mappingRevision: 1,
    effectiveFrom: '2026-07-18T00:00:00.000Z',
    effectiveTo: null,
    validationStatus: 'valid',
    validationReason: null,
    sourceCatalogRevision: 1,
    targetCatalogRevision: 1,
    lastValidatedAt: '2026-07-18T00:00:00.000Z',
    createdBy: 'accounting@example.test',
    createdAt: '2026-07-18T00:00:00.000Z',
  }],
  orders: [july18Order, amexOrder],
})
const settlementLine = multiBrandPreview.journal.lines.find((line) => line.code === 'calculated_net_card_settlement')
assert.equal(settlementLine?.sourceId, 'summary:card_settlement')
assert.equal(settlementLine?.target?.id, '1000')

const stableMenuCatalog = accounting.mergeStableToastMenuCatalog(
  accounting.discoverSafePosSourceCatalog([july18Order]),
  [{
    itemGuid: '11111111-1111-4111-8111-111111111111',
    providerItemId: '11111111-1111-4111-8111-111111111111',
    name: 'Daily sales',
    plu: 'DAILY-1',
    price: 12.5,
  }, {
    itemGuid: '12121212-1212-4121-8121-121212121212',
    providerItemId: '12121212-1212-4121-8121-121212121212',
    name: 'ICED TEA | Blueberry Green',
    plu: 'TEA-1',
    price: 5.75,
  }],
)
const observedMenuItem = stableMenuCatalog.find((entry) => entry.sourceName === 'Daily sales')
assert.equal(observedMenuItem.catalogOrigin, 'observed_and_menu')
assert.equal(observedMenuItem.sku, 'DAILY-1')
assert.equal(observedMenuItem.unitPrice, 12.5)
const unobservedMenuItem = stableMenuCatalog.find((entry) => entry.sourceName === 'ICED TEA | Blueberry Green')
assert.equal(unobservedMenuItem.catalogOrigin, 'menu')
assert.equal(unobservedMenuItem.occurrenceCount, 0)
assert.equal(unobservedMenuItem.unitPrice, 5.75)

const exactQuickBooksSuggestion = accounting.suggestQuickBooksItemForPosSource(unobservedMenuItem, [{
  quickbooks_item_id: 'qb-tea',
  name: 'ICED TEA | Blueberry Green',
  fully_qualified_name: 'Beverages:ICED TEA | Blueberry Green',
  item_type: 'NonInventory',
  sku: null,
  taxable: true,
}])
assert.equal(exactQuickBooksSuggestion.id, 'qb-tea')
assert.equal(exactQuickBooksSuggestion.confidence, 'exact')
assert.equal(accounting.suggestQuickBooksItemForPosSource(unobservedMenuItem, []), null)
assert.equal(accounting.suggestQuickBooksItemForPosSource(unobservedMenuItem, [{
  quickbooks_item_id: 'qb-tea-1', name: 'ICED TEA - Blueberry Green',
  fully_qualified_name: 'ICED TEA - Blueberry Green', item_type: 'NonInventory', sku: null, taxable: true,
}, {
  quickbooks_item_id: 'qb-tea-2', name: 'ICED TEA Blueberry Green',
  fully_qualified_name: 'ICED TEA Blueberry Green', item_type: 'NonInventory', sku: null, taxable: true,
}]), null, 'ambiguous normalized product matches must require operator review')
assert.equal(accounting.suggestQuickBooksItemForPosSource(unobservedMenuItem, [{
  quickbooks_item_id: 'qb-category', name: 'ICED TEA | Blueberry Green',
  fully_qualified_name: 'Beverages:ICED TEA | Blueberry Green', item_type: 'Category', sku: null, taxable: false,
}]), null, 'QuickBooks categories must not be suggested as transaction items')
const categoryGuardedMappings = accounting.invalidateUnavailableQuickBooksItemTargets([{
  id: 'mapping-category', scope: 'organization_default', sourceKind: 'sales_item', sourceId: 'toast-item', sourceName: 'Toast item',
  targetType: 'item', targetId: 'qb-category', targetName: 'Beverages', active: true, mappingRevision: 1,
  effectiveFrom: '2026-07-21T00:00:00.000Z', effectiveTo: null, validationStatus: 'valid', validationReason: null,
  sourceCatalogRevision: 1, targetCatalogRevision: 1, lastValidatedAt: null, createdBy: 'manager@example.com', createdAt: '2026-07-21T00:00:00.000Z',
}], ['qb-product'])
assert.equal(categoryGuardedMappings[0].validationStatus, 'missing_target')
assert.match(categoryGuardedMappings[0].validationReason, /active QuickBooks product or service/)

const quickBooksActionsPanel = read('app_src/components/accounting/QuickBooksActionsPanel.tsx')
assert.ok(quickBooksActionsPanel.includes('<DetailField label="Category" value={payload.parentCategoryName} />'))
assert.ok(quickBooksActionsPanel.includes('initialRequestId?: string | null'))
assert.ok(quickBooksActionsPanel.includes('setSelected(request)'))
assert.ok(quickBooksActionsPanel.includes("parameters.set('requestId', initialRequestToLoad.current)"))
assert.ok(quickBooksActionsPanel.includes('This accounting draft was not found in the active organization.'))

const posAccountingPanel = read('app_src/components/pos/PosAccountingPanel.tsx')
assert.ok(posAccountingPanel.includes('buildAccountingDraftReviewUrl(oldURL, prepared.id)'))
assert.ok(posAccountingPanel.includes('QuickBooks has not been changed yet.'))
assert.ok(posAccountingPanel.includes('open={Boolean(preparedProductDraft) && preparedProductDraftDialogOpen}'))
assert.ok(posAccountingPanel.includes('onClose={() => setPreparedProductDraftDialogOpen(false)}'))
assert.ok(posAccountingPanel.includes('<Button onClick={() => setPreparedProductDraftDialogOpen(false)}>Later</Button>'))
assert.ok(posAccountingPanel.includes('preparedProductDraft ? <Button color="inherit" size="small" onClick={() => reviewPreparedProductDraft(preparedProductDraft)}>Review draft</Button>'))

const accountingSection = read('app_src/components/accounting/AccountingSection.tsx')
assert.ok(accountingSection.includes('consumeAccountingDraftTarget(window.location.href)'))
assert.ok(accountingSection.includes('initialRequestId={initialActionRequestId}'))
assert.ok(accountingSection.includes('onInitialRequestHandled={() => setInitialActionRequestId(null)}'))

const accountingDraftNavigation = loadTypeScriptModule('app_src/lib/accountingDraftNavigation.ts')
assert.equal(accountingDraftNavigation.accountingExplorerViewParameter('overview'), null)
assert.equal(accountingDraftNavigation.accountingExplorerViewParameter('actions'), null)
assert.equal(accountingDraftNavigation.accountingExplorerViewParameter('products'), 'products')
const draftRequestId = '3C788366-C864-43C7-87B4-ADF481C94943'
const draftReviewUrl = accountingDraftNavigation.buildAccountingDraftReviewUrl(
  'https://aiapp.eigenracing.com/?posView=accounting&location=truck&date=2026-07-21#pos',
  draftRequestId,
)
assert.equal(draftReviewUrl.hash, '#accounting')
assert.equal(draftReviewUrl.searchParams.get('accountingView'), 'actions')
assert.equal(draftReviewUrl.searchParams.get('accountingRequest'), draftRequestId.toLowerCase())
assert.equal(draftReviewUrl.searchParams.has('posView'), false)
assert.equal(draftReviewUrl.searchParams.has('location'), false)
assert.equal(draftReviewUrl.searchParams.has('date'), false)
const consumedDraftTarget = accountingDraftNavigation.consumeAccountingDraftTarget(draftReviewUrl.toString())
assert.equal(consumedDraftTarget.view, 'actions')
assert.equal(consumedDraftTarget.requestId, draftRequestId.toLowerCase())
assert.equal(consumedDraftTarget.hasTarget, true)
assert.equal(consumedDraftTarget.cleanUrl, '/#accounting')

const mixedRefundSummary = projection.summarizeToastProjectedChecks([{
  amount: 100,
  tax: 6,
  total: 116,
  serviceCharges: 0,
  voided: false,
  deleted: false,
  selections: [{ gross: 100, net: 100, voided: false }],
  payments: [{
    type: 'CREDIT', amount: 120, tip: 10,
    refundAmount: 20, tipRefundAmount: 4,
  }],
}, {
  amount: 500,
  tax: 30,
  total: 530,
  serviceCharges: 0,
  voided: true,
  deleted: false,
  selections: [{ gross: 500, net: 500, voided: false }],
  payments: [{
    type: 'CREDIT', amount: 530, tip: 0,
    refundAmount: 0, tipRefundAmount: 0,
  }],
}])
assert.equal(mixedRefundSummary.activeChecks.length, 1)
assert.equal(mixedRefundSummary.netSales, 80)
assert.equal(mixedRefundSummary.tips, 6)
assert.equal(mixedRefundSummary.refunds, 24)
assert.equal(mixedRefundSummary.tendered, 100)
assert.equal(mixedRefundSummary.total, 106)
assert.equal(mixedRefundSummary.cardTender, 100)

const projected = projection.projectToastOrder({
  guid: '33333333-3333-4333-8333-333333333333',
  customer: { email: 'guest@example.test' },
  checks: [{
    guid: '44444444-4444-4444-8444-444444444444',
    paymentStatus: 'PAID',
    amount: 551.74,
    taxAmount: 40.58,
    totalAmount: 592.32,
    server: { name: 'Private Server' },
    selections: [{
      guid: '55555555-5555-4555-8555-555555555555',
      displayName: 'B.E.C', quantity: 1, price: 551.74,
      item: {
        guid: '66666666-6666-4666-8666-666666666666',
        multiLocationId: 'toast-item-bec', name: 'B.E.C', plu: '1001',
      },
      itemGroup: { guid: '77777777-7777-4777-8777-777777777777', name: 'Breakfast' },
      salesCategory: { guid: '88888888-8888-4888-8888-888888888888', name: 'Mains' },
      appliedDiscounts: [{
        discount: { guid: '99999999-9999-4999-8999-999999999999', name: 'Promo' },
        discountType: 'PERCENT', discountAmount: 5, percent: 10, approver: { name: 'Private Approver' },
      }],
      appliedTaxes: [{
        taxRate: { guid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'CT STATE TAX', rate: 0.0635 },
        taxAmount: 40.58, customer: { name: 'Private Guest' },
      }],
    }],
    payments: [{
      guid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      type: 'CREDIT', cardType: 'VISA', status: 'CAPTURED',
      amount: 592.32, tipAmount: 65.42, originalProcessingFee: 28.21,
      first6Digits: '411111', last4Digits: '4242', customer: { email: 'guest@example.test' },
    }],
  }],
}, 'fixture')
const payment = projected.details.checks[0].payments[0]
assert.equal(payment.processingFee, 28.21)
assert.equal(payment.cardBrand, 'VISA')
assert.equal(projected.total, 657.74)
assert.equal(projected.details.checks[0].selections[0].itemGuid, '66666666-6666-4666-8666-666666666666')
assert.equal(projected.details.checks[0].selections[0].discounts[0].providerGuid, '99999999-9999-4999-8999-999999999999')
assert.equal(projected.details.checks[0].selections[0].taxes[0].rate, 0.0635)
const safeDetails = JSON.stringify(projected.details).toLowerCase()
for (const forbidden of [
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '411111', '4242',
  'guest@example.test', 'private server', 'private approver', 'private guest',
]) {
  assert.equal(safeDetails.includes(forbidden), false, `safe projection exposed ${forbidden}`)
}

console.log('POS accounting contracts passed')
