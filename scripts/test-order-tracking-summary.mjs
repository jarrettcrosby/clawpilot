import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const require = createRequire(new URL('../app_src/package.json', import.meta.url))
const ts = require('typescript')
const source = await readFile(new URL('../app_src/lib/operations/orderTrackingSummary.ts', import.meta.url), 'utf8')
const module = { exports: {} }
vm.runInNewContext(ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { module, exports: module.exports })
const { currentOrderTrackingEvents } = module.exports
const event = (globalId, changes = {}) => ({
  globalId, kind: 'tracking_updated', status: 'in_transit',
  occurredAt: '2026-09-01T12:00:00Z', externalSubjectId: 'gid://shopify/Fulfillment/100',
  quantity: null, amountMinor: null, currency: null, trackingCarrier: 'USPS',
  trackingNumber: 'TEST-PACKAGE-1', trackingUrl: 'https://tracking.example.test/one',
  trackingRedacted: false, ...changes,
})
const ids = rows => Array.from(currentOrderTrackingEvents(rows), row => row.globalId)
const six = Array.from({ length: 6 }, (_, index) => event(`snapshot-${index}`, {
  occurredAt: `2026-09-0${index + 1}T12:00:00Z`,
  status: index === 5 ? 'delivered' : 'in_transit',
  trackingUrl: `https://tracking.example.test/snapshot-${index}`,
}))
assert.deepEqual(ids(six), ['snapshot-5'], 'Six snapshots of one known package become one current summary')
assert.deepEqual(ids([...six].reverse()), ['snapshot-5'], 'Latest timestamp wins independently of input order')
assert.strictEqual(currentOrderTrackingEvents(six)[0], six[5], 'Keep exact latest row and its link/status')
const latest = six[5]
const distinct = [
  event('fulfillment-2', { externalSubjectId: 'gid://shopify/Fulfillment/200' }),
  event('number-2', { trackingNumber: 'TEST-PACKAGE-2' }),
  event('carrier-2', { trackingCarrier: 'UPS' }),
]
assert.deepEqual(ids([...six, ...distinct]), ['snapshot-5', ...distinct.map(row => row.globalId)])
const opaque = [
  event('opaque-old', { externalSubjectId: 'shipment:001' }),
  event('opaque-new', { externalSubjectId: 'shipment:001', occurredAt: latest.occurredAt }),
  event('opaque-other', { externalSubjectId: 'shipment:1' }),
  event('case-other', { externalSubjectId: 'Shipment:001' }),
]
assert.deepEqual(ids(opaque), ['opaque-new', 'opaque-other', 'case-other'], 'Provider IDs stay opaque/exact')
for (const [field, value] of [
  ['externalSubjectId', null], ['externalSubjectId', '  '],
  ['trackingCarrier', null], ['trackingCarrier', ''],
  ['trackingNumber', null], ['trackingNumber', ''],
  ['trackingRedacted', true], ['occurredAt', ''], ['occurredAt', 'invalid'],
]) {
  const uncertain = [event('unknown-old', { [field]: value }),
    event('unknown-new', { occurredAt: latest.occurredAt, [field]: value })]
  assert.deepEqual(ids([...uncertain, latest]), ['unknown-old', 'unknown-new', 'snapshot-5'],
    `${field}=${value}: uncertain/redacted chronology or identity must not collapse`)
}
const generic = [event('generic-1', { trackingNumber: null, trackingUrl: null }),
  event('generic-2', { trackingNumber: null, trackingUrl: null, occurredAt: latest.occurredAt })]
assert.deepEqual(ids([...generic, latest]), ['generic-1', 'generic-2', 'snapshot-5'])
const urlOnly = [event('url-only-1', { trackingNumber: null }), event('url-only-2', {
  trackingNumber: null, occurredAt: latest.occurredAt,
})]
assert.deepEqual(ids(urlOnly), ['url-only-1', 'url-only-2'], 'A URL alone does not identify a package')
assert.deepEqual(ids([latest, event('same-time', { occurredAt: latest.occurredAt })]),
  ['snapshot-5', 'same-time'], 'Tied timestamps do not establish supersession')
const noLatestLink = event('new-no-link', { occurredAt: '2026-09-07T12:00:00Z', trackingUrl: null })
assert.strictEqual(currentOrderTrackingEvents([...six, noLatestLink])[0].trackingUrl, null,
  'Do not copy an older row URL into the latest record')
assert.deepEqual(ids([event('delimiter-1', { externalSubjectId: 'a|b', trackingCarrier: 'c' }),
  event('delimiter-2', { externalSubjectId: 'a', trackingCarrier: 'b|c' })]),
['delimiter-1', 'delimiter-2'], 'Identity serialization is collision-safe')
const frozen = Object.freeze(six.map(row => Object.freeze({ ...row })))
const before = JSON.stringify(frozen)
const summary = currentOrderTrackingEvents(frozen)
assert.equal(JSON.stringify(frozen), before, 'Raw history and its ordering remain unchanged')
assert.equal(frozen.length, 6);assert.equal(summary.length, 1)
assert.notStrictEqual(summary, frozen)
assert.strictEqual(summary[0], frozen[5])

const drawer = await readFile(new URL('../app_src/components/operations/ImportedOrderWorkingCopyDrawer.tsx', import.meta.url), 'utf8')
assert.ok(drawer.includes('currentOrderTrackingEvents(trackingHistory)'))
assert.match(drawer, /<Accordion[\s\S]*Tracking history \(\{trackingHistory\.length\}\)[\s\S]*<AccordionDetails>[\s\S]*trackingHistory\.map/u,
  'Expansion maps the original full tracking history, not the summary')
assert.ok(drawer.includes('slotProps={{ transition: { unmountOnExit: true } }}'),
  'Historical rows are mounted only when expanded')
assert.equal((drawer.match(/<TrackingEventDetails key=\{event\.globalId\} event=\{event\} \/>/g) || []).length, 2,
  'Summary and history render each exact row through the same field-preserving component')
console.log('Order tracking summary: all focused identity/chronology/preservation checks passed')
