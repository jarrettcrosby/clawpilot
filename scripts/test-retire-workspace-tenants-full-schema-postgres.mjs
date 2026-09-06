#!/usr/bin/env node

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { inspectRuntimeCatalog } from './retire-workspace-tenants.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const requireFromApp = createRequire(new URL('../app_src/package.json', import.meta.url))
const { Pool } = requireFromApp('pg')

function command(executable, args, options = {}) {
  return execFileSync(executable, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  }).trim()
}

async function waitForPostgres(databaseUrl) {
  const deadline = Date.now() + 60_000
  let lastError
  while (Date.now() < deadline) {
    const pool = new Pool({ connectionString: databaseUrl, max: 1 })
    try {
      await pool.query('SELECT 1')
      await pool.end()
      return
    } catch (error) {
      lastError = error
      await pool.end().catch(() => undefined)
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 200))
    }
  }
  throw lastError || new Error('Disposable PostgreSQL did not become ready')
}

let containerName = null
let pool = null
try {
  containerName = `clawpilot-retirement-schema-${process.pid}-${randomUUID().slice(0, 8)}`
  command('docker', [
    'run', '--rm', '--detach',
    '--name', containerName,
    '--env', 'POSTGRES_PASSWORD=tenant_retirement_schema_test',
    '--publish', '127.0.0.1::5432',
    'pgvector/pgvector:pg16',
  ])
  const binding = command('docker', ['port', containerName, '5432/tcp'])
  const port = /:(\d+)$/u.exec(binding)?.[1]
  assert.ok(port, `Could not parse disposable PostgreSQL port: ${binding}`)
  const databaseUrl = `postgresql://postgres:tenant_retirement_schema_test@127.0.0.1:${port}/postgres`
  await waitForPostgres(databaseUrl)
  command(process.execPath, ['scripts/db-migrate.mjs'], {
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      PGSSLMODE: 'disable',
    },
    timeout: 10 * 60 * 1000,
    maxBuffer: 32 * 1024 * 1024,
  })
  pool = new Pool({ connectionString: databaseUrl, max: 1 })
  const client = await pool.connect()
  try {
    const catalog = await inspectRuntimeCatalog(client)
    assert.deepEqual(
      catalog.organizationOwnership.unclassified,
      [],
      'Every organization-like UUID column must be FK-derived or explicitly non-tenant',
    )
    const roleNames = new Set(
      catalog.organizationOwnership.roles.map((role) => role.column),
    )
    for (const requiredRole of [
      'organization_id',
      'workspace_organization_id',
      'organization_root_id',
      'active_workspace_organization_id',
      'linked_organization_id',
      'platform_organization_id',
      'account_owner_organization_id',
      'executing_organization_id',
      'importing_organization_id',
      'required_source_authority_organization_id',
    ]) {
      assert.ok(roleNames.has(requiredRole), `Missing runtime tenant role: ${requiredRole}`)
    }
    const receiptColumns = new Set(
      catalog.relations.find((relation) => (
        relation.name === 'workspace_tenant_retirement_receipts'
      ))?.columns.map((column) => column.name),
    )
    for (const requiredReceiptColumn of [
      'lock_catalog_digest', 'locked_relations', 'deleted_counts',
    ]) {
      assert.ok(receiptColumns.has(requiredReceiptColumn))
    }
  } finally {
    client.release()
  }
  process.stdout.write('tenant retirement full-migration schema acceptance test passed\n')
} finally {
  if (pool) await pool.end().catch(() => undefined)
  if (containerName) {
    try {
      command('docker', ['stop', '--time', '1', containerName])
    } catch {
      // The disposable container may already have exited; --rm owns cleanup.
    }
  }
}
