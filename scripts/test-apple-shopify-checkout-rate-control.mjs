#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import vm from 'node:vm'

const root = process.cwd()
const read = (path) => readFileSync(resolve(root, path), 'utf8')
const nodeRequire = createRequire(import.meta.url)
const requireFromApp = createRequire(
  new URL('../app_src/package.json', import.meta.url),
)
const ts = requireFromApp('typescript')

function loadTypeScriptModule(path, mocks = {}) {
  const source = read(path)
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: path,
    reportDiagnostics: true,
  })
  const errors = (output.diagnostics || []).filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  )
  assert.deepEqual(errors, [], `${path} must transpile`)
  const module = { exports: {} }
  vm.runInNewContext(output.outputText, {
    Buffer,
    Date,
    Error,
    Headers,
    JSON,
    Map,
    Number,
    Object,
    Promise,
    RegExp,
    Request,
    Response,
    Set,
    String,
    URL,
    URLSearchParams,
    console,
    exports: module.exports,
    module,
    process,
    require(specifier) {
      if (Object.prototype.hasOwnProperty.call(mocks, specifier)) {
        return mocks[specifier]
      }
      return nodeRequire(specifier)
    },
  }, { filename: path })
  return module.exports
}

const route = read(
  'app_src/app/api/integrations/commerce/shopify/carrier-service/route.ts',
)
for (const fragment of [
  'readShopifyCarrierServiceRateControlLastChangeFromPostgres',
  'checkoutRateLastChange,',
  "} else if (action === 'save-checkout-rate-control')",
  'if (!capabilities.canManage)',
  'requireActivator(context.capabilities.canActivate)',
  'updateShopifyCarrierServiceRateControlInPostgres({',
  'expectedConfigGlobalId: configGlobalId(',
  'expectedPolicyRevision: integer(',
  'idempotencyKey: rateControlIdempotencyKey(req)',
  'return json({ ok: true, result })',
]) {
  assert.ok(route.includes(fragment), `0299 API seam is missing ${fragment}`)
}
const saveStart = route.indexOf(
  "} else if (action === 'save-checkout-rate-control')",
)
const saveEnd = route.indexOf(
  "} else if (action === 'save-plan-rate-policy')",
  saveStart,
)
assert.ok(saveStart >= 0 && saveEnd > saveStart)
const saveBranch = route.slice(saveStart, saveEnd)
for (const providerWrite of [
  'executeAuthorizedShopifyCarrierServiceMutation',
  'executeShopifyCarrierServiceRegistration',
  'testCommerceConnection',
]) {
  assert.ok(
    !saveBranch.includes(providerWrite),
    `control save must not invoke ${providerWrite}`,
  )
}

const accountDiscoveryRoutePath =
  'app_src/app/api/integrations/commerce/accounts/route.ts'
const accountDiscoveryRoute = read(accountDiscoveryRoutePath)
for (const fragment of [
  'requireRequestUser(req)',
  'operationsCapabilities(actor).canManage',
  'activeOperationsOrganizationId(actor)',
  'readCommerceAccountDiscoveryFromPostgres(',
  'organizationId,',
  'accounts:',
  "'Cache-Control': 'no-store, max-age=0'",
]) {
  assert.ok(
    accountDiscoveryRoute.includes(fragment),
    `commerce-account discovery route is missing ${fragment}`,
  )
}
for (const forbidden of [
  '/api/operations',
  "@/lib/integrations/commerceIntegrations",
  'shopifyCarrierServiceProvider',
  'executeAuthorizedShopifyCarrierServiceMutation',
  'readCommerceStoreSyncControlsFromPostgres',
]) {
  assert.ok(
    !accountDiscoveryRoute.includes(forbidden),
    `commerce-account discovery must not depend on ${forbidden}`,
  )
}

const accountDiscoveryPersistencePath =
  'app_src/lib/persistence/commerceAccountDiscovery.ts'
const accountDiscoveryPersistence = read(accountDiscoveryPersistencePath)
for (const fragment of [
  'account.organization_id = $1::uuid',
  "account.integration_type = 'commerce'",
  "account.provider IN ('shopify', 'faire')",
  'account.global_id AS account_global_id',
  'ORDER BY lower(account.display_name), account.global_id',
]) {
  assert.ok(
    accountDiscoveryPersistence.includes(fragment),
    `commerce-account discovery projection is missing ${fragment}`,
  )
}
assert.doesNotMatch(
  accountDiscoveryPersistence,
  /operations_commerce_store_sync_controls|credential_ciphertext|credential_reference/u,
  'account discovery must neither omit accounts without Store Sync rows nor read credentials',
)

const persistence = read(
  'app_src/lib/persistence/shopifyCheckoutRating.ts',
)
for (const fragment of [
  'export async function readShopifyCarrierServiceRateControlLastChangeFromPostgres',
  'operations_shopify_checkout_rate_control_receipts receipt',
  'receipt.resulting_policy_revision DESC',
  'receipt.idempotency_key',
  'receipt.request_hash',
  'receipt.actor_email',
  'receipt.requested_control',
  'receipt.reason',
  'providerWrites: 0',
]) {
  assert.ok(
    persistence.includes(fragment),
    `0299 persistence projection is missing ${fragment}`,
  )
}

const adapters = read(
  'clients/apple/Sources/ClawPilotPickingApple/AppleAdapters.swift',
)
for (const fragment of [
  'public struct ManagerCommerceAccountSummary',
  'private struct ManagerCommerceAccountsEnvelope',
  'public func fetchManagerCommerceAccounts(',
  '"/api/integrations/commerce/accounts"',
  'envelope.organizationId?.lowercased() == expectedOrganizationId',
  'accounts.allSatisfy(\\.isContractValid)',
  'Set(accounts.map(\\.accountGlobalId)).count == accounts.count',
  'public struct ManagerShopifyCheckoutRateControl',
  'public struct ManagerShopifyCheckoutRateCommand',
  'public struct ManagerShopifyCheckoutRateSubmissionFence',
  'public struct ManagerShopifyCheckoutRatePendingModel',
  'authenticationGeneration: UInt64',
  'expectedRowVersion: Int',
  'expectedPolicyRevision: Int',
  'public let actorEmail: String',
  'public let requestedControl: RequestedControl',
  'private var effectiveProjectionMatches0299: Bool',
  'control.canEdit',
  'control.lastChange?.idempotencyKey == idempotencyKey',
  'currentActorEmail: String?',
  'public func isConfirmedApplied(',
  'public func permitsStateMutation(',
  'public func fetchManagerShopifyCheckoutRateControl(',
  'public func updateManagerShopifyCheckoutRateControl(',
  '"/api/integrations/commerce/shopify/carrier-service"',
  'let action = "save-checkout-rate-control"',
  'let expectedConfigGlobalId: String',
  'request.setValue(',
  'command.idempotencyKey,',
  'providerWrites == 0',
  'http.statusCode != 408',
  'http.statusCode != 425',
]) {
  assert.ok(adapters.includes(fragment), `native adapter is missing ${fragment}`)
}

const model = read(
  'clients/apple/Apps/iPhone/ClawPilotPickingPhoneApp.swift',
)
for (const fragment of [
  '@Published var managerShopifyCheckoutRateControls',
  '@Published private(set) var isManagerSettingsControlsBusy',
  'func loadManagerSettingsControls() async',
  'let accounts = try await api.fetchManagerCommerceAccounts(',
  'for account in accounts where account.provider == "shopify"',
  'await loadManagerSettingsControls()',
  '@Published private(set) var hasPendingManagerShopifyCheckoutRateChange',
  'pendingManagerShopifyCheckoutRateCommand',
  'activeManagerShopifyCheckoutRateSubmissionFence',
  'func updateManagerShopifyCheckoutRateControl(',
  'managerShopifyCheckoutRateReviewIsCurrent(control)',
  'func retryPendingManagerShopifyCheckoutRateChange()',
  'reconcileAmbiguousManagerShopifyCheckoutRateCommand(',
  'command.isConfirmedApplied(by: control)',
  'quarantineManagerShopifyCheckoutRateCommand()',
  'managerShopifyCheckoutRateOperationIsCurrent(',
  'supersedeAuthenticationAfterUnauthorizedCheckoutRateCommand(',
  'invalidateManagerShopifyCheckoutRateControl(',
  'await waitForManagerShopifyCheckoutRateSubmissionToFinish()',
  'ownsCompletion(',
  'checkoutRateWaiters.forEach { $0.resume() }',
  'byte-identical retry',
]) {
  assert.ok(model.includes(fragment), `native manager model is missing ${fragment}`)
}
const operationsLoadStart = model.indexOf('func loadManagerOperations() async')
const settingsLoadStart = model.indexOf('func loadManagerSettingsControls() async')
assert.ok(operationsLoadStart >= 0 && settingsLoadStart > operationsLoadStart)
const operationsLoad = model.slice(operationsLoadStart, settingsLoadStart)
const operationsFailureStart = operationsLoad.indexOf(
  'failures.append("orders and Store sync:',
)
assert.ok(operationsFailureStart >= 0)
assert.ok(
  operationsLoad.indexOf(
    'await loadManagerSettingsControls()',
    operationsFailureStart,
  ) > operationsFailureStart,
  'checkout Settings must load after an Operations overview failure',
)
assert.doesNotMatch(
  operationsLoad.slice(operationsFailureStart),
  /managerShopifyCheckoutRateControls = \[\]/u,
  'Operations overview failure must not clear checkout controls',
)
const settingsLoadEnd = model.indexOf(
  'func updateManagerStoreSync(',
  settingsLoadStart,
)
const settingsLoad = model.slice(settingsLoadStart, settingsLoadEnd)
assert.ok(settingsLoadEnd > settingsLoadStart)
assert.ok(
  (settingsLoad.match(/managerStoreSyncOperationIsCurrent\(/gu) || []).length >= 5,
  'checkout Settings reads must remain fenced after every authenticated await',
)
assert.ok(
  settingsLoad.indexOf('var controls: [ManagerShopifyCheckoutRateControl] = []')
    < settingsLoad.indexOf('managerShopifyCheckoutRateControls = controls.sorted'),
  'checkout controls must publish atomically after account reads',
)
assert.ok(
  model.indexOf('managerShopifyCheckoutRateReviewIsCurrent(control)')
    < model.indexOf('pendingManagerShopifyCheckoutRateCommand = command'),
  'current editable review must be proven before a pending command is created',
)
const unauthorizedStart = model.indexOf(
  'private func supersedeAuthenticationAfterUnauthorizedCheckoutRateCommand(',
)
const unauthorizedEnd = model.indexOf(
  'private func clearManagerStoreSyncState()',
  unauthorizedStart,
)
const unauthorizedHandler = model.slice(unauthorizedStart, unauthorizedEnd)
assert.ok(unauthorizedStart >= 0 && unauthorizedEnd > unauthorizedStart)
assert.doesNotMatch(
  unauthorizedHandler,
  /await logout\(\)|waitForManagerShopifyCheckoutRateSubmissionToFinish/u,
  '401 supersession must not wait on or log out through its own submission',
)
const finishStart = model.indexOf(
  'private func finishManagerShopifyCheckoutRateSubmission(',
)
const finishEnd = model.indexOf(
  'private func waitForWorkspaceSwitchToFinish()',
  finishStart,
)
assert.ok(finishStart >= 0 && finishEnd > finishStart)
const finishSubmission = model.slice(finishStart, finishEnd)
assert.ok(
  finishSubmission.indexOf('ownsCompletion(')
    < finishSubmission.indexOf('isManagerShopifyCheckoutRateBusy = false'),
  'a stale defer must not clear the replacement submission busy token',
)

const shell = read(
  'clients/apple/Apps/iPhone/ClawPilotAppShellView.swift',
)
for (const fragment of [
  'ManagerModule(id: "settings", title: "Settings"',
  'ManagerShopifyCheckoutRateSettingsView(model: model)',
  'ManagerShopifyCheckoutRateControlsView(model: model)',
  'Text("Shopify checkout rates")',
  'Text(control.accountGlobalId)',
  'label: "Desired audience"',
  'label: "Saved source"',
  'label: "Effective availability"',
  'Last reason (control policy v',
  'ForEach(ManagerShopifyCheckoutAudience.allCases',
  'ForEach(ManagerShopifyCheckoutRateSource.allCases',
  'production store may save TEST',
  'Restricted may save LIVE',
  'zero Shopify or carrier provider writes',
  'View only. An organization owner or authorized administrator',
  'Retry exact pending checkout change',
  'managerShopifyCheckoutRateReviewGeneration',
  'model.isManagerSettingsControlsBusy',
  '!model.managerShopifyCheckoutRateReviewIsCurrent(',
  'Relaunching refreshes authoritative state without retaining the command',
]) {
  assert.ok(shell.includes(fragment), `native checkout-rate UI is missing ${fragment}`)
}
const settingsViewStart = shell.indexOf(
  'private struct ManagerShopifyCheckoutRateSettingsView',
)
const settingsViewEnd = shell.indexOf(
  'private struct ManagerPickingOperationsView',
  settingsViewStart,
)
const settingsView = shell.slice(settingsViewStart, settingsViewEnd)
assert.equal(
  settingsView.match(/loadManagerSettingsControls\(\)/gu)?.length,
  2,
  'Settings refresh and initial task must use the focused controls loader',
)
assert.doesNotMatch(
  settingsView,
  /loadManagerOperations\(\)/u,
  'Settings must not depend on the Operations overview loader',
)
for (const field of ['Account ID', 'Provider', 'Environment']) {
  assert.match(
    shell,
    new RegExp(`LabeledContent\\(\\s*"${field}"`, 'u'),
    `native checkout-rate review is missing ${field}`,
  )
}
assert.equal(
  shell.match(/ManagerShopifyCheckoutRateControlsView\(model: model\)/gu)?.length,
  2,
  'Shopify checkout-rate controls must render in Manager Operations and Settings',
)

const tests = read(
  'clients/apple/Tests/ClawPilotPickingCoreTests/ManagerShopifyCheckoutRateControlTests.swift',
)
for (const fragment of [
  'native checkout availability survives failed or malformed Operations independently',
  'native checkout account discovery and presentation fences reject workspace drift',
  'decode production TEST as saved desired but effectively empty',
  'allow every desired state while overrides stay effective only',
  'effective projection exhaustively matches 0299 precedence',
  'exact capabilities allow save while view-only produces zero POST',
  'classifies definitive 4xx and conflict separately',
  'retries transport 429 5xx and malformed responses byte identically',
  'late-session fences bind every reviewed identity',
  'success response binds account config command desired state and revisions',
  'ignores logout workspace and account switches during an in-flight save',
  'quarantines definitive rejection and retains only ambiguous exact retry',
  'stale completion cannot clear a replacement-auth submission',
  'captured[0].1 == captured[1].1',
]) {
  assert.ok(tests.includes(fragment), `native checkout-rate tests are missing ${fragment}`)
}

const discoveryOrganizationId = '11111111-1111-4111-8111-111111111111'
const otherDiscoveryOrganizationId = '22222222-2222-4222-8222-222222222222'
const secretSentinel = 'must-not-leave-postgres'
let discoveryQuery = null
const discoveryPersistenceModule = loadTypeScriptModule(
  accountDiscoveryPersistencePath,
  {
    '@/lib/persistence/postgres': {
      async query(sql, parameters) {
        discoveryQuery = { sql, parameters }
        return {
          rows: [{
            account_global_id: 'gia0009801',
            provider: 'shopify',
            environment: 'production',
            display_name: 'Pro Bakery Bites',
            status: 'active',
            credential_ciphertext: secretSentinel,
          }],
        }
      },
    },
  },
)
const projectedAccounts = await discoveryPersistenceModule
  .readCommerceAccountDiscoveryFromPostgres(discoveryOrganizationId)
assert.deepEqual(
  JSON.parse(JSON.stringify(projectedAccounts)),
  [{
    accountGlobalId: 'gia0009801',
    provider: 'shopify',
    environment: 'production',
    displayName: 'Pro Bakery Bites',
    status: 'active',
  }],
)
assert.deepEqual(
  JSON.parse(JSON.stringify(discoveryQuery?.parameters)),
  [discoveryOrganizationId],
)
assert.match(discoveryQuery?.sql || '', /account\.organization_id = \$1::uuid/u)
assert.ok(
  !JSON.stringify(projectedAccounts).includes(secretSentinel),
  'account discovery leaked a credential field',
)

let discoveryActor = {
  email: 'owner@example.test',
  organizationId: discoveryOrganizationId,
  capabilities: { canManage: true, canActivate: true },
}
let discoveryUnauthorized = false
let discoveryPostgresEnabled = true
const discoveryReads = []
const discoveryRouteModule = loadTypeScriptModule(
  accountDiscoveryRoutePath,
  {
    'next/server': {
      NextResponse: {
        json(body, init = {}) {
          return {
            body,
            status: init.status || 200,
            headers: init.headers || {},
          }
        },
      },
    },
    '@/lib/operations/authorization': {
      operationsCapabilities(actor) {
        return actor.capabilities
      },
      activeOperationsOrganizationId(actor) {
        if (!actor.organizationId) {
          throw new Error('An active organization is required')
        }
        return actor.organizationId
      },
    },
    '@/lib/persistence/commerceAccountDiscovery': {
      async readCommerceAccountDiscoveryFromPostgres(organizationId) {
        discoveryReads.push(organizationId)
        return [{
          accountGlobalId: organizationId === discoveryOrganizationId
            ? 'gia0009801'
            : 'gia0009802',
          provider: 'shopify',
          environment: 'production',
          displayName: organizationId === discoveryOrganizationId
            ? 'Pro Bakery Bites'
            : 'Other organization store',
          status: 'active',
        }]
      },
    },
    '@/lib/persistence/config': {
      isPostgresStorageEnabled() {
        return discoveryPostgresEnabled
      },
    },
    '@/lib/requestUser': {
      async requireRequestUser() {
        if (discoveryUnauthorized) throw new Error('Unauthorized')
        return discoveryActor
      },
    },
  },
)

let discoveryResponse = await discoveryRouteModule.GET({})
assert.equal(discoveryResponse.status, 200)
assert.equal(discoveryResponse.body.organizationId, discoveryOrganizationId)
assert.equal(discoveryResponse.body.accounts[0].accountGlobalId, 'gia0009801')
assert.equal(discoveryReads.at(-1), discoveryOrganizationId)

discoveryActor = {
  ...discoveryActor,
  organizationId: otherDiscoveryOrganizationId,
}
discoveryResponse = await discoveryRouteModule.GET({})
assert.equal(discoveryResponse.status, 200)
assert.equal(
  discoveryResponse.body.organizationId,
  otherDiscoveryOrganizationId,
)
assert.equal(discoveryResponse.body.accounts[0].accountGlobalId, 'gia0009802')
assert.deepEqual(
  discoveryReads,
  [discoveryOrganizationId, otherDiscoveryOrganizationId],
)

discoveryActor = {
  ...discoveryActor,
  capabilities: { canManage: false, canActivate: false },
}
discoveryResponse = await discoveryRouteModule.GET({})
assert.equal(discoveryResponse.status, 403)
assert.equal(
  discoveryResponse.body.code,
  'COMMERCE_ACCOUNT_DISCOVERY_MANAGER_REQUIRED',
)
assert.equal(discoveryReads.length, 2)

discoveryUnauthorized = true
discoveryResponse = await discoveryRouteModule.GET({})
assert.equal(discoveryResponse.status, 401)
assert.equal(discoveryResponse.body.code, 'UNAUTHORIZED')
discoveryUnauthorized = false

discoveryActor = {
  ...discoveryActor,
  capabilities: { canManage: true, canActivate: true },
}
discoveryPostgresEnabled = false
discoveryResponse = await discoveryRouteModule.GET({})
assert.equal(discoveryResponse.status, 503)
assert.equal(
  discoveryResponse.body.code,
  'COMMERCE_ACCOUNT_DISCOVERY_POSTGRES_REQUIRED',
)
assert.equal(discoveryReads.length, 2)

const packageJSON = JSON.parse(read('package.json'))
assert.equal(
  packageJSON.scripts['test:apple-shopify-checkout-rate-control'],
  'node scripts/test-apple-shopify-checkout-rate-control.mjs',
)
assert.match(
  packageJSON.scripts['test:wearable-server'],
  /npm run test:apple-shopify-checkout-rate-control/,
)

const workflow = read('.github/workflows/apple-picking-phase1.yml')
assert.match(
  workflow,
  /node scripts\/test-apple-shopify-checkout-rate-control\.mjs/,
)
assert.match(
  workflow,
  /- 'scripts\/test-apple-shopify-checkout-rate-control\.mjs'/,
)

console.log('Apple Shopify checkout-rate control source acceptance passed')
