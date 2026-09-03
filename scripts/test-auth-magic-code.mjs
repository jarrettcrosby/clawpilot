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

const magicRequestRoute = read('app_src/app/api/auth/magic/request/route.ts')
for (const fragment of [
  "export const dynamic = 'force-dynamic'",
  "'Cache-Control': 'private, no-store, max-age=0'",
  "code: 'AUTH_MAGIC_REQUEST_INVALID'",
  "code: 'AUTH_MAGIC_EMAIL_INVALID'",
  "code: 'AUTH_MAGIC_RATE_LIMITED'",
  "code: 'AUTH_MAGIC_DELIVERY_UNAVAILABLE'",
  "{ 'Retry-After': String(retryAfter) }",
]) {
  assert.ok(magicRequestRoute.includes(fragment), `magic-code request route missing ${fragment}`)
}

const magicVerifyRoute = read('app_src/app/api/auth/magic/verify/route.ts')
for (const fragment of [
  "export const dynamic = 'force-dynamic'",
  "'Cache-Control': 'private, no-store, max-age=0'",
  "code: 'AUTH_MAGIC_REQUEST_INVALID'",
  "code: 'AUTH_MAGIC_CODE_INVALID'",
  "code: 'AUTH_MAGIC_VERIFICATION_UNAVAILABLE'",
]) {
  assert.ok(magicVerifyRoute.includes(fragment), `magic-code verify route missing ${fragment}`)
}

for (const configurationSource of [
  read('.env.example'),
  read('scripts/start-railway.sh'),
  read('scripts/validate-runtime-config.mjs'),
  read('scripts/verify-mail-sender.mjs'),
  read('app_src/app/api/health/route.ts'),
]) {
  assert.ok(configurationSource.includes('MATON_AUTH_GMAIL_CONNECTION_ID'))
  assert.ok(configurationSource.includes('CLAWPILOT_AUTH_MAIL_FROM'))
}
for (const configurationSource of [
  read('scripts/start-railway.sh'),
  read('scripts/validate-runtime-config.mjs'),
  read('scripts/verify-mail-sender.mjs'),
  read('app_src/lib/matonMail.ts'),
]) {
  assert.ok(configurationSource.includes('MATON_AUTH_GMAIL_CONNECTION_ID must differ from MATON_GMAIL_CONNECTION_ID'))
  assert.ok(!configurationSource.includes('CLAWPILOT_AUTH_MAIL_FROM must differ from CLAWPILOT_MAIL_FROM'))
}
assert.ok(!read('app_src/app/api/health/route.ts').includes(
  'Hosted runtime authentication mail sender must differ from the platform mail sender.',
))

const nativeAuthAdapter = read('clients/apple/Sources/ClawPilotPickingApple/AppleAdapters.swift')
for (const fragment of [
  'case serviceUnavailable(statusCode: Int, retryAfterSeconds: Int?)',
  'request.setValue("application/json", forHTTPHeaderField: "Accept")',
  'if [502, 503, 504].contains(http.statusCode), envelope == nil',
  'ClawPilot is temporarily unavailable. Try again shortly.',
]) {
  assert.ok(nativeAuthAdapter.includes(fragment), `native auth adapter missing ${fragment}`)
}
const nativePhoneModel = read('clients/apple/Apps/iPhone/ClawPilotPickingPhoneApp.swift')
assert.ok(nativePhoneModel.includes('error.isInvalidMagicCode'))
assert.ok(nativePhoneModel.includes('That code is invalid or expired. Check the code or request a new one.'))
assert.ok(nativePhoneModel.includes('Code verification failed: \\(error.localizedDescription)'))

const nextServerMock = {
  NextResponse: {
    json(payload, init = {}) {
      return Response.json(payload, init)
    },
  },
}
const requestRouteState = { result: { status: 'sent' }, error: null }
const requestRouteModule = loadTypeScriptModule('app_src/app/api/auth/magic/request/route.ts', {
  'next/server': nextServerMock,
  '@/lib/authMagicCode': {
    async requestAuthMagicCode() {
      if (requestRouteState.error) throw requestRouteState.error
      return requestRouteState.result
    },
  },
  '@/lib/authAudit': { async recordAuthActivity() {} },
})

const verifyRouteState = { result: { status: 'invalid' }, error: null }
const verifyRouteModule = loadTypeScriptModule('app_src/app/api/auth/magic/verify/route.ts', {
  'next/server': nextServerMock,
  '@/lib/authSessions': {
    async createBrowserSession() { return { token: 'test-session' } },
    setBrowserSessionCookie() {},
  },
  '@/lib/authAudit': { async recordAuthActivity() {} },
  '@/lib/authMagicCode': {
    async verifyAuthMagicCode() {
      if (verifyRouteState.error) throw verifyRouteState.error
      return verifyRouteState.result
    },
  },
  '@/lib/pipelineProvisioning': { async queuePipelineProvisioning() {} },
  '@/lib/persistence/crm': { async syncAppUserProfileToOwnedPipelines() {} },
  '@/lib/tenancy': { async ensureDefaultResourcesForUser() { return { pipelineProvisioningRequired: false } } },
  '@/lib/workspaceMemberships': {
    async requireWorkspaceAppUser(email, organizationId) {
      return { email, organizationId }
    },
  },
})

function authRequest(path, body, forwardedFor) {
  return new Request(`https://auth-route.test${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-forwarded-for': forwardedFor,
    },
    body,
  })
}

async function assertAuthResponse(response, expectedStatus, expectedCode) {
  assert.equal(response.status, expectedStatus)
  assert.equal(response.headers.get('cache-control'), 'private, no-store, max-age=0')
  assert.equal(response.headers.get('pragma'), 'no-cache')
  assert.equal(response.headers.get('expires'), '0')
  assert.match(response.headers.get('vary') || '', /Cookie/i)
  const payload = await response.json()
  assert.equal(payload.code, expectedCode)
  return payload
}

await assertAuthResponse(
  await requestRouteModule.exports.POST(authRequest('/api/auth/magic/request', '{', 'request-malformed')),
  400,
  'AUTH_MAGIC_REQUEST_INVALID',
)
await assertAuthResponse(
  await requestRouteModule.exports.POST(authRequest('/api/auth/magic/request', JSON.stringify({ email: 'invalid' }), 'request-invalid-email')),
  400,
  'AUTH_MAGIC_EMAIL_INVALID',
)
requestRouteState.result = { status: 'unavailable' }
await assertAuthResponse(
  await requestRouteModule.exports.POST(authRequest('/api/auth/magic/request', JSON.stringify({ email: 'picker@example.com' }), 'request-unavailable')),
  503,
  'AUTH_MAGIC_DELIVERY_UNAVAILABLE',
)
requestRouteState.result = { status: 'sent' }
for (let attempt = 0; attempt < 5; attempt += 1) {
  const response = await requestRouteModule.exports.POST(
    authRequest('/api/auth/magic/request', JSON.stringify({ email: 'picker@example.com' }), 'request-rate-limit'),
  )
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'private, no-store, max-age=0')
}
const limitedResponse = await requestRouteModule.exports.POST(
  authRequest('/api/auth/magic/request', JSON.stringify({ email: 'picker@example.com' }), 'request-rate-limit'),
)
await assertAuthResponse(limitedResponse, 429, 'AUTH_MAGIC_RATE_LIMITED')
assert.match(limitedResponse.headers.get('retry-after') || '', /^\d+$/)

await assertAuthResponse(
  await verifyRouteModule.exports.POST(authRequest('/api/auth/magic/verify', '{', 'verify-malformed')),
  400,
  'AUTH_MAGIC_REQUEST_INVALID',
)
await assertAuthResponse(
  await verifyRouteModule.exports.POST(authRequest('/api/auth/magic/verify', JSON.stringify({ email: 'picker@example.com', code: '12' }), 'verify-invalid-input')),
  401,
  'AUTH_MAGIC_CODE_INVALID',
)
verifyRouteState.result = { status: 'invalid' }
await assertAuthResponse(
  await verifyRouteModule.exports.POST(authRequest('/api/auth/magic/verify', JSON.stringify({ email: 'picker@example.com', code: '123456' }), 'verify-invalid-code')),
  401,
  'AUTH_MAGIC_CODE_INVALID',
)
verifyRouteState.error = new Error('database unavailable')
const originalConsoleError = console.error
try {
  console.error = () => {}
  await assertAuthResponse(
    await verifyRouteModule.exports.POST(authRequest('/api/auth/magic/verify', JSON.stringify({ email: 'picker@example.com', code: '123456' }), 'verify-unavailable')),
    503,
    'AUTH_MAGIC_VERIFICATION_UNAVAILABLE',
  )
} finally {
  console.error = originalConsoleError
}
verifyRouteState.error = null
verifyRouteState.result = {
  status: 'verified',
  email: 'picker@example.com',
  organizationId: '10000000-0000-4000-8000-000000000001',
}
const verifiedResponse = await verifyRouteModule.exports.POST(
  authRequest('/api/auth/magic/verify', JSON.stringify({ email: 'picker@example.com', code: '123456' }), 'verify-success'),
)
assert.equal(verifiedResponse.status, 200)
assert.equal(verifiedResponse.headers.get('cache-control'), 'private, no-store, max-age=0')
assert.deepEqual(await verifiedResponse.json(), { ok: true })

const originalEnv = {
  APP_LOGIN_EMAIL: process.env.APP_LOGIN_EMAIL,
  APP_SESSION_SECRET: process.env.APP_SESSION_SECRET,
  MATON_GMAIL_CONNECTION_ID: process.env.MATON_GMAIL_CONNECTION_ID,
  MATON_AUTH_GMAIL_CONNECTION_ID: process.env.MATON_AUTH_GMAIL_CONNECTION_ID,
  CLAWPILOT_MAIL_FROM: process.env.CLAWPILOT_MAIL_FROM,
  CLAWPILOT_AUTH_MAIL_FROM: process.env.CLAWPILOT_AUTH_MAIL_FROM,
  CLAWPILOT_PUBLIC_URL: process.env.CLAWPILOT_PUBLIC_URL,
  NODE_ENV: process.env.NODE_ENV,
}

try {
  process.env.APP_LOGIN_EMAIL = 'operator@example.com'
  process.env.APP_SESSION_SECRET = 'test-session-secret-with-at-least-32-characters'
  process.env.MATON_GMAIL_CONNECTION_ID = 'test-gmail-connection'
  process.env.CLAWPILOT_MAIL_FROM = 'stewards@eigenracing.com'
  delete process.env.MATON_AUTH_GMAIL_CONNECTION_ID
  delete process.env.CLAWPILOT_AUTH_MAIL_FROM
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

      if (
        sql.includes('FROM app_user_invitations AS invitation')
        && sql.includes('FOR UPDATE OF invitation')
      ) {
        return invitationValid && values[0] === '10000000-0000-4000-8000-000000000001'
          ? {
            rows: [{
              id: values[0],
              workspace_organization_id: invitationOrganizationId,
              assigned_organization_ids: [
                invitationOrganizationId,
                ...activeInvitationAdditionalOrganizationIds,
              ],
            }],
            rowCount: 1,
          }
          : { rows: [], rowCount: 0 }
      }

      if (sql.includes('SELECT email') && sql.includes('FROM app_users')) {
        return values[0] === 'invited@example.com'
          ? { rows: [{ email: values[0] }], rowCount: 1 }
          : { rows: [], rowCount: 0 }
      }

      if (
        sql.includes('SELECT organization_id::text, status')
        && sql.includes('FOR UPDATE')
      ) {
        return {
          rows: values[1].map((organizationId) => ({
            organization_id: organizationId,
            status: 'invited',
          })),
          rowCount: values[1].length,
        }
      }

      if (sql.includes('UPDATE app_user_organization_memberships')) {
        const organizationIds = Array.isArray(values[1]) ? values[1] : []
        if (
          values[0] === 'invited@example.com'
          && organizationIds.includes(invitationOrganizationId)
        ) {
          const seen = new Set()
          for (const organizationId of organizationIds) {
            if (typeof organizationId !== 'string' || seen.has(organizationId)) continue
            seen.add(organizationId)
            activatedMemberships.push({ email: values[0], organizationId })
          }
          return { rows: organizationIds.map((organizationId) => ({ organization_id: organizationId })), rowCount: organizationIds.length }
        }
        return { rows: [], rowCount: 0 }
      }

      if (sql.includes('UPDATE app_user_invitations')) {
        return invitationValid
          ? { rows: [{ id: values[0] }], rowCount: 1 }
          : { rows: [], rowCount: 0 }
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
  assert.ok(authModule.source.includes('FOR UPDATE OF invitation'))
  assert.ok(authModule.source.includes('invitedUser.rowCount !== 1'))
  assert.ok(authModule.source.includes('min(candidate.position) AS position'))
  assert.ok(authModule.source.includes('cardinality(assigned.organization_ids) > 0'))
  assert.ok(authModule.source.includes('membership.status <> \'invited\''))
  assert.ok(authModule.source.includes('lockedMemberships.rowCount !== inviteOrganizationIds.length'))
  const invitationActivationSource = authModule.source.slice(
    authModule.source.indexOf('const activatedMembership'),
    authModule.source.indexOf('const activated ='),
  )
  assert.ok(invitationActivationSource.includes('AND organization_id = ANY($2::uuid[])'))
  assert.ok(!invitationActivationSource.includes('ANY($3::uuid[])'))
  assert.ok(invitationActivationSource.includes('activatedMembership.rowCount !== inviteOrganizationIds.length'))
  assert.ok(
    authModule.source.indexOf('const activatedMembership')
      < authModule.source.indexOf('const accepted ='),
  )
  assert.ok(authModule.source.includes('workspace_organization_ids'))
  assert.ok(authModule.source.includes('assigned.organization_ids::uuid[]'))
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
  let authTransportFailure = null
  let authTransportStatus = null
  let authSenderVerification = 'accepted'
  let platformMailboxEmail = 'workspace@example.com'
  let authMailboxEmail = 'jarrettcrosby@gmail.com'
  const mockMatonMailFetch = async (profile, pathname, init) => {
    matonCalls.push({ profile, pathname, init })
    if (profile === 'auth' && authTransportFailure) throw authTransportFailure
    if (profile === 'auth' && authTransportStatus) {
      return new Response('{}', { status: authTransportStatus })
    }
    if (pathname.endsWith('/users/me/profile')) {
      return Response.json({
        emailAddress: profile === 'auth' ? authMailboxEmail : platformMailboxEmail,
      })
    }
    if (pathname.includes('/settings/sendAs/')) {
      const requestedSender = decodeURIComponent(pathname.split('/').at(-1))
      const authVerificationStatus = ['empty', 'primary'].includes(authSenderVerification)
        ? ''
        : authSenderVerification
      return new Response(JSON.stringify({
        isPrimary: profile === 'auth' && authSenderVerification === 'primary',
        sendAsEmail: requestedSender,
        verificationStatus: profile === 'auth' ? authVerificationStatus : 'accepted',
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    return new Response(JSON.stringify({ id: 'gmail-message-id' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  const mailModule = loadTypeScriptModule('app_src/lib/matonMail.ts', {
    '@/lib/maton': {
      async matonAuthMailFetch(pathname, init) {
        return mockMatonMailFetch('auth', pathname, init)
      },
      async matonPlatformMailFetch(pathname, init) {
        return mockMatonMailFetch('platform', pathname, init)
      },
    },
    '@/lib/publicUrl': {
      appPublicUrl() { return 'https://aiapp.eigenracing.com' },
    },
    '@/lib/persistence/config': {
      isHostedRuntime() { return false },
    },
  })

  function loadFocusedMailHarness({
    platformMailbox,
    authMailbox,
    lookupDelayMs = 0,
    authProfileFailures = 0,
    authSenderFailures = 0,
  }) {
    const calls = []
    let remainingAuthProfileFailures = authProfileFailures
    let remainingAuthSenderFailures = authSenderFailures
    const waitForLookup = async () => {
      if (lookupDelayMs > 0) await new Promise((resolveDelay) => setTimeout(resolveDelay, lookupDelayMs))
    }
    const mockFetch = async (profile, pathname, init) => {
      calls.push({ profile, pathname, init })
      if (pathname.endsWith('/users/me/profile')) {
        await waitForLookup()
        if (profile === 'auth' && remainingAuthProfileFailures > 0) {
          remainingAuthProfileFailures -= 1
          return new Response('{}', { status: 503 })
        }
        return Response.json({
          emailAddress: profile === 'auth' ? authMailbox : platformMailbox,
        })
      }
      if (pathname.includes('/settings/sendAs/')) {
        await waitForLookup()
        if (profile === 'auth' && remainingAuthSenderFailures > 0) {
          remainingAuthSenderFailures -= 1
          return new Response('{}', { status: 503 })
        }
        const requestedSender = decodeURIComponent(pathname.split('/').at(-1))
        return Response.json({
          isPrimary: false,
          sendAsEmail: requestedSender,
          verificationStatus: 'accepted',
        })
      }
      return Response.json({ id: 'focused-gmail-message-id' })
    }
    const loaded = loadTypeScriptModule('app_src/lib/matonMail.ts', {
      '@/lib/maton': {
        async matonAuthMailFetch(pathname, init) {
          return mockFetch('auth', pathname, init)
        },
        async matonPlatformMailFetch(pathname, init) {
          return mockFetch('platform', pathname, init)
        },
      },
      '@/lib/publicUrl': {
        appPublicUrl() { return 'https://aiapp.eigenracing.com' },
      },
      '@/lib/persistence/config': {
        isHostedRuntime() { return false },
      },
    })
    return { calls, mail: loaded.exports }
  }

  const mailResult = await mailModule.exports.sendAuthMagicCodeEmail({
    to: 'operator@example.com',
    code: '123456',
  })
  assert.equal(mailResult.messageId, 'gmail-message-id')
  assert.ok(!Object.hasOwn(mailResult, 'code'))
  assert.equal(matonCalls.length, 2)
  assert.equal(matonCalls[0].profile, 'auth')
  assert.equal(matonCalls[1].profile, 'auth')
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

  process.env.MATON_AUTH_GMAIL_CONNECTION_ID = 'personal-auth-gmail-connection'
  await assert.rejects(
    mailModule.exports.sendAuthMagicCodeEmail({
      to: 'operator@example.com',
      code: '234567',
    }),
    /MATON_AUTH_GMAIL_CONNECTION_ID and CLAWPILOT_AUTH_MAIL_FROM must be configured together/,
  )
  assert.equal(matonCalls.length, 2)

  process.env.CLAWPILOT_AUTH_MAIL_FROM = 'JarrettCrosby@gmail.com'
  process.env.MATON_AUTH_GMAIL_CONNECTION_ID = process.env.MATON_GMAIL_CONNECTION_ID
  await assert.rejects(
    mailModule.exports.sendAuthMagicCodeEmail({
      to: 'operator@example.com',
      code: '234567',
    }),
    /MATON_AUTH_GMAIL_CONNECTION_ID must differ from MATON_GMAIL_CONNECTION_ID/,
  )
  assert.equal(matonCalls.length, 2)

  process.env.MATON_AUTH_GMAIL_CONNECTION_ID = 'personal-auth-gmail-connection'
  process.env.CLAWPILOT_AUTH_MAIL_FROM = ' STEWARDS@EIGENRACING.COM '
  const dedicatedAuthMailResult = await mailModule.exports.sendAuthMagicCodeEmail({
    to: 'operator@example.com',
    code: '234567',
  })
  assert.equal(dedicatedAuthMailResult.messageId, 'gmail-message-id')
  const dedicatedAuthCalls = matonCalls.slice(2)
  assert.equal(dedicatedAuthCalls.length, 4)
  assert.deepEqual(
    dedicatedAuthCalls.slice(0, 2).map((call) => [call.profile, call.pathname]).sort(),
    [
      ['auth', '/google-mail/gmail/v1/users/me/profile'],
      ['platform', '/google-mail/gmail/v1/users/me/profile'],
    ],
  )
  assert.equal(dedicatedAuthCalls[2].profile, 'auth')
  assert.match(dedicatedAuthCalls[2].pathname, /\/settings\/sendAs\/stewards%40eigenracing\.com$/)
  assert.equal(dedicatedAuthCalls[3].profile, 'auth')
  assert.equal(dedicatedAuthCalls[3].pathname, '/google-mail/gmail/v1/users/me/messages/send')
  const dedicatedAuthPayload = JSON.parse(dedicatedAuthCalls[3].init.body)
  const dedicatedAuthMessage = decodeBase64Url(dedicatedAuthPayload.raw)
  assert.match(dedicatedAuthMessage, /From: ClawPilot Stewards <stewards@eigenracing\.com>/)
  assert.match(dedicatedAuthMessage, /234567/)

  const callsBeforeVisibleAliasRecipient = matonCalls.length
  await mailModule.exports.sendAuthMagicCodeEmail({
    to: ' STEWARDS@EIGENRACING.COM ',
    code: '345678',
  })
  const visibleAliasRecipientCalls = matonCalls.slice(callsBeforeVisibleAliasRecipient)
  assert.equal(visibleAliasRecipientCalls.length, 1)
  assert.equal(visibleAliasRecipientCalls[0].profile, 'auth')
  assert.equal(visibleAliasRecipientCalls[0].pathname, '/google-mail/gmail/v1/users/me/messages/send')

  const callsBeforeSelfAddressedCode = matonCalls.length
  const selfAddressedAuthMailResult = await mailModule.exports.sendAuthMagicCodeEmail({
    to: ' JARRETTCROSBY@GMAIL.COM ',
    code: '456789',
  })
  assert.equal(selfAddressedAuthMailResult.messageId, 'gmail-message-id')
  const selfAddressedCalls = matonCalls.slice(callsBeforeSelfAddressedCode)
  assert.equal(selfAddressedCalls.length, 2)
  assert.ok(selfAddressedCalls.every((call) => call.profile === 'platform'))
  assert.match(selfAddressedCalls[0].pathname, /\/settings\/sendAs\/stewards%40eigenracing\.com$/)
  assert.equal(selfAddressedCalls[1].pathname, '/google-mail/gmail/v1/users/me/messages/send')
  const selfAddressedPayload = JSON.parse(selfAddressedCalls[1].init.body)
  const selfAddressedMessage = decodeBase64Url(selfAddressedPayload.raw)
  assert.match(selfAddressedMessage, /From: ClawPilot Stewards <stewards@eigenracing\.com>/)
  assert.match(selfAddressedMessage, /To: <JARRETTCROSBY@GMAIL\.COM>/)

  process.env.MATON_GMAIL_CONNECTION_ID = 'consumer-routing-platform-connection'
  process.env.MATON_AUTH_GMAIL_CONNECTION_ID = 'consumer-routing-auth-connection'
  process.env.CLAWPILOT_AUTH_MAIL_FROM = 'stewards@eigenracing.com'
  const consumerRouting = loadFocusedMailHarness({
    platformMailbox: 'workspace@example.com',
    authMailbox: 'jarrett.crosby@gmail.com',
  })
  await consumerRouting.mail.sendAuthMagicCodeEmail({
    to: ' J.A.R.R.E.T.T.C.R.O.S.B.Y+ClawPilot@GOOGLEMAIL.COM ',
    code: '456780',
  })
  const consumerRoutingSend = consumerRouting.calls.find((call) => call.pathname.endsWith('/messages/send'))
  assert.equal(consumerRoutingSend.profile, 'platform')

  process.env.MATON_GMAIL_CONNECTION_ID = 'workspace-routing-platform-connection'
  process.env.MATON_AUTH_GMAIL_CONNECTION_ID = 'workspace-routing-auth-connection'
  const workspaceRouting = loadFocusedMailHarness({
    platformMailbox: 'platform@example.com',
    authMailbox: 'Jarrett@bposupplychain.com',
  })
  await workspaceRouting.mail.sendAuthMagicCodeEmail({
    to: ' JARRETT+ClawPilot@BPOSUPPLYCHAIN.COM ',
    code: '456781',
  })
  const workspaceRoutingSend = workspaceRouting.calls.find((call) => call.pathname.endsWith('/messages/send'))
  assert.equal(workspaceRoutingSend.profile, 'platform')

  process.env.MATON_GMAIL_CONNECTION_ID = 'workspace-dot-platform-connection'
  process.env.MATON_AUTH_GMAIL_CONNECTION_ID = 'workspace-dot-auth-connection'
  const workspaceDotRouting = loadFocusedMailHarness({
    platformMailbox: 'platform@example.com',
    authMailbox: 'jarrett.crosby@bposupplychain.com',
  })
  await workspaceDotRouting.mail.sendAuthMagicCodeEmail({
    to: 'jarrettcrosby@bposupplychain.com',
    code: '456782',
  })
  const workspaceDotRoutingSend = workspaceDotRouting.calls.find((call) => call.pathname.endsWith('/messages/send'))
  assert.equal(workspaceDotRoutingSend.profile, 'auth')

  process.env.MATON_GMAIL_CONNECTION_ID = 'gmail-equivalent-platform-connection'
  process.env.MATON_AUTH_GMAIL_CONNECTION_ID = 'gmail-equivalent-auth-connection'
  const gmailEquivalentAccounts = loadFocusedMailHarness({
    platformMailbox: 'j.arrett@gmail.com',
    authMailbox: 'jarrett@googlemail.com',
  })
  await assert.rejects(
    gmailEquivalentAccounts.mail.sendAuthMagicCodeEmail({
      to: 'operator@example.com',
      code: '456783',
    }),
    /Authentication Gmail account must differ from platform Gmail account/,
  )
  assert.ok(gmailEquivalentAccounts.calls.every((call) => !call.pathname.endsWith('/messages/send')))

  process.env.MATON_GMAIL_CONNECTION_ID = 'single-flight-platform-connection'
  process.env.MATON_AUTH_GMAIL_CONNECTION_ID = 'single-flight-auth-connection'
  const singleFlight = loadFocusedMailHarness({
    platformMailbox: 'workspace@example.com',
    authMailbox: 'jarrettcrosby@gmail.com',
    lookupDelayMs: 5,
  })
  await Promise.all(Array.from({ length: 4 }, (_, index) => (
    singleFlight.mail.sendAuthMagicCodeEmail({
      to: `operator-${index}@example.com`,
      code: `45679${index}`,
    })
  )))
  assert.equal(singleFlight.calls.filter((call) => call.pathname.endsWith('/users/me/profile')).length, 2)
  assert.equal(singleFlight.calls.filter((call) => call.pathname.includes('/settings/sendAs/')).length, 1)
  assert.equal(singleFlight.calls.filter((call) => call.pathname.endsWith('/messages/send')).length, 4)
  await singleFlight.mail.sendAuthMagicCodeEmail({
    to: 'cached-operator@example.com',
    code: '456794',
  })
  assert.equal(singleFlight.calls.filter((call) => call.pathname.endsWith('/users/me/profile')).length, 2)
  assert.equal(singleFlight.calls.filter((call) => call.pathname.includes('/settings/sendAs/')).length, 1)

  process.env.MATON_GMAIL_CONNECTION_ID = 'profile-recovery-platform-connection'
  process.env.MATON_AUTH_GMAIL_CONNECTION_ID = 'profile-recovery-auth-connection'
  const profileRecovery = loadFocusedMailHarness({
    platformMailbox: 'workspace@example.com',
    authMailbox: 'jarrettcrosby@gmail.com',
    lookupDelayMs: 5,
    authProfileFailures: 1,
  })
  const failedProfileRequests = await Promise.allSettled([
    profileRecovery.mail.sendAuthMagicCodeEmail({ to: 'first@example.com', code: '456795' }),
    profileRecovery.mail.sendAuthMagicCodeEmail({ to: 'second@example.com', code: '456796' }),
  ])
  assert.ok(failedProfileRequests.every((result) => result.status === 'rejected'))
  assert.equal(profileRecovery.calls.filter((call) => call.profile === 'auth' && call.pathname.endsWith('/users/me/profile')).length, 1)
  await profileRecovery.mail.sendAuthMagicCodeEmail({
    to: 'retry@example.com',
    code: '456797',
  })
  assert.equal(profileRecovery.calls.filter((call) => call.profile === 'auth' && call.pathname.endsWith('/users/me/profile')).length, 2)
  assert.equal(profileRecovery.calls.filter((call) => call.pathname.endsWith('/messages/send')).length, 1)

  process.env.MATON_GMAIL_CONNECTION_ID = 'sender-recovery-platform-connection'
  process.env.MATON_AUTH_GMAIL_CONNECTION_ID = 'sender-recovery-auth-connection'
  const senderRecovery = loadFocusedMailHarness({
    platformMailbox: 'workspace@example.com',
    authMailbox: 'jarrettcrosby@gmail.com',
    lookupDelayMs: 5,
    authSenderFailures: 1,
  })
  const failedSenderRequests = await Promise.allSettled([
    senderRecovery.mail.sendAuthMagicCodeEmail({ to: 'first@example.com', code: '456798' }),
    senderRecovery.mail.sendAuthMagicCodeEmail({ to: 'second@example.com', code: '456799' }),
  ])
  assert.ok(failedSenderRequests.every((result) => result.status === 'rejected'))
  assert.equal(senderRecovery.calls.filter((call) => call.pathname.includes('/settings/sendAs/')).length, 1)
  await senderRecovery.mail.sendAuthMagicCodeEmail({
    to: 'retry@example.com',
    code: '456800',
  })
  assert.equal(senderRecovery.calls.filter((call) => call.pathname.includes('/settings/sendAs/')).length, 2)
  assert.equal(senderRecovery.calls.filter((call) => call.pathname.endsWith('/messages/send')).length, 1)

  process.env.MATON_GMAIL_CONNECTION_ID = 'test-gmail-connection'
  process.env.MATON_AUTH_GMAIL_CONNECTION_ID = 'rotated-personal-auth-gmail-connection'
  const callsBeforeConnectionRotation = matonCalls.length
  await mailModule.exports.sendAuthMagicCodeEmail({
    to: 'operator@example.com',
    code: '567890',
  })
  const rotatedConnectionCalls = matonCalls.slice(callsBeforeConnectionRotation)
  assert.equal(rotatedConnectionCalls.length, 3)
  assert.ok(rotatedConnectionCalls.every((call) => call.profile === 'auth'))
  assert.equal(rotatedConnectionCalls[0].pathname, '/google-mail/gmail/v1/users/me/profile')
  assert.match(rotatedConnectionCalls[1].pathname, /\/settings\/sendAs\/stewards%40eigenracing\.com$/)
  assert.equal(rotatedConnectionCalls[2].pathname, '/google-mail/gmail/v1/users/me/messages/send')

  process.env.MATON_AUTH_GMAIL_CONNECTION_ID = 'primary-empty-auth-gmail-connection'
  process.env.CLAWPILOT_AUTH_MAIL_FROM = 'jarrettcrosby@gmail.com'
  authSenderVerification = 'primary'
  const callsBeforePrimarySender = matonCalls.length
  await mailModule.exports.sendAuthMagicCodeEmail({
    to: 'operator@example.com',
    code: '567890',
  })
  const primarySenderCalls = matonCalls.slice(callsBeforePrimarySender)
  assert.equal(primarySenderCalls.length, 3)
  assert.ok(primarySenderCalls.every((call) => call.profile === 'auth'))
  assert.equal(primarySenderCalls[0].pathname, '/google-mail/gmail/v1/users/me/profile')
  assert.match(primarySenderCalls[1].pathname, /\/settings\/sendAs\/jarrettcrosby%40gmail\.com$/)
  assert.equal(primarySenderCalls[2].pathname, '/google-mail/gmail/v1/users/me/messages/send')

  process.env.MATON_AUTH_GMAIL_CONNECTION_ID = 'non-primary-empty-auth-gmail-connection'
  process.env.CLAWPILOT_AUTH_MAIL_FROM = 'stewards@eigenracing.com'
  authSenderVerification = 'empty'
  const callsBeforeUnverifiedSender = matonCalls.length
  const platformCallsBeforeUnverifiedSender = matonCalls.filter((call) => call.profile === 'platform').length
  await assert.rejects(
    mailModule.exports.sendAuthMagicCodeEmail({
      to: 'operator@example.com',
      code: '678901',
    }),
    /Authentication mail sender is not verified/,
  )
  const unverifiedSenderCalls = matonCalls.slice(callsBeforeUnverifiedSender)
  assert.equal(unverifiedSenderCalls.length, 2)
  assert.ok(unverifiedSenderCalls.every((call) => call.profile === 'auth'))
  assert.equal(unverifiedSenderCalls[0].pathname, '/google-mail/gmail/v1/users/me/profile')
  assert.match(unverifiedSenderCalls[1].pathname, /\/settings\/sendAs\/stewards%40eigenracing\.com$/)
  assert.equal(matonCalls.filter((call) => call.profile === 'platform').length, platformCallsBeforeUnverifiedSender)

  process.env.MATON_AUTH_GMAIL_CONNECTION_ID = 'non-primary-pending-auth-gmail-connection'
  authSenderVerification = 'pending'
  const callsBeforePendingSender = matonCalls.length
  await assert.rejects(
    mailModule.exports.sendAuthMagicCodeEmail({
      to: 'operator@example.com',
      code: '789012',
    }),
    /Authentication mail sender is not verified/,
  )
  const pendingSenderCalls = matonCalls.slice(callsBeforePendingSender)
  assert.equal(pendingSenderCalls.length, 2)
  assert.ok(pendingSenderCalls.every((call) => call.profile === 'auth'))
  assert.equal(pendingSenderCalls[0].pathname, '/google-mail/gmail/v1/users/me/profile')
  assert.match(pendingSenderCalls[1].pathname, /\/settings\/sendAs\/stewards%40eigenracing\.com$/)
  authSenderVerification = 'accepted'

  process.env.MATON_GMAIL_CONNECTION_ID = 'same-mailbox-platform-connection'
  process.env.MATON_AUTH_GMAIL_CONNECTION_ID = 'same-mailbox-auth-connection'
  platformMailboxEmail = 'same-account@gmail.com'
  authMailboxEmail = ' SAME-ACCOUNT@GMAIL.COM '
  const callsBeforeSameMailbox = matonCalls.length
  await assert.rejects(
    mailModule.exports.sendAuthMagicCodeEmail({
      to: 'operator@example.com',
      code: '789012',
    }),
    /Authentication Gmail account must differ from platform Gmail account/,
  )
  const sameMailboxCalls = matonCalls.slice(callsBeforeSameMailbox)
  assert.equal(sameMailboxCalls.length, 2)
  assert.deepEqual(
    sameMailboxCalls.map((call) => [call.profile, call.pathname]).sort(),
    [
      ['auth', '/google-mail/gmail/v1/users/me/profile'],
      ['platform', '/google-mail/gmail/v1/users/me/profile'],
    ],
  )
  assert.ok(sameMailboxCalls.every((call) => !call.pathname.includes('/settings/sendAs/')))
  assert.ok(sameMailboxCalls.every((call) => !call.pathname.endsWith('/messages/send')))

  process.env.MATON_GMAIL_CONNECTION_ID = 'test-gmail-connection'
  process.env.MATON_AUTH_GMAIL_CONNECTION_ID = 'rotated-personal-auth-gmail-connection'
  platformMailboxEmail = 'workspace@example.com'
  authMailboxEmail = 'jarrettcrosby@gmail.com'

  authTransportStatus = 503
  const callsBeforeAuthFailure = matonCalls.length
  const platformCallsBeforeAuthFailure = matonCalls.filter((call) => call.profile === 'platform').length
  await assert.rejects(
    mailModule.exports.sendAuthMagicCodeEmail({
      to: 'operator@example.com',
      code: '890123',
    }),
    /Maton Gmail delivery failed with status 503/,
  )
  const failedAuthCalls = matonCalls.slice(callsBeforeAuthFailure)
  assert.equal(failedAuthCalls.length, 1)
  assert.equal(failedAuthCalls[0].profile, 'auth')
  assert.equal(matonCalls.filter((call) => call.profile === 'platform').length, platformCallsBeforeAuthFailure)
  authTransportStatus = null

  process.env.MATON_AUTH_GMAIL_CONNECTION_ID = 'timed-out-auth-gmail-connection'
  authTransportFailure = new Error('simulated authentication mail transport timeout')
  const callsBeforeAuthTimeout = matonCalls.length
  const platformCallsBeforeAuthTimeout = matonCalls.filter((call) => call.profile === 'platform').length
  await assert.rejects(
    mailModule.exports.sendAuthMagicCodeEmail({
      to: 'operator@example.com',
      code: '901234',
    }),
    /simulated authentication mail transport timeout/,
  )
  const timeoutCalls = matonCalls.slice(callsBeforeAuthTimeout)
  assert.equal(timeoutCalls.length, 1)
  assert.equal(timeoutCalls[0].profile, 'auth')
  assert.equal(matonCalls.filter((call) => call.profile === 'platform').length, platformCallsBeforeAuthTimeout)
  authTransportFailure = null

  const callsBeforeInvitation = matonCalls.length
  await mailModule.exports.sendInvitationEmail({
    to: 'new-user@example.com',
    inviterName: 'Jarrett Crosby',
    welcomeUrl: 'https://aiapp.eigenracing.com/welcome#token=test-token',
    expiresAt: '2026-07-20T12:00:00.000Z',
  })
  const invitationCalls = matonCalls.slice(callsBeforeInvitation)
  assert.equal(invitationCalls.length, 1)
  assert.equal(invitationCalls[0].profile, 'platform')
  assert.equal(invitationCalls[0].pathname, '/google-mail/gmail/v1/users/me/messages/send')
  const invitationPayload = JSON.parse(invitationCalls[0].init.body)
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
