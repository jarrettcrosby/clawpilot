#!/usr/bin/env node
// Pure, data-only URL/description tests. No credentials, SQL or provider calls.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'

const ts = createRequire(new URL('../app_src/package.json', import.meta.url))('typescript')
const module = { exports: {} }
const source = readFileSync(new URL('../app_src/lib/crm/customerFolderLinks.ts', import.meta.url), 'utf8')
vm.runInNewContext(ts.transpileModule(source, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
} }).outputText, { module, exports: module.exports, URL, Error, decodeURIComponent,
  require: name => assert.fail(`Pure folder links helper must not import ${name}`) })
const { CUSTOMER_FOLDER_LINK_LABELS: labels, normalizeCustomerFolderLinks: validate,
  parseCustomerFolderLinks: parse, updateCustomerFolderLinks: update, segmentCustomerFolderDescription: segment } = module.exports
const plain = value => JSON.parse(JSON.stringify(value))
// User-provided shortlinks are inert test data, never defaults or fetched URLs.
const values = { bpoDriveUrl: 'https://bposupplychain.com/s/fbjdbq3',
  fractionalCustomerFolderUrl: 'https://app.bposupplychain.com/s/d_dCUts2_v096LwHXOjc2OJw' }
const empty = { bpoDriveUrl: '', fractionalCustomerFolderUrl: '' }
const bpo = `${labels.bpoDriveUrl}: ${values.bpoDriveUrl}`
const fractional = `${labels.fractionalCustomerFolderUrl}: ${values.fractionalCustomerFolderUrl}`
let passed = 0
function check(name, work) { work(); passed++; console.log(`PASS ${name}`) }

check('exact supplied shortlinks roundtrip as data without host restrictions or normalization', () => {
  assert.deepEqual(plain(validate(values)), values)
  assert.equal(update('', values), `${bpo}\n${fractional}`)
  assert.deepEqual(plain(parse(`${bpo}\n${fractional}`).values), values)
  assert.equal(parse(`${bpo}\n${fractional}`).hasDuplicates, false)
})
check('notes and mixed line endings remain byte-exact while existing links update in place', () => {
  const original = `  Notes stay  \r\n${bpo}\rBetween notes\n${fractional}\r\nTail  `
  const changed = { ...values, bpoDriveUrl: 'https://drive.google.com/drive/folders/changed?usp=sharing' }
  assert.equal(update(original, changed), original.replace(values.bpoDriveUrl, changed.bpoDriveUrl))
  assert.equal(update(original, values), original)
  assert.equal(segment(original).map(part => part.text).join(''), original)
})
check('insertion and replay are deterministic and do not duplicate either label', () => {
  for (const original of ['', 'Unrelated note', 'Unrelated note\r\n', `Before\n${fractional}\nAfter`]) {
    const once = update(original, values)
    assert.equal(update(once, values), once)
    assert.deepEqual(plain(parse(once).values), values)
    assert.equal(parse(once).hasDuplicates, false)
  }
})
check('clearing one or both links removes only their exact reserved lines', () => {
  const original = `Before\n${bpo}\nBetween\n${fractional}\nAfter`
  assert.equal(update(original, { ...values, bpoDriveUrl: '' }), `Before\nBetween\n${fractional}\nAfter`)
  assert.equal(update(original, { ...values, fractionalCustomerFolderUrl: '' }), `Before\n${bpo}\nBetween\nAfter`)
  assert.equal(update(original, empty), 'Before\nBetween\nAfter')
  assert.equal(update(`${bpo}\n${fractional}`, empty), '')
  assert.equal(update('  Unrelated notes  ', empty), '  Unrelated notes  ')
})
check('duplicates are exposed and refused even when values match or one line is malformed', () => {
  for (const original of [`${bpo}\n${bpo}`, `${fractional}\n${fractional}`, `${bpo}\n${labels.bpoDriveUrl}: `,
    `${bpo}\n${bpo}\n${fractional}\n${fractional}`]) {
    assert.equal(parse(original).hasDuplicates, true)
    assert.ok(parse(original).duplicateLabels.length)
    assert.throws(() => update(original, values), /Duplicate/)
    assert.throws(() => update(original, empty), /Duplicate/)
  }
})
check('malformed exact named lines remain text and require manual repair before mutation', () => {
  for (const line of [`${labels.bpoDriveUrl}:javascript:alert(1)`, `${labels.bpoDriveUrl}: https://example.test/ trailing prose`,
    `${labels.bpoDriveUrl}: `, `${labels.bpoDriveUrl}: https://example.test/\t`, `${labels.bpoDriveUrl}: https://user@example.test/`]) {
    assert.deepEqual(plain(parse(line).invalidLabels), ['bpoDriveUrl'])
    assert.deepEqual(plain(segment(line)), [{ type: 'text', text: line }])
    assert.throws(() => update(line, values), /Malformed/)
  }
})
check('near labels, prose, HTML and arbitrary URL lines are preserved as unlinked text', () => {
  const original = ` ${bpo}\n${bpo.toLowerCase()}\nBPO Supply Chain Drive notes: https://example.test/\n<script>alert(1)</script>\nhttps://example.test/`
  assert.deepEqual(plain(parse(original).values), empty)
  assert.deepEqual(plain(segment(original)), [{ type: 'text', text: original }])
  assert.ok(update(original, values).startsWith(`${original}\n`))
})
check('only complete valid folder lines produce safe anchors and preserve raw segment text', () => {
  const original = `Notes\n${bpo}\n${fractional}\nTail`
  const parts = segment(original)
  assert.equal(parts.map(part => part.text).join(''), original)
  assert.deepEqual(plain(parts.filter(part => part.type === 'folder-link').map(part => part.url)), Object.values(values))
  assert.equal(parts.filter(part => part.type === 'folder-link').every(part => part.lineEnding === '\n'), true)
})
check('URL schemes, WHATWG repairs, credentials, whitespace and raw controls are rejected before normalization', () => {
  for (const value of ['http://example.test/', 'javascript:alert(1)', '//example.test/', '/relative', 'https:example.test/',
    'HTTPS://example.test/', ' https://example.test/', 'https://example.test/ ', 'https://example.test/a b',
    'https://user:pass@example.test/', 'https://user@example.test/', 'https://@example.test/', 'https://:@example.test/',
    'https://example.test\\evil', 'https:///example.test/', 'https://', 'https://example.test/\nInjected',
    'https://example.test/\r', 'https://example.test/\t', 'https://example.test/\u0000', 'https://example.test/\u007f',
    'https://example.test/\u0085', 'https://example.test/\u009f', 'https://example.test/\u2028', 'https://example.test/\u00a0']) {
    assert.throws(() => validate({ ...values, bpoDriveUrl: value }), undefined, value)
  }
})
check('encoded controls/whitespace including nested encodings are rejected without rejecting ordinary UTF-8', () => {
  for (const value of ['%00', '%0a', '%0D', '%09', '%1f', '%7F', '%C2%80', '%C2%85', '%C2%9F', '%20', '%E2%80%A8',
    '%250A', '%25250d', '%25C2%2585', '100%25?x=%250A', '%', '%ZZ', '%E0%A4%A', '%ff']) {
    assert.throws(() => validate({ ...values, bpoDriveUrl: `https://example.test/${value}` }), undefined, value)
  }
  for (const value of ['https://example.test/%E2%80%A2', 'https://example.test/a%2Fb?x=%26&y=1#fragment',
    'https://example.test/100%25', 'https://example.test/100%25?x=%2526']) {
    assert.equal(validate({ ...values, bpoDriveUrl: value }).bpoDriveUrl, value)
  }
})
check('URL bounds and typed empty removal are enforced without coercion', () => {
  const prefix = 'https://example.test/'
  assert.equal(validate({ ...values, bpoDriveUrl: prefix + 'a'.repeat(2048 - prefix.length) }).bpoDriveUrl.length, 2048)
  assert.throws(() => validate({ ...values, bpoDriveUrl: prefix + 'a'.repeat(2049 - prefix.length) }))
  for (const invalid of [null, undefined, 0, false, {}, [], new URL('https://example.test/')]) {
    assert.throws(() => validate({ ...values, bpoDriveUrl: invalid }))
  }
  assert.deepEqual(plain(validate(empty)), empty)
})
check('description output is bounded at 10,000 characters and never silently truncated', () => {
  const suffix = `\n${bpo}\n${fractional}`
  const notes = 'n'.repeat(10_000 - suffix.length)
  assert.equal(update(notes, values).length, 10_000)
  assert.throws(() => update(notes + 'n', values), /10,000/)
  assert.throws(() => update('n'.repeat(10_001), empty), /10,000/)
})
console.log(`${passed} customer folder links checks passed`)
