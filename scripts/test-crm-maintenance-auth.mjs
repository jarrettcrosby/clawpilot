#!/usr/bin/env node
// Real auth/lookup code with synthetic HTTP and a write-denying fixture DAL.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'

const requireFromApp = createRequire(new URL('../app_src/package.json', import.meta.url))
const ts = requireFromApp('typescript')
const email = 'operator@smoke-fixture.test'
const memberEmail = 'member@smoke-fixture.test'
const operatorSecret = 'fixture-operator-secret-at-least-32-characters'
const password = 'fixture-password'
const workspaceId = '11111111-1111-4111-8111-111111111111'
const runtime = { env: {
  APP_LOGIN_EMAIL: email,
  PIPELINE_OUTBOX_WORKER_SECRET: operatorSecret,
  CLAWPILOT_CRM_SYNC_MAINTENANCE: '1',
} }

function load(path, imports) {
  const source = readFileSync(new URL('../' + path, import.meta.url), 'utf8')
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      esModuleInterop: true,
    },
  })
  const module = { exports: {} }
  vm.runInNewContext(outputText, {
    module, exports: module.exports, process: runtime, Buffer, console,
    require(id) {
      return Object.hasOwn(imports, id) ? imports[id] : requireFromApp(id)
    },
  }, { filename: path })
  return module.exports
}

const ownerRow = { email, role: 'owner', status: 'active', crm_user_enabled: true, permissions: {} }
let owner = { ...ownerRow }
const member = { email: memberEmail, role: 'member', status: 'active', crm_user_enabled: false, permissions: {} }
const calls = []
const users = load('app_src/lib/users.ts', {
  '@/lib/persistence/postgres': {
    async query(sql, values) {
      const normalized = sql.trim()
      if (normalized === 'SELECT * FROM app_users WHERE email = $1') {
        calls.push('lookup:' + values[0])
        const row = values[0] === email ? owner : values[0] === memberEmail ? member : null
        return { rows: row ? [row] : [] }
      }
      assert.match(normalized, /^INSERT INTO app_users/u)
      assert.notEqual(runtime.env.CLAWPILOT_CRM_SYNC_MAINTENANCE, '1', 'CRM fence rejects owner bootstrap')
      assert.equal(values[0], email)
      calls.push('bootstrap')
      owner = { ...ownerRow, status: owner?.status === 'disabled' ? 'disabled' : 'active' }
      return { rows: [owner] }
    },
  },
  '@/lib/persistence/crmNativeEmailAuthority': {},
  '@/lib/crm/nativeEmailWorkspaceUserRuntime': {},
  '@/lib/auditWriter': {},
  '@/lib/invitationWorkspaceScope': {},
  '@/lib/crm/suiteCrmClient': {},
  '@/lib/demoMode': {},
})

const next = { NextResponse: Response }
const session = {
  async createBrowserSession(input) {
    calls.push('session:' + input.authMethod)
    if (input.email === email && owner?.status !== 'active') throw new Error('inactive fixture owner')
    return { session: { activeWorkspaceOrganizationId: workspaceId } }
  },
  setBrowserSessionCookie(response) { response.headers.set('x-fixture-session', 'issued') },
}
const tenancy = {
  async ensureDefaultResourcesForUser() {
    calls.push('provision')
    assert.notEqual(runtime.env.CLAWPILOT_CRM_SYNC_MAINTENANCE, '1', 'CRM fence rejects provisioning')
    return { pipelineProvisioningRequired: true, pipelineId: 'fixture-pipeline' }
  },
}
const shared = {
  'next/server': next,
  '@/lib/authSessions': session,
  '@/lib/authAudit': { async recordAuthActivity() {} },
  '@/lib/tenancy': tenancy,
}
const login = load('app_src/app/api/auth/login/route.ts', {
  ...shared,
  '@/lib/auth': { getLoginPassword: () => password },
  '@/lib/users': {
    ...users,
    async markAppUserSignedIn() {
      calls.push('mark-signed-in')
      assert.notEqual(runtime.env.CLAWPILOT_CRM_SYNC_MAINTENANCE, '1', 'CRM fence rejects login activation')
    },
  },
})
const actor = { email: memberEmail, organizationId: workspaceId }
const magic = load('app_src/app/api/auth/magic/verify/route.ts', {
  ...shared,
  '@/lib/authMagicCode': { async verifyAuthMagicCode() { return { status: 'verified', ...actor } } },
  '@/lib/pipelineProvisioning': { async queuePipelineProvisioning() { calls.push('queue-pipeline') } },
  '@/lib/persistence/crm': { async syncAppUserProfileToOwnedPipelines() { calls.push('sync-profile') } },
  '@/lib/workspaceMemberships': {
    async requireWorkspaceAppUser(actorEmail, actorWorkspace) {
      assert.equal(actorEmail, memberEmail)
      assert.equal(actorWorkspace, workspaceId)
      calls.push('authorize')
      return actor
    },
  },
})
const google = load('app_src/app/api/auth/google/native/route.ts', {
  ...shared,
  '@/lib/googleSso': {
    GoogleSsoError: Error,
    async verifyGoogleIdentityToken() { calls.push('verify-google'); return { email: memberEmail, subject: 'fixture-subject' } },
  },
  '@/lib/persistence/googleIdentityLinking': {
    async resolveLinkedGoogleIdentity() { calls.push('authorize'); return actor },
  },
})
const request = (body, headers = {}) => new Request('https://fixture.test', {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body),
})
const operatorLogin = (candidate = password, secret = operatorSecret) =>
  login.POST(request({ password: candidate }, { 'x-clawpilot-operator-secret': secret }))
const drain = (expected) => assert.deepEqual(calls.splice(0), expected)

assert.equal((await users.getAppUser(email)).role, 'owner')
assert.equal((await users.getAppUser(memberEmail)).role, 'member')
assert.equal(await users.getAppUser('missing@smoke-fixture.test'), null)
drain(['lookup:' + email, 'lookup:' + memberEmail, 'lookup:missing@smoke-fixture.test'])

assert.equal((await operatorLogin(password, 'incorrect-secret')).status, 404)
assert.equal((await operatorLogin('incorrect-password')).status, 401)
drain([])
const pausedLogin = await operatorLogin()
assert.equal(pausedLogin.status, 200)
assert.equal(pausedLogin.headers.get('x-fixture-session'), 'issued')
drain(['lookup:' + email, 'session:operator_password'])
owner = { ...ownerRow, status: 'disabled' }
assert.equal((await operatorLogin()).status, 401)
await assert.rejects(users.requireActiveAppUser(email), /not active/u)
drain(['lookup:' + email, 'lookup:' + email])
owner = { ...ownerRow, role: 'member' }
assert.equal((await operatorLogin()).status, 503)
drain(['lookup:' + email])
owner = null
assert.equal(await users.getAppUser(email), null)
assert.equal((await operatorLogin()).status, 503)
drain(['lookup:' + email, 'lookup:' + email])

assert.equal((await magic.POST(request({ email: memberEmail, code: '123456' }))).status, 200)
drain(['authorize', 'session:magic_code'])
assert.equal((await google.POST(request({ idToken: 'fixture-token' }))).status, 200)
drain(['verify-google', 'authorize', 'session:google_sso'])

delete runtime.env.CLAWPILOT_CRM_SYNC_MAINTENANCE
assert.equal((await operatorLogin()).status, 200)
drain(['lookup:' + email, 'bootstrap', 'mark-signed-in', 'provision', 'session:operator_password'])
assert.equal((await operatorLogin()).status, 200)
drain(['lookup:' + email, 'mark-signed-in', 'provision', 'session:operator_password'])
assert.equal((await magic.POST(request({ email: memberEmail, code: '123456' }))).status, 200)
drain(['authorize', 'provision', 'sync-profile', 'queue-pipeline', 'session:magic_code'])
assert.equal((await google.POST(request({ idToken: 'fixture-token' }))).status, 200)
drain(['verify-google', 'authorize', 'provision', 'session:google_sso'])
console.log('PASS CRM maintenance auth: existing lookups and paused sign-ins avoid CRM writes; explicit unpaused bootstrap stays authenticated')
