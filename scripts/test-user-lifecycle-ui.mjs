#!/usr/bin/env node
// Real React/MUI UI with isolated API mocks; no messages, user mutations, or deployment.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const root = process.cwd()
const require = createRequire(join(root, 'app_src/package.json'))
const { chromium, expect } = require('@playwright/test')
const webpack = require('next/dist/compiled/webpack/webpack').webpack
const output = await mkdtemp(join(tmpdir(), 'clawpilot-user-lifecycle-ui-'))
let browser, server
try {
  await new Promise((done, reject) => {
    const compiler = webpack({ mode: 'development', devtool: false, cache: false,
      entry: join(root, 'scripts/fixtures/user-lifecycle-ui.tsx'), output: { path: output, filename: 'fixture.js' },
      resolve: { extensions: ['.tsx', '.ts', '.js', '.mjs', '.json'], modules: [join(root, 'app_src/node_modules'), 'node_modules'], alias: { '@': join(root, 'app_src') } },
      module: { rules: [{ test: /\.tsx?$/, exclude: /node_modules/, use: join(root, 'scripts/lib/shortlink-ui-ts-loader.cjs') }] },
    })
    compiler.run((error, stats) => compiler.close(() => error || stats?.hasErrors() ? reject(error || new Error(stats.toString({ all: false, errors: true }))) : done()))
  })
  const bundle = await readFile(join(output, 'fixture.js'))
  server = createServer((req, res) => { res.setHeader('Content-Type', req.url === '/fixture.js' ? 'text/javascript' : 'text/html'); res.end(req.url === '/fixture.js' ? bundle : '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script src="/fixture.js"></script>') })
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } })
  await page.addInitScript(() => { window.process = { env: { NODE_ENV: 'development' } } })
  const errors = []
  const mutations = []
  page.on('pageerror', (error) => { errors.push(error.message); console.error('UI runtime:', error.message) })
  const origin = `http://127.0.0.1:${server.address().port}`
  let failVerification = false, trashed = false, changeEnabled = false, employeeEnabled = true, failEmployee = false
  let identitySync = 'verified', linkExistingOnSync=false
  let pendingAccessChange = null, holdNextUserChange = false, holdResume = false, userStatus = 'active'
  let pendingSharingChange=null,holdNextShare=false,holdSharingResume=false,sharedRole='viewer'
  let showRootControls=false,rootEmployeeEnabled=false,releaseRootSave=null
  const owner = { email: 'owner@example.test', role: 'owner', status: 'active', displayName: 'Owner', organizationId: 'org-a', organizationName: 'Org A', permissions: {}, timezone: 'America/New_York', locale: 'en-US', crmUserEnabled: true, referenceCode: 'gu1234567' }
  const member = { ...owner, email: 'member@example.test', role: 'member', displayName: 'Member', referenceCode: 'gu0123456789av', suiteCrmUserId: 'native-member', suiteCrmUsername: 'gu0123456789av' }
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
    if (url.pathname === '/api/auth/login-email') {
      if (request.method() === 'GET') return json({ ok: true, loginEmail: owner.email, changeEnabled,
        changeUnavailableReason: changeEnabled ? null : 'Login email changes are temporarily unavailable while the authentication rollout is being verified. Your current sign-in address still works.' })
      const body = request.postDataJSON(); mutations.push(body)
      if (failVerification) return json({ ok: false, error: 'Verification was rejected' }, 400)
      return json(request.method() === 'POST' ? { ok: true, pendingEmail: body.email } : { ok: true, loginEmail: body.email, signInRequired: true })
    }
    if (url.pathname === '/api/crm/root-access') {
      if(!showRootControls)return json({ok:false,error:'Not included in this basic user lifecycle fixture'},403)
      if(request.method()==='POST'){
        const body=request.postDataJSON();mutations.push(body)
        assert.deepEqual(body,{action:'employee',userEmail:member.email,enabled:true,registryVersion:'d'.repeat(64)})
        await new Promise(resolve=>{releaseRootSave=resolve});rootEmployeeEnabled=true
      }
      return json({ok:true,settings:{workspaceId:'org-a',workspaceName:'Org A',configured:true,enabled:true,registryVersion:'d'.repeat(64),
        workspaces:[{id:'org-a',name:'Org A',selected:true,available:true}],pending:null,
        employees:[{email:member.email,displayName:'Member',status:'active',enabled:rootEmployeeEnabled,crmAllowed:true}]}})
    }
    if (url.pathname === '/api/users') {
      if (request.method() === 'PATCH') {
        const body = request.postDataJSON(); mutations.push(body)
        if (body.action === 'crm-user-sync') {
          if (identitySync === 'held') return json({ ok: false, error: 'This CRM identity needs a permission-verified change. No identity change was queued.' }, 409)
          if(linkExistingOnSync){linkExistingOnSync=false;member.suiteCrmUserId='native-member';member.suiteCrmUsername=member.referenceCode}
          return json({ ok: true, user: { ...member, crmUserEnabled: employeeEnabled, status: userStatus }, crmIdentitySync: identitySync })
        }
        if (body.action === 'crm-employee') {
          if (failEmployee) return json({ ok: false, error: 'Employee update was rejected' }, 409)
          employeeEnabled = body.enabled
          return json({ ok: true, user: { ...member, crmUserEnabled: employeeEnabled, status: userStatus }, crmIdentitySync: 'retained' })
        }
        if (body.action === 'resume-access-change') {
          assert.equal(body.transitionId, pendingAccessChange.transitionId)
          assert.deepEqual(Object.keys(body).sort(), ['action', 'transitionId'])
          if (holdResume) return json({ ok: false, error: 'CRM access is still pending. Resume this saved change again.' }, 409)
          pendingAccessChange = null
          return json({ ok: true })
        }
        if (body.action === 'trash-user') trashed = true
        if (body.action === 'restore-user') trashed = false
        if (body.status) userStatus = body.status
        if (holdNextUserChange) {
          holdNextUserChange = false
          pendingAccessChange = { transitionId: 'a'.repeat(64), userEmail: member.email, workspaceId: 'org-a', actionKind: body.action === 'trash-user' ? 'trash' : 'status' }
          return json({ ok: false, error: 'CRM access change is pending.', transitionId: pendingAccessChange.transitionId }, 409)
        }
        return json({ ok: true, user: { ...member, crmUserEnabled: employeeEnabled, status: userStatus, trashedAt: trashed ? new Date().toISOString() : null } })
      }
      return json({ ok: true, currentUser: owner, currentOrganization: { id: 'org-a', name: 'Org A' }, isAdmin: true, canInvite: true, canManageUserAccess: true, workspaceOrganizations: [],
        pendingAccessChange,
        users: url.searchParams.get('view') === 'trash' ? (trashed ? [{ ...member, crmUserEnabled: employeeEnabled, status: 'disabled', trashedAt: new Date().toISOString() }] : []) : [owner, ...(trashed ? [] : [{ ...member, crmUserEnabled: employeeEnabled, status: userStatus }])] })
    }
    if (url.pathname === '/api/workspaces') {
      if(request.method()==='POST'){
        const body=request.postDataJSON();mutations.push(body)
        if(body.action==='share-pipeline'){
          sharedRole=body.accessRole
          if(holdNextShare){holdNextShare=false;pendingSharingChange={transitionId:'b'.repeat(64),workspaceId:'org-a',pipelineId:'pipeline-a',pipelineName:'Sales pipeline',userEmail:member.email,accessRole:sharedRole}
            return json({ok:false,error:'Sharing change is pending.'},409)}
        }
        if(body.action==='resume-sharing-change'){
          assert.deepEqual(body,{action:'resume-sharing-change',transitionId:pendingSharingChange.transitionId})
          if(holdSharingResume)return json({ok:false,error:'Sharing is still pending. Try Resume sharing change again.'},409)
          pendingSharingChange=null
        }
      }
      return json({ok:true,boards:[],pendingSharingChange,pipelines:[{id:'pipeline-a',name:'Sales pipeline',ownerEmail:owner.email,isDefault:true,accessRole:'owner',
        provisioningStatus:'unbound',provisioningError:null,shortLinkUrl:null,sheetBacked:false,syncEnabled:false,
        members:[{email:member.email,displayName:'Member',status:'active',accessRole:sharedRole}]}]})
    }
    return json({ ok: true, boards: [], pipelines: [] })
  })
  await page.goto(origin)
  await expect(page.getByText('Current sign-in address: owner@example.test')).toBeVisible()
  await expect(page.getByText('Login email changes are temporarily unavailable', { exact: false })).toBeVisible()
  await expect(page.getByLabel('New login email', { exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Send verification code', exact: true })).toBeDisabled()
  assert.equal(mutations.length, 0, 'Default-off UI does not issue a verification request')
  changeEnabled = true
  await page.reload()
  await expect(page.getByLabel('New login email', { exact: true })).toBeEnabled()
  await page.getByLabel('New login email', { exact: true }).fill('new@example.test')
  await page.getByRole('button', { name: 'Send verification code', exact: true }).click()
  await expect(page.getByText('Enter the six-digit code sent to new@example.test.', { exact: false })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Verify and change login email' })).toBeDisabled()
  await page.getByLabel('Login email verification code').fill('123456')
  failVerification = true
  await page.getByRole('button', { name: 'Verify and change login email' }).click()
  await expect(page.getByText('Verification was rejected')).toBeVisible()
  failVerification = false
  await page.getByRole('button', { name: 'Verify and change login email' }).click()
  await expect(page.locator('body')).toHaveAttribute('data-navigation', '/login?email=new%40example.test')
  await page.goto(`${origin}/?people=1`)
  const employee = page.getByLabel('CRM employee access for member@example.test', { exact: true })
  await expect(employee).toBeChecked()
  await expect(page.getByLabel('CRM employee access for owner@example.test', { exact: true })).toBeDisabled()
  await employee.click()
  await expect(page.getByText('Member was removed as a CRM employee.', { exact: true })).toBeVisible()
  await page.reload()
  await expect(employee).not.toBeChecked()
  await expect(page.getByLabel('SuiteCRM username for member@example.test', { exact: true })).toHaveCount(0)
  await employee.click()
  await expect(page.getByLabel('SuiteCRM username for member@example.test', { exact: true })).toHaveValue(member.referenceCode)
  failEmployee = true
  await employee.click()
  await expect(page.getByText('Employee update was rejected', { exact: true })).toBeVisible()
  await expect(employee).toBeChecked()
  await expect(page.getByLabel('SuiteCRM username for member@example.test', { exact: true })).toHaveValue(member.referenceCode)
  failEmployee = false
  const resync = page.getByRole('button', { name: 'Resync CRM identity', exact: true })
  await resync.click()
  await expect(page.getByText("Member's SuiteCRM identity is verified as gu0123456789av. No identity changes were needed.", { exact: true })).toBeVisible()
  identitySync = 'queued'
  await resync.click()
  await expect(page.getByText('Member is syncing to SuiteCRM as gu0123456789av.', { exact: true })).toBeVisible()
  identitySync = 'held'
  await resync.click()
  await expect(page.getByText('This CRM identity needs a permission-verified change. No identity change was queued.', { exact: true })).toBeVisible()
  await expect(page.getByText('Member is syncing to SuiteCRM as gu0123456789av.', { exact: true })).toHaveCount(0)
  await expect(page.getByLabel('SuiteCRM username for member@example.test', { exact: true })).toHaveValue(member.referenceCode)
  identitySync = undefined
  await resync.click()
  await expect(page.getByText('CRM mapping response was incomplete', { exact: true })).toBeVisible()
  await expect(page.getByText('Member is syncing to SuiteCRM as gu0123456789av.', { exact: true })).toHaveCount(0)
  assert.deepEqual(mutations.filter(body => body.action === 'crm-employee').map(body => [body.email, body.organizationId, body.enabled]),
    [[member.email, 'org-a', false], [member.email, 'org-a', true], [member.email, 'org-a', false]])
  member.suiteCrmUserId=null;member.suiteCrmUsername=null;identitySync='verified';linkExistingOnSync=true
  await page.reload()
  await page.locator('div').filter({has:page.getByLabel('SuiteCRM username for member@example.test',{exact:true})})
    .filter({has:page.getByRole('button',{name:'Sync CRM identity',exact:true})}).last()
    .getByRole('button',{name:'Sync CRM identity',exact:true}).click()
  await expect(page.getByText("Member's SuiteCRM identity is verified as gu0123456789av. Linked to the existing SuiteCRM account.",{exact:true})).toBeVisible()
  await expect(page.getByRole('button',{name:'Resync CRM identity',exact:true})).toBeVisible()
  await page.getByRole('button', { name: 'Trashed users', exact: true }).click()
  await expect(page.getByText('No trashed users.')).toBeVisible()
  await page.getByRole('button', { name: 'Users', exact: true }).click()
  page.once('dialog', (dialog) => dialog.accept())
  await page.getByRole('button', { name: 'Move member@example.test to Trash', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Move member@example.test to Trash', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'Trashed users', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Restore user', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Restore user', exact: true }).click()
  await expect(page.getByText('No trashed users.')).toBeVisible()
  await page.getByRole('button', { name: 'Users', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Move member@example.test to Trash', exact: true })).toBeVisible()
  assert.deepEqual(mutations.slice(-2).map((body) => [body.action, body.email, body.organizationId]), [['trash-user', 'member@example.test', 'org-a'], ['restore-user', 'member@example.test', 'org-a']])

  // App-side mutation has committed, so the user card no longer has the old
  // action or dirty form. Resume is global and uses only the stored identity.
  holdNextUserChange = true
  await page.getByRole('button', { name: 'Disable member@example.test', exact: true }).click()
  await expect(page.getByText('User access change pending for member@example.test', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Restore member@example.test', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Resume change', exact: true })).toHaveCount(1)
  await expect(page.getByRole('button', { name: 'Resume change', exact: true })).toBeEnabled()
  assert.ok(!(await page.locator('body').innerText()).includes('a'.repeat(64)), 'Private transition identity is not displayed')
  await page.getByRole('tab', { name: 'Profile', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Save profile', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Resume change', exact: true })).toBeEnabled()
  holdResume = true
  await page.getByRole('button', { name: 'Resume change', exact: true }).click()
  await expect(page.getByText('CRM access is still pending. Resume this saved change again.', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Resume change', exact: true })).toBeEnabled()
  await page.reload()
  await expect(page.getByRole('button', { name: 'Resume change', exact: true })).toBeEnabled()
  holdResume = false
  await page.getByRole('button', { name: 'Resume change', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Resume change', exact: true })).toHaveCount(0)
  await expect(page.getByText('The saved user access change is complete.', { exact: true })).toBeVisible()

  holdNextUserChange = true
  page.once('dialog', (dialog) => dialog.accept())
  await page.getByRole('button', { name: 'Move member@example.test to Trash', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Move member@example.test to Trash', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'Trashed users', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Restore user', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Resume change', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: 'Resume change', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Resume change', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Restore user', exact: true })).toBeVisible()
  assert.equal(mutations.filter(body => body.action === 'resume-access-change').length, 3)
  assert.equal(mutations.filter(body => body.status === 'disabled').length, 1, 'Resume never replays the form mutation')
  trashed=false;userStatus='active'
  // A first native identity link may have committed its local mapping before
  // the native grant reply is lost. Fresh discovery must still expose a safe
  // global Resume action, not rely on the original Sync button/form state.
  pendingAccessChange={transitionId:'c'.repeat(64),userEmail:member.email,workspaceId:'org-a',actionKind:'identity_link'}
  await page.reload()
  await expect(page.getByText('User access change pending for member@example.test',{exact:true})).toBeVisible()
  assert.ok(!(await page.locator('body').innerText()).includes('c'.repeat(64)))
  holdResume=true
  await page.getByRole('button',{name:'Resume change',exact:true}).click()
  await expect(page.getByText('CRM access is still pending. Resume this saved change again.',{exact:true})).toBeVisible()
  assert.deepEqual(mutations.at(-1),{action:'resume-access-change',transitionId:'c'.repeat(64)})
  holdResume=false
  await page.getByRole('button',{name:'Resume change',exact:true}).click()
  await expect(page.getByRole('button',{name:'Resume change',exact:true})).toHaveCount(0)
  assert.equal(mutations.filter(body=>body.action==='resume-access-change').length,5)
  await page.getByRole('tab',{name:'Sharing',exact:true}).click()
  holdNextShare=true
  await page.getByRole('combobox',{name:'Access for member@example.test',exact:true}).click()
  await page.getByRole('option',{name:'Editor',exact:true}).click()
  await expect(page.getByText('Sharing change pending for Sales pipeline',{exact:true})).toBeVisible()
  await expect(page.getByRole('combobox',{name:'Access for member@example.test',exact:true})).toHaveText('Editor')
  await page.reload()
  await expect(page.getByRole('button',{name:'Resume sharing change',exact:true})).toBeEnabled()
  assert.ok(!(await page.locator('body').innerText()).includes('b'.repeat(64)),'Private sharing transition ID is not displayed')
  await page.getByRole('tab',{name:'Sharing',exact:true}).click()
  await page.getByLabel('User email',{exact:true}).fill('unsubmitted@example.test')
  holdSharingResume=true
  await page.getByRole('button',{name:'Resume sharing change',exact:true}).click()
  await expect(page.getByText('Sharing is still pending. Try Resume sharing change again.',{exact:true})).toBeVisible()
  await expect(page.getByRole('button',{name:'Resume sharing change',exact:true})).toBeEnabled()
  holdSharingResume=false
  await page.getByRole('button',{name:'Resume sharing change',exact:true}).click()
  await expect(page.getByRole('button',{name:'Resume sharing change',exact:true})).toHaveCount(0)
  await expect(page.getByText('The saved pipeline sharing change is complete.',{exact:true})).toBeVisible()
  await expect(page.getByLabel('User email',{exact:true})).toHaveValue('unsubmitted@example.test')
  assert.equal(mutations.filter(body=>body.action==='share-pipeline').length,1,'Resume never resubmits a sharing form')
  assert.equal(mutations.filter(body=>body.action==='resume-sharing-change').length,2)
  showRootControls=true
  await page.goto(`${origin}/?people=1`)
  await expect(page.getByText('Company-wide CRM access',{exact:true})).toBeVisible()
  const rootEmployee=page.getByRole('checkbox',{name:'Company-wide CRM access for member@example.test',exact:true})
  await rootEmployee.click()
  await expect(page.getByRole('button',{name:'Disable member@example.test',exact:true})).toBeDisabled()
  await expect(page.getByRole('button',{name:'Saving CRM access…',exact:true})).toBeDisabled()
  assert.ok(releaseRootSave);releaseRootSave()
  await expect(rootEmployee).toBeChecked()
  await expect(page.getByRole('button',{name:'Disable member@example.test',exact:true})).toBeEnabled()
  await page.reload();await expect(rootEmployee).toBeChecked()
  await page.setViewportSize({ width: 390, height: 844 })
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Mobile viewport has no horizontal overflow')
  assert.deepEqual(errors, [])
  console.log('PASS: real React login/employee/identity/Trash state, saved first-identity/user/pipeline discovery and exact Resume/retry after reload with unsaved drafts preserved, integrated root CRM controls/parent busy fencing, private-ID exclusion and mobile width; APIs mocked')
} finally {
  await browser?.close()
  if (server) await new Promise((done) => server.close(done))
  await rm(output, { recursive: true, force: true })
}
