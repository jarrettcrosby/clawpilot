#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const appRequire = createRequire(new URL('../app_src/package.json', import.meta.url))
const ts = appRequire('typescript')
const noIo = () => { throw new Error('Unexpected pipeline sheet-link test I/O') }
const actor = {
  email: 'operator@example.test',
  organizationId: '11111111-1111-4111-8111-111111111111',
}

function loadModule(path, dependencies) {
  const output = ts.transpileModule(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    fileName: path,
  }).outputText
  const module = { exports: {} }
  vm.runInNewContext(output, {
    URL, console, process, module, exports: module.exports,
    require(specifier) {
      if (Object.hasOwn(dependencies, specifier)) return dependencies[specifier]
      if (specifier.startsWith('node:')) return appRequire(specifier)
      throw new Error(`Unexpected pipeline sheet-link test import: ${specifier}`)
    },
  }, { filename: path })
  return module.exports
}

const shortlinks = loadModule('app_src/lib/shortlinks.ts', {
  '@/lib/globalIds.mjs': { globalIdFragment: () => '[a-z0-9]+', globalIdPattern: () => /^g[a-z][a-z0-9]+$/ },
  '@/lib/persistence/config': { getStorageDriver: () => 'postgres' },
  '@/lib/persistence/postgres': { query: noIo, withTransaction: noIo },
  '@/lib/requestUser': { requireRequestUser: noIo },
  '@/lib/users': {},
  '@/lib/workspaceMemberships': {},
})

let rows = []
let reads = 0
const tenancy = loadModule('app_src/lib/tenancy.ts', {
  '@/lib/persistence/postgres': {
    query: async (sql, params) => {
      reads += 1
      assert.match(sql, /FROM pipeline_spaces pipeline/)
      assert.match(sql, /short_link\.public_domain AS short_link_public_domain/,
        'Pipeline summaries must retain the persisted domain, not infer it from current preferences')
      assert.match(sql, /WHERE pipeline\.workspace_organization_id = \$2::uuid/)
      assert.equal(params[0], actor.email)
      assert.equal(params[1], actor.organizationId)
      return { rows }
    },
    withTransaction: noIo,
  },
  '@/lib/auditWriter': { recordAuditEvent: noIo },
  '@/lib/persistence/pipeline': {},
  '@/lib/shortlinks': shortlinks,
  '@/lib/organizations': { ensurePrimaryWorkspaceOrganization: noIo },
  '@/lib/pipeline/baseTemplate.mjs': {},
  '@/lib/users': {},
  '@/lib/workspaceMemberships': {
    requireWorkspaceAppUser: async (email, organizationId) => {
      assert.equal(email, actor.email)
      assert.equal(organizationId, actor.organizationId)
      return actor
    },
  },
  '@/lib/demoMode': { isDemoWorkspaceId: () => false },
})

function row(slug, publicDomain) {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    name: 'My pipeline', owner_email: actor.email,
    workspace_organization_id: actor.organizationId, is_default: true,
    access_role: 'owner', members: [], sheet_id: 'test-sheet-id', sync_enabled: true,
    provisioning_status: 'ready', provisioning_error: null,
    provisioning_requested_at: null, provisioning_started_at: null,
    provisioning_last_attempted_at: null, provisioning_completed_at: null,
    short_link_id: '33333333-3333-4333-8333-333333333333',
    short_link_slug: slug, short_link_public_domain: publicDomain,
    projection: null, created_at: '2026-10-09T14:00:00Z', updated_at: '2026-10-09T14:00:00Z',
  }
}

const originalOrigin = process.env.SHORTLINK_PUBLIC_ORIGIN
try {
  process.env.SHORTLINK_PUBLIC_ORIGIN = 'https://eigenracing.com'
  rows = [row('bpo-pipeline', 'bpo'), row('legacy-pipeline', null), row(null, 'bpo'), row('unknown-domain', 'untrusted')]
  const pipelines = await tenancy.listPipelineSpaces(actor, { ensureDefaults: false })
  assert.equal(pipelines[0].shortLinkUrl, 'https://bposupplychain.com/s/bpo-pipeline',
    'Open Sheet must use the BPO resolver for a BPO-created link')
  assert.equal(pipelines[1].shortLinkUrl, 'https://eigenracing.com/s/legacy-pipeline',
    'Legacy links keep their stored domain even when BPO is the current organization default')
  assert.equal(pipelines[2].shortLinkUrl, null, 'An unavailable or missing slug must not produce a link')
  assert.equal(pipelines[3].shortLinkUrl, null, 'An unknown persisted domain must fail closed')
  assert.equal(pipelines[0].shortLinkId, rows[0].short_link_id, 'Database identity is distinct from the public slug')

  process.env.SHORTLINK_PUBLIC_ORIGIN = 'http://localhost:4002'
  rows = [row('bpo-pipeline', 'bpo'), row('legacy-pipeline', null)]
  const local = await tenancy.listPipelineSpaces(actor, { ensureDefaults: false })
  assert.equal(local[0].shortLinkUrl, 'https://bposupplychain.com/s/bpo-pipeline')
  assert.equal(local[1].shortLinkUrl, null, 'Hosted Open Sheet links remain HTTPS-only')
  assert.equal(reads, 2)
} finally {
  if (originalOrigin === undefined) delete process.env.SHORTLINK_PUBLIC_ORIGIN
  else process.env.SHORTLINK_PUBLIC_ORIGIN = originalOrigin
}

console.log('Pipeline Open Sheet preserves stored short-link domain, legacy behavior, scope, and HTTPS safety')
