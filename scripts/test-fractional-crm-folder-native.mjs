import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'

const ts = createRequire(new URL('../app_src/package.json', import.meta.url))('typescript')
const module = { exports: {} }
vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../app_src/lib/crm/suiteCrmClient.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText, { module, exports: module.exports, Buffer, URL, URLSearchParams, Response, AbortSignal,
  process: { env: { SUITECRM_BASE_URL: 'https://crm.example.invalid', SUITECRM_CLIENT_ID: 'fixture', SUITECRM_CLIENT_SECRET: 'fixture' } },
  require: name => new Proxy({}, { get: () => () => assert.fail(`Unexpected dependency ${name}`) }),
})
const nativeId = '11111111-2222-4333-8444-555555555555', globalId = 'ga0000001'
const previousDescription = 'Keep BPO notes and drive link'
const description = previousDescription + '\nFractional Customer Folder: https://app.example.invalid/s/folder'
const record = { entity: 'organizations', pipelineId: 'fixture-pipeline', localId: 'fixture-account',
  suiteCrmId: nativeId, attributes: { global_id_c: globalId, description }, accountDescriptionPatch: { previousDescription } }
function provider(options = {}) {
  const calls = []
  let current = options.description ?? previousDescription
  return { calls, fetch: async (url, init) => {
    const path = new URL(url).pathname
    if (path === '/Api/access_token') return Response.json({ access_token: 'synthetic', expires_in: 3600 })
    calls.push(init.method)
    if (init.method === 'GET') {
      assert.equal(path, `/Api/V8/module/Accounts/${nativeId}`)
      if (options.missing) return Response.json({}, { status: options.missing })
      return Response.json({ data: { id: options.id ?? nativeId, type: 'Accounts',
        attributes: { global_id_c: options.globalId ?? globalId, name: 'Do not write', description: current } } })
    }
    assert.equal(init.method, 'PATCH', 'the narrow outbox never creates an Account')
    assert.equal(path, '/Api/V8/module')
    assert.deepEqual(JSON.parse(init.body), { data: { type: 'Accounts', id: nativeId, attributes: { description } } })
    if (!options.noReadback) current = description
    if (options.loseResponse) throw new Error('Synthetic lost response after applying')
    return Response.json({ data: { id: nativeId, type: 'Accounts' } })
  } }
}
test('native scope patches only the verified existing Account description and reads it back', async () => {
  const p = provider()
  assert.equal(await module.exports.patchExistingSuiteCrmAccountDescription(record, p.fetch), nativeId)
  assert.deepEqual(p.calls, ['GET', 'PATCH', 'GET'])
})
test('native scope refuses missing identity or manual description drift without a mutation', async () => {
  for (const state of [{ missing: 400 }, { missing: 404 }, { id: 'different' }, { globalId: 'ga0000002' }, { description: 'Edited in SuiteCRM' }]) {
    const p = provider(state)
    await assert.rejects(module.exports.patchExistingSuiteCrmAccountDescription(record, p.fetch))
    assert.deepEqual(p.calls, ['GET'])
  }
  const p = provider()
  await assert.rejects(module.exports.patchExistingSuiteCrmAccountDescription({ ...record, attributes: { ...record.attributes, name: 'forged' } }, p.fetch))
  assert.deepEqual(p.calls, [])
})

test('generic native upsert never treats an embedded folder marker as authority', async () => {
  const p = provider()
  await assert.rejects(module.exports.upsertSuiteCrmRecordWithResult(record, p.fetch), /dedicated outbox operation/)
  assert.deepEqual(p.calls, [])
})
test('native scope requires readback and resolves a lost response without sending PATCH again', async () => {
  const p = provider({ loseResponse: true }), notApplied = provider({ noReadback: true })
  await assert.rejects(module.exports.patchExistingSuiteCrmAccountDescription(record, notApplied.fetch), /could not be verified/)
  assert.deepEqual(notApplied.calls, ['GET', 'PATCH', 'GET'])
  await assert.rejects(module.exports.patchExistingSuiteCrmAccountDescription(record, p.fetch), /lost response/)
  assert.equal(await module.exports.patchExistingSuiteCrmAccountDescription(record, p.fetch), nativeId)
  assert.deepEqual(p.calls, ['GET', 'PATCH', 'GET'])
})

async function workerFixture(item) {
  const p = provider(), worker = { exports: {} }, completed = [], failed = []
  const unexpected = () => assert.fail('The folder job may not dispatch a generic write or enqueue broad work')
  const deps = {
    '@/lib/crm/suiteCrmClient': {
      createSuiteCrmNativeEmailPublicationClient: () => ({}),
      patchExistingSuiteCrmAccountDescription: value => module.exports.patchExistingSuiteCrmAccountDescription(value, p.fetch),
      upsertSuiteCrmRecordWithResult: unexpected,
    },
    '@/lib/crm/suiteCrmNativeEmailProjection': {},
    '@/lib/persistence/crm': {
      claimSuiteCrmOutboxInPostgres: async () => [item],
      completeSuiteCrmOutboxInPostgres: async value => { completed.push(value.id) },
      writeSuiteCrmWorkerHeartbeat: async () => {},
      withVerifiedSuiteCrmRecordLifecycle: (_value, publish) => publish(),
      readCrmWorkbookProjectionReadiness: unexpected,
      failSuiteCrmOutboxInPostgres: async value => { failed.push(value.error); return 'failed' },
    },
    '@/lib/persistence/pipeline': { enqueuePipelineSyncOutboxInPostgres: unexpected },
    '@/lib/crm/nativeEmailPublicationWorker': {
      createNativeEmailPublicationWorker: () => ({ resume: async () => ({}), process: unexpected }),
      touchesNativeEmail: () => false,
    },
    '@/lib/persistence/crmNativeEmailPublication': { createPostgresNativeEmailWorkerPersistence: () => ({}) },
    '@/lib/crm/suiteCrmRecordLifecycleClient': {},
  }
  vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../app_src/lib/crm/worker.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { module: worker, exports: worker.exports, require: name => {
    assert.ok(Object.hasOwn(deps, name), `Unexpected dependency ${name}`); return deps[name]
  } })
  const result = await worker.exports.processSuiteCrmOutbox()
  return { result, completed, failed, calls: p.calls }
}

const dedicatedItem = { id: 'folder-job', operation: 'patch_account_description', aggregateId: record.localId, payload: record }

test('successful dedicated folder outbox completion does not enqueue pipeline-wide workbook work', async () => {
  const { result, completed, failed, calls } = await workerFixture(dedicatedItem)
  assert.equal(result.succeeded, 1)
  assert.equal(result.projectionsQueued, 0)
  assert.deepEqual(completed, [dedicatedItem.id])
  assert.deepEqual(failed, [])
  assert.deepEqual(calls, ['GET', 'PATCH', 'GET'])
})

test('worker rejects a marker on a generic operation or dedicated work without a marker', async () => {
  const { accountDescriptionPatch: _, ...noMarker } = record
  for (const item of [{ ...dedicatedItem, operation: 'upsert_record' }, { ...dedicatedItem, payload: noMarker }]) {
    const { result, completed, failed, calls } = await workerFixture(item)
    assert.equal(result.failed, 1)
    assert.deepEqual(completed, [])
    assert.deepEqual(failed, ['CRM Account description publication scope changed'])
    assert.deepEqual(calls, [])
  }
})
