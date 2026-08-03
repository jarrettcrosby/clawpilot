#!/usr/bin/env node

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()

function read(path) {
  return readFileSync(resolve(root, path), 'utf8')
}

function includes(source, fragments, label) {
  for (const fragment of fragments) {
    assert.ok(source.includes(fragment), `${label} missing ${fragment}`)
  }
}

const persistence = read(
  'app_src/lib/persistence/commerceCatalogSync.ts',
)
includes(persistence, [
  'reconcileOrphanedCommerceCatalogSyncCursorsWithClient',
  "SET reconciliation_status = 'idle'",
  "cursor.resource = 'products'",
  "cursor.reconciliation_status = 'running'",
  "active.status IN ('pending', 'processing', 'failed')",
  'COMMERCE_CATALOG_SYNC_ORPHAN_RECONCILED',
  'await reconcileOrphanedCommerceCatalogSyncCursorsWithClient(client)',
], 'Durable orphaned catalog-cursor reconciliation')

const fenceCancellation = persistence.slice(
  persistence.indexOf(
    'export async function completeCommerceCatalogSyncPageInPostgres',
  ),
  persistence.indexOf(
    'export async function failCommerceCatalogSyncJobInPostgres',
  ),
)
includes(fenceCancellation, [
  "SET status = 'cancelled'",
  'if (cancelled.rowCount === 1)',
  'reconcileOrphanedCommerceCatalogSyncCursorsWithClient(client',
], 'Fenced page-completion cursor reconciliation')

const health = read('app_src/app/api/health/route.ts')
includes(health, [
  'orphaned_running_cursors: number',
  ') AS orphaned_running_cursors',
  'orphanedRunningCursors',
  '|| orphanedRunningCursors > 0',
  'Commerce catalog sync has running cursors without active jobs.',
], 'Orphaned catalog-cursor health evidence')

console.log('Commerce catalog cursor reconciliation contract passed')
