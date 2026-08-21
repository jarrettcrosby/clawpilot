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
  persistence,
  /commandEnforcement: 'shopify_order_management' \| 'not_connected'/u,
)
assert.match(
  persistence,
  /providerWritesEffective: commandConnected && bindingCurrent/u,
)
assert.match(
  persistence,
  /row\.environment === 'sandbox'[\s\S]*scopes\?\.includes\('write_orders'\)/u,
)
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
assert.match(panel, /Imports and refresh remain available while Off/u)
assert.match(
  panel,
  /providerWriteControl\?\.commandEnforcement[\s\S]*=== 'shopify_order_management' \? \([\s\S]*<Switch[\s\S]*checked=/u,
)
assert.match(panel, /\? 'Not connected'[\s\S]*providerWritesEffective/u)
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
