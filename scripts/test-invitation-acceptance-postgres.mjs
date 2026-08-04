#!/usr/bin/env node

import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import crypto, { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import vm from 'node:vm'

const root = process.cwd()
const requireFromApp = createRequire(
  new URL('../app_src/package.json', import.meta.url),
)
const requireFromTest = createRequire(import.meta.url)
const { Pool } = requireFromApp('pg')
const ts = requireFromApp('typescript')
let runtimePool = null

function read(path) {
  return readFileSync(resolve(root, path), 'utf8')
}

function command(file, args, options = {}) {
  return execFileSync(file, args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  })
}

function loadTypeScriptModule(path, mocks) {
  const output = ts.transpileModule(read(path), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: path,
    reportDiagnostics: true,
  })
  const diagnostics = (output.diagnostics || []).filter(
    (entry) => entry.category === ts.DiagnosticCategory.Error,
  )
  assert.deepEqual(diagnostics, [])
  const loaded = { exports: {} }
  vm.runInNewContext(output.outputText, {
    AbortSignal,
    Array,
    Buffer,
    Date,
    Error,
    JSON,
    Map,
    Math,
    Number,
    Object,
    Promise,
    RegExp,
    Set,
    String,
    URL,
    clearTimeout,
    console,
    exports: loaded.exports,
    fetch,
    module: loaded,
    process,
    require(specifier) {
      if (Object.prototype.hasOwnProperty.call(mocks, specifier)) {
        return mocks[specifier]
      }
      return requireFromTest(specifier)
    },
    setTimeout,
  }, { filename: path })
  return loaded.exports
}

async function waitForPostgres(databaseUrl) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const pool = new Pool({
      connectionString: databaseUrl,
      connectionTimeoutMillis: 1_000,
      max: 1,
    })
    try {
      await pool.query('SELECT 1')
      await pool.end()
      return
    } catch {
      await pool.end().catch(() => {})
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250))
    }
  }
  throw new Error('Disposable PostgreSQL did not become ready')
}

async function withRuntimeTransaction(callback) {
  assert.ok(runtimePool, 'Runtime PostgreSQL pool is not configured')
  const client = await runtimePool.connect()
  try {
    await client.query('BEGIN')
    const result = await callback(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

async function createSchema(pool) {
  await pool.query(`
    CREATE EXTENSION IF NOT EXISTS pgcrypto;

    CREATE TABLE app_users (
      email text PRIMARY KEY,
      display_name text,
      role text NOT NULL DEFAULT 'member',
      status text NOT NULL CHECK (status IN ('invited', 'active', 'disabled')),
      activated_at timestamptz,
      last_login_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE workspace_organizations (
      id uuid PRIMARY KEY,
      name text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE app_user_organization_memberships (
      user_email text NOT NULL REFERENCES app_users(email) ON DELETE CASCADE,
      organization_id uuid NOT NULL REFERENCES workspace_organizations(id),
      role text NOT NULL DEFAULT 'member',
      status text NOT NULL CHECK (status IN ('invited', 'active', 'disabled')),
      is_default boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (user_email, organization_id)
    );

    CREATE TABLE app_user_invitations (
      id uuid PRIMARY KEY,
      email text NOT NULL REFERENCES app_users(email) ON DELETE CASCADE,
      invited_by text REFERENCES app_users(email),
      workspace_organization_id uuid REFERENCES workspace_organizations(id),
      workspace_organization_ids uuid[] DEFAULT ARRAY[]::uuid[],
      token_digest text NOT NULL UNIQUE,
      from_address text NOT NULL,
      opened_at timestamptz,
      code_requested_at timestamptz,
      accepted_at timestamptz,
      revoked_at timestamptz,
      expires_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE auth_magic_codes (
      id uuid PRIMARY KEY,
      email text NOT NULL UNIQUE,
      code_digest text NOT NULL,
      attempts smallint NOT NULL DEFAULT 0,
      purpose text NOT NULL CHECK (purpose IN ('sign_in', 'invitation')),
      invitation_id uuid REFERENCES app_user_invitations(id) ON DELETE CASCADE,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz NOT NULL,
      last_attempt_at timestamptz,
      consumed_at timestamptz
    );
  `)
}

function invitationTokenDigest(token) {
  return crypto
    .createHash('sha256')
    .update(`clawpilot-user-invitation:v1\n${token}`)
    .digest('hex')
}

async function seedOrganizations(pool) {
  const ids = {
    primary: randomUUID(),
    additional: randomUUID(),
    outside: randomUUID(),
  }
  await pool.query(
    `INSERT INTO workspace_organizations (id, name)
     VALUES ($1::uuid, 'Primary workspace'),
            ($2::uuid, 'Additional workspace'),
            ($3::uuid, 'Outside workspace')`,
    [ids.primary, ids.additional, ids.outside],
  )
  return ids
}

async function seedInvitation(pool, organizations, email) {
  const invitationId = randomUUID()
  const token = crypto.randomBytes(32).toString('base64url')
  await pool.query(
    `INSERT INTO app_users (email, display_name, status)
     VALUES ($1, 'Invited operator', 'invited')`,
    [email],
  )
  await pool.query(
    `INSERT INTO app_user_organization_memberships (
       user_email, organization_id, status, is_default
     ) VALUES
       ($1, $2::uuid, 'invited', true),
       ($1, $3::uuid, 'invited', false),
       ($1, $4::uuid, 'disabled', false)`,
    [
      email,
      organizations.primary,
      organizations.additional,
      organizations.outside,
    ],
  )
  await pool.query(
    `INSERT INTO app_user_invitations (
       id, email, workspace_organization_id, workspace_organization_ids,
       token_digest, from_address, expires_at
     ) VALUES (
       $1::uuid, $2, $3::uuid, ARRAY[$3::uuid, $4::uuid, $3::uuid],
       $5, 'no-reply@clawpilot.test', now() + interval '1 day'
     )`,
    [
      invitationId,
      email,
      organizations.primary,
      organizations.additional,
      invitationTokenDigest(token),
    ],
  )
  return { email, invitationId, token }
}

async function snapshotInvitation(pool, fixture) {
  const [user, invitation, memberships, code] = await Promise.all([
    pool.query(
      `SELECT status, activated_at::text, last_login_at::text
       FROM app_users WHERE email = $1`,
      [fixture.email],
    ),
    pool.query(
      `SELECT accepted_at::text, opened_at::text, code_requested_at::text
       FROM app_user_invitations WHERE id = $1::uuid`,
      [fixture.invitationId],
    ),
    pool.query(
      `SELECT organization_id::text, status
       FROM app_user_organization_memberships
       WHERE user_email = $1
       ORDER BY organization_id`,
      [fixture.email],
    ),
    pool.query(
      `SELECT attempts::integer, consumed_at::text
       FROM auth_magic_codes WHERE email = $1`,
      [fixture.email],
    ),
  ])
  return {
    user: user.rows[0],
    invitation: invitation.rows[0],
    memberships: memberships.rows,
    code: code.rows[0] || null,
  }
}

async function verifyAcceptance(databaseUrl) {
  runtimePool = new Pool({ connectionString: databaseUrl, max: 6 })
  await createSchema(runtimePool)
  const organizations = await seedOrganizations(runtimePool)
  const deliveredCodes = new Map()
  const persistenceMock = {
    query(sql, values) {
      return runtimePool.query(sql, values)
    },
    withTransaction: withRuntimeTransaction,
  }
  const usersMock = {
    normalizeUserEmail(value) {
      const email = String(value || '').trim().toLowerCase()
      if (!email.includes('@')) throw new Error('invalid email')
      return email
    },
    async getAppUser(email) {
      const result = await runtimePool.query(
        'SELECT email, role, status FROM app_users WHERE email = $1',
        [email],
      )
      return result.rows[0] || null
    },
  }
  const auth = loadTypeScriptModule('app_src/lib/authMagicCode.ts', {
    '@/lib/matonMail': {
      async sendAuthMagicCodeEmail({ to, code }) {
        deliveredCodes.set(to, code)
        return { messageId: randomUUID() }
      },
    },
    '@/lib/persistence/postgres': persistenceMock,
    '@/lib/users': usersMock,
  })
  const invitations = loadTypeScriptModule('app_src/lib/invitations.ts', {
    '@/lib/authMagicCode': {
      requestInvitationAuthMagicCode: auth.requestInvitationAuthMagicCode,
    },
    '@/lib/matonMail': {
      async sendInvitationEmail() {
        throw new Error('Invitation creation is outside this acceptance')
      },
      mailFromAddress() {
        return 'no-reply@clawpilot.test'
      },
    },
    '@/lib/organizations': {
      async resolveInvitationWorkspaceOrganization() {
        throw new Error('Invitation creation is outside this acceptance')
      },
      async retireUnusedWorkspaceOrganization() {},
    },
    '@/lib/persistence/postgres': persistenceMock,
    '@/lib/publicUrl': {
      appPublicUrl() {
        return 'https://clawpilot.test'
      },
    },
    '@/lib/users': {
      ...usersMock,
      async getAppUser(email) {
        return usersMock.getAppUser(email)
      },
      async inviteAppUser() {
        throw new Error('Invitation creation is outside this acceptance')
      },
      async resolveAppUserActor() {
        throw new Error('Invitation creation is outside this acceptance')
      },
      async restoreInvitedUserAssignments() {},
    },
  })

  const success = await seedInvitation(
    runtimePool,
    organizations,
    'multi-org-success@example.com',
  )
  const opened = await invitations.openUserInvitation(success.token)
  assert.equal(opened.email, success.email)
  assert.equal(opened.organizationName, 'Primary workspace')
  const delivery = await invitations.requestUserInvitationCode(success.token)
  assert.equal(delivery.delivery, 'sent')
  const successCode = deliveredCodes.get(success.email)
  assert.match(successCode, /^\d{6}$/u)
  const accepted = await auth.verifyAuthMagicCode({
    email: success.email,
    code: successCode,
  })
  assert.equal(accepted.status, 'verified')
  assert.equal(accepted.organizationId, organizations.primary)
  const successState = await snapshotInvitation(runtimePool, success)
  assert.equal(successState.user.status, 'active')
  assert.ok(successState.user.activated_at)
  assert.ok(successState.user.last_login_at)
  assert.ok(successState.invitation.accepted_at)
  assert.ok(successState.code.consumed_at)
  const successMemberships = new Map(successState.memberships.map((row) => (
    [row.organization_id, row.status]
  )))
  assert.equal(successMemberships.get(organizations.primary), 'active')
  assert.equal(successMemberships.get(organizations.additional), 'active')
  assert.equal(
    successMemberships.get(organizations.outside),
    'disabled',
    'Memberships outside the invitation remain unchanged',
  )

  async function assertMutationRollsBack(label, mutateMembership) {
    const fixture = await seedInvitation(
      runtimePool,
      organizations,
      `${label}@example.com`,
    )
    await invitations.openUserInvitation(fixture.token)
    const requested = await invitations.requestUserInvitationCode(
      fixture.token,
    )
    assert.equal(requested.delivery, 'sent')
    const code = deliveredCodes.get(fixture.email)
    assert.match(code, /^\d{6}$/u)
    await mutateMembership(fixture)
    const result = await auth.verifyAuthMagicCode({
      email: fixture.email,
      code,
    })
    assert.equal(result.status, 'not-authorized')
    const state = await snapshotInvitation(runtimePool, fixture)
    assert.equal(state.user.status, 'invited')
    assert.equal(state.user.activated_at, null)
    assert.equal(state.user.last_login_at, null)
    assert.equal(state.invitation.accepted_at, null)
    assert.equal(state.code.attempts, 0)
    assert.equal(
      state.code.consumed_at,
      null,
      'A failed exact-set acceptance must roll back code consumption',
    )
    const primary = state.memberships.find(
      (row) => row.organization_id === organizations.primary,
    )
    assert.equal(primary?.status, 'invited')
    await assert.rejects(
      invitations.openUserInvitation(fixture.token),
      /invalid or expired/u,
    )
  }

  await assertMutationRollsBack('removed-membership', async (fixture) => {
    await runtimePool.query(
      `DELETE FROM app_user_organization_memberships
       WHERE user_email = $1 AND organization_id = $2::uuid`,
      [fixture.email, organizations.additional],
    )
  })
  await assertMutationRollsBack('disabled-membership', async (fixture) => {
    await runtimePool.query(
      `UPDATE app_user_organization_memberships
       SET status = 'disabled'
       WHERE user_email = $1 AND organization_id = $2::uuid`,
      [fixture.email, organizations.additional],
    )
  })
  await assertMutationRollsBack('premature-active-membership', async (fixture) => {
    await runtimePool.query(
      `UPDATE app_user_organization_memberships
       SET status = 'active'
       WHERE user_email = $1 AND organization_id = $2::uuid`,
      [fixture.email, organizations.additional],
    )
  })

  const concurrentChange = await seedInvitation(
    runtimePool,
    organizations,
    'concurrent-membership-change@example.com',
  )
  await invitations.openUserInvitation(concurrentChange.token)
  const concurrentDelivery = await invitations.requestUserInvitationCode(
    concurrentChange.token,
  )
  assert.equal(concurrentDelivery.delivery, 'sent')
  const concurrentCode = deliveredCodes.get(concurrentChange.email)
  const blocker = await runtimePool.connect()
  try {
    await blocker.query('BEGIN')
    await blocker.query(
      `UPDATE app_user_organization_memberships
       SET status = 'disabled'
       WHERE user_email = $1 AND organization_id = $2::uuid`,
      [concurrentChange.email, organizations.additional],
    )
    let verificationSettled = false
    const concurrentVerification = auth.verifyAuthMagicCode({
      email: concurrentChange.email,
      code: concurrentCode,
    }).finally(() => {
      verificationSettled = true
    })
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 150))
    assert.equal(
      verificationSettled,
      false,
      'Acceptance must wait for an in-flight target-membership change',
    )
    await blocker.query('COMMIT')
    const concurrentResult = await concurrentVerification
    assert.equal(concurrentResult.status, 'not-authorized')
  } catch (error) {
    await blocker.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    blocker.release()
  }
  const concurrentState = await snapshotInvitation(
    runtimePool,
    concurrentChange,
  )
  assert.equal(concurrentState.user.status, 'invited')
  assert.equal(concurrentState.user.activated_at, null)
  assert.equal(concurrentState.user.last_login_at, null)
  assert.equal(concurrentState.invitation.accepted_at, null)
  assert.equal(concurrentState.code.attempts, 0)
  assert.equal(concurrentState.code.consumed_at, null)
  assert.equal(
    concurrentState.memberships.find((row) => (
      row.organization_id === organizations.primary
    ))?.status,
    'invited',
  )
  assert.equal(
    concurrentState.memberships.find((row) => (
      row.organization_id === organizations.additional
    ))?.status,
    'disabled',
  )

  const invalidBeforeCode = await seedInvitation(
    runtimePool,
    organizations,
    'invalid-token-boundary@example.com',
  )
  await runtimePool.query(
    `DELETE FROM app_user_organization_memberships
     WHERE user_email = $1 AND organization_id = $2::uuid`,
    [invalidBeforeCode.email, organizations.additional],
  )
  await assert.rejects(
    invitations.openUserInvitation(invalidBeforeCode.token),
    /invalid or expired/u,
  )
  await assert.rejects(
    invitations.requestUserInvitationCode(invalidBeforeCode.token),
    /invalid, expired, or already used/u,
  )
  assert.deepEqual(
    JSON.parse(JSON.stringify(
      await auth.requestInvitationAuthMagicCode({
        email: invalidBeforeCode.email,
        invitationId: invalidBeforeCode.invitationId,
      }),
    )),
    { status: 'not-authorized' },
  )
  const invalidState = await snapshotInvitation(runtimePool, invalidBeforeCode)
  assert.equal(invalidState.invitation.opened_at, null)
  assert.equal(invalidState.invitation.code_requested_at, null)
  assert.equal(invalidState.invitation.accepted_at, null)
  assert.equal(invalidState.code, null)

  const missingPrimary = await seedInvitation(
    runtimePool,
    organizations,
    'missing-primary-organization@example.com',
  )
  await runtimePool.query(
    `UPDATE app_user_invitations
     SET workspace_organization_id = NULL
     WHERE id = $1::uuid`,
    [missingPrimary.invitationId],
  )
  await assert.rejects(
    invitations.openUserInvitation(missingPrimary.token),
    /invalid or expired/u,
  )
  assert.deepEqual(
    JSON.parse(JSON.stringify(
      await auth.requestInvitationAuthMagicCode({
        email: missingPrimary.email,
        invitationId: missingPrimary.invitationId,
      }),
    )),
    { status: 'not-authorized' },
  )
  const missingPrimaryState = await snapshotInvitation(
    runtimePool,
    missingPrimary,
  )
  assert.equal(missingPrimaryState.invitation.opened_at, null)
  assert.equal(missingPrimaryState.invitation.code_requested_at, null)
  assert.equal(missingPrimaryState.invitation.accepted_at, null)
  assert.equal(missingPrimaryState.code, null)

  await runtimePool.end()
  runtimePool = null
}

async function main() {
  process.env.APP_SESSION_SECRET =
    'invitation-acceptance-postgres-secret-32-characters'
  command('docker', ['info'], { timeout: 30_000 })
  const container = (
    `clawpilot-invitation-acceptance-${process.pid}-${randomUUID().slice(0, 8)}`
  )
  try {
    command('docker', [
      'run', '--rm', '-d', '--name', container,
      '-e', 'POSTGRES_PASSWORD=invitation_acceptance',
      '-e', 'POSTGRES_DB=invitation_acceptance',
      '-p', '127.0.0.1::5432',
      'postgres:16-alpine',
    ], { timeout: 180_000 })
    const portOutput = command('docker', ['port', container, '5432/tcp'])
    const port = Number(portOutput.match(/:(\d+)\s*$/u)?.[1])
    assert.ok(port > 0, `Unable to resolve PostgreSQL port: ${portOutput}`)
    const databaseUrl = (
      'postgresql://postgres:invitation_acceptance@127.0.0.1:'
      + `${port}/invitation_acceptance`
    )
    await waitForPostgres(databaseUrl)
    await verifyAcceptance(databaseUrl)
  } finally {
    if (runtimePool) await runtimePool.end().catch(() => {})
    runtimePool = null
    spawnSync('docker', ['stop', '-t', '1', container], {
      cwd: root,
      encoding: 'utf8',
      timeout: 20_000,
    })
  }
  console.log('Invitation exact-set disposable-PostgreSQL acceptance passed')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
