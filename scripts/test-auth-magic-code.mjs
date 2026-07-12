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

const originalEnv = {
  APP_LOGIN_EMAIL: process.env.APP_LOGIN_EMAIL,
  APP_SESSION_SECRET: process.env.APP_SESSION_SECRET,
  MATON_GMAIL_CONNECTION_ID: process.env.MATON_GMAIL_CONNECTION_ID,
  NODE_ENV: process.env.NODE_ENV,
}

try {
  process.env.APP_LOGIN_EMAIL = 'operator@example.com'
  process.env.APP_SESSION_SECRET = 'test-session-secret-with-at-least-32-characters'
  process.env.MATON_GMAIL_CONNECTION_ID = 'test-gmail-connection'
  process.env.NODE_ENV = 'test'

  let now = Date.parse('2026-07-12T12:00:00.000Z')
  let sequence = 0
  let record = null
  const delivered = []
  let deliveryShouldFail = false

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
        return { rows: [{ status, attempts: record.attempts }], rowCount: 1 }
      }

      throw new Error('Unexpected transactional query in focused auth test')
    },
  }

  const persistenceMock = {
    async withTransaction(fn) {
      return fn(fakeClient)
    },
    async query(sql, values) {
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

  const authModule = loadTypeScriptModule('app_src/lib/authMagicCode.ts', {
    '@/lib/matonMail': mailMock,
    '@/lib/persistence/postgres': persistenceMock,
  })
  const { requestAuthMagicCode, verifyAuthMagicCode } = authModule.exports

  assert.ok(authModule.source.includes('crypto.randomInt(0, 1_000_000)'))
  assert.ok(authModule.source.includes("createHmac('sha256'"))
  assert.ok(authModule.source.includes("interval '15 minutes'"))
  assert.ok(authModule.source.includes("interval '60 seconds'"))
  assert.ok(authModule.source.includes('FOR UPDATE'))
  assert.ok(!authModule.source.includes('console.'))

  const unauthorized = await requestAuthMagicCode({ email: 'other@example.com' })
  assert.equal(unauthorized.status, 'not-authorized')
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
      async matonFetch(pathname, init) {
        matonCalls.push({ pathname, init })
        return new Response(JSON.stringify({ id: 'gmail-message-id' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      },
    },
  })
  const mailResult = await mailModule.exports.sendAuthMagicCodeEmail({
    to: 'operator@example.com',
    code: '123456',
  })
  assert.equal(mailResult.messageId, 'gmail-message-id')
  assert.ok(!Object.hasOwn(mailResult, 'code'))
  assert.equal(matonCalls.length, 1)
  assert.equal(matonCalls[0].pathname, '/google-mail/gmail/v1/users/me/messages/send')
  assert.equal(matonCalls[0].init.method, 'POST')
  assert.equal(matonCalls[0].init.headers['Maton-Connection'], 'test-gmail-connection')
  const mailPayload = JSON.parse(matonCalls[0].init.body)
  const decodedMessage = decodeBase64Url(mailPayload.raw)
  assert.match(decodedMessage, /Content-Type: multipart\/alternative/)
  assert.match(decodedMessage, /Content-Type: text\/plain/)
  assert.match(decodedMessage, /Content-Type: text\/html/)
  assert.match(decodedMessage, /ClawPilot/)
  assert.match(decodedMessage, /123456/)
  assert.match(decodedMessage, /^[\x00-\x7f]*$/)
  assert.ok(!mailModule.source.includes('console.'))

  console.log('PASS test-auth-magic-code')
} finally {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}
