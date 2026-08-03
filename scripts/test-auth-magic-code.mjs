#!/usr/bin/env node
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import vm from 'node:vm'

const root = process.cwd()
const requireFromApp = createRequire(new URL('../app_src/package.json', import.meta.url))
const requireFromTest = createRequire(import.meta.url)
const ts = requireFromApp('typescript')

function read(relativePath) {
  return readFileSync(resolve(root, relativePath), 'utf8')
}

function loadTypeScriptModule(relativePath, mocks) {
  const source = read(relativePath)
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: relativePath,
  }).outputText
  const module = { exports: {} }
  const sandbox = {
    AbortSignal,
    Buffer,
    Headers,
    Request,
    Response,
    URL,
    clearTimeout,
    console,
    exports: module.exports,
    fetch,
    module,
    process,
    require(id) {
      if (Object.hasOwn(mocks, id)) return mocks[id]
      return requireFromTest(id)
    },
    setTimeout,
  }
  vm.runInNewContext(output, sandbox, { filename: relativePath })
  return { exports: module.exports, source }
}

function decodeBase64Url(value) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
  return Buffer.from(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='), 'base64').toString('utf8')
}

const migration = read('db/migrations/0003_auth_magic_codes.sql')
for (const fragment of [
  'CREATE TABLE IF NOT EXISTS auth_magic_codes',
  'code_digest text NOT NULL',
  'attempts BETWEEN 0 AND 5',
  'expires_at timestamptz NOT NULL',
  'consumed_at timestamptz',
]) {
  assert.ok(migration.includes(fragment), `migration missing ${fragment}`)
}
const invitationMigration = read('db/migrations/0010_user_invitations.sql')
for (const fragment of [
  'CREATE TABLE IF NOT EXISTS app_user_invitations',
  "purpose text NOT NULL DEFAULT 'sign_in'",
  'invitation_id uuid REFERENCES app_user_invitations',
]) {
  assert.ok(invitationMigration.includes(fragment), `invitation migration missing ${fragment}`)
}
const invitationDeliveryMigration = read('db/migrations/0013_invitation_delivery_coordination.sql')
assert.ok(invitationDeliveryMigration.includes('supersedes_id'))
const invitationPendingMigration = read('db/migrations/0014_invitation_delivery_pending.sql')
assert.ok(invitationPendingMigration.includes('delivery_pending_at'))

const welcomePage = read('app_src/app/welcome/page.tsx')
assert.ok(welcomePage.includes("window.sessionStorage.setItem(INVITATION_TOKEN_STORAGE_KEY"))
assert.ok(welcomePage.includes("window.sessionStorage.getItem(INVITATION_TOKEN_STORAGE_KEY)"))
assert.ok(welcomePage.includes("window.history.replaceState"))
const loginPage = read('app_src/app/login/page.tsx')
assert.ok(loginPage.includes("invitedFlow ? '/api/invitations/accept' : '/api/auth/magic/request'"))
assert.ok(loginPage.includes("window.sessionStorage.removeItem(INVITATION_TOKEN_STORAGE_KEY)"))

const originalEnv = {
  APP_LOGIN_EMAIL: process.env.APP_LOGIN_EMAIL,
  APP_SESSION_SECRET: process.env.APP_SESSION_SECRET,
    MATON_GMAIL_CONNECTION_ID: process.env.MATON_GMAIL_CONNECTION_ID,
    CLAWPILOT_MAIL_FROM: process.env.CLAWPILOT_MAIL_FROM,
    CLAWPILOT_PUBLIC_URL: process.env.CLAWPILOT_PUBLIC_URL,
  NODE_ENV: process.env.NODE_ENV,
}

try {
  process.env.APP_LOGIN_EMAIL = 'operator@example.com'
  process.env.APP_SESSION_SECRET = 'test-session-secret-with-at-least-32-characters'
  process.env.MATON_GMAIL_CONNECTION_ID = 'test-gmail-connection'
  process.env.CLAWPILOT_MAIL_FROM = 'stewards@eigenracing.com'
  process.env.CLAWPILOT_PUBLIC_URL = 'https://aiapp.eigenracing.com'
  process.env.NODE_ENV = 'test'

  let now = Date.parse('2026-07-12T12:00:00.000Z')
  let sequence = 0
  let record = null
  const delivered = []
  const activatedMemberships = []
  let deliveryShouldFail = false
  let invitationValid = true
  const invitationOrganizationId = '20000000-0000-4000-8000-000000000001'
  const additionalInvitedOrganizationIds = [
    '33333333-3333-4333-8333-333333333333',
    '44444444-4444-4444-8444-444444444444',
  ]
  let activeInvitationAdditionalOrganizationIds = []

  const fakeClient = {
    async query(sql, values) {
      if (sql.includes('INSERT INTO auth_magic_codes')) {
        if (record && now - record.createdAt < 60_000) return { rows: [], rowCount: 0 }
        record = {
          id: `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`,
          email: values[0],
          digest: values[1],
          attempts: 0,
          createdAt: now,
          expiresAt: now + 15 * 60_000,
          consumedAt: null,
          purpose: values[2],
          invitationId: values[3],
        }
        return {
          rows: [{ id: record.id, expires_at: new Date(record.expiresAt).toISOString() }],
          rowCount: 1,
        }
      }

      if (sql.includes('retry_after_seconds')) {
        const seconds = record ? Math.max(1, Math.ceil((record.createdAt + 60_000 - now) / 1000)) : 60
        return { rows: [{ retry_after_seconds: seconds }], rowCount: 1 }
      }

      if (sql.includes('WITH candidate AS')) {
        if (!record || record.email !== values[0]) return { rows: [], rowCount: 0 }
        let status
        if (record.consumedAt !== null) status = 'consumed'
        else if (record.expiresAt <= now) status = 'expired'
        else if (record.attempts >= 5) status = 'locked'
        else if (record.digest === values[1]) {
          status = 'verified'
          record.consumedAt = now
        } else {
          record.attempts += 1
          status = record.attempts >= 5 ? 'locked' : 'invalid'
        }
        return { rows: [{ status, attempts: record.attempts, purpose: record.purpose, invitation_id: record.invitationId }], rowCount: 1 }
      }

      if (sql.includes('UPDATE app_user_invitations')) {
        return invitationValid && values[0] === '10000000-0000-4000-8000-000000000001'
          ? {
            rows: [{
              id: values[0],
              workspace_organization_id: invitationOrganizationId,
              workspace_organization_ids: activeInvitationAdditionalOrganizationIds,
            }],
            rowCount: 1,
          }
          : { rows: [], rowCount: 0 }
      }

      if (sql.includes('UPDATE app_user_organization_memberships')) {
        if (
          values[0] === 'invited@example.com'
          && (
            values[1] === invitationOrganizationId
            || (Array.isArray(values[2]) && values[2].includes(values[1]))
          )
        ) {
          const organizationIds = [values[1], ...(Array.isArray(values[2]) ? values[2] : [])]
          const seen = new Set()
          for (const organizationId of organizationIds) {
            if (typeof organizationId !== 'string' || seen.has(organizationId)) continue
            seen.add(organizationId)
            activatedMemberships.push({ email: values[0], organizationId })
          }
          return { rows: [{ organization_id: values[1] }], rowCount: 1 }
        }
        return { rows: [], rowCount: 0 }
      }

      if (sql.includes('UPDATE app_users')) {
        return values[0] === 'operator@example.com' || values[0] === 'invited@example.com'
          ? { rows: [{ email: values[0] }], rowCount: 1 }
          : { rows: [], rowCount: 0 }
      }

      throw new Error('Unexpected transactional query in focused auth test')
    },
  }

  const persistenceMock = {
    async withTransaction(fn) {
      return fn(fakeClient)
    },
    async query(sql, values) {
      if (sql.includes('FROM app_user_invitations invitation')) {
        return invitationValid
          ? {
            rows: [{
              id: '10000000-0000-4000-8000-000000000001',
              workspace_organization_id: invitationOrganizationId,
              workspace_organization_ids: activeInvitationAdditionalOrganizationIds,
            }],
            rowCount: 1,
          }
          : { rows: [], rowCount: 0 }
      }
      if (sql.includes('UPDATE app_user_invitations')) {
        return invitationValid && values[0] === '10000000-0000-4000-8000-000000000001'
          ? {
            rows: [{
              id: values[0],
              workspace_organization_id: invitationOrganizationId,
              workspace_organization_ids: activeInvitationAdditionalOrganizationIds,
            }],
            rowCount: 1,
          }
          : { rows: [], rowCount: 0 }
      }
      assert.ok(sql.includes('DELETE FROM auth_magic_codes'))
      if (record && record.id === values[0] && record.email === values[1] && record.digest === values[2]) {
        record = null
      }
      return { rows: [], rowCount: 1 }
    },
  }

  const mailMock = {
    async sendAuthMagicCodeEmail(input) {
      delivered.push({ ...input })
      if (deliveryShouldFail) throw new Error('simulated delivery failure')
      return { messageId: 'test-message' }
    },
  }

  const usersMock = {
    normalizeUserEmail(value) {
      const email = String(value || '').trim().toLowerCase()
      if (!email.includes('@')) throw new Error('invalid email')
      return email
    },
    async getAppUser(email) {
      return email === 'operator@example.com'
        ? { email, role: 'owner', status: 'active' }
        : email === 'invited@example.com'
          ? { email, role: 'member', status: 'invited' }
        : null
    },
  }

  const authModule = loadTypeScriptModule('app_src/lib/authMagicCode.ts', {
    '@/lib/matonMail': mailMock,
    '@/lib/persistence/postgres': persistenceMock,
    '@/lib/users': usersMock,
  })
  const { requestAuthMagicCode, requestInvitationAuthMagicCode, verifyAuthMagicCode } = authModule.exports

  assert.ok(authModule.source.includes('crypto.randomInt(0, 1_000_000)'))
  assert.ok(authModule.source.includes("createHmac('sha256'"))
  assert.ok(authModule.source.includes("interval '15 minutes'"))
  assert.ok(authModule.source.includes("interval '60 seconds'"))
  assert.ok(authModule.source.includes('FOR UPDATE'))
  assert.ok(authModule.source.includes('membership.organization_id = invitation.workspace_organization_id'))
  assert.ok(authModule.source.includes("membership.status = 'invited'"))
  assert.ok(authModule.source.includes('OR organization_id = ANY($3::uuid[])'))
  assert.ok(authModule.source.includes('workspace_organization_ids'))
  assert.ok(authModule.source.includes('AND organization_id = $2::uuid'))
  assert.ok(authModule.source.includes('workspace_organization_ids::uuid[]'))
  assert.ok(!authModule.source.includes('console.'))

  const unauthorized = await requestAuthMagicCode({ email: 'other@example.com' })
  assert.equal(unauthorized.status, 'not-authorized')
  const invitedCannotUseRegularSignIn = await requestAuthMagicCode({ email: 'invited@example.com' })
  assert.equal(invitedCannotUseRegularSignIn.status, 'not-authorized')
  assert.equal(delivered.length, 0)

  const first = await requestAuthMagicCode({ email: 'Operator@Example.com' })
  assert.equal(first.status, 'sent')
  assert.ok(!Object.hasOwn(first, 'code'))
  assert.equal(delivered.length, 1)
  assert.match(delivered[0].code, /^\d{6}$/)
  const firstCode = delivered[0].code
  const expectedDigest = crypto
    .createHmac('sha256', process.env.APP_SESSION_SECRET)
    .update(`clawpilot-auth-magic-code:v1\noperator@example.com\n${firstCode}`)
    .digest('hex')
  assert.equal(record.digest, expectedDigest)
  assert.notEqual(record.digest, firstCode)

  const cooldown = await requestAuthMagicCode({ email: 'operator@example.com' })
  assert.equal(cooldown.status, 'cooldown')
  assert.equal(cooldown.retryAfterSeconds, 60)
  assert.equal(delivered.length, 1)

  const wrongCode = firstCode === '000000' ? '000001' : '000000'
  for (let attempt = 1; attempt <= 4; attempt++) {
    const result = await verifyAuthMagicCode({ email: 'operator@example.com', code: wrongCode })
    assert.equal(result.status, 'invalid')
    assert.equal(result.attemptsRemaining, 5 - attempt)
  }
  const locked = await verifyAuthMagicCode({ email: 'operator@example.com', code: wrongCode })
  assert.equal(locked.status, 'locked')
  const correctAfterLock = await verifyAuthMagicCode({ email: 'operator@example.com', code: firstCode })
  assert.equal(correctAfterLock.status, 'locked')

  now += 61_000
  const replacement = await requestAuthMagicCode({ email: 'operator@example.com' })
  assert.equal(replacement.status, 'sent')
  const replacementCode = delivered.at(-1).code
  const verified = await verifyAuthMagicCode({ email: 'operator@example.com', code: replacementCode })
  assert.equal(verified.status, 'verified')
  assert.equal(verified.email, 'operator@example.com')
  assert.equal(verified.organizationId, null)
  const consumed = await verifyAuthMagicCode({ email: 'operator@example.com', code: replacementCode })
  assert.equal(consumed.status, 'consumed')

  now += 61_000
  const expiring = await requestAuthMagicCode({ email: 'operator@example.com' })
  assert.equal(expiring.status, 'sent')
  const expiringCode = delivered.at(-1).code
  now += 15 * 60_000 + 1
  const expired = await verifyAuthMagicCode({ email: 'operator@example.com', code: expiringCode })
  assert.equal(expired.status, 'expired')

  now += 61_000
  const invited = await requestInvitationAuthMagicCode({
    email: 'invited@example.com',
    invitationId: '10000000-0000-4000-8000-000000000001',
  })
  assert.equal(invited.status, 'sent')
  assert.equal(record.purpose, 'invitation')
  assert.equal(record.invitationId, '10000000-0000-4000-8000-000000000001')
  const invitationVerified = await verifyAuthMagicCode({ email: 'invited@example.com', code: delivered.at(-1).code })
  assert.equal(invitationVerified.status, 'verified')
  assert.equal(invitationVerified.organizationId, invitationOrganizationId)
  assert.deepEqual(activatedMemberships, [{
    email: 'invited@example.com',
    organizationId: invitationOrganizationId,
  }])
  activatedMemberships.length = 0

  now += 61_000
  activeInvitationAdditionalOrganizationIds = additionalInvitedOrganizationIds
  const invitedAcrossOrganizations = await requestInvitationAuthMagicCode({
    email: 'invited@example.com',
    invitationId: '10000000-0000-4000-8000-000000000001',
  })
  assert.equal(invitedAcrossOrganizations.status, 'sent')
  assert.equal(record.purpose, 'invitation')
  assert.equal(record.invitationId, '10000000-0000-4000-8000-000000000001')
  const invitationVerifiedWithAdditions = await verifyAuthMagicCode({
    email: 'invited@example.com',
    code: delivered.at(-1).code,
  })
  assert.equal(invitationVerifiedWithAdditions.status, 'verified')
  assert.equal(invitationVerifiedWithAdditions.organizationId, invitationOrganizationId)
  assert.deepEqual(activatedMemberships, [
    { email: 'invited@example.com', organizationId: invitationOrganizationId },
    ...additionalInvitedOrganizationIds.map((orgId) => ({
      email: 'invited@example.com',
      organizationId: orgId,
    })),
  ])
  activeInvitationAdditionalOrganizationIds = []

  now += 61_000
  invitationValid = false
  const revokedInvitation = await requestInvitationAuthMagicCode({
    email: 'invited@example.com',
    invitationId: '10000000-0000-4000-8000-000000000001',
  })
  assert.equal(revokedInvitation.status, 'not-authorized')
  invitationValid = true

  now += 61_000
  deliveryShouldFail = true
  let deliveryError = null
  try {
    await requestAuthMagicCode({ email: 'operator@example.com' })
  } catch (error) {
    deliveryError = error
  }
  assert.ok(deliveryError && typeof deliveryError === 'object')
  assert.equal(String(deliveryError.message), 'Unable to deliver sign-in code')
  assert.equal(record, null)
  assert.ok(!String(deliveryError.message).includes(delivered.at(-1).code))

  deliveryShouldFail = false
  const matonCalls = []
  const mailModule = loadTypeScriptModule('app_src/lib/matonMail.ts', {
    '@/lib/maton': {
      async matonPlatformMailFetch(pathname, init) {
        matonCalls.push({ pathname, init })
        if (pathname.includes('/settings/sendAs/')) {
          return new Response(JSON.stringify({
            sendAsEmail: 'stewards@eigenracing.com',
            verificationStatus: 'accepted',
          }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        }
        return new Response(JSON.stringify({ id: 'gmail-message-id' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      },
    },
    '@/lib/publicUrl': {
      appPublicUrl() { return 'https://aiapp.eigenracing.com' },
    },
    '@/lib/persistence/config': {
      isHostedRuntime() { return false },
    },
  })
  const mailResult = await mailModule.exports.sendAuthMagicCodeEmail({
    to: 'operator@example.com',
    code: '123456',
  })
  assert.equal(mailResult.messageId, 'gmail-message-id')
  assert.ok(!Object.hasOwn(mailResult, 'code'))
  assert.equal(matonCalls.length, 2)
  assert.match(matonCalls[0].pathname, /\/settings\/sendAs\/stewards%40eigenracing\.com$/)
  assert.equal(matonCalls[1].pathname, '/google-mail/gmail/v1/users/me/messages/send')
  assert.equal(matonCalls[1].init.method, 'POST')
  assert.equal(matonCalls[1].init.headers['Maton-Connection'], undefined)
  const mailPayload = JSON.parse(matonCalls[1].init.body)
  const decodedMessage = decodeBase64Url(mailPayload.raw)
  assert.match(decodedMessage, /Content-Type: multipart\/alternative/)
  assert.match(decodedMessage, /Content-Type: text\/plain/)
  assert.match(decodedMessage, /Content-Type: text\/html/)
  assert.match(decodedMessage, /ClawPilot/)
  assert.match(decodedMessage, /From: ClawPilot Stewards <stewards@eigenracing\.com>/)
  assert.match(decodedMessage, /123456/)
  assert.match(decodedMessage, /^[\x00-\x7f]*$/)
  assert.ok(!mailModule.source.includes('console.'))

  await mailModule.exports.sendInvitationEmail({
    to: 'new-user@example.com',
    inviterName: 'Jarrett Crosby',
    welcomeUrl: 'https://aiapp.eigenracing.com/welcome#token=test-token',
    expiresAt: '2026-07-20T12:00:00.000Z',
  })
  assert.equal(matonCalls.length, 3)
  const invitationPayload = JSON.parse(matonCalls[2].init.body)
  const invitationMessage = decodeBase64Url(invitationPayload.raw)
  assert.match(invitationMessage, /Welcome to ClawPilot/)
  assert.match(invitationMessage, /Accept invitation/)
  assert.match(invitationMessage, /six-digit, one-time sign-in code/)
  assert.match(invitationMessage, /stewards@eigenracing\.com/)

  console.log('PASS test-auth-magic-code')
} finally {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}
