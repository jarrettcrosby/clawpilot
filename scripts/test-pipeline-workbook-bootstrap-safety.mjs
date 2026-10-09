#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const appRequire = createRequire(new URL('../app_src/package.json', import.meta.url))
const ts = appRequire('typescript')
const path = 'app_src/lib/crm/workbookProjection.ts'
const source = readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const output = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  fileName: path,
}).outputText
const pipelineId = '11111111-1111-4111-8111-111111111111'
const context = { pipelineId, sheetId: 'bootstrap-test-sheet' }
const actorEmail = 'operator@example.test'
const plain = value => JSON.parse(JSON.stringify(value))
const opportunity = (id, name) => ({
  id, sourceKey: id, priority: 'High', name, owner: 'Operator', organization: 'Example organization',
  status: 'Open', stage: 'Proposal', lossReason: '', source: 'Referral', value: 1250,
  probability: 60, expectedClose: '2026-10-09', notes: 'Original notes',
})
const opportunities = [opportunity('opportunity-first', 'First opportunity'), opportunity('opportunity-second', 'Second opportunity')]
const opportunityCells = record => [
  record.sourceKey, record.priority, record.name, record.owner, record.organization, record.status,
  record.stage, record.lossReason, record.source, record.value, record.probability, record.expectedClose, record.notes,
]
const expectedRows = opportunities.map(opportunityCells)
const snapshot = {
  organizations: [{ id: 'organization', sourceKey: 'organization', priority: '', name: 'Example organization' }],
  contacts: [{ id: 'contact', sourceKey: 'contact', priority: '', fullName: 'Example contact' }],
  opportunities,
  interactions: [{ id: 'interaction', sourceKey: 'interaction', interactionType: 'Email', subject: 'Example message',
    description: 'Message body', contactId: 'contact', opportunityId: 'opportunity-first', occurredAt: '2026-10-09T14:00:00Z' }],
  counts: { organizations: 1, contacts: 1, opportunities: 2, interactions: 1 },
}

function loadProjection({ actual = [], priorProjection = false, importStatus = null, legacy = false, ready = true } = {}) {
  const events = []
  const runtime = { serviceAccountEmail: 'managed@example.test' }
  const record = (kind, detail) => events.push({ kind, detail: plain(detail) })
  const module = { exports: {} }
  const dependencies = {
    '@/lib/pipelineProvisioning': {
      configurePipelineTabs: async (...args) => record('configure-managed', args),
      applyPipelineWorkbookBranding: async (...args) => record('brand-managed', args),
    },
    '@/lib/organizationBranding': {
      readPipelineWorkbookBranding: async id => { record('read-branding', id); return { organizationName: 'Example' } },
    },
    '@/lib/pipelineLegacyWorkbook': {
      configureLegacyPipelineTabs: async (...args) => record('configure-legacy', args),
      applyLegacyPipelineWorkbookBranding: async (...args) => record('brand-legacy', args),
    },
    '@/lib/integrations/googleWorkspace': {
      resolveManagedGoogleWorkspaceRuntime: async () => runtime,
    },
    '@/lib/integrations/googleWorkspaceClient': {
      googleSheetsJson: async (_runtime, requestPath, options) => {
        const decodedPath = decodeURIComponent(requestPath)
        if (!options?.method || options.method === 'GET') {
          record('read-initial-opportunities', decodedPath)
          assert.match(decodedPath, /\/values\/'Opportunities'!A5:Z20000\?valueRenderOption=FORMULA$/)
          return { values: actual }
        }
        record(options.method === 'PUT' ? 'write-managed' : 'clear-managed', { path: decodedPath, options })
        return {}
      },
    },
    '@/lib/maton': {
      matonFetch: async (requestPath, options) => {
        record(options.method === 'PUT' ? 'write-legacy' : 'clear-legacy', { path: decodeURIComponent(requestPath), options })
        return { ok: true }
      },
    },
    '@/lib/persistence/crm': {
      readCrmWorkbookProjectionReadiness: async id => {
        assert.equal(id, pipelineId)
        record('read-readiness', id)
        return { ready, unresolved: ready ? 0 : 1, importStatus }
      },
      readCrmWorkbookProjectionSnapshotInPostgres: async input => {
        assert.equal(input.pipelineId, pipelineId)
        record('read-snapshot', input)
        return snapshot
      },
      beginCrmSyncRun: async input => { record('begin-run', input); return 'sync-run' },
      finishCrmSyncRun: async input => record('finish-run', input),
    },
    '@/lib/persistence/pipeline': {
      resolvePipelineSheetBindingInPostgres: async () => ({
        legacyOwnerFallback: legacy, googleServiceAccountEmail: runtime.serviceAccountEmail, googleSharedDriveId: 'shared-drive',
      }),
    },
    '@/lib/persistence/postgres': {
      query: async (sql, params) => {
        assert.equal(params[0], pipelineId)
        if (/^SELECT EXISTS/.test(sql.trim())) {
          record('read-prior-projection', { sql, params })
          assert.match(sql, /direction = 'crm_to_sheet' AND status = 'succeeded'/)
          return { rows: [{ projected: priorProjection }] }
        }
        assert.match(sql, /^UPDATE pipeline_spaces SET crm_last_synced_at/)
        assert.equal(params[1], context.sheetId)
        record('write-sync-timestamp', { sql, params })
        return { rows: [] }
      },
    },
  }
  vm.runInNewContext(output, {
    module, exports: module.exports, console,
    require(specifier) {
      if (Object.hasOwn(dependencies, specifier)) return dependencies[specifier]
      throw new Error(`Unexpected bootstrap safety test import: ${specifier}`)
    },
  }, { filename: path })
  return { projection: module.exports, events }
}

const editsError = /unsynchronized Opportunities edits/
const isMutation = ({ kind }) => /^(begin-run|finish-run|configure-|brand-|clear-|write-)/.test(kind)
const assertPopulated = (events, mode) => {
  const writes = events.filter(({ kind }) => kind === `write-${mode}`)
  assert.equal(writes.length, 4, 'All four projected tabs receive their actual CRM rows')
  assert.equal(events.filter(({ kind }) => kind === `clear-${mode}`).length, 4)
  const opportunityWrite = writes.find(({ detail }) => detail.path.includes("'Opportunities'!A5?"))
  assert.ok(opportunityWrite)
  const payload = mode === 'managed' ? opportunityWrite.detail.options.body : JSON.parse(opportunityWrite.detail.options.body)
  assert.deepEqual(payload.values, expectedRows)
  assert.equal(events.find(({ kind }) => kind === 'finish-run').detail.status, 'succeeded')
}

// The actual projection entry point must reject user changes before beginning
// a sync run, changing formatting, clearing rows, or recording a sync timestamp.
const changedRow = [...expectedRows[0]]
changedRow[12] = 'User edited these notes while waiting for the initial projection'
const edited = loadProjection({ actual: [changedRow] })
await assert.rejects(edited.projection.projectCrmWorkbook({ context, actorEmail }), editsError)
assert.equal(edited.events.filter(({ kind }) => kind === 'read-initial-opportunities').length, 1)
assert.equal(edited.events.filter(isMutation).length, 0, 'Protection runs before every workbook or database mutation')
assert.equal(edited.events.filter(({ kind }) => kind === 'read-branding').length, 0)

const extraColumn = [...expectedRows[0], 'Operator notes outside the managed schema']
const extended = loadProjection({ actual: [extraColumn] })
await assert.rejects(extended.projection.projectCrmWorkbook({ context, actorEmail }), editsError)
assert.equal(extended.events.filter(isMutation).length, 0, 'Extra-column edits inside the clear extent must be protected before writes')

const blank = loadProjection({ actual: [[], ['', ' ', null, '\t']] })
assert.equal((await blank.projection.projectCrmWorkbook({ context, actorEmail })).ok, true)
assertPopulated(blank.events, 'managed')
const guardIndex = blank.events.findIndex(({ kind }) => kind === 'read-initial-opportunities')
assert.ok(guardIndex >= 0 && guardIndex < blank.events.findIndex(isMutation))

// A failed partial projection can retry its own exact rows without discarding
// anything new entered by the operator. Missing rows are not user edits.
const partial = loadProjection({ actual: [expectedRows[1]] })
assert.equal((await partial.projection.projectCrmWorkbook({ context, actorEmail })).ok, true)
assertPopulated(partial.events, 'managed')

// Only the initial population acquires this new protection. Existing managed
// projections and reconciled legacy workbooks retain their established path.
const previouslyProjected = loadProjection({ actual: [changedRow], priorProjection: true })
await previouslyProjected.projection.projectCrmWorkbook({ context, actorEmail })
assert.equal(previouslyProjected.events.filter(({ kind }) => kind === 'read-initial-opportunities').length, 0)
assertPopulated(previouslyProjected.events, 'managed')

const legacyImported = loadProjection({ actual: [changedRow], legacy: true, importStatus: 'succeeded' })
await legacyImported.projection.projectCrmWorkbook({ context, actorEmail })
assert.equal(legacyImported.events.filter(({ kind }) => kind.startsWith('read-initial') || kind === 'read-prior-projection').length, 0)
assertPopulated(legacyImported.events, 'legacy')

const managedImported = loadProjection({ actual: [changedRow], importStatus: 'succeeded' })
await managedImported.projection.projectCrmWorkbook({ context, actorEmail })
assert.equal(managedImported.events.filter(({ kind }) => kind === 'read-initial-opportunities').length, 0)
assertPopulated(managedImported.events, 'managed')

for (const importStatus of ['failed', 'running']) {
  const waiting = loadProjection({ ready: false, importStatus })
  await assert.rejects(waiting.projection.projectCrmWorkbook({ context, actorEmail }), /waiting for reconciliation/)
  assert.equal(waiting.events.length, 1)
  assert.equal(waiting.events.filter(isMutation).length, 0)
}

const validate = loadProjection().projection.assertInitialWorkbookOpportunityRows
assert.doesNotThrow(() => validate([], expectedRows))
assert.doesNotThrow(() => validate([[], ['', ' ', undefined, null]], expectedRows))
assert.doesNotThrow(() => validate([expectedRows[1], expectedRows[0]], expectedRows), 'Row order is not an unsynchronized edit')
assert.throws(() => validate([expectedRows[0], expectedRows[0]], expectedRows), editsError, 'Duplicate identities are unsafe')
assert.throws(() => validate([['unknown-id', 'New opportunity']], expectedRows), editsError)
assert.throws(() => validate([['', '', 'Unsaved new opportunity']], expectedRows), editsError)
assert.throws(() => validate([changedRow], expectedRows), editsError)
assert.throws(() => validate([extraColumn], expectedRows), editsError, 'Nonempty extra columns must not be cleared during bootstrap')
assert.doesNotThrow(() => validate([[...expectedRows[0], '', null, ' ']], expectedRows), 'Blank extra columns remain a safe retry')
assert.throws(() => validate([expectedRows[0]], []), editsError)

const numericAndTrimmed = [...expectedRows[0]]
numericAndTrimmed[2] = `  ${numericAndTrimmed[2]}  `
numericAndTrimmed[9] = '1250'
numericAndTrimmed[10] = '60'
numericAndTrimmed[11] = Date.parse('2026-10-09T00:00:00Z') / 86_400_000 + 25_569
assert.doesNotThrow(() => validate([numericAndTrimmed], expectedRows), 'Sheets numeric/date serials can represent our unchanged row')

const equivalentOffset = [...expectedRows[0]]
equivalentOffset[11] = '2026-10-08T20:00:00-04:00'
assert.doesNotThrow(() => validate([equivalentOffset], expectedRows), 'Equivalent timestamps compare on their UTC calendar date')
const differentUtcDate = [...expectedRows[0]]
differentUtcDate[11] = '2026-10-09T00:00:00+14:00'
assert.throws(() => validate([differentUtcDate], expectedRows), editsError, 'A timezone shift to a different UTC day is not our unchanged row')
const formulaEdit = [...expectedRows[0]]
formulaEdit[9] = '=1250'
assert.throws(() => validate([formulaEdit], expectedRows), editsError, 'Formula evidence is preserved rather than treating it as a projected number')

console.log('Initial workbook bootstrap preserves user edits before writes, supports safe retries, and retains reconciled projection behavior')
