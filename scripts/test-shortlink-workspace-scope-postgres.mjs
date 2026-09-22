#!/usr/bin/env node

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import vm from 'node:vm'
import { additionalPublicOrigins } from '../app_src/lib/publicOriginRouting.mjs'
import {
  disposablePostgresDockerArgs,
  disposablePostgresDockerCleanupArgs,
} from './lib/disposable-postgres-docker.mjs'

const root = process.cwd()
const appRequire = createRequire(new URL('../app_src/package.json', import.meta.url))
const { Pool } = appRequire('pg')
const ts = appRequire('typescript')
const orgA = '11111111-1111-4111-8111-111111111111'
const orgB = '22222222-2222-4222-8222-222222222222'
const sameEmail = 'same@example.test'
const otherEmail = 'other@example.test'
const IDs = {
  ownA: '10000000-0000-4000-8000-000000000001',
  otherA: '10000000-0000-4000-8000-000000000002',
  ownB: '10000000-0000-4000-8000-000000000003',
  serviceA: '10000000-0000-4000-8000-000000000004',
  serviceB: '10000000-0000-4000-8000-000000000005',
}

function command(file, args, options = {}) {
  return execFileSync(file, args, { cwd: root, encoding: 'utf8', timeout: 30_000, ...options })
}

async function waitForPostgres(url) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const pool = new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 1000 })
    try {
      await pool.query('SELECT 1')
      await pool.end()
      return
    } catch {
      await pool.end().catch(() => {})
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250))
    }
  }
  throw new Error('Disposable Postgres was not ready')
}

function loadShortlinks(pool) {
  const path = 'app_src/lib/shortlinks.ts'
  const output = ts.transpileModule(readFileSync(resolve(root, path), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    fileName: path,
  }).outputText
  const module = { exports: {} }
  vm.runInNewContext(output, {
    URL, console, process, exports: module.exports, module,
    require(specifier) {
      if (specifier === 'node:crypto') return appRequire('node:crypto')
      if (specifier === '@/lib/globalIds.mjs') {
        return { globalIdFragment: () => '[a-z0-9]+', globalIdPattern: () => /^g[a-z][a-z0-9]+$/ }
      }
      if (specifier === '@/lib/persistence/config') return { getStorageDriver: () => 'postgres' }
      if (specifier === '@/lib/persistence/postgres') return {
        query: (sql, values) => pool.query(sql, values),
        withTransaction: async (callback) => {
          const client = await pool.connect()
          try {
            await client.query('BEGIN')
            const result = await callback(client)
            await client.query('COMMIT')
            return result
          } catch (error) {
            await client.query('ROLLBACK')
            throw error
          } finally {
            client.release()
          }
        },
      }
      if (specifier === '@/lib/requestUser') return { requireRequestUser: async () => null }
      if (specifier === '@/lib/users') return {
        effectiveAuthorizationRole: () => 'owner',
        effectiveUserPermissions: () => ({ manageLinks: true }),
        normalizeUserEmail: (value) => String(value).toLowerCase(),
      }
      if (specifier === '@/lib/workspaceMemberships') return {
        requireWorkspaceAppUser: async () => ({ organizationId: orgA }),
        WorkspaceAccessError: class WorkspaceAccessError extends Error {},
      }
      throw new Error(`Unexpected short-link scope test import: ${specifier}`)
    },
  }, { filename: path })
  return module.exports
}

function actor({ ownerEmail = sameEmail, organizationId = orgA, manageOrganization = false, service = false, sourceApp = 'clawpilot' } = {}) {
  return { ownerEmail, organizationId, manageOrganization, service, sourceApp }
}

function loadOrganizationPreferences(pool) {
  const path = 'app_src/lib/organizationWebPreferences.ts'
  const output = ts.transpileModule(readFileSync(resolve(root, path), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const module = { exports: {} }
  vm.runInNewContext(output, { URL, process, module, exports: module.exports, require(specifier) {
    if (specifier === '@/lib/auditWriter') return { recordAuditEvent: async () => {} }
    if (specifier === '@/lib/users') return { effectiveAuthorizationRole: (user) => user.role }
    if (specifier === '@/lib/publicUrl') return { appPublicUrl: () => process.env.CLAWPILOT_PUBLIC_URL }
    if (specifier === '@/lib/publicOriginRouting.mjs') return { additionalPublicOrigins }
    if (specifier === '@/lib/persistence/postgres') return { query: (sql, values) => pool.query(sql, values), withTransaction: async (callback) => {
      const client = await pool.connect()
      try { await client.query('BEGIN'); const result = await callback(client); await client.query('COMMIT'); return result }
      catch (error) { await client.query('ROLLBACK'); throw error }
      finally { client.release() }
    } }
    throw new Error(`Unexpected organization preference test import: ${specifier}`)
  } }, { filename: path })
  return module.exports
}

async function main() {
  command('docker', ['info'])
  const container = `clawpilot-shortlink-scope-${process.pid}-${randomUUID().slice(0, 8)}`
  let started = false
  try {
    command('docker', disposablePostgresDockerArgs([
      'run', '--rm', '-d', '--name', container,
      '-e', 'POSTGRES_PASSWORD=clawpilot_shortlink_scope',
      '-e', 'POSTGRES_DB=clawpilot_shortlink_scope',
      '-p', '127.0.0.1::5432',
      'postgres:18',
    ]), { timeout: 180_000 })
    started = true
    const port = Number(command('docker', ['port', container, '5432/tcp']).match(/:(\d+)\s*$/u)?.[1])
    assert.ok(port > 0, 'Disposable Postgres port unavailable')
    const url = `postgresql://postgres:clawpilot_shortlink_scope@127.0.0.1:${port}/clawpilot_shortlink_scope`
    await waitForPostgres(url)
    const pool = new Pool({ connectionString: url, max: 2 })
    try {
      await pool.query("CREATE TABLE workspace_organizations(id uuid PRIMARY KEY); CREATE TABLE app_users(email text PRIMARY KEY, status text DEFAULT 'active');")
      await pool.query('INSERT INTO workspace_organizations(id) VALUES ($1), ($2)', [orgA, orgB])
      await pool.query('INSERT INTO app_users(email) VALUES ($1), ($2)', [sameEmail, otherEmail])
      await pool.query(`
        CREATE TABLE short_links (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_email text NOT NULL, organization_root_id uuid NOT NULL,
          source_app text NOT NULL, slug text NOT NULL UNIQUE,
          destination_url text NOT NULL, title text NOT NULL DEFAULT '',
          tags text[] NOT NULL DEFAULT ARRAY[]::text[], max_clicks bigint,
          click_count bigint NOT NULL DEFAULT 0, expires_at timestamptz,
          disabled_at timestamptz, last_clicked_at timestamptz,
          created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
          deleted_at timestamptz
        )
      `)
      await pool.query(`CREATE TABLE app_user_organization_memberships (
        user_email text NOT NULL, organization_id uuid NOT NULL, status text NOT NULL, role text NOT NULL DEFAULT 'member',
        PRIMARY KEY (user_email, organization_id)
      )`)
      await pool.query(`CREATE TABLE app_user_workspace_preferences (
        user_email text NOT NULL, workspace_organization_id uuid NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (user_email, workspace_organization_id)
      )`)
      await pool.query(readFileSync(resolve(root, 'db/migrations/0367_short_link_public_domain.sql'), 'utf8'))
      await pool.query(readFileSync(resolve(root, 'db/migrations/0368_short_link_workspace_default_domain.sql'), 'utf8'))
      await pool.query(readFileSync(resolve(root, 'db/migrations/0371_organization_web_domains.sql'), 'utf8'))
      for (const [email, organizationId] of [[sameEmail, orgA], [sameEmail, orgB], [otherEmail, orgA]]) {
        await pool.query(`INSERT INTO app_user_organization_memberships
          (user_email, organization_id, status) VALUES ($1, $2::uuid, 'active')`, [email, organizationId])
      }
      await pool.query("UPDATE app_user_organization_memberships SET role = 'admin' WHERE user_email = $1 AND organization_id = $2", [sameEmail, orgA])
      const fixtures = [
        [IDs.ownA, sameEmail, orgA, 'clawpilot', 'scope-a-own'],
        [IDs.otherA, otherEmail, orgA, 'clawpilot', 'scope-a-other'],
        [IDs.ownB, sameEmail, orgB, 'clawpilot', 'scope-b-own'],
        [IDs.serviceA, sameEmail, orgA, 'trusted-client', 'scope-a-service'],
        [IDs.serviceB, sameEmail, orgB, 'trusted-client', 'scope-b-service'],
      ]
      for (const values of fixtures) {
        await pool.query(`INSERT INTO short_links
          (id, owner_email, organization_root_id, source_app, slug, destination_url)
          VALUES ($1::uuid, $2, $3::uuid, $4, $5, 'https://destination.example.test')`, values)
      }
      process.env.SHORTLINK_PUBLIC_ORIGIN = 'https://eigenracing.com'
      const shortlinks = loadShortlinks(pool)
      const listIds = async (who) => (await shortlinks.listShortLinks(who)).map((link) => link.id).sort()
      assert.deepEqual(await listIds(actor()), [IDs.ownA, IDs.otherA, IDs.serviceA].sort(),
        'Normal actor sees current organization only, including same-email row in no other organization')
      assert.deepEqual(await listIds(actor({ manageOrganization: true })), [IDs.ownA, IDs.otherA, IDs.serviceA].sort())
      const serviceActor = actor({ service: true, sourceApp: 'trusted-client' })
      assert.deepEqual(await listIds(serviceActor), [IDs.serviceA],
        'Service actor remains owner-, source-, and organization-bound')

      for (const who of [actor(), actor({ manageOrganization: true })]) {
        await assert.rejects(shortlinks.updateShortLink(who, { id: IDs.ownB, title: 'cross-org' }),
          (error) => error?.status === 404)
        await assert.rejects(shortlinks.deleteShortLink(who, IDs.ownB),
          (error) => error?.status === 404)
      }
      await assert.rejects(shortlinks.updateShortLink(serviceActor, { id: IDs.serviceB, title: 'cross-org' }),
        (error) => error?.status === 404)
      await assert.rejects(shortlinks.deleteShortLink(serviceActor, IDs.serviceB),
        (error) => error?.status === 404)
      await assert.rejects(shortlinks.updateShortLink(serviceActor, { id: IDs.ownA, title: 'wrong-source' }),
        (error) => error?.status === 404)
      await assert.rejects(shortlinks.deleteShortLink(serviceActor, IDs.ownA),
        (error) => error?.status === 404)

      assert.equal((await shortlinks.updateShortLink(actor(), { id: IDs.ownA, title: 'own-update' })).title, 'own-update')
      await assert.rejects(shortlinks.updateShortLink(actor(), { id: IDs.otherA, title: 'not-owner' }),
        (error) => error?.status === 404)
      assert.equal((await shortlinks.updateShortLink(actor({ manageOrganization: true }),
        { id: IDs.otherA, title: 'admin-update' })).title, 'admin-update')
      assert.equal((await shortlinks.updateShortLink(serviceActor,
        { id: IDs.serviceA, title: 'service-update' })).title, 'service-update')
      await shortlinks.deleteShortLink(actor(), IDs.ownA)
      await shortlinks.deleteShortLink(actor({ manageOrganization: true }), IDs.otherA)
      await shortlinks.deleteShortLink(serviceActor, IDs.serviceA)
      const untouched = await pool.query('SELECT id::text, title, deleted_at FROM short_links WHERE organization_root_id = $1::uuid ORDER BY id', [orgB])
      assert.equal(untouched.rows.length, 2)
      assert.ok(untouched.rows.every((link) => link.deleted_at === null && link.title === ''),
        'Cross-organization rows remain unchanged')

      process.env.SHORTLINK_BPO_PUBLIC_ROUTE_READY = '1'
      process.env.SHORTLINK_BPO_ALLOWED_ORGANIZATION_IDS_JSON = JSON.stringify([orgA])
      process.env.SHORTLINK_BPO_RESOLVER_SECRET = 'test-bpo-resolver-secret-longer-than-thirty-two-characters'
      assert.equal(await shortlinks.readShortLinkDefaultDomain(actor()), 'bpo', 'Eligible user begins with BPO default')
      assert.equal(await shortlinks.readShortLinkDefaultDomain(actor({ organizationId: orgB })), 'eigenracing')
      assert.equal(await shortlinks.readShortLinkDefaultDomain(actor({ ownerEmail: otherEmail })), 'bpo')
      assert.equal(await shortlinks.saveShortLinkDefaultDomain(actor(), 'eigenracing'), 'eigenracing')
      assert.equal(await shortlinks.readShortLinkDefaultDomain(actor()), 'eigenracing')
      assert.equal(await shortlinks.readShortLinkDefaultDomain(actor({ ownerEmail: otherEmail })), 'bpo',
        'Another user in the same workspace retains their own default')
      assert.equal(await shortlinks.saveShortLinkDefaultDomain(actor(), 'bpo'), 'bpo')
      const reloadedShortlinks = loadShortlinks(pool)
      assert.equal(await reloadedShortlinks.readShortLinkDefaultDomain(actor()), 'bpo',
        'Saved default survives a fresh module instance')
      assert.equal(await reloadedShortlinks.readShortLinkDefaultDomain(actor({ organizationId: orgB })), 'eigenracing',
        "Same user's other workspace remains independent")
      await assert.rejects(shortlinks.saveShortLinkDefaultDomain(actor({ organizationId: orgB }), 'bpo'),
        (error) => error?.status === 403)
      await assert.rejects(shortlinks.saveShortLinkDefaultDomain(serviceActor, 'bpo'),
        (error) => error?.status === 403)
      assert.equal(await shortlinks.readShortLinkDefaultDomain(serviceActor), 'eigenracing')
      await assert.rejects(shortlinks.readShortLinkDefaultDomain(actor({ organizationId: '44444444-4444-4444-8444-444444444444' })),
        (error) => error?.status === 403)
      await assert.rejects(shortlinks.saveShortLinkDefaultDomain(actor({ organizationId: '44444444-4444-4444-8444-444444444444' }), 'eigenracing'),
        (error) => error?.status === 403)
      process.env.SHORTLINK_BPO_PUBLIC_ROUTE_READY = '0'
      assert.equal(await shortlinks.readShortLinkDefaultDomain(actor()), 'eigenracing',
        'Saved BPO choice falls back while its route is unavailable')
      const savedPreference = await pool.query(`SELECT short_link_default_domain FROM app_user_workspace_preferences
        WHERE user_email = $1 AND workspace_organization_id = $2::uuid`, [sameEmail, orgA])
      assert.equal(savedPreference.rows[0].short_link_default_domain, 'bpo', 'Unavailable domain does not erase saved choice')
      process.env.SHORTLINK_BPO_PUBLIC_ROUTE_READY = '1'
      assert.equal(await shortlinks.readShortLinkDefaultDomain(actor()), 'bpo')

      process.env.CLAWPILOT_PUBLIC_URL = 'https://aiapp.eigenracing.com'
      process.env.CLAWPILOT_ADDITIONAL_PUBLIC_ORIGINS_JSON = JSON.stringify(['https://aiapp.bposupplychain.com', 'https://dev.aiapp.bposupplychain.com'])
      const organizationPreferences = loadOrganizationPreferences(pool)
      const admin = { email: sameEmail, organizationId: orgA, role: 'admin' }
      const domains = shortlinks.availableShortLinkDomains(actor())
      const save = (changes = {}, user = admin) => organizationPreferences.saveOrganizationWebPreferences(user, { appDomain: 'bpo', shortLinkDomain: 'bpo', allowUserShortLinkOverride: true, revision: 0, ...changes }, domains)
      assert.equal((await organizationPreferences.readOrganizationWebPreferences(orgA)).appDomain, 'bpo')
      assert.equal(await organizationPreferences.organizationAppPublicUrl(orgA), 'https://aiapp.bposupplychain.com')
      assert.ok(organizationPreferences.availableOrganizationAppDomains().every((choice) => !choice.url.includes('dev.')), 'Never expose a different environment app host')
      await assert.rejects(save({}, { ...admin, role: 'member' }), (error) => error.status === 403)
      await assert.rejects(save({}, { ...admin, email: otherEmail, organizationId: orgB }), (error) => error.status === 403)
      await pool.query("UPDATE app_user_organization_memberships SET role = 'member' WHERE user_email = $1 AND organization_id = $2", [sameEmail, orgA])
      await assert.rejects(save(), (error) => error.status === 403, 'A stale admin actor cannot bypass a current membership downgrade')
      await pool.query("UPDATE app_user_organization_memberships SET role = 'admin' WHERE user_email = $1 AND organization_id = $2", [sameEmail, orgA])
      await assert.rejects(save({ appDomain: 'https://evil.example' }), (error) => error.status === 400)
      const locked = await save({ appDomain: 'eigenracing', shortLinkDomain: 'eigenracing', allowUserShortLinkOverride: false })
      assert.equal(locked.revision, 1)
      await assert.rejects(save(), (error) => error.status === 409, 'Stale admins cannot overwrite organization settings')
      assert.equal(await organizationPreferences.organizationAppPublicUrl(orgA), 'https://aiapp.eigenracing.com')
      assert.equal(await shortlinks.readShortLinkDefaultDomain(actor()), 'eigenracing', 'Locked organization default overrides a previous user BPO preference')
      assert.equal((await shortlinks.readShortLinkDomainPreferences(actor())).availableDomains.length, 1)
      await assert.rejects(shortlinks.saveShortLinkDefaultDomain(actor(), 'bpo'), (error) => error.status === 403)
      await assert.rejects(shortlinks.saveShortLinkDefaultDomain(actor(), null), (error) => error.status === 403)
      await assert.rejects(shortlinks.createShortLink(actor(), { destinationUrl: 'https://destination.example.test', publicDomain: 'bpo', slug: 'locked-domain-denied' }), (error) => error.status === 403)
      assert.equal((await shortlinks.createShortLink(actor(), { destinationUrl: 'https://destination.example.test', slug: 'locked-domain-default' })).publicDomain, 'eigenracing')
      assert.equal((await shortlinks.createShortLink(serviceActor, { destinationUrl: 'https://destination.example.test', slug: 'service-domain-unchanged' })).publicDomain, 'eigenracing', 'Service callers retain existing independent legacy behavior')
      await save({ revision: 1, appDomain: 'bpo' })
      assert.equal(await shortlinks.readShortLinkDefaultDomain(actor()), 'bpo', 'Enabling overrides restores the preserved explicit user preference')
      await shortlinks.saveShortLinkDefaultDomain(actor(), null)
      assert.equal((await shortlinks.readShortLinkDomainPreferences(actor())).userDefaultDomain, null, 'User can explicitly return to organization inheritance')
      await save({ revision: 2, shortLinkDomain: 'eigenracing' })
      assert.equal(await shortlinks.readShortLinkDefaultDomain(actor()), 'eigenracing', 'Inherited default follows subsequent admin changes')
      assert.equal((await organizationPreferences.readOrganizationWebPreferences(orgB)).revision, 0, 'Other organization settings remain untouched')
      process.env.CLAWPILOT_ADDITIONAL_PUBLIC_ORIGINS_JSON = '[]'
      assert.equal(await organizationPreferences.organizationAppPublicUrl(orgA), 'https://aiapp.eigenracing.com', 'Unavailable saved BPO address falls back without changing preference')
      assert.equal((await organizationPreferences.readOrganizationWebPreferences(orgA)).appDomain, 'bpo')
    } finally {
      await pool.end()
    }
  } finally {
    if (started) command('docker', disposablePostgresDockerCleanupArgs(container), { timeout: 30_000 })
  }
  console.log('Short-link same-email cross-organization list/update/delete PostgreSQL scope passed')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
