#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import { disposablePostgresDockerArgs, disposablePostgresDockerCleanupArgs } from './lib/disposable-postgres-docker.mjs'

const require = createRequire(new URL('../app_src/package.json', import.meta.url))
const { Pool } = require('pg')
const ts = require('typescript')
const owner = 'owner@example.test'
const member = 'member@example.test'
const orgA = '11111111-1111-4111-8111-111111111111'
const orgB = '22222222-2222-4222-8222-222222222222'
const runtime = { env: { ...process.env, APP_LOGIN_EMAIL: owner, APP_LOGIN_EMAIL_ALIASES: 'owner-alias@example.test', APP_SESSION_SECRET: 'test-session-secret-of-at-least-32-characters' } }
const command = (args) => execFileSync('docker', args, { encoding: 'utf8', timeout: 180_000 })
const read = (path) => readFileSync(path, 'utf8')
function load(path, mocks) {
  const output = ts.transpileModule(read(path), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText
  const module = { exports: {} }
  vm.runInNewContext(output, { module, exports: module.exports, process: runtime, Buffer, Date, URL, console, require: (id) => mocks[id] || require(id) }, { filename: path })
  return module.exports
}

const container = `clawpilot-user-lifecycle-${process.pid}-${randomUUID().slice(0, 8)}`
let started = false
let pool
try {
  command(disposablePostgresDockerArgs(['run', '--rm', '-d', '--name', container, '-e', 'POSTGRES_PASSWORD=lifecycle_test', '-e', 'POSTGRES_DB=lifecycle_test', '-p', '127.0.0.1::5432', 'postgres:18']))
  started = true
  const port = Number(command(['port', container, '5432/tcp']).match(/:(\d+)\s*$/)?.[1])
  pool = new Pool({ connectionString: `postgresql://postgres:lifecycle_test@127.0.0.1:${port}/lifecycle_test`, max: 4 })
  for (let attempt = 0; ; attempt += 1) {
    try { await pool.query('SELECT 1'); break } catch (error) { if (attempt > 100) throw error; await new Promise((done) => setTimeout(done, 200)) }
  }
  await pool.query(`
    CREATE TABLE workspace_organizations (id uuid PRIMARY KEY, name text, parent_id uuid, is_demo boolean DEFAULT false);
    CREATE TABLE app_users (email text PRIMARY KEY, role text DEFAULT 'member', status text DEFAULT 'active', permissions jsonb DEFAULT '{}', activated_at timestamptz, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
    CREATE TABLE app_user_organization_memberships (user_email text REFERENCES app_users(email), organization_id uuid REFERENCES workspace_organizations(id), role text DEFAULT 'member', status text DEFAULT 'active', permissions jsonb DEFAULT '{}', is_default boolean DEFAULT false, updated_by text, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(), PRIMARY KEY (user_email, organization_id));
    CREATE TABLE app_sessions (id uuid DEFAULT gen_random_uuid(), authenticated_user_email text, effective_user_email text, active_workspace_organization_id uuid, revoked_at timestamptz, revoked_reason text);
    CREATE TABLE app_user_invitations (email text, workspace_organization_id uuid, workspace_organization_ids uuid[], accepted_at timestamptz, revoked_at timestamptz);
    CREATE TABLE auth_magic_codes (email text PRIMARY KEY);
  `)
  await pool.query(read('db/migrations/0265_google_identity_linking.sql'))
  await pool.query(read('db/migrations/0369_user_membership_trash.sql'))
  await pool.query("INSERT INTO workspace_organizations(id, name) VALUES ($1, 'Org A'), ($2, 'Org B')", [orgA, orgB])
  await pool.query("INSERT INTO app_users(email, role) VALUES ($1, 'owner'), ($2, 'member'), ('other@example.test', 'member')", [owner, member])
  await pool.query("INSERT INTO app_user_organization_memberships(user_email, organization_id, role) VALUES ($1, $3, 'owner'), ($2, $3, 'member'), ($2, $4, 'member')", [owner, member, orgA, orgB])
  await pool.query("INSERT INTO app_user_external_identities(provider, provider_subject, user_email, verified_email, linked_organization_id, linked_by) VALUES ('google', 'old-subject', $1, $1, $2, $1)", [member, orgA])
  await pool.query(read('db/migrations/0370_verified_login_email.sql'))
  assert.equal((await pool.query("SELECT user_email FROM app_google_subject_owners WHERE provider_subject = 'old-subject'")).rows[0].user_email, member, 'Migration backfills immutable ownership for existing Google links')
  await pool.query('INSERT INTO app_sessions(authenticated_user_email, effective_user_email, active_workspace_organization_id) VALUES ($1, $1, $2), ($1, $1, $3)', [member, orgA, orgB])
  const audit = []
  const persistence = {
    query: (sql, values) => pool.query(sql, values),
    withTransaction: async (callback) => {
      const client = await pool.connect()
      try { await client.query('BEGIN'); const result = await callback(client); await client.query('COMMIT'); return result }
      catch (error) { await client.query('ROLLBACK'); throw error }
      finally { client.release() }
    },
  }
  const mocks = { '@/lib/persistence/postgres': persistence, '@/lib/auditWriter': { recordAuditEvent: async (event) => audit.push(event) }, '@/lib/crm/suiteCrmClient': {}, '@/lib/demoMode': { DEMO_WORKSPACE_ID: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' } }
  const users = load('app_src/lib/users.ts', mocks)
  const actor = { email: owner, role: 'owner', status: 'active', permissions: users.OWNER_PERMISSIONS, organizationId: orgA }
  const mutate = (trashed, extra = {}) => users.setAppUserTrashed({ actorEmail: actor, email: member, organizationId: orgA, trashed, ...extra })
  await assert.rejects(mutate(true, { email: owner }), /own account/)
  await assert.rejects(mutate(true, { organizationId: orgB }), /outside/)
  await assert.rejects(mutate(true, { actorEmail: { ...actor, role: 'member' } }), /permission/)
  const removed = await mutate(true)
  assert.ok(removed.trashedAt)
  assert.equal((await users.listAppUsers(actor)).users.some((user) => user.email === member), false)
  assert.equal((await users.listAppUsers(actor, 'trash')).users[0].email, member)
  assert.equal((await pool.query('SELECT status FROM app_users WHERE email = $1', [member])).rows[0].status, 'active', 'Other organization access survives')
  assert.equal((await pool.query('SELECT revoked_at FROM app_sessions WHERE active_workspace_organization_id = $1', [orgA])).rows[0].revoked_at !== null, true)
  assert.equal((await pool.query('SELECT revoked_at FROM app_sessions WHERE active_workspace_organization_id = $1', [orgB])).rows[0].revoked_at, null)
  await assert.rejects(users.setAppUserStatus({ actorEmail: actor, email: member, organizationId: orgA, status: 'active' }), /Trash/)
  await assert.rejects(pool.query("UPDATE app_user_organization_memberships SET status = 'active' WHERE user_email = $1 AND organization_id = $2", [member, orgA]), /app_membership_trash_state/)
  assert.equal((await mutate(false)).status, 'active')
  for (const previous of ['invited', 'disabled']) {
    await pool.query('UPDATE app_user_organization_memberships SET status = $3 WHERE user_email = $1 AND organization_id = $2', [member, orgA, previous])
    await mutate(true)
    assert.equal((await mutate(false)).status, previous, 'Restore never upgrades a previous access state')
  }
  await pool.query("UPDATE app_user_organization_memberships SET status = 'active' WHERE user_email = $1", [member])
  const identity = load('app_src/lib/authLoginIdentity.ts', { ...mocks, '@/lib/users': users })
  const sent = []
  const notices = []
  let failMail = false
  const changes = load('app_src/lib/loginEmailChange.ts', { ...mocks, '@/lib/users': users, '@/lib/authLoginIdentity': identity,
    '@/lib/authSessions': { SESSION_POLICY: { recentAuthSeconds: 900 } },
    '@/lib/matonMail': { sendLoginEmailChangeCode: async (mail) => { if (failMail) throw new Error('delivery failed'); sent.push(mail) }, sendLoginEmailChangedNotice: async (mail) => notices.push(mail) },
  })
  const session = { authenticatedUser: member, effectiveUser: member, lastAuthenticatedAt: new Date().toISOString(), activeWorkspaceOrganizationId: orgA }
  const resetCooldown = () => pool.query("UPDATE app_login_email_changes SET requested_at = now() - interval '61 seconds', request_window_started = now() - interval '2 hours' WHERE user_email = $1", [member])
  await assert.rejects(changes.requestLoginEmailChange({ ...session, impersonating: true }, 'new@example.test'), /yourself/)
  await assert.rejects(changes.requestLoginEmailChange({ ...session, lastAuthenticatedAt: '2000-01-01' }, 'new@example.test'), /sign out/)
  await assert.rejects(changes.requestLoginEmailChange(session, 'other@example.test'), /another account/)
  await assert.rejects(changes.requestLoginEmailChange(session, 'owner-alias@example.test'), /another account/)
  await changes.requestLoginEmailChange(session, 'New@Example.test')
  assert.equal(await identity.currentLoginEmail(member), member, 'Request alone never changes login')
  await assert.rejects(changes.requestLoginEmailChange(session, 'new@example.test'), /wait/)
  const wrongCode = sent.at(-1).code === '000000' ? '111111' : '000000'
  for (let attempt = 0; attempt < 5; attempt += 1) await assert.rejects(changes.confirmLoginEmailChange(session, { email: 'new@example.test', code: wrongCode }), /invalid/)
  await assert.rejects(changes.confirmLoginEmailChange(session, { email: 'new@example.test', code: sent.at(-1).code }), /invalid/)
  await resetCooldown()
  failMail = true
  await assert.rejects(changes.requestLoginEmailChange(session, 'new@example.test'), /deliver/)
  assert.ok((await pool.query('SELECT consumed_at FROM app_login_email_changes WHERE user_email = $1', [member])).rows[0].consumed_at)
  failMail = false
  await resetCooldown()
  await changes.requestLoginEmailChange(session, 'new@example.test')
  await pool.query("UPDATE app_login_email_changes SET expires_at = now() - interval '1 second' WHERE user_email = $1", [member])
  await assert.rejects(changes.confirmLoginEmailChange(session, { email: 'new@example.test', code: sent.at(-1).code }), /invalid/)
  await resetCooldown()
  await changes.requestLoginEmailChange(session, 'new@example.test')
  await pool.query('INSERT INTO auth_magic_codes(email) VALUES ($1), ($2)', [member, 'new@example.test'])
  await changes.confirmLoginEmailChange(session, { email: 'new@example.test', code: sent.at(-1).code })
  assert.equal(await identity.currentLoginEmail(member), 'new@example.test')
  assert.equal(await identity.resolveLoginAccountEmail('new@example.test'), member)
  assert.equal(await identity.resolveLoginAccountEmail(member), null, 'Old durable email cannot fall back to login')
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM app_user_organization_memberships WHERE user_email = $1', [member])).rows[0].n, 2)
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM app_sessions WHERE effective_user_email = $1 AND revoked_at IS NULL', [member])).rows[0].n, 0)
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM app_user_external_identities')).rows[0].n, 1, 'Immutable Google identity history survives')
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM app_effective_google_identities')).rows[0].n, 0, 'Old Google link is no longer eligible')
  await assert.rejects(pool.query('DELETE FROM app_user_external_identities'), /immutable/)
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM auth_magic_codes')).rows[0].n, 0)
  assert.equal(notices[0].to, member)
  await assert.rejects(changes.confirmLoginEmailChange(session, { email: 'new@example.test', code: sent.at(-1).code }), /invalid/)
  await assert.rejects(pool.query("INSERT INTO app_users(email) VALUES ('new@example.test')"), /existing login/)
  await assert.rejects(pool.query("INSERT INTO app_user_login_addresses(user_email, login_email) VALUES ($1, 'other@example.test')", [owner]), /existing account/)
  await pool.query("INSERT INTO app_user_login_addresses(user_email, login_email) VALUES ($1, 'owner-new@example.test')", [owner])
  assert.equal(await identity.resolveLoginAccountEmail(owner), null)
  assert.equal(await identity.resolveLoginAccountEmail('owner-alias@example.test'), null, 'Environment aliases cannot bypass changed login')
  assert.equal(await identity.resolveLoginAccountEmail('owner-new@example.test'), owner)
  const sessions = load('app_src/lib/authSessions.ts', { ...mocks, '@/lib/authLoginIdentity': identity,
    '@/lib/auth': { getCookieNames: () => ['test-session'], verifySessionToken: () => ({ ok: true, user: member, exp: Math.floor(Date.now() / 1000) + 3600 }) },
    '@/lib/requestIpAddress': { observedRequestIpAddress: () => null },
  })
  assert.equal(await sessions.resolveRequestSession({ cookies: { get: () => ({ value: 'signed.legacy' }) }, headers: new Headers() }), null, 'Stateless legacy cookie must not survive login email change')
  await assert.rejects(sessions.createBrowserSession({ email: member, authMethod: 'magic_code', headers: new Headers(), verifiedLoginEmail: member }), /Login address changed/, 'Session issuance rechecks login mapping under user lock')
  await assert.rejects(sessions.createBrowserSession({ email: member, authMethod: 'legacy_upgrade', headers: new Headers() }), /Sign in again/)
  await assert.rejects(sessions.createBrowserSession({ email: member, authMethod: 'google_sso', headers: new Headers(), verifiedLoginEmail: 'new@example.test', verifiedGoogleSubject: 'old-subject' }), /Google identity changed/)
  const google = load('app_src/lib/persistence/googleIdentityLinking.ts', { ...mocks, '@/lib/users': users, '@/lib/authLoginIdentity': identity,
    '@/lib/persistence/postgres': { ...persistence, acquireTransactionAdvisoryLock: (client, key) => client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [key]) },
    '@/lib/googleSso': { GoogleSsoError: class extends Error { constructor(code, message, status) { super(message); this.code = code; this.status = status } }, googleSsoClientConfiguration: () => ({ configured: true, clientId: 'test-client' }) },
    '@/lib/workspaceMemberships': { requireWorkspaceAppUser: async (email, organizationId) => ({ email, organizationId }) },
  })
  const memberActor = { ...actor, email: member, role: 'member', permissions: users.MEMBER_PERMISSIONS }
  await assert.rejects(google.resolveLinkedGoogleIdentity({ subject: 'old-subject', email: member }), /different ClawPilot user/)
  await google.linkGoogleIdentity({ actor: memberActor, identity: { subject: 'new-subject', email: 'new@example.test' }, idempotencyKey: 'test-new-login-link' })
  assert.equal((await google.resolveLinkedGoogleIdentity({ subject: 'new-subject', email: 'new@example.test' })).email, member)
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM app_user_external_identities')).rows[0].n, 1)
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM app_auth_mutation_receipts')).rows[0].n, 1)
  await assert.rejects(pool.query('DELETE FROM app_auth_mutation_receipts'), /immutable/)
  await resetCooldown()
  await changes.requestLoginEmailChange(session, 'third@example.test')
  await changes.confirmLoginEmailChange(session, { email: 'third@example.test', code: sent.at(-1).code })
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM app_auth_mutation_receipts')).rows[0].n, 1, 'Security receipts remain immutable across email changes')
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM app_effective_google_identities WHERE user_email = $1', [member])).rows[0].n, 0)
  assert.equal((await pool.query("SELECT user_email FROM app_google_subject_owners WHERE provider_subject = 'new-subject'")).rows[0].user_email, member, 'Rotating login preserves ownership of a subject first linked after an email change')
  await assert.rejects(pool.query("DELETE FROM app_google_subject_owners WHERE provider_subject = 'new-subject'"), /immutable/)
  await assert.rejects(pool.query("UPDATE app_google_subject_owners SET user_email = 'other@example.test' WHERE provider_subject = 'new-subject'"), /immutable/)
  await pool.query("INSERT INTO app_user_organization_memberships(user_email, organization_id) VALUES ('other@example.test', $1)", [orgA])
  const otherActor = { ...memberActor, email: 'other@example.test' }
  await assert.rejects(google.linkGoogleIdentity({ actor: otherActor, identity: { subject: 'new-subject', email: 'other@example.test' }, idempotencyKey: 'test-reassign-revoked-subject' }), /belongs to another user/, 'A distinct user cannot claim a subject whose current binding was revoked')
  await assert.rejects(pool.query("INSERT INTO app_user_external_identities(provider, provider_subject, user_email, verified_email, linked_organization_id, linked_by) VALUES ('google', 'new-subject', 'other@example.test', 'other@example.test', $1, 'other@example.test')", [orgA]), /belongs to another account/, 'Database ownership guard protects the original-link path as well')
  await assert.rejects(pool.query("INSERT INTO app_user_google_login_bindings(provider_subject, user_email, verified_email, linked_organization_id, linked_by) VALUES ('new-subject', 'other@example.test', 'other@example.test', $1, 'other@example.test')", [orgA]), /belongs to another account/, 'Database ownership guard protects the current-binding path')
  await google.linkGoogleIdentity({ actor: memberActor, identity: { subject: 'third-subject', email: 'third@example.test' }, idempotencyKey: 'test-third-login-link' })
  assert.equal((await google.resolveLinkedGoogleIdentity({ subject: 'third-subject', email: 'third@example.test' })).email, member)
  assert.ok(audit.some((event) => event.eventType === 'user.trashed'))
  assert.ok(audit.some((event) => event.eventType === 'auth.login_email.changed'))
  console.log('PASS: user Trash/Restore isolation, access states, sessions; login verification, rate limits, collisions, identity preservation, old login revocation')
} finally {
  await pool?.end()
  if (started) command(disposablePostgresDockerCleanupArgs(container))
}
