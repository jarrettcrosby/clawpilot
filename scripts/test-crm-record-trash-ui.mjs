#!/usr/bin/env node
// Real CRM React/MUI controls with synthetic HTTP responses.
// No live account, CRM deletion, email recovery, database, or provider calls.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const root = process.cwd()
const requireApp = createRequire(join(root, 'app_src/package.json'))
const { chromium, expect } = requireApp('@playwright/test')
const webpack = requireApp('next/dist/compiled/webpack/webpack').webpack
const output = await mkdtemp(join(tmpdir(), 'clawpilot-crm-trash-ui-'))
let server, browser
try {
  await new Promise((done, reject) => {
    const compiler = webpack({ mode: 'development', devtool: false, cache: false,
      entry: join(root, 'scripts/fixtures/crm-feedback-ui.tsx'), output: { path: output, filename: 'fixture.js' },
      resolve: { extensions: ['.tsx', '.ts', '.js', '.mjs', '.json'], modules: [join(root, 'app_src/node_modules'), 'node_modules'], alias: { '@': join(root, 'app_src') } },
      module: { rules: [{ test: /\.tsx?$/, exclude: /node_modules/, use: join(root, 'scripts/lib/shortlink-ui-ts-loader.cjs') }] },
    })
    compiler.run((error, stats) => compiler.close(() => error || stats?.hasErrors() ? reject(error || new Error(stats.toString({ all: false, errors: true }))) : done()))
  })
  const bundle = await readFile(join(output, 'fixture.js'))
  server = createServer((req, res) => {
    res.setHeader('Content-Type', req.url === '/fixture.js' ? 'text/javascript' : 'text/html')
    res.end(req.url === '/fixture.js' ? bundle : '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script src="/fixture.js"></script>')
  })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  const origin = `http://127.0.0.1:${server.address().port}`
  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } })
  await page.addInitScript(() => { window.process = { env: { NODE_ENV: 'development' } } })
  const errors = [], mutations = []
  page.on('pageerror', error => errors.push(error.message))
  const pipelineId = '00000000-0000-4000-8000-000000000001'
  const external = { id: '00000000-0000-4000-8000-000000000002', referenceCode: 'ga1111111', name: 'Suburbia example', accountType: 'Supplier', relationshipType: 'customer', syncStatus: 'synced' }
  const unrelated = { ...external, id: '00000000-0000-4000-8000-000000000003', referenceCode: 'ga2222222', name: 'BPO example', accountType: 'Customer' }
  const contact = { id: '00000000-0000-4000-8000-000000000004', referenceCode: 'gc1111111', organizationId: external.id, fullName: 'Customer contact', syncStatus: 'synced' }
  let organizations = [external, unrelated], contacts = [contact], accessRole = 'editor', failArchive = false
  const mailbox = { connectionId: 'fixture-mailbox', accountEmail: 'owner@example.test', verified: true }
  const participantContacts = [
    { id: contact.id, reference: contact.referenceCode, name: 'Airspace participant', email: 'airspace@example.test',
      organizationId: external.id, organizationReference: external.referenceCode, company: 'Airspace fixture' },
    { id: '00000000-0000-4000-8000-000000000005', reference: 'gc2222222', name: 'Globus participant', email: 'globus@example.test',
      organizationId: unrelated.id, organizationReference: unrelated.referenceCode, company: 'Globus fixture' },
  ]
  const reviewedMessage = { messageId: 'abcdef', threadId: 'abcdef01', subject: 'Synthetic reviewed email',
    receivedAt: '2026-11-05T12:00:00.000Z', legacy: false, participantContacts,
    participantContactIds: participantContacts.map(item => item.id), participantEmails: participantContacts.map(item => item.email) }
  const reviewReads = [], previewRequests = [], unexpectedReviewRequests = []
  let testingEmailReview = false, reviewDialogRequested = false
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url())
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
    if (testingEmailReview) {
      const method = request.method()
      if (url.pathname === '/api/crm/mailbox-identity' && method === 'GET' && url.searchParams.get('pipelineId') === pipelineId) {
        reviewReads.push('mailbox')
        return json({ ok: true, mailboxes: [mailbox] })
      }
      if (url.pathname === '/api/crm/email-review-candidates' && method === 'GET'
        && url.searchParams.get('pipelineId') === pipelineId && url.searchParams.get('connectionId') === mailbox.connectionId) {
        reviewReads.push('candidates')
        return json({ ok: true, pipelineId, connectionId: mailbox.connectionId, messages: [reviewedMessage] })
      }
      if (url.pathname === '/api/crm/email-recovery' && method === 'POST' && request.postDataJSON()?.apply === false) {
        previewRequests.push(request.postDataJSON())
        return json({ ok: true, recovery: { applied: false, digest: 'a'.repeat(64), messages: [{
          messageId: reviewedMessage.messageId, subject: reviewedMessage.subject,
          organizationReferences: [external.referenceCode, unrelated.referenceCode],
          contactReferences: participantContacts.map(item => item.reference),
        }] } })
      }
      if (method !== 'GET' || (url.pathname === '/api/crm'
        && ['contacts', 'organizations'].includes(url.searchParams.get('entity'))
        && (reviewDialogRequested || !url.searchParams.has('query')))
        || /^\/api\/crm\/(?:mailbox-identity|email-review-candidates|email-recovery)$/.test(url.pathname)) {
        unexpectedReviewRequests.push(`${method} ${url.pathname}${url.search}`)
        return json({ ok: false, error: 'Unexpected email-review request in browser fixture' }, 400)
      }
    }
    if (url.pathname === '/api/workspaces') return json({ ok: true, selectedPipelineId: pipelineId,
      pipelines: [{ id: pipelineId, name: 'Customer pipeline', ownerEmail: 'owner@example.test', accessRole }] })
    if (url.pathname === '/api/crm') {
      if (request.method() === 'PATCH') {
        const body = request.postDataJSON(); mutations.push(body)
        if (failArchive) return json({ ok: false, error: 'This record cannot be deleted yet. Try again.' }, 409)
        assert.equal(body.action, 'archive')
        if (body.entity === 'organizations') organizations = organizations.filter(record => record.id !== body.id)
        else if (body.entity === 'contacts') contacts = contacts.filter(record => record.id !== body.id)
        else assert.fail('Only selected organization/contact is in this fixture')
        return json({ ok: true, result: { archived: true, suiteCrmDeleteQueued: body.entity === 'organizations' } })
      }
      return json({ ok: true,
        records: url.searchParams.get('entity') === 'organizations' ? organizations : url.searchParams.get('entity') === 'contacts' ? contacts : [],
        pipeline: { id: pipelineId, name: 'Customer pipeline', accessRole },
      })
    }
    return json({ ok: true })
  })
  const openOrganization = async () => {
    await page.goto(origin)
    await page.getByText(external.name, { exact: true }).click()
  }
  const openContact = async () => {
    await page.goto(origin)
    await page.getByRole('tab', { name: 'Contacts', exact: true }).click()
    await page.getByText(contact.fullName, { exact: true }).click()
  }
  // Fresh owner page: never open a record editor to hydrate directory choices.
  accessRole = 'owner'; testingEmailReview = true
  await page.goto(origin)
  await page.getByRole('tab', { name: 'Interactions', exact: true }).click()
  reviewDialogRequested = true
  await page.getByRole('button', { name: 'Review email', exact: true }).click()
  const review = page.getByRole('dialog', { name: 'Review selected Gmail messages' })
  const preview = review.getByRole('button', { name: 'Preview selected messages', exact: true })
  await expect(review.getByRole('button', { name: 'Apply reviewed selection', exact: true })).toBeDisabled()
  await review.getByRole('checkbox', { name: reviewedMessage.subject, exact: true }).check()
  await expect(preview).toBeDisabled()
  await review.getByRole('combobox', { name: 'Actual participant contacts', exact: true }).click()
  for (const participant of participantContacts) {
    await page.getByRole('option', { name: `${participant.name} — ${participant.email} — ${participant.company}`, exact: true }).click()
  }
  await expect(preview).toBeDisabled()
  await review.getByRole('combobox', { name: /^Primary company/ }).click()
  await page.getByRole('option', { name: `Globus fixture · ${unrelated.referenceCode}`, exact: true }).click()
  await expect(preview).toBeEnabled()
  await preview.click()
  await expect(review.getByText('Reviewed preview — 1 selected messages', { exact: true })).toBeVisible()
  await expect(review.getByText(`${reviewedMessage.subject} · Companies: ${external.referenceCode}, ${unrelated.referenceCode} · Contacts: ${participantContacts.map(item => item.reference).join(', ')}`, { exact: true })).toBeVisible()
  assert.deepEqual(reviewReads, ['mailbox', 'candidates'])
  assert.deepEqual(previewRequests, [{ pipelineId, connectionId: mailbox.connectionId, messageIds: [reviewedMessage.messageId],
    reviewedAssociations: [{ messageId: reviewedMessage.messageId, threadId: reviewedMessage.threadId,
      primaryOrganizationReference: unrelated.referenceCode, contactReferences: participantContacts.map(item => item.reference) }],
    decisionKind: 'review', apply: false }])
  await review.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(review).toHaveCount(0)
  assert.deepEqual(unexpectedReviewRequests, [], 'Review neither fetches editor options nor applies a change')
  assert.deepEqual(mutations, [])
  console.log('PASS fresh-owner CRM email review: exact two-company picker and Globus primary preview without directory lookup or Apply; HTTP mocked')
  testingEmailReview = false; accessRole = 'editor'
  for(const mode of ['light','dark']){
    await page.goto(`${origin}/?mode=${mode}`)
    await expect(page.getByRole('columnheader',{name:'Type',exact:true})).toBeVisible()
    await expect(page.getByRole('columnheader',{name:'Organization role',exact:true})).toBeVisible()
    const supplier=page.getByRole('row').filter({has:page.getByText(external.referenceCode,{exact:true})})
    await expect(supplier.getByRole('cell',{name:'Supplier',exact:true})).toBeVisible()
    await expect(supplier.getByRole('cell',{name:'External organization',exact:true})).toBeVisible()
    await expect(supplier.getByRole('cell',{name:'customer',exact:true})).toHaveCount(0)
  }
  await openOrganization()
  // MUI includes the selected option in the combobox's accessible name.
  try{await expect(page.getByRole('combobox',{name:'Type Supplier',exact:true})).toHaveText('Supplier')}
  catch(error){
    console.error('CRM_TYPE_CONTROLS='+JSON.stringify(await page.getByRole('combobox',{includeHidden:true}).evaluateAll(elements=>elements.map(element=>({
      text:element.textContent,label:element.getAttribute('aria-label'),labelledBy:element.getAttribute('aria-labelledby'),
      labels:(element.getAttribute('aria-labelledby')||'').split(' ').map(id=>document.getElementById(id)?.textContent||'')})))))
    throw error
  }
  await page.getByRole('button', { name: 'Move to Trash', exact: true }).click()
  const confirmation = page.getByRole('dialog', { name: 'Move CRM record to Trash?' })
  await expect(confirmation.getByText(external.name, { exact: true })).toBeVisible()
  await expect(confirmation.getByText(`Global ID: ${external.referenceCode}`, { exact: true })).toBeVisible()
  await expect(confirmation).toContainText('queue deletion of its linked SuiteCRM record')
  await expect(confirmation).toContainText('Activity history is kept')
  await expect(confirmation).toContainText('Other organizations, contacts, and their records will not be deleted')
  await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click()
  assert.equal(mutations.length, 0, 'Cancel never submits deletion')
  await page.getByRole('button', { name: 'Move to Trash', exact: true }).click()
  failArchive = true
  await confirmation.getByRole('button', { name: 'Move to Trash', exact: true }).click()
  await expect(confirmation.getByRole('alert')).toContainText('This record cannot be deleted yet')
  await expect(confirmation.getByText(`Global ID: ${external.referenceCode}`, { exact: true })).toBeVisible()
  failArchive = false
  await confirmation.getByRole('button', { name: 'Move to Trash', exact: true }).click()
  await expect(confirmation).toHaveCount(0)
  await expect(page.getByText(external.referenceCode, { exact: true })).toHaveCount(0)
  await expect(page.getByText(unrelated.referenceCode, { exact: true })).toBeVisible()
  await expect(page.getByText('Organization moved to Trash in ClawPilot; SuiteCRM deletion queued. Activity history is preserved.', { exact: true })).toBeVisible()
  assert.deepEqual(mutations, Array.from({ length: 2 }, () => ({ action: 'archive', entity: 'organizations', id: external.id })))
  assert.equal(contacts.length, 1, 'UI request does not include a contact cascade')
  await openContact()
  await page.getByRole('button', { name: 'Move to Trash', exact: true }).click()
  await expect(confirmation.getByText(`Global ID: ${contact.referenceCode}`, { exact: true })).toBeVisible()
  await confirmation.getByRole('button', { name: 'Move to Trash', exact: true }).click()
  await expect(confirmation).toHaveCount(0)
  assert.deepEqual(mutations.at(-1), { action: 'archive', entity: 'contacts', id: contact.id })
  await expect(page.getByText('Contact removed from active CRM records. Activity history is preserved.', { exact: true })).toBeVisible()

  // Managed identities and viewers never receive the destructive control.
  for (const protection of [{ workspaceOrganizationId: 'managed-workspace' }, { relationshipType: 'workspace_root' }, { relationshipType: 'workspace_member' }]) {
    organizations = [{ ...external, ...protection }, unrelated]
    await openOrganization()
    await expect(page.getByRole('button', { name: 'Move to Trash', exact: true })).toHaveCount(0)
  }
  organizations = [external, unrelated]
  for (const protection of [{ pipelineUser: true }, { appUserEmail: 'member@example.test' }]) {
    contacts = [{ ...contact, ...protection }]
    await openContact()
    await expect(page.getByRole('button', { name: 'Move to Trash', exact: true })).toHaveCount(0)
  }
  contacts = [contact]; accessRole = 'viewer'
  await openOrganization()
  await expect(page.getByRole('dialog', { name: 'View Organization' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Move to Trash', exact: true })).toHaveCount(0)
  await openContact()
  await expect(page.getByRole('dialog', { name: 'View Contact' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Move to Trash', exact: true })).toHaveCount(0)
  assert.equal(mutations.length, 3, 'Protected and viewer states issue no additional mutation')

  accessRole = 'editor'
  await page.setViewportSize({ width: 390, height: 844 })
  await openContact()
  await page.getByRole('button', { name: 'Move to Trash', exact: true }).click()
  await expect(confirmation).toBeVisible()
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Mobile confirmation fits viewport')
  assert.deepEqual(errors, [])
  console.log('PASS CRM supplier Type versus internal organization role in light/dark table and drawer; HTTP mocked')
  console.log('PASS CRM Trash UI: exact confirmation, cancel/failure/retry, queued status, separate account/contact commands, protected identities, viewers, mobile; HTTP mocked')
} finally {
  await browser?.close()
  if (server) await new Promise(done => server.close(done))
  await rm(output, { recursive: true, force: true })
}
