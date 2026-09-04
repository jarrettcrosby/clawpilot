import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import { emailBodyPreview } from '../app_src/lib/crm/emailBodyPreview.mjs'

const require = createRequire(new URL('../app_src/package.json', import.meta.url))
const ts = require('typescript')
const root = new URL('../', import.meta.url)
function load(path, mocks = {}, expose = []) {
  const module = { exports: {} }
  const source = readFileSync(new URL(path, root), 'utf8')
    + (expose.length ? `\nexport { ${expose.join(', ')} };` : '')
  const code = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
    jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true,
  } }).outputText
  vm.runInNewContext(code, { module, exports: module.exports, Date, URL,
    require: (name) => mocks[name] ?? (name === '@/lib/integrations/commerceOrderHistoryReadLimits'
      ? limits : require(name)) }, { filename: path })
  return module.exports
}
const limits = load('app_src/lib/integrations/commerceOrderHistoryReadLimits.ts')
const native = load('app_src/lib/integrations/shopifyOrderNativeActivity.ts', {
  '@/lib/crm/emailBodyPreview.mjs': { emailBodyPreview },
})
const orderId = 'gid://shopify/Order/9988'
const observedAt = '2026-09-03T20:00:00.000Z'
const basic = (id, changes = {}) => ({
  __typename: 'BasicEvent', id: `gid://shopify/BasicEvent/${id}`,
  subjectId: orderId, action: 'fulfillment_cancelled',
  createdAt: '2026-09-03T19:00:00.000Z', message: '<b>Cancelled</b> &amp; restocked',
  actor: 'Store operator', attributeToUser: true, attributeToApp: false, ...changes,
})
const page = (nodes, hasNextPage = false, endCursor = null) => ({ order: {
  id: orderId, events: { nodes, pageInfo: { hasNextPage, endCursor } },
} })
async function read(pages, overrides = {}) {
  const requests = []
  const result = await native.readShopifyOrderNativeActivity({
    externalOrderId: orderId, observedAt, includeStaffAuthors: false,
    readPage: async (request) => {
      requests.push(request)
      const response = pages[requests.length - 1]
      if (response instanceof Error) throw response
      return response
    }, ...overrides,
  })
  return { result, requests }
}
let checked = 0
const complete = await read([page([basic(1)])])
assert.equal(complete.result.nativeActivityState, 'complete')
assert.equal(complete.result.events[0].providerMessage, 'Cancelled & restocked')
assert.equal(complete.result.events[0].providerActorDisplayName, 'Store operator')
assert.equal(complete.result.events[0].attributionSource, 'unavailable')
assert.equal(complete.result.providerReads, 1)
assert.match(complete.requests[0].query, /first: 250/)
assert.doesNotMatch(complete.requests[0].query, /staffAuthor/)
assert.match(complete.requests[0].variables.query, /comments:true created_at:<=2026-09-03T20:00:00.000Z/)
checked += 1

const controlledActor = await read([page([basic(3, { actor: 'Store\u0000\u0085\noperator' })])])
assert.equal(controlledActor.result.events[0].providerActorDisplayName, 'Store operator')
assert.equal(controlledActor.result.nativeActivityState, 'complete')
checked += 1

const comment = { __typename: 'CommentEvent', id: 'gid://shopify/CommentEvent/21',
  action: 'comment', createdAt: '2026-09-03T19:00:00.000Z', message: 'Comment',
  rawMessage: 'Call customer\n<script>alert(1)</script><a href="javascript:bad">review</a><img src="https://pixel.test/x">',
  attributeToUser: true, attributeToApp: false, edited: true }
const comments = await read([page([comment])])
assert.equal(comments.result.events[0].providerMessage, 'Call customer review')
assert.equal(comments.result.events[0].providerActorDisplayName, null)
assert.equal(comments.result.nativeActivityState, 'complete')
assert.match(native.shopifyOrderNativeActivityQuery(true), /staffAuthor: author \{ id name \}/)
checked += 1

const two = await read([page([basic(1)], true, 'cursor-one'), page([basic(2)])])
assert.equal(two.result.nativeActivityState, 'complete')
assert.equal(two.requests[1].variables.after, 'cursor-one')
assert.equal(two.result.providerReads, 2)
assert.equal(two.result.nativeActivityFetchedCount, 2)
checked += 1

const bounded = await read([
  page(Array.from({ length: 250 }, (_, i) => basic(i + 1)), true, 'cursor-one'),
  page(Array.from({ length: 250 }, (_, i) => basic(i + 251)), true, 'cursor-two'),
])
assert.equal(bounded.requests.length, 2)
assert.equal(bounded.result.events.length, 500)
assert.equal(bounded.result.nativeActivityState, 'partial')
assert.equal(bounded.result.nativeActivityReason, 'page_budget')
checked += 1

for (const pages of [[new Error('access denied')], [page([basic(1)], true, 'next'), new Error('throttled')]]) {
  const sample = await read(pages)
  assert.equal(sample.result.nativeActivityState, pages.length === 1 ? 'unavailable' : 'partial')
  assert.equal(sample.result.providerReads, pages.length)
  assert.equal(sample.result.nativeActivityReason, 'provider_unavailable')
  checked += 1
}
for (const response of [page([basic(1)], true, ''),
  page([basic(1, { subjectId: 'gid://shopify/Order/other' })]),
  page([basic(1, { createdAt: '2026-09-04T00:00:00.000Z' })]),
  page([basic(1, { action: '<unsafe action>' })]),
  page([basic(1), basic(1)]),
  page([basic(1, { message: 'x'.repeat(8_100) })])]) {
  const sample = await read([response])
  assert.equal(sample.result.nativeActivityState, 'partial')
  assert.ok(sample.result.events.every((event) => (event.providerMessage?.length || 0) <= 8_000))
  checked += 1
}
assert.equal((await read([page([])])).result.nativeActivityState, 'complete')
const otherOrder = await read([{ order: { id: 'gid://shopify/Order/other', events: page([]).order.events } }])
assert.equal(otherOrder.result.nativeActivityState, 'unavailable')
assert.equal(otherOrder.result.events.length, 0)
checked += 2

const audits = []
const persistence = load('app_src/lib/persistence/commerceOrderNativeActivity.ts', {
  '@/lib/auditWriter': { recordAuditEvent: async (...args) => { audits.push(args) } },
})
const scope = { organizationId: 'org', integrationAccountId: 'account', provider: 'shopify' }
const event = { eventHash: 'a'.repeat(64), eventKind: 'provider_activity', eventStatus: 'comment',
  providerMessage: 'Message A', providerActorDisplayName: 'Operator A' }
const observation = { externalOrderId: orderId, sourceHash: 'b'.repeat(64), observedAt, events: [event] }
const retained = { event_hash: event.eventHash, expired: false, sensitive_evidence_redacted_at: null,
  latest_id: 'snapshot-one', provider_action: 'comment', provider_message: 'Message A',
  provider_actor_display_name: 'Operator A', latest_observed_at: new Date('2026-09-03T19:30:00Z'), latest_redacted_at: null }
const inspect = (rows, value = observation) => persistence.inspectCommerceOrderNativeActivityWithClient(
  { query: async () => ({ rows }) }, scope, value,
)
assert.equal((await inspect([])).length, 1, 'new native event gets an initial snapshot')
assert.equal((await inspect([retained])).length, 0, 'unchanged provider note is a no-op')
const edited = { ...observation, events: [{ ...event, providerMessage: 'Message B' }] }
assert.equal((await inspect([retained], edited)).length, 1, 'edited note creates snapshot without conflict')
assert.equal((await inspect([{ ...retained, provider_message: 'Message B' }])).length, 1, 'A to B to A retained')
assert.equal((await inspect([{ ...retained, expired: true }], edited)).length, 0)
assert.equal((await inspect([{ ...retained, latest_redacted_at: new Date() }], edited)).length, 0)
assert.equal((await inspect([{ ...retained, sensitive_evidence_redacted_at: new Date() }], edited)).length, 0)
assert.equal((await inspect([{ ...retained, latest_observed_at: new Date('2026-09-03T21:00:00Z') }], edited)).length, 0)
checked += 8
const statements = []
await persistence.appendCommerceOrderNativeActivityWithClient({ query: async (sql, params) => {
  statements.push({ sql, params }); return { rows: [{ id: 'new-snapshot' }] }
} }, scope, observation, 'parent-observation', await inspect([]))
assert.equal(statements.length, 1)
assert.match(statements[0].sql, /parent\.observed_at/)
assert.match(statements[0].sql, /event\.sensitive_evidence_expires_at > clock_timestamp\(\)/)
const snapshot = JSON.parse(statements[0].params[5])[0]
assert.equal(snapshot.providerMessage, event.providerMessage)
assert.match(snapshot.evidenceHash, /^[a-f0-9]{64}$/)
assert.equal(audits.length, 1)
assert.doesNotMatch(JSON.stringify(audits[0][0]), /Message A|Operator A/)
assert.match(persistence.commerceOrderNativeActivityJoinSql('native_observation.id = anchor.id'), /native_observation\.id = anchor\.id/)
assert.match(persistence.COMMERCE_ORDER_NATIVE_MESSAGE_SQL, /sensitive_evidence_redacted_at IS NULL/)
checked += 1

const React = require('react')
const { renderToStaticMarkup } = require('react-dom/server')
const components = load('app_src/components/operations/CommerceNativeActivity.tsx')
const html = renderToStaticMarkup(React.createElement(components.NativeActivityText, {
  message: '<img src=x onerror=alert(1)> <script>bad</script>', actor: '<svg onload=bad>',
}))
assert.doesNotMatch(html, /<img src=x|<script>bad|<svg onload/)
assert.match(html, /&lt;img/)
const notice = (coverage) => renderToStaticMarkup(React.createElement(components.NativeActivityCoverageNotice, { coverage }))
assert.match(notice({ state: 'complete', reason: null, fetchedCount: 47, displayTruncated: false }), /47 provider-available/)
assert.match(notice({ state: 'complete', reason: null, fetchedCount: 500, displayTruncated: true }), /not the complete Shopify Admin timeline/)
assert.match(notice({ state: 'unavailable', reason: 'provider_unavailable', fetchedCount: 0, displayTruncated: false }), /Order and fulfillment details remain available/)
assert.match(notice(undefined), /not yet been captured/)
checked += 5

const presenter = load('app_src/lib/operations/providerOrderHistory.ts')
const projected = presenter.operationsProviderHistoryFromTimeline({ items: [
  { evidenceSource: 'provider', eventKind: 'order_lines_snapshot', payload: {
    nativeActivityState: 'complete', nativeActivityReason: null, nativeActivityFetchedCount: 1, lines: [],
  } },
  { evidenceSource: 'provider', evidenceGlobalId: 'activity-one', eventKind: 'provider_activity',
    eventStatus: 'comment', occurredAt: observedAt, payload: { providerMessage: 'Review requested',
      providerActorDisplayName: 'Provider operator', nativeActivityRedacted: false } },
], truncated: false })
assert.equal(projected.nativeActivity.state, 'complete')
assert.equal(projected.events[0].providerMessage, 'Review requested')
assert.equal(projected.events[0].providerActorDisplayName, 'Provider operator')
assert.equal(projected.events[0].actorEmail, undefined)
checked += 1
const batch = load('app_src/lib/persistence/commerceOrderHistoryBatch.ts', {
  '@/lib/integrations/commerceReadRuntime': { commerceReadAccountSql: () => 'TRUE' },
  '@/lib/persistence/postgres': {},
}, ['validatedOutcome'])
const expected = { candidateGlobalId: 'gcoc0000001', accountGlobalId: 'gia0000001', provider: 'shopify', terminal: false }
const outcome = { ...expected, outcome: 'captured', changed: true, code: null,
  terminalUnsupported: false, providerReads: 5 }
delete outcome.terminal
assert.equal(batch.validatedOutcome(outcome, expected).providerReads, 5)
assert.throws(() => batch.validatedOutcome({ ...outcome, providerReads: 6 }, expected), /invalid/)
assert.throws(() => batch.validatedOutcome({ ...outcome, provider: 'faire', providerReads: 3 },
  { ...expected, provider: 'faire' }), /invalid/)
assert.equal(batch.validatedOutcome({ ...outcome, provider: 'faire', providerReads: 2 },
  { ...expected, provider: 'faire' }).providerReads, 2)
checked += 4
console.log(`Shopify native activity ${checked} adapter, pagination, snapshot, retention, and safe UI cases passed`)
