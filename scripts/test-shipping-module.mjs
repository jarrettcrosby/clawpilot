#!/usr/bin/env node

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()

function read(path) {
  return readFileSync(resolve(root, path), 'utf8')
}

function section(source, startMarker, endMarker, label) {
  const start = source.indexOf(startMarker)
  assert.notEqual(start, -1, `${label} is missing start marker: ${startMarker}`)
  const end = endMarker
    ? source.indexOf(endMarker, start + startMarker.length)
    : source.length
  assert.notEqual(end, -1, `${label} is missing end marker: ${endMarker}`)
  return source.slice(start, end)
}

function assertIncludes(source, fragments, label) {
  for (const fragment of fragments) {
    assert.ok(source.includes(fragment), `${label} is missing ${fragment}`)
  }
}

const navigation = read('app_src/components/Navigation.tsx')
const homeClient = read('app_src/app/HomeClient.tsx')
const appHeader = read('app_src/components/AppHeader.tsx')
const shippingSection = read('app_src/components/shipping/ShippingSection.tsx')
const shippingExecutionPanel = read('app_src/components/shipping/ShippingOneOffExecutionPanel.tsx')
const parcelDialog = read('app_src/components/operations/OneOffShipmentDialog.tsx')
const shippingRoute = read('app_src/app/api/operations/shipping/route.ts')
const shippingPersistence = read('app_src/lib/persistence/shipping.ts')
const shippingContract = read('app_src/lib/operations/shipping.ts')

const shippingChildren = section(
  navigation,
  'const SHIPPING_CHILDREN',
  'const NAV_ITEMS',
  'Shipping navigation children',
)
assertIncludes(shippingChildren, [
  "id: 'shipping'",
  "label: 'Create shipment'",
  "id: 'shipping/shipments'",
  "label: 'Shipments'",
  "id: 'shipping/pickups'",
  "label: 'Schedule pickups'",
], 'Shipping navigation children')
assert.match(
  navigation,
  /id: 'shipping',[\s\S]*?label: 'Shipping',[\s\S]*?children: SHIPPING_CHILDREN/,
  'Shipping must be a standalone top-level module with its own submodules',
)
assertIncludes(navigation, [
  '(flyout?.item.children || []).map',
  "`${flyout?.item.label || 'Module'} submodules`",
], 'Collapsed navigation flyout')
assert.doesNotMatch(
  section(navigation, '<Menu', '</Menu>', 'Collapsed navigation flyout'),
  /OPERATIONS_CHILDREN\.map/,
  'The collapsed flyout must use the selected module children, not Operations-only children',
)

assertIncludes(homeClient, [
  "from '@/components/shipping/ShippingSection'",
  "'shipping'",
  'const SHIPPING_TARGETS',
  "'shipping/shipments'",
  "'shipping/pickups'",
  'hash in SHIPPING_TARGETS',
  '<ShippingSection',
  'SHIPPING_TARGETS[navigationTarget]',
], 'HomeClient Shipping wiring')
assert.match(
  appHeader,
  /shipping:\s*'Shipping'/,
  'The app header must label the standalone Shipping module',
)

assertIncludes(shippingSection, [
  "export type ShippingView = 'create' | 'shipments' | 'pickups'",
  'ShippingTransportMode',
  'Parcel',
  'LTL',
  'Create Shipment',
  'Shipments',
  'Schedule Pickups',
  "fetch('/api/operations/shipping'",
  '<OneOffShipmentDialog',
  '<LtlFreightClassAssessmentPanel',
  '<ShippingOneOffExecutionPanel',
  'standaloneOneOffExecutionEligible',
  'Standalone postage',
  'canCreateShipments={Boolean(workspace?.capabilities.canCreate)}',
], 'Shipping module')
assertIncludes(shippingExecutionPanel, [
  "action: 'refresh-packed-rates'",
  "action: 'purchase-group'",
  "action: 'void-group'",
  'Check status',
  'Create TEST labels',
  'Purchase LIVE postage',
  'definitiveClientRejection',
  'command.body',
], 'Standalone Shipping postage controls')
assert.doesNotMatch(
  shippingExecutionPanel,
  /canManage|canExecute|canActivate|operations_activation_scopes/,
  'Standalone Shipping postage controls must not depend on Operations access or mode',
)
assert.match(
  shippingSection,
  /disabled=\{true\}|disabled\s/,
  'Unproven shipment or pickup execution must remain visibly disabled',
)
assertIncludes(shippingSection, [
  'pickupAvailability',
  'blocker',
  'LTL preparation only',
  'Rating, tender, and pickup are not connected yet.',
  'Pickup scheduling is not yet available',
], 'Pickup readiness gating')
assert.doesNotMatch(
  shippingSection,
  /create-ltl-shipment|tender-ltl-shipment|schedule-ltl-pickup/,
  'The initial LTL preparation surface must not expose executable shipment or pickup actions',
)

assert.doesNotMatch(
  parcelDialog,
  /LtlFreightClassAssessmentPanel/,
  'The Parcel dialog must not contain the independent LTL classification workflow',
)
assert.doesNotMatch(
  parcelDialog,
  /Freight class candidate|LTL freight classification/i,
  'The Parcel dialog must not present LTL classification copy',
)

assertIncludes(shippingContract, [
  "export type ShippingTransportMode = 'parcel' | 'ltl'",
  "| 'shipment_plan'",
  "| 'parcel_shipment'",
  "| 'ltl_tender'",
  'pickupAvailability',
  'available: false',
], 'Shipping read contract')

assertIncludes(shippingRoute, [
  'export async function GET',
  'requireRequestUser(req)',
  'shippingCapabilities(actor)',
  'if (!capabilities.canView)',
  'activeOperationsOrganizationId(actor)',
  'readShippingWorkspaceFromPostgres({',
  "error.message === 'Unauthorized'",
  "code: 'UNAUTHORIZED'",
  "'Cache-Control': 'private, no-store'",
], 'Shipping read route')
assert.doesNotMatch(
  shippingRoute,
  /operationsCapabilities|operations_activation_scopes/,
  'Shipping reads must not depend on Operations permission or activation state',
)
assert.doesNotMatch(
  shippingRoute,
  /searchParams\.get\(['"]organizationId['"]\)|req(?:uest)?\.json\(/,
  'The Shipping read route must derive organization scope from the authenticated workspace',
)

assertIncludes(shippingPersistence, [
  'readShippingWorkspaceFromPostgres',
  'organizationId: string',
  'WHERE source_order.organization_id = $1::uuid',
  'WHERE shipment.organization_id = $1::uuid',
  'WHERE tender.organization_id = $1::uuid',
  "shipping_order.source_provider = 'clawpilot_native'",
  "shipping_order.order_type = 'one_off'",
  'parcel_shipment',
  'ltl_tender',
  '[input.organizationId]',
], 'Organization-fenced Shipping persistence')
assert.ok(
  (shippingPersistence.match(/organization_id = \$1::uuid/g) || []).length >= 3,
  'Every parcel-plan, parcel-shipment, and LTL-tender read branch must be organization fenced',
)
assert.doesNotMatch(
  shippingPersistence,
  /INSERT\s+INTO|UPDATE\s+operations_|DELETE\s+FROM/i,
  'The initial Shipping workspace endpoint must remain read-only',
)

console.log('Shipping module contract checks passed.')
