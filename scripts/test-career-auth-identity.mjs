#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'

const appRequire = createRequire(new URL('../app_src/package.json', import.meta.url))
const ts = appRequire('typescript')
function load(path, mocks) {
  const source = readFileSync(path, 'utf8')
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText
  const module = { exports: {} }
  vm.runInNewContext(code, { module, exports: module.exports, process, Buffer, console, URL, Request, Response, Headers, AbortSignal, Date, Map, Set, Error,
    require: (name) => Object.hasOwn(mocks, name) ? mocks[name] : appRequire(name),
  }, { filename: path })
  return module.exports
}
const original = { owner: process.env.APP_LOGIN_EMAIL, aliases: process.env.APP_LOGIN_EMAIL_ALIASES }
try {
  process.env.APP_LOGIN_EMAIL = 'owner@original.example'
  process.env.APP_LOGIN_EMAIL_ALIASES = 'owner@renamed.example'
  const independentAccounts = new Set(['member@gmail.com'])
  const users = {
    normalizeUserEmail: (value) => {
      const email = String(value).trim().toLowerCase()
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || /[^\x21-\x7e]/.test(email)) throw new Error('invalid email')
      return email
    },
    configuredOwnerEmail: () => process.env.APP_LOGIN_EMAIL,
  }
  const aliases = load('app_src/lib/authLoginIdentity.ts', {
    '@/lib/users': users,
    '@/lib/persistence/postgres': { query: async (_sql, [email]) => ({ rows: independentAccounts.has(email) ? [{ email }] : [] }) },
  })
  assert.equal(await aliases.resolveLoginAccountEmail('OWNER@RENAMED.EXAMPLE'), 'owner@original.example')
  assert.equal(await aliases.resolveLoginAccountEmail('member@gmail.com'), 'member@gmail.com')
  assert.equal(await aliases.resolveLoginAccountEmail('stranger@renamed.example'), 'stranger@renamed.example')
  process.env.APP_LOGIN_EMAIL_ALIASES = 'owner@renamed.example,member@gmail.com'
  assert.equal(await aliases.resolveLoginAccountEmail('member@gmail.com'), null)
  process.env.APP_LOGIN_EMAIL_ALIASES = 'owner@renamed.example,owner@renamed.example'
  await assert.rejects(aliases.resolveLoginAccountEmail('owner@renamed.example'), /unique/)
  process.env.APP_LOGIN_EMAIL_ALIASES = 'owner@renamed.example'
  let status = 'active'
  let membership = 'original-membership'
  const queries = []
  const linkedGoogle = load('app_src/lib/persistence/googleIdentityLinking.ts', {
    '@/lib/authLoginIdentity': aliases,
    '@/lib/auditWriter': {},
    '@/lib/googleSso': { GoogleSsoError: class extends Error { constructor(code, message, status) { super(message); this.code = code; this.status = status } } },
    '@/lib/users': users,
    '@/lib/workspaceMemberships': { requireWorkspaceAppUser: async (email, organizationId) => ({ email, organizationId, referenceCode: 'preserved-user-reference' }) },
    '@/lib/persistence/postgres': {
      query: async (sql, [subject, email]) => {
        queries.push({ sql, subject, email })
        assert.match(sql, /identity\.provider_subject = \$1/)
        assert.match(sql, /identity\.verified_email = \$2/)
        return { rows: subject === 'original-google-subject' && email === 'owner@original.example'
          ? [{ user_email: email, user_status: status, organization_id: membership }] : [] }
      },
    },
  })
  const identity = { subject: 'original-google-subject', email: 'owner@renamed.example' }
  const renamed = await linkedGoogle.resolveLinkedGoogleIdentity(identity)
  assert.equal(renamed.email, 'owner@original.example')
  assert.equal(renamed.organizationId, 'original-membership')
  assert.equal(renamed.referenceCode, 'preserved-user-reference')
  await assert.rejects(linkedGoogle.resolveLinkedGoogleIdentity({ ...identity, subject: 'different-google-subject' }), (error) => error.code === 'GOOGLE_SSO_LINK_REQUIRED')
  await assert.rejects(linkedGoogle.resolveLinkedGoogleIdentity({ ...identity, email: 'stranger@renamed.example' }), (error) => error.code === 'GOOGLE_SSO_LINK_REQUIRED')
  status = 'disabled'
  await assert.rejects(linkedGoogle.resolveLinkedGoogleIdentity(identity), (error) => error.code === 'GOOGLE_SSO_ACCESS_DENIED')
  status = 'active'; membership = null
  await assert.rejects(linkedGoogle.resolveLinkedGoogleIdentity(identity), (error) => error.code === 'GOOGLE_SSO_ACCESS_DENIED')
  assert.ok(queries.every(({ sql }) => !/\b(?:UPDATE|INSERT|DELETE)\b/.test(sql)))

  const config = { enabled: true, sourceApp: 'jarrett-career-agents', ownerEmail: 'owner@original.example', organizationId: 'original-organization' }
  let actor = { service: true, ...config }
  let deliveryFails = false
  const deliveries = []
  const route = load('app_src/app/api/career-site/auth/send-code/route.ts', {
    'next/server': { NextResponse: { json: (body, init) => Response.json(body, init) } },
    '@/lib/matonMail': { sendCareerDeskMagicCodeEmail: async (input) => { if (deliveryFails) throw new Error('secret-provider-error'); deliveries.push(input) } },
    '@/lib/users': users,
    '@/lib/careerSiteAgentContract': { resolveCareerSiteAgentConfiguration: () => config },
    '@/lib/shortlinks': { validateShortLinkConfiguration: () => {}, resolveShortLinkActor: async () => actor },
  })
  const request = (body) => new Request('https://clawpilot.test/api/career-site/auth/send-code', { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) })
  const valid = { email: 'owner@renamed.example', code: '123456' }
  for (const override of [{ service: false }, { ownerEmail: 'other@example.com' }, { sourceApp: 'another-app' }, { organizationId: 'another-organization' }]) {
    actor = { service: true, ...config, ...override }
    assert.equal((await route.POST(request(valid))).status, 403)
  }
  actor = { service: true, ...config }
  for (const invalid of [{ ...valid, code: 123456 }, { ...valid, code: '12345' }, { ...valid, email: 'bad\r\nBcc:x@example.com' }, { ...valid, text: 'arbitrary email content' }, 'not json', 'x'.repeat(3000)]) {
    assert.equal((await route.POST(request(invalid))).status, 400)
  }
  assert.equal(deliveries.length, 0)
  const sent = await route.POST(request(valid))
  assert.equal(sent.status, 200)
  assert.deepEqual(await sent.json(), { ok: true })
  assert.match(sent.headers.get('cache-control'), /no-store/)
  assert.equal(deliveries.length, 1)
  assert.equal(deliveries[0].to, valid.email)
  assert.equal((await route.POST(request(valid))).status, 429)
  assert.equal(deliveries.length, 1)
  deliveryFails = true
  const failed = await route.POST(request({ ...valid, email: 'invited@example.com' }))
  assert.equal(failed.status, 503)
  assert.deepEqual(await failed.json(), { ok: false })

  const proxy = readFileSync('app_src/proxy.ts', 'utf8')
  assert.ok(proxy.includes("normalizedPath === '/api/career-site/auth/send-code'"), 'The private bridge authenticates in its handler without a browser session')
  console.log('PASS test-career-auth-identity: exact aliases, preserved Google identity, independent-account collision, bridge auth, bounded input, rate limit and delivery failure')
} finally {
  if (original.owner === undefined) delete process.env.APP_LOGIN_EMAIL; else process.env.APP_LOGIN_EMAIL = original.owner
  if (original.aliases === undefined) delete process.env.APP_LOGIN_EMAIL_ALIASES; else process.env.APP_LOGIN_EMAIL_ALIASES = original.aliases
}
