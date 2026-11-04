#!/usr/bin/env node
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import vm from 'node:vm'

const ts = createRequire(new URL('../app_src/package.json', import.meta.url))('typescript')
const source = readFileSync(new URL('../app_src/lib/persistence/pipeline.ts', import.meta.url), 'utf8')
const ast = ts.createSourceFile('pipeline.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
const names = ['cleanString', 'requirePipelineSheetContext', 'assertPipelineSheetContext', 'insertPipelineOutbox',
  'enqueuePipelineSyncOutboxWithClient', 'enqueuePipelineSyncOutboxInPostgres', 'claimPipelineSyncOutboxInPostgres']
const declarations = names.map(name => {
  const node = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name)
  assert.ok(node, `Actual ${name} must exist`)
  return node.getText(ast)
}).join('\n')
const compiled = ts.transpileModule(declarations, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText
const pipelineId = '00000000-0000-4000-8000-000000000001', sheetId = 'managed-sheet'
const input = { pipelineId, sheetId, aggregateType: 'pipeline_crm_workbook', aggregateId: pipelineId,
  operation: 'project_crm_workbook', idempotencyKey: 'native-email:operation-one',
  payload: { waitForCrmReadiness: true }, actor: 'system' }
const copy = value => JSON.parse(JSON.stringify(value))

function harness() {
  let durable = { rows: [], audits: [] }, transactions = 0
  const observed = []
  const clientFor = state => ({ async query(sql, params = []) {
    observed.push(sql)
    if (sql.includes('FROM pipeline_spaces')) return { rows: params[0] === pipelineId && params[1] === sheetId ? [{ id: pipelineId }] : [] }
    if (sql.includes('SELECT id::text, status') && sql.includes('FROM sync_outbox')) {
      return { rows: state.rows.filter(row => row.key === params[0]) }
    }
    if (sql.includes('INSERT INTO sync_outbox')) {
      const row = { id: `intent-${state.rows.length + 1}`, status: 'queued', key: params[4], payload: JSON.parse(params[3]) }
      state.rows.push(row); return { rows: [row] }
    }
    if (sql.includes('INSERT INTO audit_events')) { state.audits.push(copy(params)); return { rows: [] } }
    if (sql.includes('worker lease expired') || sql.includes('WITH candidates AS')) return { rows: [] }
    throw new Error(`Unexpected query ${sql}`)
  } })
  const transaction = async callback => {
    transactions++
    const staged = copy(durable), result = await callback(clientFor(staged))
    durable = staged
    return result
  }
  const runtime = { exports: {}, crypto, withTransaction: transaction,
    UUID_PATTERN: /^[0-9a-f-]{36}$/, SHEET_ID_PATTERN: /^[A-Za-z0-9_-]{1,256}$/ }
  vm.runInNewContext(compiled, runtime)
  return { api: runtime.exports, transaction, observed, state: () => durable, count: () => transactions }
}

test('native caller enqueues the real Sheets intent in its own transaction and rollback retains no partial intent', async () => {
  const h = harness()
  await assert.rejects(h.transaction(async tx => {
    await h.api.enqueuePipelineSyncOutboxWithClient(tx, input)
    assert.equal(h.count(), 1, 'No nested transaction inside caller-owned enqueue')
    throw new Error('synthetic finalization rollback')
  }), /synthetic finalization rollback/)
  assert.deepEqual(h.state(), { rows: [], audits: [] })
  await h.transaction(tx => h.api.enqueuePipelineSyncOutboxWithClient(tx, input))
  assert.equal(h.state().rows.length, 1)
  assert.equal(h.state().audits.length, 1)
  assert.equal(h.state().rows[0].key, `pipeline:${pipelineId}:native-email:operation-one`)
  assert.equal(h.state().rows[0].payload.waitForCrmReadiness, true)
  await h.api.enqueuePipelineSyncOutboxInPostgres(input)
  assert.equal(h.count(), 3)
  assert.equal(h.state().rows.length, 1, 'Same settled operation cannot create duplicate workbook intents')
})

test('claim SQL preserves initial gating and requires imported or verified managed source for native intents', async () => {
  const h = harness()
  await h.api.claimPipelineSyncOutboxInPostgres()
  const sql = h.observed.find(value => value.includes('WITH candidates AS'))
  assert.ok(sql)
  assert.match(sql, /operation <> 'project_crm_workbook'\s+OR \(payload->>'initialManagedWorkbook' IS DISTINCT FROM 'true'\s+AND payload->>'waitForCrmReadiness' IS DISTINCT FROM 'true'\)/)
  assert.match(sql, /reconciliation\.payload->>'pipelineId' = candidate\.payload->>'pipelineId'/)
  assert.match(sql, /reconciliation\.status <> 'succeeded'/)
  assert.match(sql, /import_run\.pipeline_id::text = candidate\.payload->>'pipelineId'/)
  assert.match(sql, /import_run\.direction = 'sheet_to_crm'/)
  assert.match(sql, /\), CASE WHEN payload->>'waitForCrmReadiness' IS DISTINCT FROM 'true'\s+OR EXISTS \(/)
  assert.match(sql, /pipeline\.id::text = candidate\.payload->>'pipelineId'/)
  assert.match(sql, /pipeline\.provisioning_status = 'ready'/)
  assert.match(sql, /pipeline\.sync_enabled = true/)
  assert.match(sql, /pipeline\.sheet_id IS NOT NULL/)
  assert.match(sql, /pipeline\.sheet_id = pipeline\.provisioning_sheet_id/)
  for (const field of ['provisioning_completed_at', 'drive_folder_id', 'google_service_account_email', 'google_shared_drive_id']) {
    assert.match(sql, new RegExp(`pipeline\\.${field} IS NOT NULL`))
  }
  assert.match(sql, /THEN 'succeeded' ELSE 'not_imported' END\) = 'succeeded'/)
})
