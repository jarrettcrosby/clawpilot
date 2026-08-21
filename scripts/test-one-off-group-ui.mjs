import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

const constants = read('app_src/lib/operations/oneOffShipmentConstants.ts')
const dialog = read('app_src/components/operations/OneOffShipmentDialog.tsx')
const section = read('app_src/components/operations/OperationsSection.tsx')
const panel = read('app_src/components/operations/OneOffShippingExecutionPanel.tsx')
const carrierSettings = read('app_src/components/settings/CarrierIntegrationPanel.tsx')
const oneOffTypes = read('app_src/lib/operations/oneOffShipments.ts')
const route = read('app_src/app/api/operations/one-off-shipments/route.ts')
const persistence = read('app_src/lib/persistence/operationOneOffShipping.ts')

assert.match(constants, /ONE_OFF_MAX_SYNCHRONOUS_PACKAGES = 40/)
assert.match(dialog, /ONE_OFF_MAX_SYNCHRONOUS_PACKAGES/)
assert.match(dialog, /oneOffShipmentConstants/)
assert.doesNotMatch(dialog, /const MAX_PACKAGES\s*=\s*\d+/)
assert.doesNotMatch(dialog, /canActivate|Operations activation permission/)
assert.match(dialog, /disabled=\{!mode\.enabled\}/)
assert.match(dialog, /onChange=\{\(event\) => \{\s*setExecutionMode\(event\.target\.value as 'test' \| 'live'\)\s*resetQuote\(\)/)

for (const action of ['refresh-packed-rates', 'purchase-group', 'void-group']) {
  assert.match(section, new RegExp(`action: '${action}'`))
}
assert.doesNotMatch(section, /action: 'purchase-label'/)
assert.doesNotMatch(section, /action: 'void-label'/)
assert.match(section, /orderGlobalId=|URLSearchParams\(\{ orderGlobalId \}\)/)
assert.match(section, /ONE_OFF_LIVE_POSTAGE_CONFIRMATION/)
assert.match(section, /oneOffShipmentConstants/)
assert.match(section, /capabilities\.canActivate/)
assert.match(oneOffTypes, /from '@\/lib\/operations\/oneOffShipmentConstants'/)
assert.match(section, /const oneOffGroupVoidPermissionsReady = \(\) => Boolean\([\s\S]*capabilities\?\.canManage && capabilities\.canExecute/)
assert.match(section, /voidOneOffCarrierGroup[\s\S]*!oneOffGroupVoidPermissionsReady\(\)/)

const voidRoute = route.slice(
  route.indexOf("if (action === 'void-group')"),
  route.indexOf("throw new OneOffShipmentPersistenceError(\n      'OPERATIONS_ONE_OFF_ACTION_INVALID'"),
)
assert.doesNotMatch(voidRoute, /canActivate|LIVE_VOID_PERMISSION_REQUIRED/)
assert.match(voidRoute, /executionMode === 'live' && !capabilities\.canPurchaseLivePostage/)
assert.match(voidRoute, /canPurchaseLivePostage: capabilities\.canPurchaseLivePostage/)

assert.match(panel, /one-off-group-shipping-execution/)
assert.match(panel, /complete label set/i)
assert.match(panel, /Provider charge variance/)
assert.match(panel, /packedRateConsumed/)
assert.match(panel, /printJobGlobalId/)
assert.match(panel, /printStatus/)
assert.match(panel, /Close complete TEST sample/)
assert.match(panel, /Void complete shipment group/)
assert.match(panel, /group\?\.lifecycleMode === 'local_sample_close'/)
assert.doesNotMatch(panel, /state\.executionMode === 'test' && group\?\.provider === 'ups_rest'/)
assert.match(panel, /Refresh packed-group rate/)
assert.match(panel, /Review whole-shipment purchase/)
const panelVoidBlocker = panel.slice(
  panel.indexOf('const voidBlocker ='),
  panel.indexOf('\n\n  return (', panel.indexOf('const voidBlocker =')),
)
assert.match(panelVoidBlocker, /basePermissionBlocker/)
assert.doesNotMatch(panelVoidBlocker, /activationBlocker|purchasePermissionBlocker|canActivate/)

assert.match(persistence, /JSON\.stringify\(preparedRequest\.redactedRequest\)/)
assert.match(persistence, /JSON\.stringify\(localRequest\)/)
assert.doesNotMatch(
  persistence,
  /JSON\.stringify\(\{\s*\.\.\.(?:preparedRequest\.redactedRequest|localRequest),\s*reason/u,
)
assert.match(oneOffTypes, /lifecycleMode: 'local_sample_close' \| 'carrier_void' \| null/)
assert.match(persistence, /carrierOneOffGroupLifecycleMode\(\{/)
assert.match(persistence, /packageTrackingNumbers: labels\.rows\.map/)
assert.match(section, /carrierGroup\?\.lifecycleMode[\s\S]*=== 'local_sample_close'/)
assert.match(persistence, /create_attempt\.provider_charge_minor::text[\s\S]*AS create_provider_charge_minor/)
assert.match(persistence, /providerChargeMinor: input\.attempt\.create_provider_charge_minor/)
assert.match(persistence, /if \(prepared\.replayed\) \{\s*return replayVoidedGroup/)

assert.match(panel, /one\s+whole-shipment command/)
assert.match(panel, /Purchase and cancellation are never offered per package/)
assert.match(section, /one whole-shipment cancellation/)
assert.match(section, /package labels must be retired together/)
assert.match(carrierSettings, /Production capabilities/)
assert.match(carrierSettings, /Rate-only ready/)
assert.match(carrierSettings, /a quote cannot create a label or shipment/i)
assert.doesNotMatch(
  carrierSettings,
  /individual package purchase and void controls are intentionally unavailable/i,
)

console.log('one-off multi-package UI contracts passed')
