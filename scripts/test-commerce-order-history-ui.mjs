import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const root = new URL('../', import.meta.url)
const requireFromApp = createRequire(new URL('../app_src/package.json', import.meta.url))
const ts = requireFromApp('typescript')
const route = await readFile(
  new URL('app_src/app/api/integrations/commerce/order-history/route.ts', root),
  'utf8',
)
const panel = await readFile(
  new URL('app_src/components/operations/CommerceOrderHistoryPanel.tsx', root),
  'utf8',
)
const authorityPanel = await readFile(
  new URL('app_src/components/operations/CommerceAuthoritySummaryPanel.tsx', root),
  'utf8',
)
const imports = await readFile(
  new URL('app_src/components/operations/CommerceImportsPanel.tsx', root),
  'utf8',
)
const health = await readFile(
  new URL('app_src/app/api/health/route.ts', root),
  'utf8',
)
const predeploy = await readFile(
  new URL('scripts/verify-predeploy.mjs', root),
  'utf8',
)
const historyHealthSource = await readFile(
  new URL(
    'app_src/lib/integrations/commerceOrderHistoryHealth.ts',
    root,
  ),
  'utf8',
)
const requestFenceSource = await readFile(
  new URL(
    'app_src/lib/integrations/commerceOrderHistoryRequestFence.ts',
    root,
  ),
  'utf8',
)
const presentationSource = await readFile(
  new URL(
    'app_src/lib/integrations/commerceOrderHistoryPresentation.ts',
    root,
  ),
  'utf8',
)
const compiledPresentation = ts.transpileModule(presentationSource, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText
const presentationModule = { exports: {} }
vm.runInNewContext(compiledPresentation, {
  exports: presentationModule.exports,
  module: presentationModule,
})
const { commerceOrderQuantitySummary } = presentationModule.exports
assert.equal(
  commerceOrderQuantitySummary({
    orderedQuantity: 3,
    fulfilledQuantity: null,
  }),
  '3 ordered · fulfillment unavailable',
  'Unknown provider fulfillment quantity must never render as zero',
)
assert.equal(
  commerceOrderQuantitySummary({
    orderedQuantity: 3,
    fulfilledQuantity: 0,
  }),
  '3 ordered · 0 fulfilled',
  'An exact provider zero remains visible as zero',
)
const compiledRequestFence = ts.transpileModule(requestFenceSource, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText
const requestFenceModule = { exports: {} }
vm.runInNewContext(compiledRequestFence, {
  exports: requestFenceModule.exports,
  module: requestFenceModule,
})
const { createCommerceOrderHistoryRequestFence } = requestFenceModule.exports

async function resolveIfCurrent(fence, token, value, delayMs) {
  await new Promise((resolve) => setTimeout(resolve, delayMs))
  return fence.isCurrent(token) ? value : null
}

const accountFence = createCommerceOrderHistoryRequestFence('shopify:account-a')
const slowAccountA = accountFence.issue('shopify:account-a')
accountFence.reset('shopify:account-b')
const fastAccountB = accountFence.issue('shopify:account-b')
assert.deepEqual(
  await Promise.all([
    resolveIfCurrent(accountFence, slowAccountA, 'account-a', 5),
    resolveIfCurrent(accountFence, fastAccountB, 'account-b', 0),
  ]),
  [null, 'account-b'],
  'A delayed prior-account response must not overwrite the selected account',
)

const timelineFence = createCommerceOrderHistoryRequestFence('shopify:account-b')
const slowOrderA = timelineFence.issue('shopify:account-b:order-a')
const fastOrderB = timelineFence.issue('shopify:account-b:order-b')
assert.deepEqual(
  await Promise.all([
    resolveIfCurrent(timelineFence, slowOrderA, 'order-a', 5),
    resolveIfCurrent(timelineFence, fastOrderB, 'order-b', 0),
  ]),
  [null, 'order-b'],
  'A delayed prior-order timeline must not overwrite the opened order',
)

const pageFence = createCommerceOrderHistoryRequestFence('shopify:account-b')
const slowLoadMore = pageFence.issue('shopify:account-b')
const fastReload = pageFence.issue('shopify:account-b')
assert.deepEqual(
  await Promise.all([
    resolveIfCurrent(pageFence, slowLoadMore, 'old-page', 5),
    resolveIfCurrent(pageFence, fastReload, 'fresh-page', 0),
  ]),
  [null, 'fresh-page'],
  'A delayed load-more response must not append into a newer reload',
)

const compiledHistoryHealth = ts.transpileModule(historyHealthSource, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText
const historyHealthModule = { exports: {} }
vm.runInNewContext(compiledHistoryHealth, {
  Date,
  Math,
  Number,
  String,
  exports: historyHealthModule.exports,
  module: historyHealthModule,
})
const {
  commerceOrderHistoryDurableDegraded,
  commerceOrderHistoryOperationalHealth,
} = historyHealthModule.exports
const checkedAtMs = Date.parse('2026-08-13T18:00:00.000Z')
const operationalInput = {
  heartbeatCheckedAt: '2026-08-13T17:59:30.000Z',
  checkedAtMs,
  pollIntervalMs: 60_000,
  durableDegraded: false,
}
assert.equal(commerceOrderHistoryOperationalHealth({
  ...operationalInput,
  runtimeAvailable: false,
}).status, 'disabled')
assert.equal(commerceOrderHistoryOperationalHealth({
  ...operationalInput,
  runtimeAvailable: true,
  heartbeatCheckedAt: null,
}).status, 'stale')
assert.equal(commerceOrderHistoryOperationalHealth({
  ...operationalInput,
  runtimeAvailable: true,
  heartbeatCheckedAt: '2026-08-13T17:56:59.999Z',
}).status, 'stale')
assert.equal(commerceOrderHistoryOperationalHealth({
  ...operationalInput,
  runtimeAvailable: true,
  durableDegraded: true,
}).status, 'degraded')
assert.equal(commerceOrderHistoryOperationalHealth({
  ...operationalInput,
  runtimeAvailable: true,
  workerDegraded: true,
}).status, 'degraded')
assert.equal(commerceOrderHistoryOperationalHealth({
  ...operationalInput,
  runtimeAvailable: true,
}).status, 'ready')
const cleanDurable = {
  staleProcessing: 0,
  failed: 0,
  blocked: 0,
  dead: 0,
  overduePolls: 0,
  expiredSensitiveEvidence: 0,
  cursorKeysReady: true,
}
assert.equal(commerceOrderHistoryDurableDegraded(cleanDurable), false)
assert.equal(commerceOrderHistoryDurableDegraded({
  ...cleanDurable,
  failed: 1,
}), true)
assert.equal(commerceOrderHistoryDurableDegraded({
  ...cleanDurable,
  blocked: 1,
}), true)

assert.match(route, /operationsCapabilities\(actor\)\.canManage/)
assert.match(route, /activeOperationsOrganizationId\(actor\)/)
assert.match(route, /readCommerceOrderHistorySummariesFromPostgres/)
assert.match(route, /readCommerceOrderEvidenceTimelineByExternalOrderFromPostgres/)
assert.match(route, /requestCommerceOrderBackfillInPostgres/)
assert.match(route, /snapshotObservationGlobalId/)
assert.match(route, /\(cursorObservationGlobalId === null\)[\s\S]*!== \(snapshotObservationGlobalId === null\)/)
assert.match(route, /Idempotency-Key header is required/)
assert.match(route, /receivedBytes > MAX_REQUEST_BYTES/)
assert.match(route, /reader\.cancel\('request_too_large'\)/)
assert.match(route, /Cache-Control': 'private, no-store'/)
assert.doesNotMatch(route, /providerActorFingerprint:/)
assert.match(route, /items: timeline\.items\.map/)
assert.match(route, /truncated: timeline\.truncated/)

assert.match(panel, /Shopify · last 60 days · read only/)
assert.match(panel, /Faire · provider-available history · read only/)
assert.match(panel, /Start history/)
assert.match(panel, /snapshotObservationGlobalId/)
assert.match(panel, /createCommerceOrderHistoryRequestFence/)
assert.match(panel, /historyRequests\.current\.isCurrent\(request\)/)
assert.match(panel, /timelineRequests\.current\.isCurrent\(request\)/)
assert.match(panel, /startRequests\.current\.isCurrent\(request\)/)
assert.match(panel, /snapshot: payload\.history\?\.snapshotObservationGlobalId/)
assert.match(panel, /latest\?\.status === 'succeeded'/)
assert.match(panel, />\s*Reload\s*</)
assert.match(panel, /Provider reads run in the background/)
assert.match(panel, /has not granted read_returns/)
assert.match(panel, /did not attest the oldest rolling-window edge/)
assert.match(panel, /0 provider writes/)
assert.match(panel, /item\.orderGlobalId/)
assert.match(panel, /onOpenOrder\(item\.orderGlobalId!\)/)
assert.match(panel, /event\.actorEmail/)
assert.match(panel, /Picker assigned:/)
assert.match(panel, /PICK_ASSIGNMENT_EVENT_KINDS\.has\(event\.eventKind\)/)
assert.match(panel, /Picked by/)
assert.match(panel, /Provider staff unavailable/)
assert.match(panel, /commerceOrderQuantitySummary\(item\)/)
assert.doesNotMatch(panel, /fulfilledQuantity \?\? 0/)
assert.match(panel, /order_lines_snapshot/)
assert.match(panel, /Order demand—not a historical stock balance/)
assert.match(panel, /Showing the latest \{timelineLimit\} events/)
assert.match(panel, /minHeight: 44/g)
assert.doesNotMatch(panel, /providerActorFingerprint/)
assert.doesNotMatch(panel, /customer|shippingAddress|billingAddress/)

assert.match(authorityPanel, /System of record/)
assert.match(authorityPanel, /Store writeback is off/)
assert.match(authorityPanel, /0 provider writes/)
assert.match(authorityPanel, /Faire quantities are retained as channel observations/)
assert.match(authorityPanel, /Shopify quantities set the current warehouse inventory projection/)
assert.match(authorityPanel, /Seven core Shopify order signals flow into read-only history/)
assert.match(authorityPanel, /Faire changes flow into read-only history through continuous five-minute scheduled checks/)
assert.match(authorityPanel, /Faire does not provide a supported webhook transport/)
assert.match(authorityPanel, /Started warehouse work is reviewed instead of silently replaced/)
assert.match(authorityPanel, /Status details/)
assert.match(authorityPanel, /minHeight: 44/)
assert.doesNotMatch(authorityPanel, /setCommerceAuthorityPolicy|method:\s*'POST'/)

assert.match(imports, /<CommerceOrderHistoryPanel/)
assert.match(imports, /key=\{`history:\$\{selectedAccount\.globalId\}`\}/)
assert.match(imports, /<CommerceAuthoritySummaryPanel/)
assert.match(imports, /provider=\{selectedAccount\.provider\}/)
assert.match(imports, /onOpenOrder=\{onOpenOrder\}/)

for (const contract of [
  '0276_operations_commerce_order_sync_foundation.sql',
  '0277_operations_commerce_authority_policies.sql',
  '0278_operations_shopify_order_webhook_signals.sql',
  'operations_commerce_order_sync_foundation_applied',
  'operations_commerce_authority_policies_applied',
  'operations_shopify_order_webhook_signals_applied',
  'readCommerceOrderSyncHealthFromPostgres',
  'readCommerceOrderSyncCursorKeyReadinessFromPostgres',
  'commerceOrderHistory',
  'transport: durable.transport',
  'continuousTransportCounts: durable.continuousTransportCounts',
  'commerceOrderHistoryOperationalHealth',
  'runtimeAvailable: operational.runtimeAvailable',
  '...operational.worker',
  'Commerce order history worker heartbeat is missing or stale.',
  'historyWorkerResult?.degraded === true',
  "historyWorkerHeartbeat?.phase === 'failed'",
  'workerDegraded: historyWorkerDegraded',
  'The latest commerce order history worker cycle was degraded.',
  'failed: durable.failed',
  'blocked: durable.blocked',
  'Commerce order history has failed or blocked provider-read sessions.',
  "'operations_commerce_order_sync_policies'",
  "'operations_commerce_order_observation_lines'",
  "'protect_credentialed_commerce_account_identity()'",
  "'protect_commerce_order_sync_session_lineage()'",
  "'protect_commerce_order_sync_session_mutation()'",
  "'protect_commerce_order_observation_lineage()'",
  "'commerce_order_observation_accepts_children(uuid,uuid)'",
  "'protect_commerce_order_observation_line_lineage()'",
  "'protect_commerce_order_event_lineage()'",
  "'reject_commerce_order_sync_evidence_mutation()'",
  "'operations_shopify_order_webhook_signals'",
  "'operations_shopify_order_webhook_targets'",
  "'operations_shopify_order_webhook_reads'",
  "'protect_shopify_order_webhook_signal()'",
  "'protect_shopify_order_webhook_target()'",
  "'protect_shopify_order_webhook_read()'",
  "'protect_shopify_order_webhook_signal_write'",
  "'protect_shopify_order_webhook_target_write'",
  "'protect_shopify_order_webhook_read_write'",
  "'credentialed_commerce_account_identity_guard'",
  "'commerce_order_sync_session_lineage_guard'",
  "'commerce_order_sync_session_mutation_guard'",
  "'commerce_order_observations_lineage_guard'",
  "'commerce_order_observation_lines_lineage_guard'",
  "'commerce_order_event_observations_lineage_guard'",
  "'commerce_order_observations_immutable'",
  "'commerce_order_observation_lines_immutable'",
  "'commerce_order_event_observations_immutable'",
  "installed_history_trigger.tgenabled IN ('O', 'A')",
  'installed_history_trigger.tgfoid = to_regprocedure',
]) {
  assert.ok(health.includes(contract), `Health is missing ${contract}`)
}
assert.ok(
  (health.match(/operations_commerce_order_sync_foundation_applied/gu) || [])
    .length >= 4,
  'Order-history migration must gate database readiness and health errors',
)
assert.ok(
  (health.match(/operations_commerce_authority_policies_applied/gu) || [])
    .length >= 4,
  'Authority-policy migration must gate database readiness and health errors',
)
for (const contract of [
  'db/migrations/0276_operations_commerce_order_sync_foundation.sql',
  'db/migrations/0277_operations_commerce_authority_policies.sql',
  'app_src/app/api/integrations/commerce/order-history/route.ts',
  'app_src/app/api/integrations/commerce/authority-policies/route.ts',
  'app_src/components/operations/CommerceAuthoritySummaryPanel.tsx',
  'app_src/components/operations/CommerceOrderHistoryPanel.tsx',
  'app_src/lib/integrations/commerceOrderHistory.ts',
  'app_src/lib/integrations/commerceOrderHistoryRequestFence.ts',
  'app_src/lib/integrations/commerceOrderHistoryPresentation.ts',
  'app_src/lib/integrations/commerceOrderHistoryHealth.ts',
  'app_src/lib/integrations/commerceAuthorityPolicy.ts',
  'app_src/lib/persistence/commerceOrderSync.ts',
  'app_src/lib/persistence/commerceAuthorityPolicies.ts',
  'scripts/test-commerce-order-sync-postgres.mjs',
  'scripts/test-commerce-order-history-worker-drain.mjs',
]) {
  assert.ok(predeploy.includes(contract), `Predeploy is missing ${contract}`)
}

console.log('Commerce order history API and UI contracts passed')
