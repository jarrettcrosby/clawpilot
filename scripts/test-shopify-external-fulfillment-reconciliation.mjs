import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const [
  migration,
  evidence,
  runtime,
  persistence,
  domain,
  route,
  ui,
] = await Promise.all([
  readFile('db/migrations/0268_operations_shopify_external_fulfillment_reconciliation.sql', 'utf8'),
  readFile('app_src/lib/integrations/shopifyExternalFulfillmentEvidence.ts', 'utf8'),
  readFile('app_src/lib/integrations/shopifyExternalFulfillmentReconciliation.ts', 'utf8'),
  readFile('app_src/lib/persistence/operations.ts', 'utf8'),
  readFile('app_src/lib/operations/domain.ts', 'utf8'),
  readFile('app_src/app/api/operations/route.ts', 'utf8'),
  readFile('app_src/components/operations/OperationsSection.tsx', 'utf8'),
])

assert.match(
  migration,
  /operations_shopify_external_fulfillment_reconciliations/,
)
assert.match(migration, /provider_write_count integer NOT NULL CHECK \(provider_write_count = 0\)/)
assert.match(migration, /rows are immutable/)
assert.match(
  migration,
  /operations_shopify_external_fulfillment_reconciliation_required/,
)
assert.match(migration, /operations_commerce_inventory_captures/)
assert.match(migration, /operations_fulfillment_allocations allocation/)

assert.match(evidence, /displayFulfillmentStatus !== 'FULFILLED'/)
assert.match(evidence, /order\.fulfillable !== false/)
assert.match(evidence, /exactFulfillment\.createdAt/)
assert.match(evidence, /SHOPIFY_EXTERNAL_FULFILLMENT_PREDATES_RELEASE/)
assert.match(evidence, /exact successful fulfillment/)

assert.match(runtime, /query ClawPilotExternalFulfillmentReconciliation/)
assert.doesNotMatch(runtime, /\bmutation\b/)
assert.match(runtime, /providerWrites: 0/)

const commandStart = persistence.indexOf(
  'export async function reconcileShopifyExternalFulfillmentFromPostgres',
)
const commandEnd = persistence.indexOf(
  'export async function confirmOperationsOrderPicksFromPostgres',
  commandStart,
)
assert.ok(commandStart >= 0 && commandEnd > commandStart)
const command = persistence.slice(commandStart, commandEnd)
assert.match(command, /inspectShopifyExternalFulfillment/)
assert.match(command, /status = 'cancelled'/)
assert.match(command, /reservation_authority = 'provider_commitment'/)
assert.match(command, /status = 'released'/)
assert.match(command, /customerNotificationSent: false/)
assert.match(command, /providerWrites: 0/)
assert.doesNotMatch(command, /executeShopifyFulfillmentWriteback/)
assert.doesNotMatch(command, /INSERT INTO operations_shipments/)
assert.doesNotMatch(command, /INSERT INTO operations_commerce_fulfillment_exports/)

assert.match(
  persistence,
  /OPERATIONS_SHOPIFY_EXTERNAL_FULFILLMENT_RECONCILIATION_REQUIRED/,
)
assert.match(domain, /reconcile_external_fulfillment/)
assert.match(route, /action === 'reconcile-external-fulfillment'/)
assert.match(
  route,
  /action === 'reconcile-external-fulfillment'[\s\S]*?!capabilities\.canManage \|\| !capabilities\.canExecute/,
)
assert.match(ui, /shopifyExternalFulfillmentReconciliationRequired/)
assert.match(ui, /does not write to Shopify/)
assert.match(ui, /sent no customer notification/)

console.log('Shopify external-fulfillment reconciliation contract checks passed')
