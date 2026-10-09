#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const appRequire = createRequire(new URL('../app_src/package.json', import.meta.url))
const ts = appRequire('typescript')
function loadModule(path, dependencies) {
  const output = ts.transpileModule(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }, fileName: path,
  }).outputText
  const module = { exports: {} }
  vm.runInNewContext(output, {
    URL, URLSearchParams, Buffer, console, process, module, exports: module.exports,
    require(specifier) {
      if (Object.hasOwn(dependencies, specifier)) return dependencies[specifier]
      if (specifier === 'crypto' || specifier.startsWith('node:')) return appRequire(specifier)
      throw new Error(`Unexpected pipeline share test import: ${specifier}`)
    },
  }, { filename: path })
  return module.exports
}
const noIo = () => { throw new Error('Unexpected test I/O') }
let providerRequests = []
let verifyStatus = 'accepted'
const mail = loadModule('app_src/lib/matonMail.ts', {
  '@/lib/maton': {
    matonAuthMailFetch: noIo,
    matonPlatformMailFetch: async (path, init = {}) => {
      providerRequests.push({ path, init })
      if (path.endsWith('/profile')) return Response.json({ emailAddress: 'mailbox@example.test' })
      if (path.includes('/settings/sendAs/')) return Response.json({ sendAsEmail: 'stewards@example.test', verificationStatus: verifyStatus })
      if (path.endsWith('/drafts/send')) return Response.json({ id: 'sent-receipt' })
      if (path.endsWith('/drafts') && init.method === 'POST') return Response.json({ id: 'draft-receipt' })
      if (path.includes('/drafts?')) return Response.json({ drafts: [] })
      if (path.includes('/messages?')) return Response.json({ messages: [{ id: 'sent-receipt' }] })
      throw new Error('Unexpected provider operation')
    },
  },
  '@/lib/publicUrl': { appPublicUrl: () => 'https://aiapp.bposupplychain.com' },
  '@/lib/persistence/config': { isHostedRuntime: () => true },
})
const originalSender = process.env.CLAWPILOT_MAIL_FROM
const originalConnection = process.env.MATON_GMAIL_CONNECTION_ID
process.env.CLAWPILOT_MAIL_FROM = 'stewards@example.test'
process.env.MATON_GMAIL_CONNECTION_ID = 'connection-exact'
const pipelineId = '11111111-1111-4111-8111-111111111111'
const noticeId = '22222222-2222-4222-8222-222222222222'
const rfcMessageId = `clawpilot-pipeline-share-${noticeId}@notifications.clawpilot`
const content = {
  to: 'operator@example.test', organizationName: 'BPO Supply Chain', pipelineName: 'My pipeline',
  sheetId: 'exact-sheet', folderId: 'exact-folder', accessRole: 'writer',
}
try {
  const built = mail.buildPipelineGoogleShareEmail(content)
  assert.match(built.text, /initial CRM refresh may still be loading/)
  assert.match(built.text, /https:\/\/docs.google.com\/spreadsheets\/d\/exact-sheet\/edit/)
  assert.match(built.text, /https:\/\/drive.google.com\/drive\/folders\/exact-folder/)
  assert.doesNotMatch(built.text, /\/s\//, 'Access notification does not depend on a short-link resolver')
  assert.throws(() => mail.buildPipelineGoogleShareEmail({ ...content, folderId: 'folder/redirect' }), /resource is invalid/)
  assert.throws(() => mail.buildPipelineGoogleShareEmail({ ...content, pipelineName: 'Name\r\nBcc: victim@example.test' }), /Pipeline name is required/)
  assert.throws(() => mail.buildPipelineGoogleShareEmail({ ...content, accessRole: 'owner' }), /role is invalid/)
  assert.equal(await mail.createPipelineShareMailDraft(content, rfcMessageId), 'draft-receipt')
  const binding = await mail.verifyPipelineShareMailSender()
  assert.equal(binding.mailboxEmail, 'mailbox@example.test')
  assert.equal(binding.senderEmail, 'stewards@example.test')
  assert.match(binding.connectionFingerprint, /^[0-9a-f]{64}$/)
  assert.doesNotMatch(JSON.stringify(binding), /connection-exact/, 'Persisted draft binding does not expose provider connection credentials')
  const raw = Buffer.from(JSON.parse(providerRequests.find((request) => request.init.method === 'POST').init.body).message.raw, 'base64url').toString('utf8')
  assert.match(raw, /From: ClawPilot Stewards <stewards@example.test>/)
  assert.match(raw, new RegExp(`Message-ID: <${rfcMessageId}>`))
  assert.doesNotMatch(raw, /service-account@/)
  assert.equal(await mail.sendPipelineShareMailDraft('draft-receipt'), 'sent-receipt')
  assert.equal(await mail.findSentPipelineShareMail(rfcMessageId), 'sent-receipt')
  assert.match(providerRequests.at(-1).path, /labelIds=SENT/)
  assert.equal(await mail.findPipelineShareMailDraft(rfcMessageId), null)
  await assert.rejects(() => mail.findSentPipelineShareMail('attacker\r\nBcc: unsafe'), /identity is invalid/)
  // New module avoids verification-cache reuse and proves unverified aliases fail closed.
  verifyStatus = 'pending'
  const unverifiedMail = loadModule('app_src/lib/matonMail.ts', {
    '@/lib/maton': { matonAuthMailFetch: noIo, matonPlatformMailFetch: async () => Response.json({ sendAsEmail: 'stewards@example.test', verificationStatus: verifyStatus }) },
    '@/lib/publicUrl': { appPublicUrl: () => 'https://aiapp.bposupplychain.com' },
    '@/lib/persistence/config': { isHostedRuntime: () => true },
  })
  await assert.rejects(() => unverifiedMail.createPipelineShareMailDraft(content, rfcMessageId), /sender is not verified/)
} finally {
  if (originalSender === undefined) delete process.env.CLAWPILOT_MAIL_FROM
  else process.env.CLAWPILOT_MAIL_FROM = originalSender
  if (originalConnection === undefined) delete process.env.MATON_GMAIL_CONNECTION_ID
  else process.env.MATON_GMAIL_CONNECTION_ID = originalConnection
}

let state
let calls
let lookupSent
let lookupDraft
let draftFailure
let mailFailure
let context
let mailBinding
let knownGoogleAccount
const readyContext = {
  pipeline_id: pipelineId, pipeline_name: 'My pipeline', organization_name: 'BPO Supply Chain',
  sheet_id: 'exact-sheet', drive_folder_id: 'exact-folder', provisioning_status: 'ready', sync_enabled: true,
  permission_id: 'permission-exact', google_role: 'writer', desired_role: 'writer', expired: false,
  recipient_status: 'active', membership_status: 'active',
}
function reset() {
  state = { payload: {} }; calls = []; lookupSent = null; lookupDraft = null; draftFailure = null; mailFailure = null
  context = { ...readyContext }
  mailBinding = { mailboxEmail: 'mailbox@example.test', senderEmail: 'stewards@example.test', connectionFingerprint: 'fingerprint-exact' }
  knownGoogleAccount = false
}
reset()
const persistence = loadModule('app_src/lib/persistence/pipelineShareNotifications.ts', {
  '@/lib/persistence/postgres': {
    query: async (sql, parameters) => {
      calls.push({ sql, parameters })
      if (sql.startsWith('SELECT EXISTS')) {
        assert.match(sql, /identity\.verified_email = \$1/)
        assert.match(sql, /connection\.owner_email = \$1 AND connection\.account_email = \$1/)
        assert.match(sql, /connection\.status = 'ACTIVE' AND connection\.source = 'maton'/)
        return { rows: [{ verified: knownGoogleAccount }] }
      }
      if (sql.startsWith('INSERT')) {
        assert.match(sql, /JOIN app_users recipient/)
        assert.match(sql, /pipeline\.drive_folder_id = \$2/)
        assert.match(sql, /pipeline\.owner_email = \$3 OR EXISTS/)
        assert.match(sql, /ON CONFLICT \(target_system, idempotency_key\)/)
        return { rows: [{ id: noticeId, status: 'queued' }], rowCount: 1 }
      }
      if (sql.startsWith('SELECT')) {
        assert.match(sql, /membership\.organization_id = pipeline\.workspace_organization_id/)
        assert.match(sql, /membership\.trashed_at IS NULL/)
        assert.match(sql, /membership\.status IN \('invited', 'active'\)/)
        return { rows: context ? [context] : [], rowCount: context ? 1 : 0 }
      }
      if (sql.includes("'draftCreationReserved', true")) {
        if (state.payload.draftCreationReserved) return { rowCount: 0 }
        state.payload.draftCreationReserved = true
        state.payload.draftSheetId = parameters[2]
        state.payload.draftAccessRole = parameters[3]
        state.payload.mailBinding = JSON.parse(parameters[4])
      } else if (sql.includes("'draftId'")) state.payload.draftId = parameters[2]
      else if (sql.includes("'providerMessageId'")) state.payload.providerMessageId = parameters[2]
      else if (sql.includes("status = 'queued'")) state.deferred = true
      else throw new Error('Unexpected notification SQL')
      return { rowCount: 1 }
    },
  },
  '@/lib/matonMail': {
    PipelineShareMailError: mail.PipelineShareMailError,
    verifyPipelineShareMailSender: async () => { calls.push('verifySender'); return mailBinding },
    findSentPipelineShareMail: async () => lookupSent,
    findPipelineShareMailDraft: async () => lookupDraft,
    createPipelineShareMailDraft: async (input) => { calls.push({ createDraft: input }); if (draftFailure) throw draftFailure; return 'saved-draft' },
    sendPipelineShareMailDraft: async (draftId) => { calls.push({ sendDraft: draftId }); if (mailFailure) throw mailFailure; return 'saved-receipt' },
  },
})
const item = () => ({
  id: noticeId, operation: 'notify_pipeline_google_share', aggregateType: 'pipeline_google_share', aggregateId: pipelineId,
  pipelineId, sheetId: null, attempts: 1, lockToken: 'lease-exact',
  payload: { pipelineId, resourceId: 'exact-folder', recipientEmail: content.to, googleRole: 'writer', ...state.payload },
})
const deliver = () => persistence.deliverPipelineGoogleShareNotification({
  item: item(), verifyAccess: async (input) => {
    assert.equal(input.pipelineId, pipelineId); assert.equal(input.resourceId, 'exact-folder')
    assert.equal(input.recipientEmail, content.to); assert.equal(input.permissionId, 'permission-exact')
    calls.push('verifyAccess')
  },
})
await persistence.enqueuePipelineGoogleShareNotificationInPostgres({ pipelineId, resourceId: 'exact-folder', recipientEmail: content.to, googleRole: 'writer' })
assert.match(calls[0].parameters[4], /pipeline-share:/)
await assert.rejects(() => persistence.enqueuePipelineGoogleShareNotificationInPostgres({ pipelineId, resourceId: 'exact-folder', recipientEmail: 'person\nunsafe@example.test', googleRole: 'writer' }), /context is invalid/)
assert.equal(await deliver(), 'delivered')
assert.equal(state.payload.draftId, 'saved-draft')
assert.equal(state.payload.providerMessageId, 'saved-receipt')
assert.equal(calls.filter((entry) => entry?.createDraft).length, 1)
lookupSent = 'saved-receipt'
assert.equal(await deliver(), 'delivered')
assert.equal(calls.filter((entry) => entry?.sendDraft).length, 1, 'Completed send is recovered without another send')

reset(); context.provisioning_status = 'queued'
assert.equal(await deliver(), 'deferred')
assert.equal(state.deferred, true)
assert.ok(!calls.includes('verifySender'))
reset(); context.membership_status = 'invited'
assert.equal(await deliver(), 'deferred', 'Pending org invitation does not send before activation')
assert.ok(!calls.includes('verifySender'))
reset(); context.recipient_status = 'invited'
assert.equal(await deliver(), 'deferred', 'Pending app user does not send before activation')
assert.ok(!calls.includes('verifySender'))
reset(); context = null
assert.equal(await deliver(), 'obsolete', 'Revoked membership/deleted pipeline never gets a notice')
assert.ok(!calls.includes('verifySender'))
reset(); context.provisioning_status = 'failed'; context.expired = true
await assert.rejects(deliver, /operator review is required/)

reset(); draftFailure = new mail.PipelineShareMailError('Ambiguous creation', null, true)
await assert.rejects(deliver, /Ambiguous creation/)
draftFailure = null
await assert.rejects(deliver, /without creating another/)
assert.equal(calls.filter((entry) => entry?.createDraft).length, 1, 'Unknown draft creation never creates duplicate drafts')
lookupDraft = 'recovered-draft'
assert.equal(await deliver(), 'delivered')
assert.equal(state.payload.draftId, 'recovered-draft')
delete state.payload.providerMessageId
context.desired_role = 'reader'
await assert.rejects(deliver, /role changed/)

reset(); draftFailure = new mail.PipelineShareMailError('Ambiguous creation', null, true)
await assert.rejects(deliver, /Ambiguous creation/)
draftFailure = null; mailBinding = { ...mailBinding, connectionFingerprint: 'new-mailbox-connection' }
await assert.rejects(deliver, /connection or sender changed/)
assert.equal(calls.filter((entry) => entry?.sendDraft).length, 0, 'Stored draft cannot be replayed through a different Gmail connection')

reset()
assert.equal(await persistence.pipelineShareRecipientHasVerifiedGoogleAccount(content.to), false, 'Unknown addresses retain Google visitor invitations')
knownGoogleAccount = true
assert.equal(await persistence.pipelineShareRecipientHasVerifiedGoogleAccount(content.to), true, 'Only positively verified exact Google recipients suppress provider invitations')

reset(); mailFailure = new mail.PipelineShareMailError('Draft consumed', 404)
await assert.rejects(deliver, /Draft consumed/)
mailFailure = null; lookupSent = 'recovered-receipt'
assert.equal(await deliver(), 'delivered')
assert.equal(calls.filter((entry) => entry?.sendDraft).length, 1, 'Consumed draft send is recovered instead of repeated')

const provisioningSource = readFileSync(new URL('../app_src/lib/pipelineProvisioning.ts', import.meta.url), 'utf8')
assert.match(provisioningSource, /sendNotificationEmail: knownGoogleAccount \? 'false' : 'true'/)
assert.match(provisioningSource, /parameters\.set\('emailMessage', `ClawPilot shared your/)
assert.ok(provisioningSource.indexOf('await enqueuePipelineGoogleShareNotificationInPostgres') < provisioningSource.indexOf('permission = await createDrivePermission'), 'Notice is durable before remote grant')
assert.match(provisioningSource, /if \(!tracked\)/, 'Tracked historical permissions do not mass-mail on reconciliation')
console.log('Pipeline share notifications preserve scope/access, verified branding, durable queue, draft recovery, and no duplicate invitations')
