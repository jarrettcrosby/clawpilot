#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()
const requireFromApp = createRequire(new URL('../app_src/package.json', import.meta.url))
const ts = requireFromApp('typescript')
const paths = {
  panel: 'app_src/components/operations/ShopifyOrderManagementPanel.tsx',
  section: 'app_src/components/operations/OperationsSection.tsx',
}
const source = Object.fromEntries(
  Object.entries(paths).map(([key, path]) => [key, readFileSync(resolve(root, path), 'utf8')]),
)

for (const [key, path] of Object.entries(paths)) {
  const output = ts.transpileModule(source[key], {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
    },
    fileName: path,
    reportDiagnostics: true,
  })
  const errors = (output.diagnostics || []).filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  )
  assert.deepEqual(errors, [], `${path} must transpile without syntax errors`)
}

assert.match(source.section, /import ShopifyOrderManagementPanel from/)
assert.match(
  source.section,
  /order\.sourceProvider === 'shopify'[\s\S]{0,250}<ShopifyOrderManagementPanel/,
  'Shopify order detail must mount the provider-write panel',
)
assert.match(source.section, /orderGlobalId=\{order\.globalId\}/)
assert.match(source.section, /orderRowVersion=\{order\.rowVersion\}/)
assert.match(source.section, /onOrderChanged=\{onOrderRevisionChanged\}/)
assert.doesNotMatch(
  source.section,
  /order\.sourceProvider === 'shopify' && activationState !== 'shadow'/,
  'global Operations Shadow must not hide Shopify read or per-account writes',
)
assert.doesNotMatch(
  source.panel,
  /canExecute: boolean|canActivate: boolean/,
  'the panel must receive one precomputed cancellation authorization instead of raw role capabilities',
)
assert.match(source.panel, /canCancel: boolean/)
assert.match(source.section, /canCancelProviderOrder: boolean/)
assert.match(
  source.section,
  /canCancelProviderOrder=\{Boolean\([\s\S]{0,160}capabilities\?\.canActivate[\s\S]{0,160}capabilities\.canManage[\s\S]{0,160}capabilities\.canExecute/,
  'ordinary cancellation must require activation, management, and execution authorization',
)

assert.match(source.panel, />Shopify order</)
assert.match(
  source.panel,
  /Edit this order here\. Changes save to Shopify when Provider writes is On\./,
)
assert.match(source.panel, /\{state\.accountLabel\} · \{state\.shopDomain\}/)
assert.match(source.panel, />Order details</)
for (const field of [
  'label="Email"',
  'label="Phone"',
  'label="PO number"',
  'label="Tags"',
  'label="Order note"',
]) assert.ok(source.panel.includes(field), `ordinary Save is missing ${field}`)
assert.match(source.panel, />\s*Shopify source shipping address\s*</)
assert.match(
  source.panel,
  /This changes the address stored on the Shopify order\. It does[\s\S]{0,100}not change ClawPilot&apos;s local shipment-address override\./,
  'the provider address must be clearly distinct from the local shipment override',
)
for (const field of [
  'First name',
  'Last name',
  'Company',
  'Address line 1',
  'Address line 2',
  'City',
  'State / province code',
  'Country code',
  'ZIP / postal code',
  'Address phone',
]) assert.ok(source.panel.includes(field), `Shopify source address is missing ${field}`)
assert.match(source.panel, />Line quantities</)
assert.match(source.panel, />Shopify fulfillments</)
assert.match(source.panel, />\s*Reverse fulfillment\s*</)
assert.match(source.panel, />\s*Track\s*</)
assert.match(source.panel, />Cancel order</)
assert.match(source.panel, /if \(!canManage\) return/)
assert.doesNotMatch(
  source.panel,
  /if \(!canManage \|\| !canExecute \|\| !canActivate\)/,
  'normal order work must require canManage only',
)
assert.match(source.panel, /releasesAuthorization: boolean/)
assert.match(
  source.panel,
  /Shopify will void the open payment authorization\./,
)
assert.match(source.panel, /Choose how payment,\s+inventory, and the customer should be handled\./)

assert.match(
  source.panel,
  /fetch\(\s*`\/api\/operations\/shopify-order-management\?\$\{query\.toString\(\)\}`/,
  'read and refresh must remain available through the isolated route',
)
assert.equal(
  (source.panel.match(/fetch\('\/api\/operations\/shopify-order-management'/g) || []).length,
  4,
  'save, prepare, execute, and reconcile must all use the isolated route',
)
assert.doesNotMatch(
  source.panel,
  /fetch\('\/api\/operations'/,
  'provider writes must never use the generic Operations route',
)
assert.equal(
  (source.panel.match(/'Idempotency-Key': key/g) || []).length,
  4,
  'every POST must carry an idempotency key',
)
assert.match(source.panel, /shopify-order-management:\$\{action\}:\$\{exactId\}:\$\{nonce\}/)
assert.match(source.panel, /const saveAttempt = useRef<IdempotencyAttempt \| null>/)
assert.match(source.panel, /const prepareCancelAttempt = useRef<IdempotencyAttempt \| null>/)
assert.match(source.panel, /const executeCancelAttempt = useRef<IdempotencyAttempt \| null>/)
assert.match(source.panel, /const reconcileAttempt = useRef<IdempotencyAttempt \| null>/)

for (const saveField of [
  "action: 'save' as const",
  'orderGlobalId,',
  'expectedRowVersion: state.order.rowVersion',
  'mutation,',
]) {
  assert.ok(source.panel.includes(saveField), `save payload is missing ${saveField}`)
}
assert.match(source.panel, /action: 'reconcile' as const/)
assert.match(source.panel, /attemptGlobalId: attempt\.attemptGlobalId/)
const reconcileHandler = source.panel.slice(
  source.panel.indexOf('const reconcile = async'),
  source.panel.indexOf('\n  return (', source.panel.indexOf('const reconcile = async')),
)
const resolvedReconciliationBranch = reconcileHandler.slice(
  reconcileHandler.indexOf('} else {'),
  reconcileHandler.indexOf('} catch'),
)
assert.match(
  resolvedReconciliationBranch,
  /await load\(\)[\s\S]{0,120}await Promise\.resolve\(onOrderChanged\(\)\)/,
  'a proved reconciliation must reload management eligibility before the order callback',
)
assert.match(source.panel, />\s*Save order\s*</)
assert.match(source.panel, />\s*Cancel Shopify order\s*</)
assert.match(source.panel, /kind: 'save_order'/)
assert.match(source.panel, /tagAdds,/)
assert.match(source.panel, /tagRemoves,/)
assert.match(source.panel, /lineQuantities: changedLineQuantities/)
assert.match(source.panel, /shippingAddress: desiredShippingAddress/)
assert.match(source.panel, /shippingAddressDirty/)
assert.match(source.panel, /position: 'sticky'/)
assert.equal(
  (source.panel.match(/>\s*Save order\s*</g) || []).length,
  1,
  'ordinary Shopify fields must use one Save button',
)
assert.equal(
  (source.panel.match(/<SaveRounded/g) || []).length,
  1,
  'address and ordinary Shopify fields must share the one Save control',
)
assert.doesNotMatch(source.panel, />\s*Save tag\s*</)
assert.doesNotMatch(source.panel, />\s*Save quantity\s*</)
assert.doesNotMatch(
  source.panel,
  /save\(\{ kind: 'cancel'/,
  'ordinary cancellation must never use the one-click save path',
)
assert.match(source.panel, /kind: 'cancel_fulfillment'/)
assert.match(source.panel, /fulfillmentId: fulfillment\.fulfillmentId/)
assert.match(
  source.panel,
  /expectedFulfillmentUpdatedAt: eligibility\.expectedUpdatedAt/,
)
assert.match(source.panel, /const confirmed = window\.confirm\(/)
assert.match(source.panel, /This does not cancel or refund the order\./)
assert.match(source.panel, /It does not void the '/)
assert.match(source.panel, /carrier label or remove saved label and reprint history\./)
assert.match(
  source.panel,
  /mutation\.kind === 'cancel_fulfillment'[\s\S]{0,140}\|\| mutation\.kind === 'cancel_order_after_fulfillment_reversal'[\s\S]{0,40}\) await load\(\)/,
  'successful fulfillment reversal must refresh the exact provider state',
)
assert.doesNotMatch(
  source.panel,
  /cancel_fulfillment[\s\S]{0,500}save\(\{ kind: 'cancel' \}\)/,
  'fulfillment reversal must not chain order cancellation or refund behavior',
)
assert.match(
  source.panel,
  /disabled=\{busy[\s\S]{0,120}\|\| Boolean\(blocker\)[\s\S]{0,120}\|\| !eligibility\.allowed\}/,
  'the exact per-fulfillment eligibility must control the reversal action',
)
assert.doesNotMatch(
  source.panel,
  /const blocker =[\s\S]{0,500}: state\?\.blockerCode/,
  'ordinary Save and Cancel blockers must not become a panel-global reversal blocker',
)
assert.match(source.panel, />\s*Cancel order after reversal\s*</)
assert.match(source.panel, /data-testid="save-shopify-cancel-after-reversal"/)
assert.match(source.panel, /kind: 'cancel_order_after_fulfillment_reversal'/)
assert.match(source.panel, /predecessorAuthorizationGlobalId: predecessor/)
assert.match(
  source.panel,
  /This is a separate Shopify order cancellation after the fulfillment '/,
)
assert.match(
  source.panel,
  /It does not issue a refund, restock inventory, or notify '/,
)
assert.match(
  source.panel,
  /onClick=\{\(\) => void cancelAfterFulfillmentReversal\(\)\}/,
)
const reversalHandler = source.panel.slice(
  source.panel.indexOf('const reverseFulfillment = async'),
  source.panel.indexOf('const cancelAfterFulfillmentReversal = async'),
)
assert.doesNotMatch(
  reversalHandler,
  /cancel_order_after_fulfillment_reversal/,
  'fulfillment reversal must not automatically dispatch order cancellation',
)

for (const cancellationControl of [
  /'data-testid': 'shopify-cancel-reason-code'/,
  /'data-testid': 'shopify-cancel-refund-method'/,
  /data-testid="shopify-cancel-restock"/,
  /data-testid="shopify-cancel-notify-customer"/,
  /'data-testid': 'shopify-cancel-operator-reason'/,
  /data-testid="shopify-cancel-confirmation-statement"/,
  /'data-testid': 'shopify-cancel-confirmation-input'/,
]) {
  assert.match(
    source.panel,
    cancellationControl,
    'ordinary cancellation must expose explicit operator choices and confirmation',
  )
}
assert.match(source.panel, /const prepareCancellation = async/)
assert.match(source.panel, /const executeCancellation = async/)
assert.match(source.panel, /action: 'prepare' as const/)
assert.match(source.panel, /action: 'execute' as const/)
assert.match(source.panel, /confirmationStatement: cancelConfirmation/)
for (const cancellationField of [
  'reasonCode: cancelReasonCode',
  'refundMethod: cancelRefundMethod',
  'restock: cancelRestock',
  'notifyCustomer: cancelNotifyCustomer',
]) {
  assert.ok(
    source.panel.includes(cancellationField),
    `cancel payload is missing ${cancellationField}`,
  )
}
assert.match(source.panel, />\s*Review cancellation\s*</)
assert.match(source.panel, />\s*Send cancellation to Shopify\s*</)
assert.match(
  source.panel,
  /cancelConfirmation\s*!== preparedCancel\.confirmationStatement/,
  'execution must require the exact prepared confirmation statement',
)

assert.match(
  source.panel,
  /retainedAttempt[\s\S]{0,220}Resolve it before saving another change/,
  'processing and unknown attempts must block every new save',
)
assert.match(source.panel, /Reconciliation reads Shopify and never sends a second write\./)
assert.match(source.panel, /: 'Reconcile outcome'\}/)
assert.match(source.panel, /No second write was sent\./)
assert.match(source.panel, /saved\.state === 'unknown'/)
assert.match(source.panel, /caught instanceof TypeError/)
assert.match(source.panel, /setAmbiguousSave\(true\)/)
assert.doesNotMatch(
  source.panel,
  />\s*(?:Retry execute|Execute again|Retry Shopify write)\s*</i,
  'unknown outcomes must not expose an execution retry control',
)

assert.match(source.panel, /state\.eligibility\.ordinarySave\.reason/)
assert.match(source.panel, /state\.eligibility\.cancel\.reason/)
assert.match(source.panel, /eligibility\.reason \|\| 'Shopify does not allow this line edit\.'/)
assert.match(source.panel, /!state\.eligibility\.ordinarySave\.allowed/)
assert.match(source.panel, /!state\.eligibility\.cancel\.allowed/)
assert.match(
  source.panel,
  /disabled=\{busy \|\| Boolean\(retainedAttempt\)\}/,
  'Provider writes Off must not prevent drafting ordinary fields locally',
)
assert.doesNotMatch(
  source.panel,
  /disabled=\{[^}]*eligibility\.ordinarySave[^}]*\}[\s\S]{0,120}label="Address/,
  'Provider writes Off must disable dispatch, not source-address drafting',
)
assert.match(source.panel, /providerWrites === null/)
assert.ok(source.panel.includes('const AUTHORIZATION_GLOBAL_ID = /^gsom'))
assert.ok(source.panel.includes('const ATTEMPT_GLOBAL_ID = /^gsoa'))
assert.ok(source.panel.includes('const SHA256 = /^[a-f0-9]{64}$/'))

assert.ok(
  (source.panel.match(/minHeight: 4[48]/g) || []).length >= 3,
  'all provider-write controls must retain mobile touch targets',
)
assert.match(source.panel, /direction=\{\{ xs: 'column', sm: 'row' \}\}/)
assert.match(source.panel, /alignSelf: \{ xs: 'stretch', sm: 'flex-start' \}/)
assert.match(source.panel, /gridTemplateColumns: \{[\s\S]{0,100}xs: 'minmax\(0, 1fr\)'/)
assert.match(source.panel, /overflowWrap: 'anywhere'/)
assert.ok(
  (source.panel.match(/component="span" sx=\{\{ display: 'block' \}\}/g) || []).length >= 2,
  'tooltip wrappers must not collapse full-width mobile actions',
)

console.log('Shopify order management UI checks passed.')
