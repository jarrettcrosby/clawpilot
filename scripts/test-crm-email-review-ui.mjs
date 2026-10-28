#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
const requireApp = createRequire(new URL('../app_src/package.json', import.meta.url))
const ts = requireApp('typescript'), React = requireApp('react')
const { renderToStaticMarkup } = requireApp('react-dom/server')
const source = readFileSync('app_src/components/crm/EmailReviewDialog.tsx', 'utf8')
const module = { exports: {} }
vm.runInNewContext(ts.transpileModule(source, { fileName: 'EmailReviewDialog.tsx', compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
} }).outputText, { module, exports: module.exports, AbortController, URLSearchParams, require: name => {
  if (name === '@/components/settings/GoogleAuthSettingsPanel') return { loadGoogleIdentityServices: () => assert.fail('Server render cannot load GIS') }
  return requireApp(name)
} })
const api = module.exports, plain = value => JSON.parse(JSON.stringify(value))
const contacts = [{ id: 'contact-a', reference: 'gc1234567', name: 'Airspace Person', email: 'airspace@example.test', organizationId: 'company-a', company: 'Airspace' },
  { id: 'contact-b', reference: 'gc2345678', name: 'Globus Person', email: 'globus@example.test', organizationId: 'company-b', company: 'Globus' },
  { id: 'reply-only', reference: 'gc3456789', name: 'Quoted Person', email: 'quoted@example.test', organizationId: 'company-b', company: 'Globus' }]
const organizations = [{ id: 'company-a', reference: 'ga1234567', name: 'Airspace' }, { id: 'company-b', reference: 'ga2345678', name: 'Globus' }]
const candidate = { messageId: 'abcdef', threadId: 'aaaaaa', subject: '<script>Untrusted subject</script>', receivedAt: '2026-10-27T10:00:00Z', legacy: false,
  participantEmails: ['airspace@example.test','globus@example.test'], participantContactIds: ['contact-a','contact-b','reply-only'] }
const base = { pipelineId: 'pipeline', connectionId: 'mailbox', decisionKind: 'review', correctionReason: '', participantEmail: '',
  candidates: [candidate], selections: { abcdef: { contactIds: ['contact-a','contact-b'], primaryOrganizationReference: 'ga1234567' } }, contacts, organizations }
let checks = 0
function check(label, run) { run(); checks++; console.log('PASS ' + label) }
check('actual React/MUI fields show both contact/company identities, exact participants and escaped subject', () => {
  const html = renderToStaticMarkup(React.createElement(api.EmailReviewFields, { ...base, disabled: false, onSelection: () => assert.fail('Render cannot apply') }))
  assert.ok(html.includes('Airspace Person') && html.includes('Globus Person') && html.includes('Primary company'))
  assert.ok(html.includes('airspace@example.test') && html.includes('globus@example.test'))
  assert.ok(!html.includes('Quoted Person')); assert.ok(html.includes('&lt;script&gt;')); assert.ok(!html.includes('<script>Untrusted'))
})
check('command is one reviewed Email with both Contacts and chosen primary, without body or token claims', () => {
  const command = plain(api.emailReviewCommand(base))
  assert.deepEqual(command.messageIds, ['abcdef'])
  assert.deepEqual(command.reviewedAssociations, [{ messageId: 'abcdef', threadId: 'aaaaaa', primaryOrganizationReference: 'ga1234567', contactReferences: ['gc1234567','gc2345678'] }])
  assert.ok(!JSON.stringify(command).includes('subject')); assert.ok(!JSON.stringify(command).includes('idToken'))
})
check('unrelated company, absent/header-only mismatch and duplicate Contacts cannot preview', () => {
  for (const selections of [
    { abcdef: { contactIds: ['contact-b'], primaryOrganizationReference: 'ga1234567' } },
    { abcdef: { contactIds: ['reply-only'], primaryOrganizationReference: 'ga2345678' } },
    { abcdef: { contactIds: ['contact-a','contact-a'], primaryOrganizationReference: 'ga1234567' } },
    { abcdef: { contactIds: [], primaryOrganizationReference: 'ga1234567' } },
  ]) assert.equal(api.emailReviewCommand({ ...base, selections }), null)
})
check('correction requires bounded reason and late contact requires an actually selected participant', () => {
  assert.equal(api.emailReviewCommand({ ...base, decisionKind: 'correction' }), null)
  assert.equal(api.emailReviewCommand({ ...base, decisionKind: 'correction', correctionReason: 'x'.repeat(501) }), null)
  assert.equal(api.emailReviewCommand({ ...base, decisionKind: 'correction', correctionReason: '  Wrong original primary  ' }).correctionReason, 'Wrong original primary')
  assert.equal(api.emailReviewCommand({ ...base, decisionKind: 'late-contact', participantEmail: 'quoted@example.test' }), null)
  assert.equal(api.emailReviewCommand({ ...base, decisionKind: 'late-contact', participantEmail: 'GLOBUS@example.test' }).participantEmail, 'globus@example.test')
})
check('legacy selection stays exactly three and all selections are capped at25', () => {
  assert.equal(api.emailReviewCommand({ ...base, candidates: [{ ...candidate, legacy: true }] }), null)
  const candidates = Array.from({ length: 26 }, (_, index) => ({ ...candidate, messageId: index.toString(16) }))
  const selections = Object.fromEntries(candidates.map(message => [message.messageId, base.selections.abcdef]))
  assert.equal(api.emailReviewCommand({ ...base, candidates, selections }), null)
  const legacy = candidates.slice(0, 3).map(message => ({ ...message, legacy: true }))
  assert.equal(api.emailReviewCommand({ ...base, candidates: legacy, selections }).messageIds.length, 3)
})
check('every material review input produces a different preview key and apply sends only the reviewed digest', () => {
  const key = JSON.stringify(api.emailReviewCommand(base))
  for (const input of [{ ...base, connectionId: 'other-mailbox' }, { ...base, pipelineId: 'other-pipeline' },
    { ...base, decisionKind: 'correction', correctionReason: 'Reviewed correction' },
    { ...base, decisionKind: 'late-contact', participantEmail: 'globus@example.test' },
    { ...base, selections: { abcdef: { ...base.selections.abcdef, primaryOrganizationReference: 'ga2345678' } } },
    { ...base, candidates: [{ ...candidate, threadId: 'bbbbbb' }] },
  ]) assert.notEqual(JSON.stringify(api.emailReviewCommand(input)), key)
  assert.match(source, /revision\.current\+\+; setPreview\(null\)/)
  assert.match(source, /preview\.inputKey !== inputKey/)
  assert.match(source, /expectedDigest: reviewed!\.digest/)
  assert.match(source, /capturedRevision !== revision\.current/)
})
check('GIS reuses existing loader/types and sends signed token only, never supplied subjects', () => {
  assert.match(source, /import \{ loadGoogleIdentityServices \} from '@\/components\/settings\/GoogleAuthSettingsPanel'/)
  assert.doesNotMatch(source, /declare global|providerAccountId|googleSubject/)
  assert.match(source, /JSON\.stringify\(\{ pipelineId, connectionId, idToken: response\.credential \}\)/)
  assert.match(source, /idToken: response\.credential/)
  assert.doesNotMatch(source, /localStorage|sessionStorage|console\./)
})
check('real CRM mount is owner-only and communicates finite/no-audience-expansion scope', () => {
  const crm = readFileSync('app_src/components/crm/CrmSection.tsx', 'utf8')
  assert.match(crm, /pipeline\?\.accessRole === 'owner'[\s\S]*?<EmailReviewDialog/)
  assert.match(crm, /contacts=\{contacts\} organizations=\{organizations\}/)
  assert.ok(source.includes('does not add pipeline readers or make a rule for future messages'))
  assert.ok(source.includes('fixed three messages')); assert.ok(source.includes('Contacts keep their own company'))
})
console.log(`Email review UI passed ${checks} actual React/MUI and command/source checks; no live calls.`)
