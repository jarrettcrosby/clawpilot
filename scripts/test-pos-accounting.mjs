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

const dateCommandsMigration = read('db/migrations/0078_pos_accounting_date_commands.sql')
for (const fragment of [
  'draft_revision integer NOT NULL DEFAULT 1',
  "generation_reason IN ('automatic_sync', 'reload_sales', 'regenerate_accounting')",
  'supersedes_draft_id uuid',
  'WHERE is_current',
  'CREATE TABLE IF NOT EXISTS pos_accounting_commands',
  "command_type IN ('reload_sales', 'regenerate_accounting')",
  'uq_pos_accounting_active_command',
  'NEW.source_summary := OLD.source_summary',
  'NEW.quickbooks_payload := OLD.quickbooks_payload',
  'NEW.approved_by := OLD.approved_by',
  'NEW.created_at := OLD.created_at',
]) {
  assert.ok(dateCommandsMigration.includes(fragment), `POS accounting date command migration missing ${fragment}`)
}

const postingOutcomesMigration = read('db/migrations/0079_pos_accounting_posting_outcomes.sql')
for (const fragment of [
  'CREATE TABLE IF NOT EXISTS pos_accounting_posting_batches',
  'quickbooks_sales_receipt_id text',
  'quickbooks_journal_entry_id text',
  "review_outcome = 'shogo_posted'",
  "OLD.status IN ('approved', 'posting', 'posted', 'failed')",
]) {
  assert.ok(postingOutcomesMigration.includes(fragment), `POS accounting posting migration missing ${fragment}`)
}

const externalPostingOutcomesMigration = read('db/migrations/0080_external_pos_accounting_outcomes.sql')
for (const fragment of [
  'external_posting_provider text',
  'external_posting_reference text',
  "review_outcome = 'externally_posted'",
  "posting_origin = 'external'",
  'quickbooks_sales_receipt_id IS NOT NULL',
  'quickbooks_journal_entry_id IS NOT NULL',
]) {
  assert.ok(externalPostingOutcomesMigration.includes(fragment), `External POS accounting outcome migration missing ${fragment}`)
}

const paymentExceptionMigration = read('db/migrations/0102_pos_payment_exceptions.sql')
for (const fragment of [
  'payment_business_dates date[]',
  'fulfillment_business_date date',
  "'payment_exception'",
  'pos_accounting_mapping_target_compatible',
  'ALTER COLUMN sales_receipt_request_id DROP NOT NULL',
  'quickbooks_journal_entry_id IS NOT NULL',
  'jsonb_path_exists',
]) {
  assert.ok(paymentExceptionMigration.includes(fragment), `Payment exception migration missing ${fragment}`)
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
  'regeneratePosAccountingDraftInPostgres',
  'runPosAccountingRegenerationCommandInPostgres',
  'finalizePosAccountingReloadForDateInPostgres',
  "generatedFrom: 'stored_pos_sales'",
  "generationReason: 'regenerate_accounting'",
  'forceNewRevision: true',
  'SET is_current = false, superseded_at = now()',
  'status NOT IN (\'approved\', \'posting\', \'posted\', \'failed\')',
  'pos.accounting.sales_reload.completed',
  'pos.accounting.regenerated',
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
  "action === 'reload-sales'",
  "action === 'regenerate-accounting'",
  'capabilities.canPrepare',
  'queuePosAccountingSalesReloadInPostgres',
  'runPosAccountingRegenerationCommandInPostgres',
  'PROFILE_FIELDS',
  'MAPPING_FIELDS',
  'MAX_REQUEST_BYTES',
  "'Cache-Control': 'private, no-store'",
]) {
  assert.ok(route.includes(fragment), `POS accounting route missing ${fragment}`)
}
assert.equal(route.includes('export async function POST'), true, 'Accounting route must expose bounded date commands')
assert.equal(route.includes('quickbooks_payload'), false, 'Accounting date commands must not post to QuickBooks')

const panel = read('app_src/components/pos/PosAccountingPanel.tsx')
for (const fragment of [
  "capabilities.canPrepare === true && scope === 'location_override'",
  'disabled={capabilities.canManage !== true}',
  'mapping.active',
  ": { targetId: '', targetName: '', active: false }",
  "operationKind: 'item.create'",
  'clientRequestId: productDraft.clientRequestId',
  "setTargetInputBySource((current) => ({ ...current, [sourceKey]: '' }))",
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
  'Date accounting controls',
  'Reload sales',
  'Regenerate accounting',
  "method: 'POST'",
  "action === 'reload-sales'",
]) {
  assert.ok(panel.includes(fragment), `POS accounting panel missing ${fragment}`)
}

const parityPanel = read('app_src/components/accounting/PosAccountingParityPanel.tsx')
for (const fragment of [
  'Acknowledge external posting',
  "action: 'record-external-draft'",
  "action: 'record-external-range'",
  'ClawPilot will not create, approve, or resend a QuickBooks transaction.',
  'Sales Receipt ID',
  'Journal Entry ID',
  'failed validation and remain in Needs Review',
]) {
  assert.ok(parityPanel.includes(fragment), `POS accounting parity panel missing ${fragment}`)
}

const posSection = read('app_src/components/pos/PosSection.tsx')
for (const fragment of [
  'businessDate={to}',
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
let routeCapabilities = prepareOnlyCapabilities
const reloadCommandCalls = []
const regenerationCommandCalls = []
const accountingRoute = loadTypeScriptModule('app_src/app/api/pos/accounting/route.ts', {
  'next/server': {
    NextResponse: {
      json: (payload, init) => ({ status: init.status, headers: init.headers, json: async () => payload }),
    },
  },
  '@/lib/accountingAuthorization': {
    accountingCapabilities: () => routeCapabilities,
    activeAccountingOrganizationId: () => '11111111-1111-4111-8111-111111111111',
    canConfigureAccountingScope: authorization.canConfigureAccountingScope,
  },
  '@/lib/persistence/config': { isPostgresStorageEnabled: () => true },
  '@/lib/persistence/posAccountingNotifications': {
    reconcilePosAccountingIssueForDateInPostgres: async () => ({ status: 'resolved' }),
  },
  '@/lib/persistence/posAccounting': {
    POS_ACCOUNTING_SCOPES: ['organization_default', 'location_override'],
    PosAccountingRequestError: class PosAccountingRequestError extends Error {
      constructor(code, message, status = 400) {
        super(message)
        this.code = code
        this.status = status
      }
    },
    readPosAccountingWorkspaceFromPostgres: async () => ({}),
    runPosAccountingRegenerationCommandInPostgres: async (input) => {
      regenerationCommandCalls.push(input)
      return { draft: { id: 'draft-2', draftRevision: 2 }, command: { id: 'command-2', status: 'succeeded' } }
    },
    savePosAccountingMappingsInPostgres: async () => ({ mappings: [], changedCount: 0 }),
    savePosAccountingProfileInPostgres: async () => { unauthorizedProfileSaveCalls += 1 },
    validatePosAccountingMappings: (value) => value,
    validatePosAccountingProfile: (value) => value,
  },
  '@/lib/persistence/toastIntegrations': {
    queuePosAccountingSalesReloadInPostgres: async (input) => {
      reloadCommandCalls.push(input)
      return { id: 'command-1', commandType: 'reload_sales', status: 'queued' }
    },
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

const dateCommandBody = (action) => JSON.stringify({
  action,
  restaurantGuid: '22222222-2222-4222-8222-222222222222',
  businessDate: '2026-07-18',
})
const commandRequest = (action) => {
  const body = dateCommandBody(action)
  return {
    headers: { get: (name) => name === 'content-type' ? 'application/json' : String(Buffer.byteLength(body)) },
    text: async () => body,
  }
}
routeCapabilities = { canView: true, canManage: false, canPrepare: false, canApprove: false }
const deniedCommandResponse = await accountingRoute.POST(commandRequest('reload-sales'))
assert.equal(deniedCommandResponse.status, 403)
assert.equal((await deniedCommandResponse.json()).code, 'POS_ACCOUNTING_PREPARE_REQUIRED')
assert.equal(reloadCommandCalls.length, 0)

routeCapabilities = prepareOnlyCapabilities
const reloadCommandResponse = await accountingRoute.POST(commandRequest('reload-sales'))
assert.equal(reloadCommandResponse.status, 202)
assert.equal(reloadCommandCalls.length, 1)
assert.deepEqual(
  JSON.parse(JSON.stringify(reloadCommandCalls[0])),
  {
    organizationId: '11111111-1111-4111-8111-111111111111',
    restaurantGuid: '22222222-2222-4222-8222-222222222222',
    businessDate: '2026-07-18',
    actorEmail: 'preparer@example.test',
  },
)
const reloadCallsBeforeRegeneration = reloadCommandCalls.length
const regenerationResponse = await accountingRoute.POST(commandRequest('regenerate-accounting'))
assert.equal(regenerationResponse.status, 200)
assert.equal(regenerationCommandCalls.length, 1)
assert.equal(reloadCommandCalls.length, reloadCallsBeforeRegeneration, 'regeneration must not queue or call Toast')
assert.equal(regenerationCommandCalls[0].organizationId, '11111111-1111-4111-8111-111111111111')
assert.equal(regenerationCommandCalls[0].restaurantGuid, '22222222-2222-4222-8222-222222222222')
assert.equal(regenerationCommandCalls[0].businessDate, '2026-07-18')

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
assert.equal(
  persistenceSource.includes('@/lib/integrations/toastClient'),
  false,
  'stored-sales accounting regeneration must not import or call the Toast client',
)

const protectedDraft = {
  id: '55555555-5555-4555-8555-555555555555',
  status: 'approved',
  reconciliation_status: 'ready',
  approved_by: 'approver@example.test',
  approved_at: '2026-07-19T12:00:00.000Z',
  posted_at: null,
  quickbooks_transaction_id: null,
  draft_revision: 4,
  generation_reason: 'automatic_sync',
  generated_by: null,
  source_revision: 8,
  supersedes_draft_id: null,
  is_current: true,
  created_at: '2026-07-19T11:00:00.000Z',
  updated_at: '2026-07-19T12:00:00.000Z',
}
const regenerationQueries = []
const regenerationAccounting = loadTypeScriptModule('app_src/lib/persistence/posAccounting.ts', {
  '@/lib/auditWriter': { recordAuditEvent: async () => {} },
  '@/lib/integrations/toastOrderProjection': projection,
  '@/lib/persistence/postgres': {
    acquireTransactionAdvisoryLock: async () => {},
    query: async (sql, params = []) => {
      const source = String(sql)
      regenerationQueries.push({ source, params: [...params], client: false })
      if (source.includes('FROM toast_locations')) {
        return {
          rows: [{
            restaurant_guid: '22222222-2222-4222-8222-222222222222',
            restaurant_name: 'Test Restaurant',
            location_name: 'Downtown',
            analytics_access: false,
            standard_access: true,
          }],
          rowCount: 1,
        }
      }
      return { rows: [], rowCount: 0 }
    },
    withTransaction: async (work) => work({
      query: async (sql, params = []) => {
        const source = String(sql)
        regenerationQueries.push({ source, params: [...params], client: true })
        if (source.includes('FROM toast_daily_sales')) {
          return {
            rows: [{
              gross_sales: '0', net_sales: '0', discounts: '0', voids: '0', refunds: '0',
              orders_count: 0, standard_orders_count: 1,
              standard_gross_sales: '20', standard_net_sales: '20', standard_discounts: '0',
              standard_voids: '0', standard_refunds: '0', standard_tax: '1.2', standard_tips: '3',
              standard_service_charges: '0', standard_tendered: '21.2', standard_total: '24.2',
              standard_cash: '0', standard_card: '24.2', standard_other_tender: '0',
              source_revision: 9, updated_at: '2026-07-20T12:00:00.000Z',
            }],
            rowCount: 1,
          }
        }
        if (source.includes('FROM toast_sync_outbox')) {
          return { rows: [{ sync_kind: 'standard_orders', status: 'succeeded' }], rowCount: 1 }
        }
        if (source.includes('FROM toast_accounting_export_drafts')) {
          return { rows: [protectedDraft], rowCount: 1 }
        }
        if (source.includes('SET is_current = false, superseded_at = now()')) {
          return { rows: [], rowCount: 1 }
        }
        if (source.includes('INSERT INTO toast_accounting_export_drafts')) {
          return {
            rows: [{
              ...protectedDraft,
              id: '66666666-6666-4666-8666-666666666666',
              status: 'needs_review',
              reconciliation_status: 'orders_only',
              approved_by: null,
              approved_at: null,
              draft_revision: 5,
              generation_reason: 'regenerate_accounting',
              generated_by: 'preparer@example.test',
              source_revision: 9,
              supersedes_draft_id: protectedDraft.id,
              created_at: '2026-07-20T12:01:00.000Z',
              updated_at: '2026-07-20T12:01:00.000Z',
            }],
            rowCount: 1,
          }
        }
        return { rows: [], rowCount: 1 }
      },
    }),
  },
})
const regenerated = await regenerationAccounting.regeneratePosAccountingDraftInPostgres({
  organizationId: '11111111-1111-4111-8111-111111111111',
  restaurantGuid: '22222222-2222-4222-8222-222222222222',
  businessDate: '2026-07-20',
  actorEmail: 'preparer@example.test',
  generationReason: 'regenerate_accounting',
  forceNewRevision: true,
})
assert.equal(regenerated.createdRevision, true)
assert.equal(regenerated.draft.draftRevision, 5)
assert.equal(regenerated.draft.supersedesDraftId, protectedDraft.id)
assert.ok(regenerationQueries.some((entry) => entry.source.includes('SET is_current = false, superseded_at = now()')))
const insertedRevision = regenerationQueries.find((entry) => entry.source.includes('INSERT INTO toast_accounting_export_drafts'))
assert.ok(insertedRevision)
assert.equal(insertedRevision.params[8], 5)
assert.equal(insertedRevision.params[9], 'regenerate_accounting')
assert.equal(insertedRevision.params[12], protectedDraft.id)
const regeneratedSummary = JSON.parse(insertedRevision.params[6])
assert.equal(regeneratedSummary.canonical.generatedFrom, 'stored_pos_sales')
assert.equal(regeneratedSummary.canonical.sourceRevision, 9)
assert.equal(regeneratedSummary.canonical.updateRequired, true)
assert.equal(regeneratedSummary.canonical.readiness.readyForReview, false)
assert.ok(regeneratedSummary.canonical.readiness.blockers.some((blocker) => blocker.code === 'update_hold'))
assert.equal(insertedRevision.params[4], 'needs_mapping')
assert.equal(regeneratedSummary.standard.total, 24.2)

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
assert.equal(preview.salesReceipt.total, 592.32)
assert.equal(preview.salesReceipt.total, preview.salesReceipt.tender)
assert.equal(Math.round((preview.salesReceipt.total + preview.salesReceipt.tips) * 100) / 100, 657.74)
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

const discountRefundPreview = accounting.buildPosAccountingPreview({
  businessDate: '2026-07-18',
  restaurantName: 'Suburbia Sandwich Co',
  standardOnly: true,
  profile,
  mappings: [],
  orders: [{
    ...july18Order,
    gross_sales: 120,
    net_sales: 90,
    discounts: 10,
    tax: 6,
    tips: 6,
    refunds: 20,
    tendered: 96,
    total: 102,
    card_tender: 96,
    details: { checks: [] },
  }],
})
assert.equal(discountRefundPreview.salesReceipt.subtotal, 90)
assert.equal(discountRefundPreview.salesReceipt.discounts, 10)
assert.equal(discountRefundPreview.salesReceipt.tax, 6)
assert.equal(discountRefundPreview.salesReceipt.tender, 96)
assert.equal(discountRefundPreview.salesReceipt.tips, 6)
assert.equal(discountRefundPreview.salesReceipt.total, 96, 'net sales must not have discounts or refunds subtracted twice')
assert.equal(discountRefundPreview.journal.debits, 102)
assert.equal(discountRefundPreview.journal.credits, 102)
assert.equal(discountRefundPreview.journal.balanced, true)
assert.equal(discountRefundPreview.postingSideEffect, false)

const netDiscountOrder = structuredClone(july18Order)
netDiscountOrder.gross_sales = 559
netDiscountOrder.discounts = 7.26
netDiscountOrder.details.checks[0].selections[0].gross = 559
netDiscountOrder.details.checks[0].selections[0].discounts = [{
  providerGuid: '33333333-3333-4333-8333-333333333333',
  name: 'Open % Item',
  amount: 5.76,
}, {
  providerGuid: '44444444-4444-4444-8444-444444444444',
  name: 'Open $ Item',
  amount: 1.5,
}]
const unmappedNetDiscountPreview = accounting.buildPosAccountingPreview({
  businessDate: '2026-07-18',
  restaurantName: 'Suburbia Sandwich Co',
  standardOnly: true,
  profile,
  mappings: [],
  orders: [netDiscountOrder],
})
assert.equal(unmappedNetDiscountPreview.salesReceipt.discounts, 7.26)
assert.equal(unmappedNetDiscountPreview.salesReceipt.itemizedTotal, 551.74)
assert.equal(unmappedNetDiscountPreview.salesReceipt.unallocatedSubtotal, 0)
assert.equal(
  unmappedNetDiscountPreview.readiness.missingMappings.some((entry) => entry.sourceKind === 'discount'),
  false,
  'discounts already netted into item lines must not require a separate QuickBooks target',
)
const netDiscountPreview = accounting.buildPosAccountingPreview({
  businessDate: '2026-07-18',
  restaurantName: 'Suburbia Sandwich Co',
  standardOnly: true,
  profile,
  mappings: unmappedNetDiscountPreview.readiness.missingMappings.map((entry, index) => ({
    ...entry,
    targetId: `net-discount-target-${index}`,
    targetName: `Net discount target ${index}`,
    active: true,
    validationStatus: 'valid',
  })),
  orders: [netDiscountOrder],
})
assert.equal(netDiscountPreview.readiness.mappingsComplete, true)
assert.equal(netDiscountPreview.readiness.allocationComplete, true)
assert.deepEqual(Array.from(netDiscountPreview.readiness.missingMappings), [])
assert.equal(netDiscountPreview.salesReceipt.total, 592.32)
assert.equal(netDiscountPreview.journal.debits, 657.74)
assert.equal(netDiscountPreview.journal.credits, 657.74)
assert.equal(netDiscountPreview.postingSideEffect, false)

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

const preorderOrder = structuredClone(july18Order)
Object.assign(preorderOrder, {
  order_guid: 'preorder-1',
  display_number: '1',
  business_date: '2026-07-25',
  fulfillment_business_date: '2026-07-25',
  payment_business_dates: ['2026-07-23'],
  created_at_source: '2026-07-24T02:10:00.000Z',
  gross_sales: 41.82,
  net_sales: 41.82,
  discounts: 0,
  tax: 2.72,
  service_charges: 0,
  tips: 0,
  refunds: 0,
  tendered: 44.54,
  total: 44.54,
  cash_tender: 0,
  card_tender: 44.54,
  other_tender: 0,
})
Object.assign(preorderOrder.details.checks[0], {
  providerGuid: 'preorder-check-1',
  displayNumber: '1',
  amount: 41.82,
  tax: 2.72,
  total: 44.54,
  paidAt: '2026-07-24T02:10:00.000Z',
  closedAt: '2026-07-24T02:10:00.000Z',
})
Object.assign(preorderOrder.details.checks[0].selections[0], {
  quantity: 1,
  gross: 41.82,
  net: 41.82,
  tax: 2.72,
})
Object.assign(preorderOrder.details.checks[0].payments[0], {
  amount: 44.54,
  tip: 0,
  processingFee: 1.95,
  paidAt: '2026-07-24T05:10:00.000Z',
  paidBusinessDate: 20260723,
})

const captureHoldPreview = accounting.buildPosAccountingPreview({
  businessDate: '2026-07-23',
  restaurantName: 'Suburbia Sandwich Co',
  locationTimezone: 'America/New_York',
  standardOnly: true,
  profile: { ...profile, batchHoldPolicy: 'do_not_hold' },
  mappings: [],
  orders: [preorderOrder],
})
assert.equal(captureHoldPreview.salesReceipt.lineItems.length, 0)
assert.equal(captureHoldPreview.salesReceipt.total, 0)
assert.equal(captureHoldPreview.paymentExceptions.captureChecks, 1)
assert.equal(captureHoldPreview.paymentExceptions.captureAmount, 44.54)
assert.equal(captureHoldPreview.paymentExceptions.releaseAmount, 0)
assert.equal(captureHoldPreview.journal.kind, 'payment_exception')
assert.equal(captureHoldPreview.journal.debits, 44.54)
assert.equal(captureHoldPreview.journal.credits, 44.54)
assert.equal(
  captureHoldPreview.journal.lines.find((line) => line.code === 'calculated_net_card_settlement')?.amount,
  42.59,
)
assert.equal(
  captureHoldPreview.journal.lines.find((line) => line.code === 'processing_fees')?.amount,
  1.95,
)
assert.equal(
  captureHoldPreview.journal.lines.find((line) => line.code === 'payment_exception_capture')?.amount,
  44.54,
)
assert.ok(captureHoldPreview.readiness.blockers.some((blocker) =>
  blocker.code === 'payment_exception_mapping_required'
  && blocker.action === 'Map account'
  && blocker.affectedChecks === 1))

const mappingFor = (entry, index) => ({
  ...entry,
  targetId: `payment-exception-target-${index}`,
  targetName: `Payment exception target ${index}`,
  active: true,
  validationStatus: 'valid',
})
const captureMappings = captureHoldPreview.readiness.missingMappings.map(mappingFor)
const captureReadyPreview = accounting.buildPosAccountingPreview({
  businessDate: '2026-07-23',
  restaurantName: 'Suburbia Sandwich Co',
  locationTimezone: 'America/New_York',
  standardOnly: true,
  profile: { ...profile, batchHoldPolicy: 'do_not_hold' },
  mappings: captureMappings,
  orders: [preorderOrder],
})
assert.equal(captureReadyPreview.readiness.readyForReview, true)
assert.equal(captureReadyPreview.readiness.blockers.length, 0)

const fulfillmentMappingPreview = accounting.buildPosAccountingPreview({
  businessDate: '2026-07-25',
  restaurantName: 'Suburbia Sandwich Co',
  locationTimezone: 'America/New_York',
  standardOnly: true,
  profile: { ...profile, batchHoldPolicy: 'do_not_hold' },
  mappings: captureMappings,
  orders: [preorderOrder],
})
const mappingByKey = new Map(
  [...captureMappings, ...fulfillmentMappingPreview.readiness.missingMappings.map(mappingFor)]
    .map((entry) => [`${entry.sourceKind}:${entry.sourceId}:${entry.targetType}`, entry]),
)
const fulfillmentReadyPreview = accounting.buildPosAccountingPreview({
  businessDate: '2026-07-25',
  restaurantName: 'Suburbia Sandwich Co',
  locationTimezone: 'America/New_York',
  standardOnly: true,
  profile: { ...profile, batchHoldPolicy: 'do_not_hold' },
  mappings: [...mappingByKey.values()],
  orders: [preorderOrder],
})
assert.equal(fulfillmentReadyPreview.salesReceipt.total, 44.54)
assert.equal(fulfillmentReadyPreview.paymentExceptions.captureAmount, 0)
assert.equal(fulfillmentReadyPreview.paymentExceptions.releaseAmount, 44.54)
assert.equal(
  fulfillmentReadyPreview.journal.lines.find((line) => line.code === 'payment_exception_release')?.amount,
  44.54,
)
assert.equal(
  fulfillmentReadyPreview.journal.lines.find((line) => line.code === 'pos_clearing')?.amount,
  44.54,
)
assert.equal(fulfillmentReadyPreview.journal.balanced, true)
assert.equal(fulfillmentReadyPreview.readiness.readyForReview, true)
assert.equal(
  accounting.reconciliationStatusForDraft(
    { standard_orders_count: 0 },
    new Set(),
    fulfillmentReadyPreview,
  ),
  'orders_only',
  'persisted Standard rows must make a future fulfillment draft source-ready without a duplicate dated outbox job',
)

const incompleteFeeOrder = structuredClone(preorderOrder)
incompleteFeeOrder.details.checks[0].payments[0].processingFee = null
const feeBatchHoldPreview = accounting.buildPosAccountingPreview({
  businessDate: '2026-07-23',
  restaurantName: 'Suburbia Sandwich Co',
  locationTimezone: 'America/New_York',
  standardOnly: true,
  profile: { ...profile, batchHoldPolicy: 'hold_until_closed' },
  mappings: captureMappings,
  orders: [incompleteFeeOrder],
})
assert.ok(feeBatchHoldPreview.readiness.blockers.some((blocker) => blocker.code === 'batch_hold_fee_detail'))
assert.equal(feeBatchHoldPreview.readiness.readyForReview, false)

const mappingSqlCalls = []
const mappingAuditEvents = []
let mappingConnectionStatus = 'active'
let mappingMenuItemSources = []
let mappingQuickBooksItemIds = []
let mappingHistoryRowsBySource = null
let mappingHistoryRows = [{
  id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  target_type: 'account',
  mapping_revision: 1,
  effective_to: null,
}]
const accountingPersistence = loadTypeScriptModule('app_src/lib/persistence/posAccounting.ts', {
  '@/lib/auditWriter': { recordAuditEvent: async (event) => { mappingAuditEvents.push(event) } },
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
        if (source.includes('FROM toast_menu_catalog_items')) {
          return { rows: mappingMenuItemSources, rowCount: mappingMenuItemSources.length }
        }
        if (source.includes('SELECT quickbooks_item_id AS id FROM quickbooks_items')) {
          return { rows: mappingQuickBooksItemIds.map((id) => ({ id })), rowCount: mappingQuickBooksItemIds.length }
        }
        if (source.includes('FROM organization_quickbooks_connections')) {
          return {
            rows: [{ status: mappingConnectionStatus, last_catalog_synced_at: '2026-07-18T23:00:00.000Z' }],
            rowCount: 1,
          }
        }
        if (source.includes('FROM pos_accounting_catalog_mappings') && source.includes('FOR UPDATE')) {
          const rows = mappingHistoryRowsBySource?.get(String(params[3])) || mappingHistoryRows
          return { rows, rowCount: rows.length }
        }
        if (source.includes('INSERT INTO pos_accounting_catalog_mappings')) {
          return {
            rows: [{
              id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', restaurant_guid: params[1],
              source_kind: params[2], source_id: params[3], source_name: params[4],
              target_type: params[5], target_id: params[6], target_name: params[7],
              active: params[8], mapping_revision: params[9],
              effective_from: '2026-07-19T00:00:00.000Z', effective_to: null,
              validation_status: params[10], validation_reason: params[11],
              source_catalog_revision: params[12], target_catalog_revision: params[13],
              last_validated_at: params[14], created_by: params[15], created_at: '2026-07-19T00:00:00.000Z',
            }],
            rowCount: 1,
          }
        }
        return { rows: [], rowCount: 1 }
      },
    }),
  },
})
const clearedMappingResult = await accountingPersistence.savePosAccountingMappingsInPostgres({
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
assert.equal(clearedMappingResult.changedCount, 1)
assert.equal(clearedMappingResult.mappings[0].active, false)
assert.equal(clearedMappingResult.mappings[0].mappingRevision, 2)
const closePriorMapping = mappingSqlCalls.find((call) => call.source.includes('id = ANY($1::uuid[])'))
const insertClearedMapping = mappingSqlCalls.find((call) => call.source.includes('INSERT INTO pos_accounting_catalog_mappings'))
assert.deepEqual(Array.from(closePriorMapping.params[0]), ['cccccccc-cccc-4ccc-8ccc-cccccccccccc'])
assert.equal(insertClearedMapping.params[8], false)
assert.equal(insertClearedMapping.params[9], 2)

const saratogaSourceId = '14351ea1-ad68-4f2c-85e6-da00661bab4e'
const pistachioSourceId = '363eb9aa-f494-4823-a1c2-8046370fd610'
mappingMenuItemSources = [{
  provider_item_id: saratogaSourceId,
  name: 'Saratoga Springs - Sparkling Water',
  source_revision: '2026-07-20T12:00:00.000Z',
}, {
  provider_item_id: pistachioSourceId,
  name: 'HOT | Pistachio Latte',
  source_revision: '2026-07-20T11:00:00.000Z',
}]
mappingQuickBooksItemIds = ['35', '63']
mappingHistoryRows = []
const menuMappingCallStart = mappingSqlCalls.length
const menuOnlyMappingResult = await accountingPersistence.savePosAccountingMappingsInPostgres({
  organizationId: '11111111-1111-4111-8111-111111111111',
  restaurantGuid: null,
  scope: 'organization_default',
  actorEmail: 'manager@example.test',
  mappings: accountingPersistence.validatePosAccountingMappings([{
    sourceKind: 'sales_item', sourceId: saratogaSourceId, sourceName: 'Client-supplied alias',
    targetType: 'item', targetId: '35', targetName: 'Saratoga Sparkling 12 oz', active: true,
  }, {
    sourceKind: 'sales_item', sourceId: pistachioSourceId, sourceName: 'Another client-supplied alias',
    targetType: 'item', targetId: '63', targetName: 'Coffee:Hot:Pistachio Latte', active: true,
  }]),
})
const menuOnlyMappings = menuOnlyMappingResult.mappings
assert.equal(menuOnlyMappingResult.changedCount, 2)
assert.equal(menuOnlyMappings[0].sourceName, 'Saratoga Springs - Sparkling Water')
assert.equal(menuOnlyMappings[0].targetId, '35')
assert.equal(menuOnlyMappings[0].validationStatus, 'valid')
assert.equal(menuOnlyMappings[0].active, true)
assert.equal(menuOnlyMappings[1].sourceName, 'HOT | Pistachio Latte')
assert.equal(menuOnlyMappings[1].targetId, '63')
assert.equal(menuOnlyMappings[1].targetName, 'Coffee:Hot:Pistachio Latte')
assert.equal(menuOnlyMappings[1].validationStatus, 'valid')
assert.equal(menuOnlyMappings[1].active, true)
const menuMappingCalls = mappingSqlCalls.slice(menuMappingCallStart)
const menuSourceRead = menuMappingCalls.find((call) => call.source.includes('FROM toast_menu_catalog_items'))
assert.ok(menuSourceRead.source.includes('($2::uuid IS NULL OR restaurant_guid = $2::uuid)'))
assert.deepEqual(Array.from(menuSourceRead.params), ['11111111-1111-4111-8111-111111111111', null])
const insertMenuMappings = menuMappingCalls.filter((call) => call.source.includes('INSERT INTO pos_accounting_catalog_mappings'))
assert.equal(insertMenuMappings.length, 2)
assert.deepEqual(
  insertMenuMappings.map((call) => [call.params[4], call.params[6], call.params[7], call.params[10]]),
  [
    ['Saratoga Springs - Sparkling Water', '35', 'Saratoga Sparkling 12 oz', 'valid'],
    ['HOT | Pistachio Latte', '63', 'Coffee:Hot:Pistachio Latte', 'valid'],
  ],
)
for (const mapping of menuOnlyMappings) {
  assert.equal(
    mapping.active !== false && ['valid', 'unvalidated'].includes(mapping.validationStatus),
    true,
    'a menu-only mapping must remain usable when the UI reloads it',
  )
}

const currentSaratogaMapping = menuOnlyMappings[0]
mappingHistoryRows = [{
  id: currentSaratogaMapping.id,
  restaurant_guid: null,
  source_kind: currentSaratogaMapping.sourceKind,
  source_id: currentSaratogaMapping.sourceId,
  source_name: currentSaratogaMapping.sourceName,
  target_type: currentSaratogaMapping.targetType,
  target_id: currentSaratogaMapping.targetId,
  target_name: currentSaratogaMapping.targetName,
  active: currentSaratogaMapping.active,
  mapping_revision: currentSaratogaMapping.mappingRevision,
  effective_from: currentSaratogaMapping.effectiveFrom,
  effective_to: null,
  validation_status: currentSaratogaMapping.validationStatus,
  validation_reason: currentSaratogaMapping.validationReason,
  source_catalog_revision: currentSaratogaMapping.sourceCatalogRevision,
  target_catalog_revision: currentSaratogaMapping.targetCatalogRevision,
  last_validated_at: currentSaratogaMapping.lastValidatedAt,
  created_by: currentSaratogaMapping.createdBy,
  created_at: currentSaratogaMapping.createdAt,
}]
const retryCallStart = mappingSqlCalls.length
const retryAuditStart = mappingAuditEvents.length
const retriedMappingResult = await accountingPersistence.savePosAccountingMappingsInPostgres({
  organizationId: '11111111-1111-4111-8111-111111111111',
  restaurantGuid: null,
  scope: 'organization_default',
  actorEmail: 'manager@example.test',
  mappings: accountingPersistence.validatePosAccountingMappings([{
    sourceKind: 'sales_item', sourceId: saratogaSourceId, sourceName: 'Saratoga Springs - Sparkling Water',
    targetType: 'item', targetId: '35', targetName: 'Saratoga Sparkling 12 oz', active: true,
  }]),
})
assert.equal(retriedMappingResult.changedCount, 0)
assert.equal(retriedMappingResult.mappings[0].id, currentSaratogaMapping.id)
assert.equal(retriedMappingResult.mappings[0].mappingRevision, currentSaratogaMapping.mappingRevision)
const retryCalls = mappingSqlCalls.slice(retryCallStart)
assert.equal(retryCalls.some((call) => call.source.includes('UPDATE pos_accounting_catalog_mappings SET effective_to')), false)
assert.equal(retryCalls.some((call) => call.source.includes('INSERT INTO pos_accounting_catalog_mappings')), false)
assert.equal(mappingAuditEvents.length, retryAuditStart)

const currentPistachioMapping = menuOnlyMappings[1]
mappingHistoryRowsBySource = new Map([
  [saratogaSourceId, mappingHistoryRows],
  [pistachioSourceId, [{
    id: currentPistachioMapping.id,
    restaurant_guid: null,
    source_kind: currentPistachioMapping.sourceKind,
    source_id: currentPistachioMapping.sourceId,
    source_name: currentPistachioMapping.sourceName,
    target_type: currentPistachioMapping.targetType,
    target_id: '60',
    target_name: 'Coffee:Cold:Cold Latte Pistachio Latte',
    active: true,
    mapping_revision: currentPistachioMapping.mappingRevision,
    effective_from: currentPistachioMapping.effectiveFrom,
    effective_to: null,
    validation_status: 'valid',
    validation_reason: null,
    source_catalog_revision: currentPistachioMapping.sourceCatalogRevision,
    target_catalog_revision: currentPistachioMapping.targetCatalogRevision,
    last_validated_at: currentPistachioMapping.lastValidatedAt,
    created_by: currentPistachioMapping.createdBy,
    created_at: currentPistachioMapping.createdAt,
  }]],
])
const mixedAuditStart = mappingAuditEvents.length
const mixedMappingResult = await accountingPersistence.savePosAccountingMappingsInPostgres({
  organizationId: '11111111-1111-4111-8111-111111111111',
  restaurantGuid: null,
  scope: 'organization_default',
  actorEmail: 'manager@example.test',
  mappings: accountingPersistence.validatePosAccountingMappings([{
    sourceKind: 'sales_item', sourceId: saratogaSourceId, sourceName: 'Saratoga Springs - Sparkling Water',
    targetType: 'item', targetId: '35', targetName: 'Saratoga Sparkling 12 oz', active: true,
  }, {
    sourceKind: 'sales_item', sourceId: pistachioSourceId, sourceName: 'HOT | Pistachio Latte',
    targetType: 'item', targetId: '63', targetName: 'Coffee:Hot:Pistachio Latte', active: true,
  }]),
})
assert.equal(mixedMappingResult.changedCount, 1)
assert.equal(mappingAuditEvents.length, mixedAuditStart + 1)
assert.deepEqual(
  JSON.parse(JSON.stringify(mappingAuditEvents.at(-1).payload)),
  {
    scope: 'organization_default',
    restaurantGuid: null,
    mappingCount: 1,
    activeCount: 1,
    sourceKinds: ['sales_item'],
    sourceCatalogRevision: new Date('2026-07-20T12:00:00.000Z').getTime(),
    targetCatalogRevision: new Date('2026-07-18T23:00:00.000Z').getTime(),
    validationStatuses: { valid: 1 },
  },
)
mappingHistoryRowsBySource = null

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
assert.equal(
  accountingDraftNavigation.accountingSectionFromNavigationUrl(
    `https://aiapp.eigenracing.com/?accountingView=actions&accountingRequest=${draftRequestId}`,
  ),
  'accounting',
)
assert.equal(
  accountingDraftNavigation.accountingSectionFromNavigationUrl(
    'https://aiapp.eigenracing.com/?accountingView=actions&accountingRequest=invalid',
  ),
  'accounting',
)
assert.equal(
  accountingDraftNavigation.accountingSectionFromNavigationUrl(
    'https://aiapp.eigenracing.com/?accountingRequest=invalid',
  ),
  null,
)
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
const consumedQueryOnlyTarget = accountingDraftNavigation.consumeAccountingDraftTarget(
  `https://aiapp.eigenracing.com/?accountingView=actions&accountingRequest=${draftRequestId}`,
)
assert.equal(consumedQueryOnlyTarget.cleanUrl, '/#accounting')
const posPostingReviewUrl = accountingDraftNavigation.buildPosPostingReviewUrl(
  'https://clawpilot.example/?posView=accounting&location=truck&date=2026-07-23#pos',
  { draftId: draftRequestId, businessDate: '2026-07-23' },
)
assert.equal(posPostingReviewUrl.hash, '#accounting')
assert.equal(posPostingReviewUrl.searchParams.get('accountingView'), 'pos-parity')
assert.equal(posPostingReviewUrl.searchParams.get('posPostingDraft'), draftRequestId.toLowerCase())
assert.equal(posPostingReviewUrl.searchParams.get('posPostingDate'), '2026-07-23')
assert.equal(posPostingReviewUrl.searchParams.has('posView'), false)
const consumedPosPostingTarget = accountingDraftNavigation.consumePosPostingReviewTarget(
  posPostingReviewUrl.toString(),
)
assert.equal(consumedPosPostingTarget.draftId, draftRequestId.toLowerCase())
assert.equal(consumedPosPostingTarget.businessDate, '2026-07-23')
assert.equal(consumedPosPostingTarget.hasTarget, true)
assert.equal(consumedPosPostingTarget.cleanUrl, '/?accountingView=pos-parity#accounting')
assert.throws(
  () => accountingDraftNavigation.buildPosPostingReviewUrl(
    'https://clawpilot.example/#pos',
    { draftId: 'invalid', businessDate: '2026-07-23' },
  ),
  /draft id is invalid/,
)

const homeClient = read('app_src/app/HomeClient.tsx')
assert.ok(homeClient.includes('accountingSectionFromNavigationUrl(window.location.href)'))

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
