#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'

// Render the real component with synthetic hook/provider state only. No server,
// credentials, browser, provider requests, or persisted application data.
const require = createRequire(new URL('../app_src/package.json', import.meta.url))
const ts = require('typescript')
const fileName = 'app_src/components/settings/MatonIntegrationPanel.tsx'
const source = readFileSync(new URL(`../${fileName}`, import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
    jsx: ts.JsxEmit.ReactJSX,
    esModuleInterop: true,
  },
  fileName,
}).outputText

const primaryConnectionId = 'synthetic-gmail-primary'
const otherConnectionId = 'synthetic-gmail-other'
const primaryEmail = 'operator@business.example.test'
const otherEmail = 'operator@other.example.test'
const connection = (connectionId, email, selectedForUser = false) => ({
  connectionId, name: 'Synthetic Gmail', app: 'google-mail', accountEmail: email,
  selectedForUser, selectionError: '', calendars: [],
  gmailSendAsIdentities: [{ email, verificationStatus: 'accepted', isPrimary: true, isDefault: true }],
})
const primaryConnection = connection(primaryConnectionId, primaryEmail, true)
const otherConnection = connection(otherConnectionId, otherEmail)

function render({ bindingStatus, failed = '', selectionError = '', pending = false, selectedOther = false } = {}) {
  const binding = bindingStatus ? {
    app: 'google-mail', connectionId: primaryConnectionId, accountEmail: primaryEmail,
    identityEmail: primaryEmail, calendarId: null, status: bindingStatus, verifiedAt: null,
  } : null
  const communication = {
    canManage: true, organizationId: 'synthetic-organization',
    bindings: binding ? [binding] : [],
    availableConnections: [{ ...primaryConnection, selectionError }, otherConnection],
  }
  const ids = { 'google-mail': selectedOther ? otherConnectionId : primaryConnectionId, 'google-calendar': '' }
  const stateValues = new Map([
    [0, { configured: true, loginEmail: '', keyLastFour: '', platformCredentialAvailable: false, connections: [], updatedAt: null }],
    [1, communication], [2, false], [4, failed ? { 'google-mail': failed } : {}], [5, ids],
    [6, selectedOther ? otherEmail : primaryEmail], [11, false],
    [12, pending ? 'bind-communication:google-mail' : null],
  ])
  const updates = new Map()
  const requests = []
  let hookIndex = 0
  const element = (type, props) => ({ type, props: props || {} })
  const module = { exports: {} }
  vm.runInNewContext(compiled, {
    module, exports: module.exports,
    fetch: async (url, init) => {
      requests.push({ url, init })
      return { ok: true, json: async () => ({ ok: true, communication }) }
    },
    require(name) {
      if (name === 'react/jsx-runtime') return { jsx: element, jsxs: element, Fragment: 'Fragment' }
      if (name === 'react') return {
        useState(initial) {
          const index = hookIndex++
          return [stateValues.has(index) ? stateValues.get(index) : initial, (value) => updates.set(index, value)]
        },
        useEffect() {},
        useCallback: (callback) => callback,
        useRef: (initial) => ({ current: { ...initial, ...ids } }),
      }
      if (name === '@/components/timezone/UserDateTimeProvider') return { useUserDateTime: () => ({}) }
      if (name === '@/lib/userDateTime') return { formatUserDateTime: () => null }
      if (name.startsWith('@mui/') || name === '@/components/settings/IntegrationSetupJourney') {
        return name.split('/').at(-1)
      }
      throw new Error(`Unexpected component dependency: ${name}`)
    },
  }, { filename: fileName })
  const tree = module.exports.default({ isOwner: true, embedded: true })
  assert.equal(hookIndex, 16, 'Update this fixture deliberately if the component hook state changes')
  const nodes = []
  function visit(node) {
    if (Array.isArray(node)) return node.forEach(visit)
    if (!node || typeof node !== 'object') return
    nodes.push(node)
    visit(node.props?.children)
  }
  visit(tree)
  return { nodes, requests, updates }
}

const text = (node) => Array.isArray(node)
  ? node.map(text).join('')
  : node && typeof node === 'object' ? text(node.props?.children) : node == null || typeof node === 'boolean' ? '' : String(node)
const chip = (rendered, label) => rendered.nodes.find((node) => node.type === 'Chip' && node.props.label === label)
const field = (rendered, label) => rendered.nodes.find((node) => node.type === 'TextField' && node.props.label === label)
const button = (rendered, label) => rendered.nodes.find((node) => node.type === 'Button' && text(node) === label)

const unsaved = render()
assert.equal(unsaved.nodes.filter((node) => node.type === 'Chip' && node.props.label === 'No organization default').length, 2)
assert.equal(field(unsaved, 'Gmail connection').props.value, primaryConnectionId)
assert.equal(field(unsaved, 'Gmail send-as address').props.value, primaryEmail)
assert.ok(!chip(unsaved, 'Not connected'), 'An available Gmail account without an organization default must not appear disconnected')
assert.ok(unsaved.nodes.some((node) => node.type === 'Typography'
  && text(node).includes('Selections are not saved until you use the Save default button below.')))
assert.ok(button(unsaved, 'Save Gmail default'))
assert.ok(button(unsaved, 'Save Google Calendar default'))
field(unsaved, 'Gmail connection').props.onChange({ target: { value: otherConnectionId } })
assert.equal(unsaved.requests.length, 0, 'Changing the account selection must not bind or reconfigure a connection')
assert.equal(unsaved.updates.get(5)['google-mail'], otherConnectionId)
assert.equal(unsaved.updates.get(6), otherEmail)

const saved = render({ bindingStatus: 'active' })
assert.equal(chip(saved, 'Organization default').props.color, 'success')
assert.ok(!chip(saved, 'Active'), 'Saved binding status must name the organization default rather than imply provider health')
assert.ok(chip(render({ bindingStatus: 'disabled' }), 'Disabled'))
assert.ok(chip(render({ failed: 'Synthetic save failure' }), 'Failed'))
assert.ok(chip(render({ selectionError: 'Synthetic sender-list failure' }), 'Failed'))
assert.ok(chip(render({ pending: true }), 'Pending'))

const reviewedSelection = render({ selectedOther: true })
button(reviewedSelection, 'Save Gmail default').props.onClick()
await new Promise((resolve) => setImmediate(resolve))
assert.equal(reviewedSelection.requests.length, 1, 'Only the explicit Save action may persist the organization default')
assert.equal(reviewedSelection.requests[0].url, '/api/integrations/communications')
assert.equal(reviewedSelection.requests[0].init.method, 'PATCH')
assert.deepEqual(JSON.parse(reviewedSelection.requests[0].init.body), {
  action: 'bind', app: 'google-mail', connectionId: otherConnectionId, gmailSendAsEmail: otherEmail,
})
assert.equal(reviewedSelection.updates.get(13), 'Gmail organization default saved.')

console.log('Maton organization-default UI passed: synthetic rendering, unchanged explicit-save behavior, no live calls.')
