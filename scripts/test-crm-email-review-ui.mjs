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
const contacts = [{ id: 'contact-a', reference: 'gc1234567', name: 'Airspace Person', email: 'airspace@example.test', organizationId: 'company-a', organizationReference: 'ga1234567', company: 'Airspace' },
  { id: 'contact-b', reference: 'gc2345678', name: 'Globus Person', email: 'globus@example.test', organizationId: 'company-b', organizationReference: 'ga2345678', company: 'Globus' },
  { id: 'reply-only', reference: 'gc3456789', name: 'Quoted Person', email: 'quoted@example.test', organizationId: 'company-b', organizationReference: 'ga2345678', company: 'Globus' }]
const candidate = { messageId: 'abcdef', threadId: 'aaaaaa', subject: '<script>Untrusted subject</script>', receivedAt: '2026-10-27T10:00:00Z', legacy: false,
  participantEmails: ['airspace@example.test','globus@example.test'], participantContactIds: ['contact-a','contact-b','reply-only'], participantContacts: contacts }
const base = { pipelineId: 'pipeline', connectionId: 'mailbox', decisionKind: 'review', correctionReason: '', participantEmail: '',
  candidates: [candidate], selections: { abcdef: { contactIds: ['contact-a','contact-b'], primaryOrganizationReference: 'ga1234567' } } }
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
check('a contact supplied by a different candidate cannot be used for this message', () => {
  const candidates = [{ ...candidate, participantContacts: [contacts[0]] },
    { ...candidate, messageId: 'abcdef2', participantContacts: [contacts[1]] }]
  assert.equal(api.emailReviewCommand({ ...base, candidates }), null)
  const result = api.emailReviewCommand({ ...base, candidates, selections: {
    abcdef: { contactIds: ['contact-a'], primaryOrganizationReference: 'ga1234567' },
    abcdef2: { contactIds: ['contact-b'], primaryOrganizationReference: 'ga2345678' },
  } })
  assert.deepEqual(plain(result.reviewedAssociations.map(row => row.contactReferences)), [['gc1234567'], ['gc2345678']])
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
check('Casey history is an explicit complete pair, never the default review or a mixed legacy batch', () => {
  const candidates = ['1a18e03ea586cd7e','1a18f01749eb87a6'].map(messageId => ({ ...candidate,
    messageId, legacy: true, admissionScope: 'casey-reviewed-two-v1' }))
  const selections = Object.fromEntries(candidates.map(message => [message.messageId, base.selections.abcdef]))
  const input = { ...base, decisionKind: 'casey-history', candidates, selections }
  const command = plain(api.emailReviewCommand(input))
  assert.equal(command.decisionKind, 'review'); assert.equal(command.admissionScope, 'casey-reviewed-two-v1')
  assert.deepEqual(command.messageIds, candidates.map(message => message.messageId))
  assert.equal(command.reviewedAssociations.length, 2)
  assert.ok(!JSON.stringify(command).includes('legacyAdoption'))
  for (const changed of [
    { candidates: candidates.slice(0, 1) }, { selections: { [candidates[0].messageId]: base.selections.abcdef } },
    { candidates: [candidates[0], candidates[0]] }, { candidates: [...candidates, candidate] },
    { candidates: [{ ...candidates[0], admissionScope: undefined }, candidates[1]] },
    { candidates: [{ ...candidates[0], legacy: false }, candidates[1]] },
    { decisionKind: 'review' }, { decisionKind: 'correction', correctionReason: 'Not a historical admission' },
    { decisionKind: 'late-contact', participantEmail: 'globus@example.test' },
  ]) assert.equal(api.emailReviewCommand({ ...input, ...changed }), null)
  const ordinary = api.emailReviewCommand({ ...input, decisionKind: 'review',
    candidates: candidates.map(({ admissionScope, ...message }) => ({ ...message, legacy: false })) })
  assert.notEqual(JSON.stringify(command), JSON.stringify(ordinary), 'Scope is part of the existing reviewed input key')
  const html = renderToStaticMarkup(React.createElement(api.EmailReviewFields,
    { ...input, disabled: false, onSelection: () => assert.fail('Render cannot apply') }))
  assert.ok(html.includes('Separate two-message Casey review'))
  assert.ok(!html.includes('Fixed three-message legacy review'))
  assert.match(source, /decisionKind === 'casey-history' \? \{ admissionScope: 'casey-reviewed-two-v1' \} : \{\}/)
  assert.match(source, /body\.admissionScope !== 'casey-reviewed-two-v1'/)
  assert.match(source, /body\.messages\.length !== 2/)
  assert.match(source, /Original historical mailbox provenance remains unknown/)
  assert.match(source, /caseyAvailable \|\| decisionKind === 'casey-history'/)
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
  assert.match(source, /: \{ pipelineId, connectionId, idToken: response\.credential \}/)
  assert.match(source, /body: JSON\.stringify\(request\)/)
  assert.match(source, /idToken: response\.credential/)
  assert.doesNotMatch(source, /localStorage|sessionStorage|console\./)
})
check('address repair previews safe exact labels, bounded expiry and no unreviewed fields', () => {
  const now = Date.parse('2026-11-04T12:00:00.000Z')
  const repair = { required: true, oldAccountEmail: 'operator@old.example', newAccountEmail: 'operator@new.example',
    expectedDigest: 'a'.repeat(64), expiresAt: new Date(now + 5 * 60_000).toISOString() }
  assert.equal(api.validMailboxLabelPreview(repair, now), true)
  assert.equal(api.validMailboxLabelPreview({ ...repair, required: false, newAccountEmail: repair.oldAccountEmail }, now), true)
  assert.equal(api.validMailboxLabelPreview({ ...repair, oldAccountEmail: '' }, now), true)
  assert.equal(api.validMailboxLabelPreview({ ...repair, oldAccountEmail: ' OPERATOR@NEW.EXAMPLE ', required: false }, now), true)
  for (const invalid of [null, [], {}, { ...repair, expectedDigest: 'not-reviewed' },
    { ...repair, expiresAt: new Date(now).toISOString() }, { ...repair, expiresAt: new Date(now + 6 * 60_000).toISOString() },
    { ...repair, newAccountEmail: '<script>bad</script>' }, { ...repair, required: false },
    { ...repair, idToken: 'must-never-be-render-state' }, { ...repair, arbitraryClaim: 'unreviewed' }]) {
    assert.equal(api.validMailboxLabelPreview(invalid, now), false)
  }
})
check('real React repair confirmation distinguishes address-only update from login and historical proof', () => {
  const preview = { required: true, oldAccountEmail: 'operator@old.example', newAccountEmail: 'operator@new.example',
    expectedDigest: 'a'.repeat(64), expiresAt: '2026-11-04T12:05:00.000Z' }
  const render = busy => renderToStaticMarkup(React.createElement(api.MailboxLabelRepairFields,
    { preview, busy, onConfirm: () => assert.fail('Render cannot confirm'), onCancel: () => assert.fail('Render cannot cancel') }))
  const html = render(false)
  assert.ok(html.includes(preview.oldAccountEmail) && html.includes(preview.newAccountEmail))
  assert.ok(html.includes('Confirm address update') && html.includes('Cancel address review'))
  assert.ok(html.includes('does not change your ClawPilot login') && html.includes('verify historical email records'))
  assert.ok(!html.includes(preview.expectedDigest) && !html.includes('idToken'))
  assert.ok((render(true).match(/disabled=""/g) || []).length >= 2)
})
check('stale verified mailboxes remain reviewable but repair never auto-applies or reuses recovery preview', () => {
  assert.match(source, /Review saved mailbox address/)
  assert.match(source, /mailbox\?\.verified && !repairingMailbox/)
  assert.match(source, /action: 'preview-label-repair'/)
  assert.match(source, /action: 'apply-label-repair'[\s\S]*expectedDigest: proof\.expectedDigest, expiresAt: proof\.expiresAt/)
  assert.match(source, /onConfirm=\{\(\) => \{ void applyMailboxLabelRepair\(\) \}\}/)
  assert.match(source, /controller\.signal\.aborted \|\| activeRequest\.current !== controller/)
  assert.match(source, /proof\.pipelineId !== pipelineId \|\| proof\.connectionId !== connectionId/)
  assert.match(source, /labelProof\.current = null; setLabelPreview\(null\)/)
  assert.match(source, /Math\.min\(5 \* 60_000, Date\.parse\(labelPreview\.expiresAt\) - Date\.now\(\)\)/)
  assert.match(source, /clearMailboxRepair\(\); invalidate\(\); setOpen\(false\)/)
  assert.match(source, /clearMailboxRepair\(\); invalidate\(\); setConnectionId/)
  assert.match(source, /body\.accountEmail !== reviewed\.newAccountEmail/)
  assert.match(source, /invalidate\(\); const controller = begin\(\)/)
  assert.doesNotMatch(source, /localStorage|sessionStorage|console\./)
})
check('real CRM mount is owner-only and communicates finite/no-audience-expansion scope', () => {
  const crm = readFileSync('app_src/components/crm/CrmSection.tsx', 'utf8')
  assert.match(crm, /pipeline\?\.accessRole === 'owner'[\s\S]*?<EmailReviewDialog/)
  assert.doesNotMatch(crm.match(/<EmailReviewDialog[\s\S]*?\/>/)?.[0] || '', /contacts=|organizations=/)
  assert.match(source, /body\.pipelineId !== pipelineId \|\| body\.connectionId !== selectedConnection/)
  assert.ok(source.includes('does not add pipeline readers or make a rule for future messages'))
  assert.ok(source.includes('fixed three messages')); assert.ok(source.includes('Contacts keep their own company'))
})
{
  const parsed = ts.createSourceFile('EmailReviewDialog.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  let declaration
  function find(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'applyMailboxLabelRepair') declaration = node
    ts.forEachChild(node, find)
  }
  find(parsed); assert.ok(declaration, 'Exercise the actual nested apply function')
  for (const outcome of ['expired-locally', 'superseded', 'aborted']) {
    const proof = { pipelineId: 'pipeline', connectionId: 'connection', idToken: 'synthetic-in-memory-proof',
      expectedDigest: 'a'.repeat(64), expiresAt: new Date(Date.now() + 60_000).toISOString() }
    const controller = new AbortController(), activeRequest = { current: controller }, labelProof = { current: proof }
    const updates = [], errors = ['Review expired while request was in flight']; let respond
    const context = { Date, pending: { current: false }, labelProof, activeRequest,
      labelPreview: { ...proof, newAccountEmail: 'current@example.test' }, repairingMailbox: true,
      pipelineId: proof.pipelineId, connectionId: proof.connectionId,
      invalidate: () => {}, begin: () => controller, finish: () => {},
      requestJson: () => new Promise(resolve => { respond = resolve }),
      clearMailboxRepair: () => { labelProof.current = null },
      setMailboxes: update => updates.push(update([{ connectionId: proof.connectionId, verified: false }])),
      setNotice: value => updates.push(value), setError: value => errors.push(value), setLabelPreview: () => {},
    }
    vm.runInNewContext(ts.transpileModule(`${declaration.getText(parsed)}\nglobalThis.apply = applyMailboxLabelRepair`, {
      compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 },
    }).outputText, context)
    const applying = context.apply()
    labelProof.current = null // The real expiry callback removes retained proof.
    if (outcome === 'superseded') activeRequest.current = new AbortController()
    if (outcome === 'aborted') controller.abort()
    respond({ ok: true, accountEmail: 'current@example.test', verified: true, connectionLabelUpdated: true })
    await applying
    if (outcome === 'expired-locally') {
      assert.equal(updates[0][0].accountEmail, 'current@example.test')
      assert.equal(updates[0][0].verified, true)
      assert.match(updates[1], /address is updated/)
      assert.equal(errors.at(-1), '')
    } else assert.equal(updates.length, 0, 'A response from another request/scope cannot update this screen')
    assert.equal(labelProof.current, null, 'Acknowledging a response does not retain expired credentials')
  }
  checks++; console.log('PASS actual apply acknowledges a confirmed in-flight command after local expiry, never a superseded scope')
}
console.log(`Email review UI passed ${checks} actual React/MUI and command/source checks; no live calls.`)
