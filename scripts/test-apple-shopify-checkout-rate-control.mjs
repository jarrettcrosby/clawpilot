#!/usr/bin/env node

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()
const read = (path) => readFileSync(resolve(root, path), 'utf8')

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
  '!model.managerShopifyCheckoutRateReviewIsCurrent(',
  'Relaunching refreshes authoritative state without retaining the command',
]) {
  assert.ok(shell.includes(fragment), `native checkout-rate UI is missing ${fragment}`)
}
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
