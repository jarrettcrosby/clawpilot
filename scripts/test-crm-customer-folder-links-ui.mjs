#!/usr/bin/env node
// Actual React/MUI server rendering plus extracted-command/static integration
// checks. No browser interaction, signed-in save, database or provider proof.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'

const requireApp = createRequire(new URL('../app_src/package.json', import.meta.url))
const ts = requireApp('typescript'), React = requireApp('react')
const { renderToStaticMarkup } = requireApp('react-dom/server')
const read = relative => readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8')
const helperSource = read('app_src/lib/crm/customerFolderLinks.ts')
const editorSource = read('app_src/components/projects/CustomerFolderLinksEditor.tsx')
const drawerSource = read('app_src/components/projects/CardDetailDrawer.tsx')
const compilerOptions = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX }
const plain = value => JSON.parse(JSON.stringify(value))
const noEffect = () => assert.fail('This isolated UI check cannot call a provider, navigate or save on render')
function load(source, fileName, imports) {
  const module = { exports: {} }
  vm.runInNewContext(ts.transpileModule(source, { fileName, compilerOptions }).outputText, {
    module, exports: module.exports, URL, Error, decodeURIComponent, fetch: noEffect,
    require: imports,
  }, { filename: fileName, timeout: 5_000 })
  return module.exports
}
const helper = load(helperSource, 'customerFolderLinks.ts', name => assert.fail(`Data-only helper cannot import ${name}`))
const api = load(editorSource, 'CustomerFolderLinksEditor.tsx', name => {
  if (name === '@/lib/crm/customerFolderLinks') return helper
  if (name === 'react' || name === 'react/jsx-runtime' || name.startsWith('@mui/')) return requireApp(name)
  return assert.fail(`Unexpected customer-folder UI dependency: ${name}`)
})
const labels = helper.CUSTOMER_FOLDER_LINK_LABELS
const values = { bpoDriveUrl: 'https://drive.google.com/drive/folders/bpo-example',
  fractionalCustomerFolderUrl: 'https://app.example.test/customers/customer-example/folder' }
const bpoLine = `${labels.bpoDriveUrl}: ${values.bpoDriveUrl}`
const fractionalLine = `${labels.fractionalCustomerFolderUrl}: ${values.fractionalCustomerFolderUrl}`
const initialDescription = `Customer notes remain intact.\n${bpoLine}\n${fractionalLine}\nFollow up next week.`
const firstHash = '1'.repeat(64), newerHash = '2'.repeat(64)
let checks = 0
async function check(name, run) { await run(); checks++; console.log(`PASS ${name}`) }
const renderDescription = description => renderToStaticMarkup(React.createElement(api.CustomerFolderDescription, { description }))
const anchors = html => html.match(/<a\b[^>]*>/gu) || []

await check('actual React/MUI description emits exactly two validated anchors with original labels and notes', () => {
  const html = renderDescription(initialDescription)
  assert.equal(anchors(html).length, 2)
  for (const url of Object.values(values)) assert.ok(html.includes(`href="${url}"`))
  for (const label of Object.values(labels)) assert.ok(html.includes(`${label}: `))
  assert.ok(html.includes('Customer notes remain intact.'))
  assert.ok(html.includes('Follow up next week.'))
  for (const anchor of anchors(html)) {
    assert.ok(anchor.includes('target="_blank"'))
    assert.ok(anchor.includes('rel="noopener noreferrer"'))
  }
  assert.match(editorSource, /onClick=\{event => event\.stopPropagation\(\)\}/u)
})
await check('arbitrary HTML, Markdown, malformed named URLs and unrelated HTTPS notes stay escaped unlinked text', () => {
  const notes = '<script>alert("notes")</script>\n<img src=x onerror=alert(1)>\n[Bad](javascript:alert(1))\nhttps://unrelated.example.test/'
  for (const invalid of ['javascript:alert(1)', 'http://example.test/', 'https://user:pass@example.test/',
    '//example.test/', 'https://example.test/%0AInjected', 'https://example.test/ trailing text']) {
    const html = renderDescription(`${notes}\n${labels.bpoDriveUrl}: ${invalid}`)
    assert.equal(anchors(html).length, 0, invalid)
    assert.ok(html.includes('&lt;script&gt;') && html.includes('&lt;img'))
    assert.ok(!html.includes('<script>') && !html.includes('<img '))
    assert.ok(!/\sonerror\s*=/u.test(html.replaceAll('&lt;img src=x onerror=alert(1)&gt;', '')))
  }
})
await check('React independently escapes URL attribute and visible note text without an HTML renderer', () => {
  const url = 'https://example.test/folder?first=one&second=two'
  const html = renderDescription(`<b>Notes & quotes</b>\n${labels.bpoDriveUrl}: ${url}`)
  assert.equal(anchors(html).length, 1)
  assert.ok(html.includes('href="https://example.test/folder?first=one&amp;second=two"'))
  assert.ok(html.includes('&lt;b&gt;Notes &amp; quotes&lt;/b&gt;'))
  assert.doesNotMatch(editorSource, /dangerouslySetInnerHTML|innerHTML|DOMParser|react-markdown/iu)
})
await check('read-only actual React editor exposes no edit controls and editable render never saves', () => {
  const props = { description: initialDescription, descriptionHash: firstHash, readOnly: true, onSave: noEffect }
  assert.equal(renderToStaticMarkup(React.createElement(api.default, props)), '')
  const html = renderToStaticMarkup(React.createElement(api.default, { ...props, readOnly: false }))
  assert.ok(html.includes('Edit customer folder links'))
  assert.equal((html.match(/<button\b/gu) || []).length, 1)
  assert.ok(!html.includes('role="dialog"'), 'Closed editor must not expose a stale live dialog')
  const disabled = renderToStaticMarkup(React.createElement(api.default, { ...props, readOnly: false, disabled: true }))
  assert.match(disabled, /<button\b[^>]*\sdisabled=""/u)
})

// Execute the unmodified begin/save function bodies extracted from the real
// component. State setters are explicit test inputs, not a React/browser mount.
// These checks prove command construction/failure branches, not DOM events.
const editorAst = ts.createSourceFile('CustomerFolderLinksEditor.tsx', editorSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const component = editorAst.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'CustomerFolderLinksEditor')
assert.ok(component?.body, 'Real editor function must exist')
const functions = Object.fromEntries(component.body.statements.filter(ts.isFunctionDeclaration).map(node => [node.name?.text, node]))
assert.ok(functions.begin && functions.save, 'Capture and save commands must remain explicit')
const commandsSource = ts.transpileModule(`${functions.begin.getText(editorAst)}\n${functions.save.getText(editorAst)}\nglobalThis.commands = { begin, save };`, {
  compilerOptions,
}).outputText
function commands(overrides = {}) {
  const state = {
    description: initialDescription, descriptionHash: firstHash, readOnly: false, disabled: false,
    baseline: null, values: { bpoDriveUrl: '', fractionalCustomerFolderUrl: '' }, error: '', saving: false,
    submitting: { current: false }, parseCustomerFolderLinks: helper.parseCustomerFolderLinks,
    updateCustomerFolderLinks: helper.updateCustomerFolderLinks, calls: [], Error,
    onSave: async (description, hash) => { state.calls.push({ description, hash }); return true },
    ...overrides,
  }
  for (const key of ['baseline', 'values', 'error', 'saving']) {
    state[`set${key[0].toUpperCase()}${key.slice(1)}`] = next => { state[key] = typeof next === 'function' ? next(state[key]) : next }
  }
  vm.createContext(state)
  vm.runInContext(commandsSource, state, { timeout: 5_000 })
  return state
}
const replacementUrl = 'https://drive.google.com/drive/folders/reviewed-replacement'
function changed(state) { state.commands.begin(); state.values = { ...values, bpoDriveUrl: replacementUrl }; return state }

await check('real begin command captures revision and values only for editable enabled cards', () => {
  const state = commands()
  state.commands.begin()
  assert.deepEqual(plain(state.baseline), { description: initialDescription, hash: firstHash })
  assert.deepEqual(plain(state.values), values)
  for (const overrides of [{ readOnly: true }, { disabled: true }]) {
    const held = commands(overrides)
    held.commands.begin()
    assert.equal(held.baseline, null)
    assert.deepEqual(held.calls, [])
  }
})
await check('real save command retains original description/hash across live prop refresh and preserves other notes', async () => {
  const state = changed(commands())
  state.description = 'Newer unrelated CRM description'
  state.descriptionHash = newerHash
  await state.commands.save()
  assert.deepEqual(state.calls, [{ description: initialDescription.replace(values.bpoDriveUrl, replacementUrl), hash: firstHash }])
  assert.equal(state.baseline, null)
  assert.equal(state.saving, false)
  assert.equal(state.submitting.current, false)
})
await check('false/409-like save and rejected network save retain exact entered values and captured baseline for retry', async () => {
  for (const outcome of ['false', 'reject']) {
    const attempts = []
    const state = changed(commands({ onSave: async (description, hash) => {
      attempts.push({ description, hash })
      if (outcome === 'reject') throw new Error('Synthetic network failure')
      return false // Parent converts a non-OK response, including409, to false.
    } }))
    const baseline = plain(state.baseline), entered = plain(state.values)
    await state.commands.save()
    assert.deepEqual(plain(state.baseline), baseline)
    assert.deepEqual(plain(state.values), entered)
    assert.ok(state.error.includes('entries are preserved'))
    assert.equal(state.saving, false)
    assert.equal(state.submitting.current, false)
    assert.equal(attempts.length, 1)
    assert.equal(attempts[0].hash, firstHash)
  }
})
await check('invalid URLs and ambiguous source lines cannot reach the save callback', async () => {
  for (const overrides of [{}, { description: `${bpoLine}\n${bpoLine}` }, { description: `${labels.bpoDriveUrl}: javascript:alert(1)` }]) {
    const state = commands(overrides)
    state.commands.begin()
    state.values = { ...values, bpoDriveUrl: overrides.description ? replacementUrl : 'javascript:alert(1)' }
    await state.commands.save()
    assert.equal(state.calls.length, 0)
    assert.ok(state.baseline)
    assert.ok(state.error)
    assert.equal(state.saving, false)
  }
})
await check('unchanged links and read-only transition perform no save command', async () => {
  const unchanged = commands()
  unchanged.commands.begin()
  await unchanged.commands.save()
  assert.equal(unchanged.calls.length, 0)
  assert.equal(unchanged.baseline, null)
  const locked = changed(commands())
  locked.readOnly = true
  await locked.commands.save()
  assert.equal(locked.calls.length, 0)
  assert.ok(locked.baseline)
})
await check('submission ref prevents duplicate command writes while one callback is unresolved', async () => {
  let resolveSave
  const attempts = []
  const pending = new Promise(resolve => { resolveSave = resolve })
  const state = changed(commands({ onSave: (description, hash) => { attempts.push({ description, hash }); return pending } }))
  const first = state.commands.save()
  await state.commands.save()
  assert.equal(attempts.length, 1)
  assert.equal(state.submitting.current, true)
  assert.equal(state.saving, true)
  resolveSave(true)
  await first
  assert.equal(state.submitting.current, false)
  assert.equal(state.baseline, null)
})
await check('actual drawer integration is account-only, task-keyed and forwards the captured hash to existing PATCH', () => {
  assert.match(drawerSource, /task\.crm\?\.entity === 'organizations' && <CustomerFolderLinksEditor key=\{task\.id\}/u)
  assert.match(drawerSource, /description=\{displayedDescription\} descriptionHash=\{task\.crm\.descriptionHash\} readOnly=\{readOnly\}/u)
  assert.match(drawerSource, /disabled=\{saving \|\| editingDesc\}/u)
  assert.match(drawerSource, /onSave=\{async \(description, capturedHash\) => Boolean\(await patch\(\{\s*crmDescription: description, crmDescriptionHash: capturedHash,/u)
  assert.match(drawerSource, /<CustomerFolderDescription description=\{displayedDescription\}/u)
  assert.match(editorSource, /value=\{values\.bpoDriveUrl\}/u)
  assert.match(editorSource, /value=\{values\.fractionalCustomerFolderUrl\}/u)
})
await check('manual description editor captures task/hash on open and keeps a failed save draft', () => {
  assert.match(drawerSource, /descriptionEditRef\.current = \{ taskId: task\.id, hash: task\.crm\?\.descriptionHash \?\? null, description: displayedDescription \}/u)
  assert.match(drawerSource, /const baseline = descriptionEditRef\.current/u)
  assert.match(drawerSource, /baseline\.taskId !== task\.id/u)
  assert.match(drawerSource, /crmDescriptionHash: baseline\.hash/u)
  assert.match(drawerSource, /const updated = await patch\([\s\S]*?if \(!updated\) return[\s\S]*?setEditingDesc\(false\)/u)
})
await check('existing route authorization and transactional hash conflict guards are retained', () => {
  const route = read('app_src/app/api/tasks/route.ts'), projection = read('app_src/lib/crm/boardProjection.ts')
  assert.match(route, /requireModuleAccess\(actor, 'crm'\)/u)
  assert.match(route, /resolvePipelineSpaceAccess\(\{ actorEmail: actor, pipelineId: binding\.pipeline_id \}\)/u)
  assert.match(route, /requireResourceEditor\(pipeline\)/u)
  assert.match(route, /expectedDescriptionHash: crmDescriptionHash/u)
  assert.match(route, /error instanceof CrmDescriptionConflictError \? 409 : 400/u)
  assert.match(projection, /FOR UPDATE OF card/u)
  assert.match(projection, /expectedHash !== projectedHash \|\| expectedHash !== currentHash/u)
  assert.match(projection, /await updateCrmDescriptionWithClient\(client,/u)
})
await check('manual folder-link editor/helper remain data-only with separate automation controls', () => {
  assert.doesNotMatch(editorSource + helperSource, /\bfetch\s*\(|XMLHttpRequest|localStorage|sessionStorage|useEffect|window\.location|process\.env|googleapis|matonClient|createFolder|permissions\.create/u)
  assert.ok(editorSource.includes('Folder creation and connection are managed separately'))
  assert.ok(drawerSource.includes('<CustomerFolderAutomation'))
  assert.ok(editorSource.includes('Drive access permissions are unchanged'))
  assert.doesNotMatch(editorSource + helperSource, /fbjdbq3|d_dCUts2_v096LwHXOjc2OJw/u)
})
console.log(`Customer folder UI passed ${checks} actual React/MUI SSR, extracted-command and static integration checks; no signed-in/browser/provider/database proof.`)
