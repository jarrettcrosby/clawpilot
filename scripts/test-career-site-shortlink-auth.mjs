#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import vm from 'node:vm'

const root = process.cwd()
const requireFromApp = createRequire(new URL('../app_src/package.json', import.meta.url))
const ts = requireFromApp('typescript')
const organizationId = '405bb919-0364-4a88-8a62-b4c9da42cd8f'

class WorkspaceAccessError extends Error {}

function loadShortlinks(requireWorkspaceAppUser) {
  const path = 'app_src/lib/shortlinks.ts'
  const output = ts.transpileModule(readFileSync(resolve(root, path), 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: path,
  }).outputText
  const module = { exports: {} }
  vm.runInNewContext(output, {
    URL,
    console,
    exports: module.exports,
    module,
    process,
    require(specifier) {
      if (specifier === 'node:crypto') return requireFromApp('node:crypto')
      if (specifier === '@/lib/globalIds.mjs') {
        return { globalIdFragment: () => '[a-z0-9]+', globalIdPattern: () => /^[a-z0-9]+$/ }
      }
      if (specifier === '@/lib/persistence/config') return { getStorageDriver: () => 'postgres' }
      if (specifier === '@/lib/persistence/postgres') {
        return { query: async () => ({ rows: [] }), withTransaction: async (callback) => callback({}) }
      }
      if (specifier === '@/lib/requestUser') return { requireRequestUser: async () => null }
      if (specifier === '@/lib/users') {
        return {
          effectiveAuthorizationRole: () => 'owner',
          effectiveUserPermissions: () => ({ manageLinks: true }),
          normalizeUserEmail(value) {
            const email = String(value || '').trim().toLowerCase()
            if (!email.includes('@')) throw new Error('invalid email')
            return email
          },
        }
      }
      if (specifier === '@/lib/workspaceMemberships') {
        return { requireWorkspaceAppUser, WorkspaceAccessError }
      }
      throw new Error(`Unexpected short-link auth test import: ${specifier}`)
    },
  }, { filename: path })
  return module.exports
}

function request(headers) {
  const normalized = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]))
  return { headers: { get: (key) => normalized.get(String(key).toLowerCase()) || null } }
}

function configureCareerClient() {
  process.env.CAREER_SITE_SUBMISSIONS_ENABLED = '1'
  process.env.CAREER_SITE_SUBMISSIONS_OWNER_EMAIL = 'jarrett@suburbiasandwichco.com'
  process.env.CAREER_SITE_SUBMISSIONS_ORGANIZATION_ID = organizationId
  process.env.SHORTLINK_PUBLIC_ORIGIN = 'https://eigenracing.com'
  process.env.SHORTLINK_SERVICE_CLIENTS_JSON = JSON.stringify([{
    sourceApp: 'jarrett-career-site',
    secret: 'career-site-secret-that-is-longer-than-thirty-two-characters',
    ownerDomain: 'suburbiasandwichco.com',
    ownerEmail: 'jarrett@suburbiasandwichco.com',
    organizationId,
  }])
}

const original = {
  enabled: process.env.CAREER_SITE_SUBMISSIONS_ENABLED,
  owner: process.env.CAREER_SITE_SUBMISSIONS_OWNER_EMAIL,
  organization: process.env.CAREER_SITE_SUBMISSIONS_ORGANIZATION_ID,
  origin: process.env.SHORTLINK_PUBLIC_ORIGIN,
  clients: process.env.SHORTLINK_SERVICE_CLIENTS_JSON,
}
try {
  configureCareerClient()
  const headers = {
    authorization: 'Bearer career-site-secret-that-is-longer-than-thirty-two-characters',
    'x-shortlink-source': 'jarrett-career-site',
    'x-shortlink-owner': 'jarrett@suburbiasandwichco.com',
    'x-shortlink-organization': organizationId,
  }
  let shortlinks = loadShortlinks(async () => {
    throw new WorkspaceAccessError('no membership')
  })
  await assert.rejects(
    shortlinks.resolveShortLinkActor(request(headers)),
    (error) => error?.status === 403,
  )

  shortlinks = loadShortlinks(async () => {
    throw new Error('database unavailable')
  })
  await assert.rejects(
    shortlinks.resolveShortLinkActor(request(headers)),
    (error) => error?.status === 503 && /temporarily unavailable/.test(error.message),
  )

  let membershipCalls = 0
  shortlinks = loadShortlinks(async () => {
    membershipCalls += 1
    return { organizationId }
  })
  await assert.rejects(
    shortlinks.resolveShortLinkActor(request({
      ...headers,
      'x-shortlink-organization': '11111111-1111-4111-8111-111111111111',
    })),
    (error) => error?.status === 403,
  )
  assert.equal(membershipCalls, 0)

  process.env.CAREER_SITE_SUBMISSIONS_ENABLED = '0'
  process.env.SHORTLINK_SERVICE_CLIENTS_JSON = JSON.stringify([{
    sourceApp: 'legacy-client',
    secret: 'legacy-service-secret-that-is-longer-than-thirty-two-characters',
  }])
  let requestedOrganization
  shortlinks = loadShortlinks(async (_owner, value) => {
    requestedOrganization = value
    return { organizationId: '22222222-2222-4222-8222-222222222222' }
  })
  const legacy = await shortlinks.resolveShortLinkActor(request({
    authorization: 'Bearer legacy-service-secret-that-is-longer-than-thirty-two-characters',
    'x-shortlink-source': 'legacy-client',
    'x-shortlink-owner': 'legacy@example.com',
  }))
  assert.equal(requestedOrganization, undefined)
  assert.equal(legacy.organizationId, '22222222-2222-4222-8222-222222222222')
} finally {
  const restore = (name, value) => {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  restore('CAREER_SITE_SUBMISSIONS_ENABLED', original.enabled)
  restore('CAREER_SITE_SUBMISSIONS_OWNER_EMAIL', original.owner)
  restore('CAREER_SITE_SUBMISSIONS_ORGANIZATION_ID', original.organization)
  restore('SHORTLINK_PUBLIC_ORIGIN', original.origin)
  restore('SHORTLINK_SERVICE_CLIENTS_JSON', original.clients)
}

console.log('Career-site organization-pinned short-link authentication verified')
