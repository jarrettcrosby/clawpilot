#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'

const ts = createRequire(new URL('../app_src/package.json', import.meta.url))('typescript')
const module = { exports: {} }
vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../app_src/lib/crm/suiteCrmClient.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText, { module, exports: module.exports, Buffer, URL, URLSearchParams, Response, AbortSignal,
  process: { env: { SUITECRM_BASE_URL: 'https://crm.example.invalid', SUITECRM_CLIENT_ID: 'fixture-client', SUITECRM_CLIENT_SECRET: 'fixture-secret' } },
  require: name => new Proxy({}, { get: () => () => { throw new Error(`Unexpected dependency ${name}`) } }),
})
const api = module.exports
const id = '11111111-2222-4333-8444-555555555555'
const native = { name: 'Native truncated title', description: 'Native normalized body\r\nSecond line',
  date_start: '2026-10-21T14:00:00Z', date_end: '2026-10-21T14:30:00Z', duration_hours: '0', duration_minutes: '30',
  location: '', status: 'Planned', date_modified: '2026-10-20T22:00:00Z' }
const plain = value => JSON.parse(JSON.stringify(value))
const record = { entity: 'meetings', pipelineId: '22222222-3333-4444-8555-666666666666',
  localId: '33333333-4444-4555-8666-777777777777', suiteCrmId: id,
  attributes: { name: 'A longer original title that the native service truncates', description: '<p>Native normalized body</p>' } }
let calls = []
function fetcher(responseAttributes, responseId = id, responseType = 'Meeting') {
  return async (url, init) => {
    calls.push({ url, method: init.method })
    if (url.endsWith('/Api/access_token')) return Response.json({ access_token: 'synthetic-fixture', expires_in: 3600 })
    if (init.method === 'GET') return Response.json({ data: { id, type: 'Meeting', attributes: { ...native, name: 'A concurrent edit' } } })
    assert.equal(init.method, 'PATCH')
    assert.deepEqual(JSON.parse(init.body).data.attributes, record.attributes)
    return Response.json({ data: { id: responseId, type: responseType, attributes: responseAttributes } })
  }
}
const projected = await api.upsertSuiteCrmRecordWithResult(record, fetcher(native))
assert.equal(projected.meetingProjection.suiteCrmId, id)
assert.equal(projected.meetingProjection.attributes.name, native.name)
assert.equal(projected.meetingProjection.attributes.description, 'Native normalized body\nSecond line')
assert.ok(Number.isFinite(Date.parse(projected.meetingProjection.capturedAt)))
assert.equal(calls.filter(call => call.method === 'GET').length, 1,
  'Only the preflight GET occurs; a later operator GET cannot become the baseline')
assert.deepEqual(plain(projected.meetingProjection.attributes), plain(api.normalizeSuiteCrmMeetingProjectionAttributes(native)))
for (const invalid of [undefined, {}, { ...native, name: 'x'.repeat(301) }, { ...native, description: 'x'.repeat(50_001) },
  { ...native, date_start: 'invalid' }, { ...native, date_end: '2026-10-21T13:00:00Z' },
  { ...native, duration_minutes: '60' }, { ...native, location: { forged: true } }]) {
  await assert.rejects(api.upsertSuiteCrmRecordWithResult(record, fetcher(invalid)), /projection/)
}
const missingEnd = { ...native }; delete missingEnd.date_end
await assert.rejects(api.upsertSuiteCrmRecordWithResult(record, fetcher(missingEnd)), /incomplete/)
await assert.rejects(api.upsertSuiteCrmRecordWithResult(record, fetcher(native, 'different-id')), /unexpected record ID/)
await assert.rejects(api.upsertSuiteCrmRecordWithResult(record, fetcher(native, id, 'Contact')), /unexpected meeting projection identity/)
calls = []
const current = await api.readSuiteCrmMeetingSnapshot(id, fetcher(native))
assert.equal(current.attributes.name, 'A concurrent edit', 'Fresh reverse-ingestion reader observes current native state separately')
assert.ok(calls.every(call => call.method === 'GET'))
await assert.rejects(api.readSuiteCrmMeetingSnapshot('../other', fetcher(native)), /identity/)
await assert.rejects(api.readSuiteCrmMeetingSnapshot(id, async () => Response.json({ data: { id: 'other', attributes: native } })), /identity/)
console.log('SuiteCRM meeting projection passed: exact write-response baseline, concurrent-read separation, strict bounds/identity/time, and fresh read helper.')
