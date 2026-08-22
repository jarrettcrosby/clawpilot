#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()
const read = (path) => readFileSync(resolve(root, path), 'utf8')

const landing = read('app_src/components/settings/CarrierConnectionsPanel.tsx')
const settings = read('app_src/components/settings/IntegrationSettingsPanel.tsx')
const directDiagnostics = read('app_src/components/settings/CarrierIntegrationPanel.tsx')
const brokeredDiagnostics = read('app_src/components/settings/BrokeredTransportIntegrationPanel.tsx')
const brokeredRoute = read('app_src/app/api/integrations/brokered-transport/route.ts')
const developmentFixture = read('app_src/app/dev/carrier-connections/page.tsx')
const developmentFixtureClient = read(
  'app_src/components/settings/CarrierConnectionsDevelopmentFixture.tsx',
)
const renderedAcceptance = read('app_src/tests/carrier-connections/ui-acceptance.spec.ts')

for (const fragment of [
  'data-testid="carrier-connections-landing"',
  'data-testid="carrier-connections-list"',
  'data-testid="carrier-connections-empty"',
  'Add carrier',
  'Search carriers',
  "name: 'UPS'",
  "name: 'FedEx'",
  "name: 'Worldwide Express'",
  "name: 'R+L Carriers'",
  "name: 'USPS'",
  "unavailable: true",
  "fetch('/api/integrations/carriers'",
  "fetch('/api/integrations/brokered-transport'",
  "action: 'update-credential'",
  "action: 'create-account'",
  "action: 'set-enabled'",
  "action: 'verify-and-activate-rates'",
  'Test and connect',
  'Save for an administrator',
  'data-testid="carrier-activation-permission-warning"',
  "onNavigate?.('#operations/printing')",
]) {
  assert.ok(landing.includes(fragment), `Carrier landing UI missing ${fragment}`)
}

assert.ok(
  landing.includes('{troubleshootExpanded ? <CarrierIntegrationPanel brokeredFocus="all" /> : null}'),
  'Advanced carrier diagnostics must mount only after Troubleshoot is expanded',
)
assert.ok(
  landing.includes('data-testid="carrier-connections-troubleshoot"'),
  'Carrier diagnostics need one collapsed, screenshot-addressable Troubleshoot section',
)
assert.ok(
  landing.includes("selectedProvider === 'wwex_speedship' ? 'sandbox' : 'production'"),
  'The concise wizard must expose only supported brokered environments',
)
assert.ok(
  !landing.includes('https://onlinetools.ups.com')
    && !landing.includes('https://apis.fedex.com')
    && !landing.includes('https://staging.wwex.com'),
  'The browser wizard must call ClawPilot APIs, not carrier provider endpoints',
)

assert.ok(
  settings.includes("import CarrierConnectionsPanel from './CarrierConnectionsPanel'")
    && settings.includes('<CarrierConnectionsPanel onNavigate={onNavigate} />'),
  'Shipping settings must land on the persistent carrier connections page',
)
assert.ok(
  !settings.includes('shipping-integration-capability-tabs')
    && !settings.includes('shippingCapability'),
  'Shipping settings must not make operators choose an internal capability tab before seeing carriers',
)

assert.ok(
  !directDiagnostics.includes("action: 'delete-account'"),
  'The UI must not offer the account delete path forbidden by database integrity rules',
)
assert.ok(
  !directDiagnostics.includes('New account number (optional)'),
  'The UI must not offer account-number rotation forbidden by database integrity rules',
)
assert.ok(
  directDiagnostics.includes('Account numbers cannot be changed after creation.')
    && directDiagnostics.includes('!editingCarrierAccountGlobalId && carrierAccountForm.accountNumber.trim()'),
  'Editing a carrier account must keep its masked billing identity immutable',
)

assert.ok(
  brokeredRoute.includes('canActivate: operationsCapabilities(actor).canActivate')
    && brokeredRoute.includes('return json({ ok: true, canActivate, integrations })'),
  'Brokered API responses must expose activation permission without attempting activation',
)
assert.ok(
  brokeredDiagnostics.includes('const [canActivate, setCanActivate] = useState(false)')
    && brokeredDiagnostics.includes('data-testid="brokered-activation-permission-warning"')
    && brokeredDiagnostics.includes('operations activation permission is required'),
  'Troubleshoot must explain activation permission before the operator clicks a forbidden action',
)

for (const fragment of [
  "process.env.RUNTIME_LANE === 'dev'",
  "process.env.APP_AUTH_REQUIRED === '0'",
  '!process.env.RAILWAY_PROJECT_ID',
  '!process.env.VERCEL',
  "process.env.LOCAL_UI_FIXTURES === '1'",
  'Loading this page never contacts a carrier provider.',
  '<CarrierConnectionsDevelopmentFixture />',
]) {
  assert.ok(developmentFixture.includes(fragment), `Carrier UI fixture missing safety gate ${fragment}`)
}

for (const fragment of [
  '<CarrierConnectionsPanel onNavigate={navigate} />',
  'window.location.hash = hash',
  'data-testid="carrier-connections-printing-handoff"',
]) {
  assert.ok(
    developmentFixtureClient.includes(fragment),
    `Carrier UI fixture client missing ${fragment}`,
  )
}

for (const fragment of [
  "page.route('**/api/integrations/carriers'",
  "page.route('**/api/integrations/brokered-transport'",
  "name: 'Search carriers'",
  "carrier-provider-usps_rest",
  'carrier-connection-ups_rest-sandbox',
  "name: 'Set up label printing'",
  'Local fixture handoff: #operations/printing',
]) {
  assert.ok(renderedAcceptance.includes(fragment), `Rendered carrier acceptance missing ${fragment}`)
}

console.log('Carrier connections landing and wizard source checks passed.')
