import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'

const require = createRequire(import.meta.url)
const ts = createRequire(new URL('../app_src/package.json', import.meta.url))('typescript')
const source = readFileSync('app_src/lib/matonMail.ts', 'utf8')
const output = ts.transpileModule(source, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
} }).outputText
const binding = { connectionId: 'work-mail-connection', mailboxEmail: 'owner@example.com',
  recipientEmails: ['owner@example.com', 'old-alias@example.com'] }

function harness(options = {}) {
  const calls = []
  const env = {
    MATON_GMAIL_CONNECTION_ID: 'work-mail-connection', CLAWPILOT_MAIL_FROM: 'stewards@example.com',
    CLAWPILOT_AUTH_SELF_DELIVERY: JSON.stringify(binding), ...options.env,
  }
  const fetch = async (profile, path, init = {}) => {
    calls.push({ profile, path, method: init.method || 'GET', body: init.body })
    if (path.endsWith('/profile')) return Response.json({ emailAddress: options.mailbox || 'owner@example.com' })
    if (path.includes('/settings/sendAs/')) return Response.json({
      sendAsEmail: decodeURIComponent(path.split('/').at(-1)), verificationStatus: 'accepted',
    })
    if (path.endsWith('/send')) return Response.json({ id: options.messageId ?? 'auth-message-123' }, { status: options.sendStatus || 200 })
    if (path.endsWith('/modify')) {
      if (options.modifyThrow) throw new Error('private-provider-error-must-not-escape')
      return Response.json({ id: options.receiptId || 'auth-message-123', labelIds: options.labels || ['SENT', 'INBOX', 'UNREAD'] },
        { status: options.modifyStatus || 200 })
    }
    throw new Error(`Unexpected path ${path}`)
  }
  const module = { exports: {} }
  const mocks = {
    '@/lib/maton': { matonAuthMailFetch: (...args) => fetch('auth', ...args), matonPlatformMailFetch: (...args) => fetch('platform', ...args) },
    '@/lib/publicUrl': { appPublicUrl: () => 'https://clawpilot.example.com' },
    '@/lib/persistence/config': { isHostedRuntime: () => true },
  }
  vm.runInNewContext(output, { module, exports: module.exports, Buffer, URL,
    process: { env }, require: (id) => mocks[id] || require(id) })
  return { mail: module.exports, calls }
}
const send = (test, to = 'old-alias@example.com') => test.mail.sendAuthMagicCodeEmail({ to, code: '123456' })
const writes = (test) => test.calls.filter((call) => call.method === 'POST')

let test = harness()
assert.equal((await send(test)).inboxPlacement, 'confirmed')
assert.equal(writes(test).length, 2)
assert.equal(writes(test)[1].path, '/google-mail/gmail/v1/users/me/messages/auth-message-123/modify')
assert.deepEqual(JSON.parse(writes(test)[1].body), { addLabelIds: ['INBOX', 'UNREAD'] })
assert.ok(Buffer.from(JSON.parse(writes(test)[0].body).raw, 'base64url').toString().includes('From: ClawPilot Stewards <stewards@example.com>'))

for (const to of ['customer@example.com', 'old-alias+unreviewed@example.com', 'old-alias@other.example.com']) {
  test = harness()
  assert.equal((await send(test, to)).inboxPlacement, 'not-applicable')
  assert.equal(writes(test).length, 1)
  assert.equal(test.calls.some((call) => call.path.endsWith('/profile')), false)
}
for (const env of [
  { CLAWPILOT_AUTH_SELF_DELIVERY: '' },
  { CLAWPILOT_AUTH_SELF_DELIVERY: JSON.stringify({ ...binding, connectionId: 'other-connection' }) },
]) {
  test = harness({ env })
  assert.equal((await send(test)).inboxPlacement, 'not-applicable')
  assert.equal(writes(test).length, 1)
}
for (const raw of ['null', '[]', '{', JSON.stringify({ ...binding, recipientEmails: ['*'] }),
  JSON.stringify({ ...binding, recipientEmails: [] }), JSON.stringify({ ...binding, mailboxEmail: 'bad\r\n@example.com' })]) {
  test = harness({ env: { CLAWPILOT_AUTH_SELF_DELIVERY: raw } })
  await assert.rejects(send(test), /CLAWPILOT_AUTH_SELF_DELIVERY/)
  assert.equal(writes(test).length, 0)
}
test = harness({ mailbox: 'renamed-or-wrong@example.com' })
await assert.rejects(send(test), /mailbox identity changed/)
assert.equal(writes(test).length, 0)
test = harness({ sendStatus: 403 })
await assert.rejects(send(test), /delivery failed/)
assert.equal(writes(test).length, 1, 'Failed send must never relabel')
for (const options of [{ modifyStatus: 403 }, { modifyStatus: 503 }, { modifyThrow: true },
  { receiptId: 'wrong-message' }, { labels: ['SENT'] }, { messageId: '../wrong-path' }]) {
  test = harness(options)
  assert.equal((await send(test)).inboxPlacement, 'unconfirmed')
  assert.equal(writes(test).filter((call) => call.path.endsWith('/send')).length, 1, 'Label failure must not resend')
}
test = harness()
await test.mail.sendInvitationEmail({ to: 'old-alias@example.com', inviterName: 'Owner',
  organizationName: 'Example', welcomeUrl: 'https://clawpilot.example.com/welcome', expiresAt: '2026-12-01T00:00:00Z' })
assert.equal(writes(test).length, 1, 'Self-delivery is exclusively for authentication codes')
assert.equal(test.calls.some((call) => call.path.endsWith('/profile')), false)

test = harness({ env: { MATON_AUTH_GMAIL_CONNECTION_ID: 'dedicated-connection', CLAWPILOT_AUTH_MAIL_FROM: 'stewards@example.com' }, mailbox: 'owner@example.com' })
await assert.rejects(send(test), /must differ from platform Gmail account/)
assert.equal(writes(test).length, 0)
console.log('PASS: account-bound authentication self-delivery, exact message labels, unchanged branded sender, no unrelated mail writes or resend')
