#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import vm from 'node:vm'
import { spawnSync } from 'node:child_process'

const appRequire = createRequire(new URL('../app_src/package.json', import.meta.url))
const ts = appRequire('typescript')
const root = process.cwd()
const bpoOrg = '11111111-1111-4111-8111-111111111111'
const otherOrg = '22222222-2222-4222-8222-222222222222'
const secret = 'bpo-resolver-test-secret-at-least-32-characters'
const originalEnvironment = {
  SHORTLINK_PUBLIC_ORIGIN: process.env.SHORTLINK_PUBLIC_ORIGIN,
  SHORTLINK_BPO_PUBLIC_ROUTE_READY: process.env.SHORTLINK_BPO_PUBLIC_ROUTE_READY,
  SHORTLINK_BPO_ALLOWED_ORGANIZATION_IDS_JSON: process.env.SHORTLINK_BPO_ALLOWED_ORGANIZATION_IDS_JSON,
  SHORTLINK_BPO_RESOLVER_SECRET: process.env.SHORTLINK_BPO_RESOLVER_SECRET,
}

function source(path) { return readFileSync(resolve(root, path), 'utf8') }

function loadShortlinks(database) {
  const path = 'app_src/lib/shortlinks.ts'
  const output = ts.transpileModule(source(path), {
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
      if (specifier === '@/lib/persistence/postgres') return database
      if (specifier === '@/lib/requestUser') return { requireRequestUser: async () => null }
      if (specifier === '@/lib/users') return {
        effectiveAuthorizationRole: () => 'owner',
        effectiveUserPermissions: () => ({ manageLinks: true }),
        normalizeUserEmail: (value) => String(value).toLowerCase(),
      }
      if (specifier === '@/lib/workspaceMemberships') return {
        requireWorkspaceAppUser: async () => ({ organizationId: bpoOrg }),
        WorkspaceAccessError: class WorkspaceAccessError extends Error {},
      }
      throw new Error(`Unexpected short-link test import: ${specifier}`)
    },
  }, { filename: path })
  return module.exports
}

function loadBpoResolverRoute(shortlinks) {
  const path = 'app_src/app/api/shortlinks/bpo/resolve/[slug]/route.ts'
  const output = ts.transpileModule(source(path), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    fileName: path,
  }).outputText
  class FakeNextResponse extends Response {
    static redirect(url, options) {
      return new FakeNextResponse(null, {
        ...options,
        headers: { ...options.headers, Location: url },
      })
    }
  }
  const module = { exports: {} }
  vm.runInNewContext(output, {
    console, Response, URL, exports: module.exports, module,
    require(specifier) {
      if (specifier === 'next/server') return { NextResponse: FakeNextResponse }
      if (specifier === '@/lib/shortlinks') return shortlinks
      throw new Error(`Unexpected BPO resolver test import: ${specifier}`)
    },
  }, { filename: path })
  return module.exports
}

const actor = (organizationId = bpoOrg, service = false) => ({
  ownerEmail: 'operator@example.test', organizationId, sourceApp: service ? 'trusted-client' : 'clawpilot',
  manageOrganization: !service, service,
})
const row = (slug, publicDomain) => ({
  id: '33333333-3333-4333-8333-333333333333', owner_email: 'operator@example.test',
  source_app: 'clawpilot', public_domain: publicDomain, slug,
  destination_url: 'https://destination.example.test/landing', title: '', tags: [], link_status: 'active',
  expires_at: null, max_clicks: null, click_count: '0', last_clicked_at: null,
  created_at: '2026-09-21T00:00:00.000Z', updated_at: '2026-09-21T00:00:00.000Z',
})

try {
  process.env.SHORTLINK_PUBLIC_ORIGIN = 'https://eigenracing.com'
  process.env.SHORTLINK_BPO_PUBLIC_ROUTE_READY = '0'
  process.env.SHORTLINK_BPO_ALLOWED_ORGANIZATION_IDS_JSON = JSON.stringify([bpoOrg])
  process.env.SHORTLINK_BPO_RESOLVER_SECRET = secret
  const calls = []
  const shortlinks = loadShortlinks({
    query: async (sql, params) => {
      calls.push({ sql, params })
      return { rows: [row(params[4], params[3])] }
    },
    withTransaction: async (callback) => callback({ query: async () => ({ rows: [] }) }),
  })

  assert.deepEqual(Array.from(shortlinks.availableShortLinkDomains(actor()), (choice) => choice.key), ['eigenracing'])
  await assert.rejects(
    shortlinks.createShortLink(actor(), { destinationUrl: 'https://destination.example.test', publicDomain: 'bpo', slug: 'bpo-test' }),
    (error) => error?.status === 403,
  )

  process.env.SHORTLINK_BPO_PUBLIC_ROUTE_READY = '1'
  assert.deepEqual(Array.from(shortlinks.availableShortLinkDomains(actor()), (choice) => choice.key), ['eigenracing', 'bpo'])
  assert.deepEqual(Array.from(shortlinks.availableShortLinkDomains(actor(otherOrg)), (choice) => choice.key), ['eigenracing', 'bpo'],
    'An enabled domain is available to every organization, not just the original rollout workspace')
  assert.deepEqual(Array.from(shortlinks.availableShortLinkDomains(actor(bpoOrg, true)), (choice) => choice.key), ['eigenracing'])
  process.env.SHORTLINK_BPO_ALLOWED_ORGANIZATION_IDS_JSON = '["not-a-uuid"]'
  assert.deepEqual(Array.from(shortlinks.availableShortLinkDomains(actor(otherOrg)), (choice) => choice.key), ['eigenracing', 'bpo'],
    'A retired rollout allowlist cannot disable admin domain choices')
  delete process.env.SHORTLINK_BPO_ALLOWED_ORGANIZATION_IDS_JSON
  assert.doesNotThrow(() => shortlinks.validateShortLinkConfiguration())
  process.env.SHORTLINK_BPO_RESOLVER_SECRET = 'too-short'
  assert.throws(() => shortlinks.availableShortLinkDomains(actor()), (error) => error?.status === 503)
  process.env.SHORTLINK_BPO_RESOLVER_SECRET = secret
  const otherOrganizationLink = await shortlinks.createShortLink(actor(otherOrg), {
    destinationUrl: 'https://destination.example.test', publicDomain: 'bpo', slug: 'other-org-bpo',
  })
  assert.equal(otherOrganizationLink.shortUrl, 'https://bposupplychain.com/s/other-org-bpo')
  assert.equal(calls.at(-1).params[1], otherOrg, 'BPO links still belong to the active organization')
  await assert.rejects(
    shortlinks.createShortLink(actor(bpoOrg, true), { destinationUrl: 'https://destination.example.test', publicDomain: 'bpo', slug: 'bpo-test' }),
    (error) => error?.status === 403,
  )
  await assert.rejects(
    shortlinks.createShortLink(actor(), { destinationUrl: 'https://destination.example.test', publicDomain: 'https://evil.example', slug: 'bpo-test' }),
    (error) => error?.status === 400,
  )
  await assert.rejects(
    shortlinks.createShortLink(actor(), { destinationUrl: 'https://bposupplychain.com/s/other-link', publicDomain: 'bpo', slug: 'bpo-test' }),
    (error) => error?.status === 400,
  )

  const bpo = await shortlinks.createShortLink(actor(), {
    destinationUrl: 'https://destination.example.test', publicDomain: 'bpo', slug: 'bpo-test',
  })
  assert.equal(bpo.shortUrl, 'https://bposupplychain.com/s/bpo-test')
  assert.equal(bpo.publicDomain, 'bpo')
  assert.equal(calls.at(-1).params[3], 'bpo')
  const legacy = await shortlinks.createShortLink(actor(), {
    destinationUrl: 'https://destination.example.test', publicDomain: 'eigenracing', slug: 'legacy-test',
  })
  assert.equal(legacy.shortUrl, 'https://eigenracing.com/s/legacy-test')
  assert.equal(legacy.publicDomain, 'eigenracing')
  assert.equal(calls.at(-1).params[3], null)
  await assert.rejects(
    shortlinks.updateShortLink(actor(), { id: bpo.id, publicDomain: 'eigenracing' }),
    (error) => error?.status === 400 && /cannot be changed/.test(error.message),
  )
  assert.doesNotThrow(() => shortlinks.assertBpoShortLinkResolverAuthorization(`Bearer ${secret}`))
  assert.throws(() => shortlinks.assertBpoShortLinkResolverAuthorization('Bearer wrong'), (error) => error?.status === 401)
  assert.throws(() => shortlinks.assertBpoShortLinkResolverAuthorization(null), (error) => error?.status === 401)

  const resolutionCalls = []
  const resolver = loadShortlinks({
    query: async () => ({ rows: [] }),
    withTransaction: async (callback) => callback({
      query: async (sql, params) => {
        resolutionCalls.push({ sql, params })
        if (sql.includes('FROM short_links')) {
          return { rows: params[1] === 'bpo' ? [{
            id: bpo.id, destination_url: bpo.destinationUrl, disabled_at: null,
            expires_at: null, max_clicks: '1', click_count: '0',
          }] : [] }
        }
        return { rows: [], rowCount: 1 }
      },
    }),
  })
  assert.equal((await resolver.resolveShortLink({ slug: 'bpo-test' })).status, 'not-found')
  assert.equal(resolutionCalls.length, 1, 'Wrong domain cannot count a click')
  const found = await resolver.resolveShortLink({ slug: 'bpo-test', publicDomain: 'bpo' })
  assert.equal(found.status, 'found')
  assert.equal(found.destinationUrl, bpo.destinationUrl)
  assert.equal(resolutionCalls[1].params[1], 'bpo')
  assert.equal(resolutionCalls.length, 4, 'Correct domain counts exactly one click and event')

  let routedResolutions = 0
  let routeResult = { status: 'found', destinationUrl: 'https://destination.example.test/landing' }
  const bpoRoute = loadBpoResolverRoute({
    ShortLinkRequestError: shortlinks.ShortLinkRequestError,
    assertBpoShortLinkResolverAuthorization: shortlinks.assertBpoShortLinkResolverAuthorization,
    resolveShortLink: async (input) => {
      routedResolutions += 1
      assert.equal(input.publicDomain, 'bpo')
      assert.equal(input.sourceApp, 'bpo-short-link')
      return routeResult
    },
  })
  const routeContext = { params: Promise.resolve({ slug: 'bpo-test' }) }
  const unauthorized = await bpoRoute.GET({ headers: new Headers() }, routeContext)
  assert.equal(unauthorized.status, 401)
  assert.equal(routedResolutions, 0)
  const authorized = await bpoRoute.GET({ headers: new Headers({ authorization: `Bearer ${secret}` }) }, routeContext)
  assert.equal(authorized.status, 307)
  assert.equal(authorized.headers.get('Location'), 'https://destination.example.test/landing')
  assert.equal(authorized.headers.get('Cache-Control'), 'private, no-store, max-age=0')
  assert.equal(routedResolutions, 1)
  routeResult = { status: 'not-found' }
  assert.equal((await bpoRoute.GET({ headers: new Headers({ authorization: `Bearer ${secret}` }) }, routeContext)).status, 404)
  routeResult = { status: 'expired' }
  assert.equal((await bpoRoute.GET({ headers: new Headers({ authorization: `Bearer ${secret}` }) }, routeContext)).status, 410)
  const head = await bpoRoute.HEAD()
  assert.equal(head.status, 405)
  assert.equal(routedResolutions, 3, 'HEAD must never count a click')

  const runtimeEnvironment = {
    SHORTLINK_PUBLIC_ORIGIN: 'https://eigenracing.com',
    SHORTLINK_SERVICE_CLIENTS_JSON: JSON.stringify([{
      sourceApp: 'jarrett-career-agents', secret: 'test-service-secret-at-least-thirty-two-characters',
      ownerDomain: 'suburbiasandwichco.com', ownerEmail: 'jarrett@suburbiasandwichco.com',
      organizationId: '405bb919-0364-4a88-8a62-b4c9da42cd8f',
    }]),
    CAREER_SITE_AGENTS_ENABLED: '1',
    CAREER_SITE_SUBMISSIONS_OWNER_EMAIL: 'jarrett@suburbiasandwichco.com',
    CAREER_SITE_SUBMISSIONS_ORGANIZATION_ID: '405bb919-0364-4a88-8a62-b4c9da42cd8f',
    SHORTLINK_BPO_PUBLIC_ROUTE_READY: '1',
    SHORTLINK_BPO_RESOLVER_SECRET: secret,
    INTEGRATION_EVIDENCE_FINGERPRINT_KEY: 'test-fingerprint-key-at-least-thirty-two-characters',
    INTEGRATION_EVIDENCE_ACTIVE_KEY_ID: 'test-v1',
    INTEGRATION_EVIDENCE_ENCRYPTION_KEYS: JSON.stringify({ 'test-v1': 'test-evidence-key-at-least-thirty-two-characters' }),
  }
  const validateRuntime = (overrides = {}) => spawnSync(process.execPath, ['scripts/validate-runtime-config.mjs'], {
    cwd: root, encoding: 'utf8', env: { ...runtimeEnvironment, ...overrides },
  })
  const readyRuntime = validateRuntime()
  assert.equal(readyRuntime.status, 0, readyRuntime.stderr)
  assert.match(readyRuntime.stdout, /bpoShortLinkDomain=ready/, 'No organization allowlist is required at startup')
  assert.notEqual(validateRuntime({ SHORTLINK_BPO_RESOLVER_SECRET: 'too-short' }).status, 0)
  assert.notEqual(validateRuntime({ SHORTLINK_BPO_PUBLIC_ROUTE_READY: 'invalid' }).status, 0)
  assert.equal(validateRuntime({ SHORTLINK_BPO_PUBLIC_ROUTE_READY: '0', SHORTLINK_BPO_RESOLVER_SECRET: '' }).status, 0,
    'Suspended or unconfigured environments can leave the public domain disabled')

  assert.match(source('db/migrations/0367_short_link_public_domain.sql'), /CHECK \(public_domain IS NULL OR public_domain = 'bpo'\)/)
  const route = source('app_src/app/api/shortlinks/bpo/resolve/[slug]/route.ts')
  assert.match(route, /export async function HEAD\(\)/)
  assert.match(route, /status: 405/)
  assert.match(route, /assertBpoShortLinkResolverAuthorization/)
  console.log('Short-link domain selection, legacy preservation, org scope, resolver binding, and HEAD fence passed')
} finally {
  for (const [key, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}
