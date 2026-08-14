#!/usr/bin/env node

import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import vm from 'node:vm'

const root = process.cwd()
const requireFromApp = createRequire(
  new URL('../app_src/package.json', import.meta.url),
)
const ts = requireFromApp('typescript')
const { Pool } = requireFromApp('pg')

function command(executable, args, options = {}) {
  return execFileSync(executable, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  })
}

async function waitForPostgres(databaseUrl) {
  const deadline = Date.now() + 60_000
  let lastError = null
  while (Date.now() < deadline) {
    const pool = new Pool({ connectionString: databaseUrl, max: 1 })
    try {
      await pool.query('SELECT 1')
      await pool.end()
      return
    } catch (error) {
      lastError = error
      await pool.end().catch(() => {})
      await new Promise((resolveWait) => setTimeout(resolveWait, 250))
    }
  }
  throw lastError ?? new Error('Disposable PostgreSQL did not become ready')
}

function loadShippingPersistence(query) {
  const path = 'app_src/lib/persistence/shipping.ts'
  const source = readFileSync(resolve(root, path), 'utf8')
  const result = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: path,
    reportDiagnostics: true,
  })
  const errors = (result.diagnostics || []).filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  )
  assert.deepEqual(errors, [], 'Shipping persistence must transpile')
  const module = { exports: {} }
  vm.runInNewContext(result.outputText, {
    Array,
    Boolean,
    Date,
    Error,
    JSON,
    Math,
    Number,
    Object,
    Promise,
    RegExp,
    String,
    console,
    exports: module.exports,
    module,
    require(specifier) {
      if (specifier === '@/lib/persistence/postgres') return { query }
      if (specifier === '@/lib/operations/shipping') return {}
      throw new Error(`Unexpected Shipping persistence dependency: ${specifier}`)
    },
  }, { filename: path })
  return module.exports
}

async function verifyShippingProjection(databaseUrl) {
  const pool = new Pool({ connectionString: databaseUrl, max: 2 })
  try {
    const persistence = loadShippingPersistence((text, values) => (
      pool.query(text, values)
    ))
    const organizationId = randomUUID()
    const workspace = await persistence.readShippingWorkspaceFromPostgres({
      organizationId,
      canView: true,
      canCreate: false,
      canActivate: false,
    })
    assert.equal(workspace.organizationId, organizationId)
    assert.deepEqual(Array.from(workspace.records), [])
    assert.deepEqual(
      JSON.parse(JSON.stringify(workspace.capabilities)),
      { canView: true, canCreate: false, canActivate: false },
    )
    assert.equal(workspace.pickupAvailability.parcel.available, false)
    assert.equal(workspace.pickupAvailability.ltl.available, false)
  } finally {
    await pool.end()
  }
}

async function run() {
  command('docker', ['info'], { timeout: 30_000 })
  const container = `clawpilot-shipping-${process.pid}-${randomUUID().slice(0, 8)}`
  try {
    command('docker', [
      'run', '--rm', '-d', '--name', container,
      '-e', 'POSTGRES_PASSWORD=clawpilot_shipping',
      '-e', 'POSTGRES_DB=clawpilot_shipping',
      '-p', '127.0.0.1::5432',
      'pgvector/pgvector:pg16',
    ], { timeout: 180_000 })
    const portOutput = command('docker', ['port', container, '5432/tcp'])
    const port = Number(portOutput.match(/:(\d+)\s*$/u)?.[1])
    assert.ok(port > 0, `Unable to resolve PostgreSQL port: ${portOutput}`)
    const databaseUrl = (
      `postgresql://postgres:clawpilot_shipping@127.0.0.1:${port}`
      + '/clawpilot_shipping'
    )
    await waitForPostgres(databaseUrl)
    command('node', ['scripts/db-migrate.mjs'], {
      env: { ...process.env, DATABASE_URL: databaseUrl, PGSSLMODE: 'disable' },
      timeout: 180_000,
    })
    await verifyShippingProjection(databaseUrl)
  } finally {
    spawnSync('docker', ['stop', '-t', '1', container], {
      cwd: root,
      encoding: 'utf8',
      timeout: 20_000,
    })
  }
}

await run()
console.log('Shipping workspace disposable-PostgreSQL projection passed.')
