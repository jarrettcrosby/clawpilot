#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import vm from 'node:vm'

const root = process.cwd()
const nodeRequire = createRequire(import.meta.url)
const requireFromApp = createRequire(
  new URL('../app_src/package.json', import.meta.url),
)
const ts = requireFromApp('typescript')

function read(path) {
  return readFileSync(resolve(root, path), 'utf8')
}

function loadPersistenceModule() {
  const path = 'app_src/lib/persistence/commerceProviderWrites.ts'
  const output = ts.transpileModule(read(path), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: path,
  }).outputText
  const module = { exports: {} }
  vm.runInNewContext(output, {
    Buffer,
    Date,
    Error,
    JSON,
    Map,
    Math,
    Number,
    Object,
    Promise,
    RegExp,
    Set,
    String,
    console,
    exports: module.exports,
    module,
    process,
    require(specifier) {
      if (specifier === '@/lib/auditWriter') {
        return { recordAuditEvent: async () => undefined }
      }
      if (specifier === '@/lib/integrations/commerceCapabilities') {
        const scopes = [
          'read_orders',
          'write_orders',
          'write_merchant_managed_fulfillment_orders',
        ]
        return {
          SHOPIFY_ACCESS_SCOPES: scopes,
          hasEffectiveShopifyScope(grantedScopes, requiredScope) {
            return grantedScopes.includes(requiredScope)
              || (
                requiredScope.startsWith('read_')
                && grantedScopes.includes(
                  `write_${requiredScope.slice('read_'.length)}`,
                )
              )
          },
        }
      }
      if (specifier === '@/lib/persistence/postgres') {
        return {
          acquireTransactionAdvisoryLock: async () => undefined,
          query: async () => ({ rows: [] }),
          withTransaction: async (work) => work({ query: async () => ({ rows: [] }) }),
        }
      }
      return nodeRequire(specifier)
    },
  }, { filename: path })
  return module.exports
}

const migration = read(
  'db/migrations/0308_operations_commerce_provider_write_controls.sql',
)
const fulfillmentLeaseMigration = read(
  'db/migrations/0316_operations_commerce_fulfillment_authority_leases.sql',
)
const persistence = read(
  'app_src/lib/persistence/commerceProviderWrites.ts',
)
const route = read(
  'app_src/app/api/integrations/commerce/provider-writes/route.ts',
)
const panel = read(
  'app_src/components/settings/CommerceIntegrationPanel.tsx',
)
const orderCommands = read(
  'app_src/lib/operations/shopifyOrderManagementCommands.ts',
)
const orderPersistence = read(
  'app_src/lib/persistence/shopifyOrderManagement.ts',
)
const orderRoute = read(
  'app_src/app/api/operations/shopify-order-management/route.ts',
)
const orderPanel = read(
  'app_src/components/operations/ShopifyOrderManagementPanel.tsx',
)
const shopifyFulfillment = read(
  'app_src/lib/integrations/shopifyFulfillmentWriteback.ts',
)
const faireFulfillment = read(
  'app_src/lib/integrations/faireFulfillmentRuntime.ts',
)
const operationsPersistence = read(
  'app_src/lib/persistence/operations.ts',
)
const commerceIntegrations = read(
  'app_src/lib/integrations/commerceIntegrations.ts',
)

assert.match(migration, /COALESCE\(control\.requested_mode, 'off'::text\)/u)
assert.match(migration, /requested_mode = 'off'[\s\S]*bound_credential_generation IS NULL/u)
assert.match(migration, /NEW\.requested_mode = 'off'[\s\S]*membership\.role IN \('owner', 'admin'\)/u)
assert.match(migration, /operations_commerce_granted_scope_digest/u)
assert.match(migration, /bound_granted_scope_digest/u)
assert.match(migration, /operations_faire_provider_write_scope_evidence_is_current/u)
assert.match(migration, /row_version = expected_row_version \+ 1/u)
assert.match(migration, /revisions are immutable/u)
assert.match(
  migration,
  /exact pre-0308 writer shape[\s\S]*later contraction/u,
)
assert.match(
  migration,
  /NEW\.authorized_role IN \('owner', 'admin'\)[\s\S]*activation\.state = NEW\.activation_state/u,
)
assert.match(migration, /'write_orders' = ANY\(control\.bound_granted_scopes\)/u)
assert.equal(
  (migration.match(/'write_orders' = ANY\(control\.bound_granted_scopes\)/gu) || []).length,
  3,
  'Authorization, current, and attempt DB gates must each require write_orders',
)
assert.doesNotMatch(migration, /operations_commerce_active_transition/u)
assert.match(
  fulfillmentLeaseMigration,
  /LOCK TABLE public\.operations_commerce_provider_attempts,[\s\S]*public\.operations_integration_accounts,[\s\S]*public\.operations_commerce_credentials[\s\S]*IN ACCESS EXCLUSIVE MODE/u,
)
assert.match(
  fulfillmentLeaseMigration,
  /source_order\.integration_account_id = account\.id[\s\S]*source_order\.external_order_id =[\s\S]*fulfillment_export\.external_order_id/u,
)
assert.match(
  fulfillmentLeaseMigration,
  /lease_expires_at >[\s\S]*requested_at \+ interval '5 minutes'/u,
)
assert.match(
  fulfillmentLeaseMigration,
  /commerce_fulfillment_lease_count/u,
)
assert.match(
  fulfillmentLeaseMigration,
  /fence_operations_commerce_fulfillment_expired_leases/u,
)

assert.match(
  persistence,
  /\| 'shopify_order_management'[\s\S]*\| 'shopify_fulfillment'[\s\S]*\| 'shopify_order_management_and_fulfillment'[\s\S]*\| 'faire_fulfillment'[\s\S]*\| 'not_connected'/u,
)
assert.match(
  persistence,
  /providerWritesEffective: commandConnected && bindingCurrent/u,
)
assert.match(
  persistence,
  /operations_commerce_granted_scope_snapshot\([\s\S]*AS current_granted_scopes/u,
)
assert.match(
  persistence,
  /operations_commerce_granted_scope_digest\([\s\S]*AS current_granted_scope_digest/u,
)
assert.match(
  persistence,
  /const fulfillmentWritesEffective = fulfillmentConnected && bindingCurrent/u,
)
assert.match(persistence, /fulfillmentWritesBlockedReason/u)
assert.match(
  persistence,
  /Reconnect Shopify and approve write_merchant_managed_fulfillment_orders plus read_orders \(or write_orders\)/u,
)
assert.match(
  persistence,
  /row\.environment === 'sandbox'[\s\S]*scopes\.includes\('write_orders'\)/u,
)
assert.match(
  persistence,
  /SHOPIFY_FULFILLMENT_SCOPE[\s\S]*write_merchant_managed_fulfillment_orders/u,
)
assert.match(
  persistence,
  /FAIRE_FULFILLMENT_SCOPES[\s\S]*'READ_BRAND'[\s\S]*'READ_ORDERS'[\s\S]*'READ_SHIPMENTS'[\s\S]*'WRITE_ORDERS'/u,
)
assert.match(
  persistence,
  /export async function requireCurrentCommerceProviderWritesInPostgres/u,
)
assert.match(
  persistence,
  /export async function requireSealedCommerceProviderWritesInPostgres/u,
)
assert.match(
  persistence,
  /FROM public\.operations_commerce_provider_attempts provider_attempt[\s\S]*JOIN public\.operations_integration_accounts account[\s\S]*JOIN public\.operations_commerce_fulfillment_exports fulfillment_export/u,
)
assert.match(persistence, /provider_attempt\.state = 'prepared'/u)
assert.match(persistence, /provider_attempt\.request_hash = \$9/u)
assert.match(persistence, /provider_attempt\.lease_token = \$11::uuid/u)
assert.match(
  persistence,
  /minimumLeaseRemainingSeconds =[\s\S]*'provider_mutation' \? 60 : 240/u,
)
assert.match(
  persistence,
  /source_order\.integration_account_id = account\.id/u,
)
assert.match(
  persistence,
  /provider_attempt\.redacted_request->'providerWriteAuthority'[\s\S]*= \$10::jsonb/u,
)
assert.match(
  persistence,
  /shopify: \{[\s\S]*action: 'shopify\.fulfillment\.create'[\s\S]*adapterVersion: 'shopify-fulfillment-writeback-v2'/u,
)
assert.match(
  persistence,
  /faire: \{[\s\S]*action: 'faire\.fulfillment\.shipments\.create'[\s\S]*adapterVersion: 'faire-fulfillment-writeback-v2'/u,
)
assert.match(persistence, /COMMERCE_PROVIDER_WRITES_OFF/u)
assert.match(persistence, /COMMERCE_PROVIDER_WRITES_AUTHORITY_CHANGED/u)
assert.match(persistence, /COMMERCE_PROVIDER_WRITES_BINDING_STALE/u)
assert.match(persistence, /commerce\.provider_writes\.turned_on/u)
assert.match(persistence, /commerce\.provider_writes\.turned_off/u)
assert.match(route, /body\.mode === 'on' && !capabilities\.canActivate/u)
assert.match(route, /if \(!capabilities\.canManage\) return managerRequired\(\)/u)
assert.match(route, /assertExactFields\(body\)/u)
assert.match(route, /idempotencyKey\(req\)/u)
assert.match(panel, /Provider writes/u)
assert.match(panel, /\/api\/integrations\/commerce\/provider-writes/u)
assert.match(panel, /Controls Shopify order changes for this connection/u)
assert.match(panel, /Controls Shopify fulfillment and tracking updates/u)
assert.match(panel, /Controls Faire fulfillment and tracking updates/u)
assert.match(panel, /On · Order editing only/u)
assert.match(panel, /fulfillmentWritesBlockedReason/u)
assert.match(panel, /Imports and refresh remain available while Off/u)
assert.match(
  panel,
  /providerWriteControl\.requestedMode === 'on'[\s\S]*\|\| providerWriteControl\.commandEnforcement[\s\S]*!== 'not_connected'[\s\S]*\? \([\s\S]*<Switch[\s\S]*checked=/u,
)
assert.match(
  panel,
  /Turning Off blocks new attempts; an already authorized in-flight attempt may finish/u,
)
assert.match(
  panel,
  /providerWritesEffective[\s\S]*requestedMode === 'on'[\s\S]*\? 'Revalidation required'[\s\S]*commandEnforcement[\s\S]*=== 'not_connected'[\s\S]*\? 'Not connected'/u,
)
assert.match(orderCommands, /assertProviderWritesEnabled\(target\)/u)
assert.match(orderCommands, /saveShopifyOrderManagementCommand/u)
assert.doesNotMatch(
  orderPersistence,
  /JOIN operations_activation_scopes activation/u,
  'New TypeScript command persistence must not depend on global activation',
)
assert.match(orderPersistence, /provider_write_control_row_version/u)
assert.match(orderPersistence, /commerce-provider-writes:/u)
assert.match(orderRoute, /if \(action === 'save'\)/u)
assert.match(orderRoute, /if \(!capabilities\.canManage\)/u)
assert.match(orderPanel, /action: 'save' as const/u)
assert.match(orderPanel, />\s*Save order\s*</u)
assert.doesNotMatch(orderPanel, />\s*Save tag\s*</u)
assert.doesNotMatch(orderPanel, />\s*Save quantity\s*</u)
assert.doesNotMatch(orderPanel, /Type the exact confirmation statement/u)
assert.doesNotMatch(orderPanel, /Reason for this exact Shopify change/u)
assert.match(
  shopifyFulfillment,
  /requireCurrentCommerceProviderWritesInPostgres/u,
)
assert.doesNotMatch(
  shopifyFulfillment,
  /requireCommerceActiveCapabilityClaimInPostgres/u,
)
assert.doesNotMatch(shopifyFulfillment, /providerAttemptRegistered/u)
assert.match(shopifyFulfillment, /providerAttemptGlobalId/u)
assert.match(shopifyFulfillment, /providerAttemptRequestHash/u)
assert.match(shopifyFulfillment, /commerceExportGlobalId/u)
assert.match(shopifyFulfillment, /leaseCheckPhase: 'provider_mutation'/u)
assert.match(shopifyFulfillment, /await beforeProviderMutation\?\.\(\)/u)
assert.match(
  faireFulfillment,
  /requireCurrentCommerceProviderWritesInPostgres/u,
)
assert.doesNotMatch(
  faireFulfillment,
  /requireCommerceActiveCapabilityClaimInPostgres/u,
)
assert.doesNotMatch(faireFulfillment, /providerAttemptRegistered/u)
assert.match(faireFulfillment, /providerAttemptGlobalId/u)
assert.match(faireFulfillment, /providerAttemptRequestHash/u)
assert.match(faireFulfillment, /commerceExportGlobalId/u)
assert.match(faireFulfillment, /leaseCheckPhase: 'provider_mutation'/u)
assert.match(
  read('app_src/lib/integrations/faireFulfillmentWriteback.ts'),
  /await beforeProviderMutation\?\.\(\)[\s\S]*moveOrderToProcessing[\s\S]*await beforeProviderMutation\?\.\(\)[\s\S]*addOrderShipments/u,
)
assert.match(
  commerceIntegrations,
  /COMMERCE_FULFILLMENT_LEASE_BUSY/u,
)
assert.match(
  commerceIntegrations,
  /409,[\s\S]*'COMMERCE_FULFILLMENT_LEASE_BUSY'/u,
)
assert.match(
  operationsPersistence,
  /requireShipmentProviderWriteAuthority[\s\S]*providerWriteAuthority/u,
)
assert.match(
  operationsPersistence,
  /executeShopifyFulfillmentWriteback\(\{[\s\S]*providerAttemptGlobalId: registeredAttempt\.globalId,[\s\S]*providerAttemptRequestHash: registeredAttempt\.requestHash,[\s\S]*commerceExportGlobalId: input\.commerceExportGlobalId/u,
)
assert.match(
  operationsPersistence,
  /executeCurrentFaireFulfillmentWriteback\(\{[\s\S]*providerAttemptGlobalId: registeredProviderAttempt\.globalId,[\s\S]*providerAttemptRequestHash: registeredProviderAttempt\.requestHash,[\s\S]*commerceExportGlobalId: input\.commerceExportGlobalId/u,
)

const loaded = loadPersistenceModule()
const canonical = loaded.canonicalCommerceGrantedScopes([
  'write_orders',
  'read_orders',
])
assert.deepEqual(Array.from(canonical), ['read_orders', 'write_orders'])
assert.equal(
  loaded.canonicalCommerceGrantedScopes(['write_orders', 'write_orders']),
  null,
)
assert.equal(
  loaded.canonicalCommerceGrantedScopes([' write_orders']),
  null,
)
assert.equal(loaded.canonicalCommerceGrantedScopes(null), null)
assert.equal(
  loaded.commerceGrantedScopeDigest(canonical),
  createHash('sha256').update('read_orders\nwrite_orders').digest('hex'),
)
const databaseOrdered = loaded.validatedCommerceGrantedScopeSnapshot([
  'read_customers',
  'read_custom_fulfillment_services',
])
assert.deepEqual(
  Array.from(databaseOrdered),
  ['read_customers', 'read_custom_fulfillment_services'],
  'Database-canonical scope order must be retained for the persisted digest',
)
assert.equal(
  loaded.validatedCommerceGrantedScopeSnapshot([
    'read_customers',
    'read_customers',
  ]),
  null,
)
assert.equal(
  loaded.commerceGrantedScopeDigest(databaseOrdered),
  createHash('sha256')
    .update('read_customers\nread_custom_fulfillment_services')
    .digest('hex'),
)
assert.equal(
  loaded.commerceProviderHasWriteScope('shopify', canonical),
  true,
)
assert.equal(
  loaded.commerceProviderHasWriteScope('faire', ['READ_ORDERS']),
  false,
)
assert.equal(
  loaded.commerceProviderHasWriteScope('faire', ['WRITE_ORDERS']),
  true,
)

console.log('Commerce Provider writes source and unit acceptance passed')
