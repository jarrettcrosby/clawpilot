#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'

const require = createRequire(import.meta.url)
const ts = createRequire(new URL('../app_src/package.json', import.meta.url))('typescript')
const plain = value => JSON.parse(JSON.stringify(value))
function load(path, mocks = {}, globals = {}) {
  const module = { exports: {} }
  const output = ts.transpileModule(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }, fileName: path,
  }).outputText
  vm.runInNewContext(output, { Buffer, URL, URLSearchParams, Response, AbortSignal, module, exports: module.exports,
    process: { env: { SUITECRM_BASE_URL: 'https://crm.example.invalid', SUITECRM_CLIENT_ID: 'fixture-client', SUITECRM_CLIENT_SECRET: 'fixture-secret' } },
    require(name) {
      if (Object.hasOwn(mocks, name)) return mocks[name]
      if (name.startsWith('node:')) return require(name)
      return new Proxy({}, { get: () => () => { throw new Error('Unexpected dependency ' + name) } })
    }, ...globals,
  }, { filename: path })
  return module.exports
}
const helper = load('app_src/lib/crm/suiteCrmNativeEmailProjection.ts')
const emailId = '11111111-2222-4333-8444-555555555555'
const ownerId = '22222222-3333-4444-8555-666666666666'
const pipelineId = '33333333-4444-4555-8666-777777777777'
const workspaceId = '44444444-5555-4666-8777-888888888888'
function fixture() {
  const audience = { policy: 'pipeline-internal', ownerSuiteCrmId: ownerId,
    allowedSuiteCrmUserIds: [ownerId], workspaceId, pipelineId }
  audience.fingerprint = helper.suiteCrmEmailAudienceFingerprint(audience)
  return { entity: 'interactions', pipelineId, localId: emailId, suiteCrmId: emailId, suiteCrmModule: 'Emails',
    attributes: { global_id_c: 'gi1234567', name: 'Reviewed original email', description: '<p>Exact original body &amp; data</p>\r\nLine 2',
      date_sent_received: '2026-10-27 12:34:56', type: 'archived', status: 'read',
      parent_type: 'Accounts', parent_id: 'native-airspace', assigned_user_id: ownerId, description_html: '',
      from_addr_name: 'Airspace <airspace@example.test>', to_addrs_names: 'Globus <globus@example.test>',
      cc_addrs_names: 'cc@example.test', bcc_addrs_names: 'private@example.test' },
    relationships: [
      { linkFieldName: 'accounts', relatedModuleName: 'Accounts', relatedBeanId: 'native-airspace' },
      { linkFieldName: 'accounts', relatedModuleName: 'Accounts', relatedBeanId: 'native-globus' },
      { linkFieldName: 'contacts', relatedModuleName: 'Contacts', relatedBeanId: 'native-riley' },
      { linkFieldName: 'contacts', relatedModuleName: 'Contacts', relatedBeanId: 'native-joseph' },
    ],
    emailProjection: { version: 1, accounts: ['native-airspace', 'native-globus'], contacts: ['native-riley', 'native-joseph'],
      contactAccounts: [{ contactId: 'native-riley', accountId: 'native-airspace' }, { contactId: 'native-joseph', accountId: 'native-globus' }],
      previousManaged: { accounts: ['native-airspace'], contacts: ['native-riley'] }, audience },
  }
}
function harness(options = {}) {
  const record = fixture(), requests = []
  const state = { exists: options.exists !== false, attributes: plain(record.attributes),
    accounts: [...(options.accounts || ['native-airspace'])], contacts: [...(options.contacts || ['native-riley'])],
    contactAccounts: { 'native-riley': 'native-airspace', 'native-joseph': 'native-globus' } }
  let writes = 0, proofCalls = 0, emailGets = 0
  const api = load('app_src/lib/crm/suiteCrmClient.ts', { '@/lib/crm/suiteCrmNativeEmailProjection': options.helper || helper })
  const fetchMock = async (input, init) => {
    const url = new URL(input), path = url.pathname, method = init.method
    requests.push({ path, search: url.search, method, body: init.body ? JSON.parse(init.body) : undefined })
    if (path === '/Api/access_token') return Response.json({ access_token: 'synthetic-token', expires_in: 3600 })
    if (path === '/Api/V8/custom/clawpilot-email-audience') {
      proofCalls++
      if (options.missingVerifier) return Response.json({ error: 'not installed' }, { status: 404 })
      const command = JSON.parse(init.body)
      const proof = { version: 1, suiteCrmId: emailId, phase: command.phase, complete: true,
        noImplicitSharing: true, fingerprint: command.audience.fingerprint, capturedAt: new Date().toISOString(),
        readerSuiteCrmUserIds: [...record.emailProjection.audience.allowedSuiteCrmUserIds], administratorSuiteCrmUserIds: [ownerId] }
      options.proof?.(proof, command.phase)
      return Response.json(proof)
    }
    if (path === '/Api/V8/module/Emails') {
      const data = state.exists ? [{ id: emailId, type: 'Email' }] : []
      if (options.duplicateIdentity) data.push({ id: 'unmanaged-email', type: 'Email' })
      return Response.json({ data, meta: { 'total-records': data.length, 'total-pages': data.length ? 1 : 0 } })
    }
    if (path === `/Api/V8/module/Emails/${emailId}`) {
      emailGets++
      if (!state.exists) return Response.json({ errors: [{ detail: 'No bean found' }] }, { status: 400 })
      const attrs = plain(state.attributes)
      if (writes && options.readback) options.readback(attrs)
      return Response.json({ data: { id: options.wrongReadbackId && writes ? 'other-email' : emailId, type: 'Email', attributes: attrs } })
    }
    const contact = path.match(/^\/Api\/V8\/module\/Contacts\/(native-[a-z]+)$/)
    if (contact) return Response.json({ data: { id: contact[1], type: 'Contact', attributes: {
      account_id: options.wrongContactAccount || state.contactAccounts[contact[1]],
    } } })
    if (path === '/Api/V8/module') {
      assert.ok(['PATCH', 'POST'].includes(method))
      const data = JSON.parse(init.body).data
      assert.equal(data.type, 'Emails'); assert.equal(data.id, emailId)
      if (options.abortDuringWrite) return await new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => { options.onWriteCancelled?.(); reject(init.signal.reason) }, { once: true })
        options.abortDuringWrite()
      })
      writes++
      state.exists = true; Object.assign(state.attributes, data.attributes)
      return Response.json({ data: { id: emailId, type: 'Email', attributes: plain(state.attributes) } })
    }
    const link = path.match(new RegExp(`^/Api/V8/module/Emails/${emailId}/relationships/(accounts|contacts)(?:/([a-z0-9-]+))?$`))
    if (link) {
      const [, field, relatedId] = link
      if (method === 'GET') {
        if (!state[field].length) return Response.json({ meta: { message: `There is no relationship set in Email module with ${field} link field` } })
        const data = state[field].map(id => ({ id, type: field === 'accounts' ? 'Account' : 'Contact' }))
        if (options.readbackLinks && writes) options.readbackLinks(data, field)
        return Response.json({ data, meta: { 'total-records': data.length, 'total-pages': 1 } })
      }
      if (options.failRelationship) return Response.json({ errors: [{ detail: 'synthetic relationship failure' }] }, { status: 500 })
      if (method === 'DELETE') state[field] = state[field].filter(id => id !== relatedId)
      else {
        assert.equal(method, 'POST')
        const related = JSON.parse(init.body).data
        assert.equal(related.type, field === 'accounts' ? 'Accounts' : 'Contacts')
        if (!state[field].includes(related.id)) state[field].push(related.id)
      }
      return Response.json({ meta: { message: 'relationship updated' } })
    }
    throw new Error(`Unexpected mock request ${method} ${path}`)
  }
  return { record, state, requests, api, fetchMock, writes: () => writes, proofs: () => proofCalls, gets: () => emailGets }
}
let checks = 0
async function check(name, run) { await run(); checks++; console.log('PASS ' + name) }
const held = error => error?.code === 'SUITECRM_EMAIL_PROJECTION_HELD'
const mutations = h => h.requests.filter(request => request.path.startsWith('/Api/V8/module') && ['PATCH', 'POST', 'DELETE'].includes(request.method))

await check('real V8 writer reads back one Email, exact headers/body, both company/contact links, and contact ownership', async () => {
  const h = harness(), before = plain(h.record), bindings = plain(h.state.contactAccounts)
  const result = await h.api.upsertSuiteCrmRecordWithResult(h.record, h.fetchMock)
  assert.deepEqual(plain(result.emailProjection.attributes), h.record.attributes)
  assert.deepEqual(plain(result.emailProjection.accounts), ['native-airspace', 'native-globus'])
  assert.deepEqual(plain(result.emailProjection.contacts), ['native-joseph', 'native-riley'])
  assert.deepEqual(plain(result.emailProjection.audience.administratorSuiteCrmUserIds), [ownerId])
  assert.equal(h.gets(), 2); assert.equal(h.proofs(), 2); assert.equal(h.writes(), 1)
  assert.deepEqual(h.state.contactAccounts, bindings); assert.deepEqual(h.record, before)
  assert.ok(h.requests.every(request => !request.path.includes('/SecurityGroups')))
})
await check('missing contract and forged fingerprint stop before any network request', async () => {
  for (const mutate of [record => { delete record.emailProjection }, record => { record.emailProjection.audience.fingerprint = '0'.repeat(64) }]) {
    const h = harness(); mutate(h.record)
    await assert.rejects(h.api.upsertSuiteCrmRecordWithResult(h.record, h.fetchMock), held)
    assert.equal(h.requests.length, 0)
  }
})
await check('uninstalled native verifier holds before content or relationship mutation', async () => {
  const h = harness({ missingVerifier: true })
  await assert.rejects(h.api.upsertSuiteCrmRecordWithResult(h.record, h.fetchMock), held)
  assert.deepEqual(mutations(h), [])
})
for (const [label, proof] of [
  ['extra nonadministrator reader', value => { value.readerSuiteCrmUserIds.push('unapproved-human') }],
  ['extra administrator reader', value => { value.readerSuiteCrmUserIds.push('unapproved-admin'); value.administratorSuiteCrmUserIds.push('unapproved-admin') }],
  ['inheritance or workflow uncertainty', value => { value.noImplicitSharing = false }],
  ['incomplete native audience', value => { value.complete = false }],
  ['stale native audience', value => { value.capturedAt = '2020-01-01T00:00:00Z' }],
  ['wrong native identity', value => { value.suiteCrmId = 'different-email' }],
]) await check(label + ' holds before publication', async () => {
  const h = harness({ proof }); await assert.rejects(h.api.upsertSuiteCrmRecordWithResult(h.record, h.fetchMock), held)
  assert.deepEqual(mutations(h), [])
})
await check('unmanaged extra links hold; only previously managed stale links are removed', async () => {
  const h = harness({ accounts: ['native-airspace', 'native-unmanaged'] })
  await assert.rejects(h.api.upsertSuiteCrmRecordWithResult(h.record, h.fetchMock), held)
  assert.deepEqual(mutations(h), [])
  h.record.emailProjection.previousManaged.accounts.push('native-unmanaged')
  const result = await h.api.upsertSuiteCrmRecordWithResult(h.record, h.fetchMock)
  assert.deepEqual(plain(result.emailProjection.accounts), ['native-airspace', 'native-globus'])
  assert.equal(h.requests.filter(request => request.method === 'DELETE').length, 1)
})
await check('native Global ID collision holds before content writes', async () => {
  const h = harness({ duplicateIdentity: true })
  await assert.rejects(h.api.upsertSuiteCrmRecordWithResult(h.record, h.fetchMock), held)
  assert.deepEqual(mutations(h), [])
})
await check('contact company mismatch is never repaired or overwritten', async () => {
  const h = harness({ wrongContactAccount: 'foreign-account' })
  await assert.rejects(h.api.upsertSuiteCrmRecordWithResult(h.record, h.fetchMock), held)
  assert.deepEqual(mutations(h), [])
})
for (const [label, option] of [
  ['truncated subject', { readback: attrs => { attrs.name = 'truncated' } }],
  ['changed body', { readback: attrs => { attrs.description = 'different' } }],
  ['lost recipient header', { readback: attrs => { delete attrs.bcc_addrs_names } }],
  ['wrong readback identity', { wrongReadbackId: true }],
  ['missing relationship readback', { readbackLinks: (data, field) => { if (field === 'accounts') data.pop() } }],
  ['duplicate relationship readback', { readbackLinks: data => { data.push(data[0]) } }],
  ['failed native relationship write', { failRelationship: true }],
  ['audience widened after projection', { proof: (value, phase) => { if (phase === 'after') value.readerSuiteCrmUserIds.push('new-human') } }],
]) await check(label + ' cannot report success', async () => {
  const h = harness(option); await assert.rejects(h.api.upsertSuiteCrmRecordWithResult(h.record, h.fetchMock), held)
})
await check('new Email uses the deterministic identity and repeated sync does not duplicate links', async () => {
  const h = harness({ exists: false })
  await h.api.upsertSuiteCrmRecordWithResult(h.record, h.fetchMock)
  const linkWrites = h.requests.filter(request => request.path.includes('/relationships/') && request.method !== 'GET').length
  await h.api.upsertSuiteCrmRecordWithResult(h.record, h.fetchMock)
  assert.equal(h.requests.filter(request => request.path === '/Api/V8/module' && request.method === 'POST').length, 1)
  assert.equal(h.requests.filter(request => request.path.includes('/relationships/') && request.method !== 'GET').length, linkWrites)
})
await check('ordinary manual Email supports exact empty company/contact sets without inventing associations', async () => {
  const h = harness({ accounts: [], contacts: [] })
  h.record.relationships = []
  Object.assign(h.record.emailProjection, { accounts: [], contacts: [], contactAccounts: [], previousManaged: { accounts: [], contacts: [] } })
  Object.assign(h.record.attributes, { parent_type: '', parent_id: '' })
  const result = await h.api.upsertSuiteCrmRecordWithResult(h.record, h.fetchMock)
  assert.deepEqual(plain(result.emailProjection.accounts), [])
  assert.deepEqual(plain(result.emailProjection.contacts), [])
  assert.ok(h.requests.every(request => request.method !== 'DELETE' && !request.path.includes('/module/Contacts/')))
})
await check('one overall 60-second signal cancels and awaits an in-flight writer before returning held', async () => {
  const controller = new AbortController(), timeouts = []
  const boundedHelper = load('app_src/lib/crm/suiteCrmNativeEmailProjection.ts', {}, { AbortSignal: {
    timeout: milliseconds => { timeouts.push(milliseconds); return controller.signal }, any: signals => AbortSignal.any(signals),
  } })
  let cancellationHandled = false
  const h = harness({ helper: boundedHelper, abortDuringWrite: () => controller.abort(new Error('overall deadline')),
    onWriteCancelled: () => { cancellationHandled = true } })
  await assert.rejects(h.api.upsertSuiteCrmRecordWithResult(h.record, h.fetchMock), held)
  assert.deepEqual(timeouts, [60_000]); assert.equal(cancellationHandled, true)
  assert.equal(h.writes(), 0)
  assert.equal(h.requests.at(-1).path, '/Api/V8/module', 'No relationship/background task may continue after cancellation')
  const helperSource = readFileSync(new URL('../app_src/lib/crm/suiteCrmNativeEmailProjection.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(helperSource, /Promise\.race/)
})
await check('worker refuses missing proof and cannot delete prior projection or complete Email outbox', async () => {
  let completed = 0, deleted = 0, failed = 0, forwarded
  const payload = fixture()
  for (const operation of ['upsert_record', 'reproject_record']) {
    const worker = load('app_src/lib/crm/worker.ts', {
      '@/lib/crm/suiteCrmNativeEmailProjection': helper,
      '@/lib/crm/suiteCrmClient': { upsertSuiteCrmRecordWithResult: async () => ({ suiteCrmId: emailId, productImageProjection: null }), deleteSuiteCrmRecord: async () => { deleted++ } },
      '@/lib/persistence/crm': { claimSuiteCrmOutboxInPostgres: async () => [{ id: 'outbox', operation, aggregateId: emailId, payload: { ...payload, previousSuiteCrmModule: 'Notes' } }],
        withVerifiedSuiteCrmEmailPublication: async (_item, publish) => publish(),
        completeSuiteCrmOutboxInPostgres: async (_item, receipt) => { completed++; forwarded = receipt }, failSuiteCrmOutboxInPostgres: async input => { failed++; assert.match(input.error, /held/); return 'failed' },
        writeSuiteCrmWorkerHeartbeat: async () => undefined },
    })
    const result = await worker.processSuiteCrmOutbox()
    assert.equal(result.failed, 1); assert.equal(result.succeeded, 0)
  }
  assert.equal(completed, 0); assert.equal(deleted, 0); assert.equal(failed, 2); assert.equal(forwarded, undefined)
})
await check('authenticated verifier source is read-only and registration is under pinned V8 OAuth custom routes', async () => {
  const source = readFileSync(new URL('../services/suitecrm/email-audience/EmailAudience.php', import.meta.url), 'utf8')
  const routes = readFileSync(new URL('../services/suitecrm/email-audience/routes.php', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /->(?:save|add|addGroupToRecord|removeGroupFromRecord)\s*\(/)
  assert.doesNotMatch(source, /['"`]\s*(?:INSERT|UPDATE|DELETE|ALTER|GRANT|REVOKE)\b/)
  assert.match(source, /ACLAction::getUserActions\(\$userId, true\)/)
  assert.match(source, /\$email->ACLAccess\('view'\).*\$email->ACLAccess\('list'\).*\$email->ACLAccess\('export'\)/)
  assert.match(source, /\$readers !== \$expectedReaders/)
  assert.match(routes, /getAttribute\('oauth_client_id'\)/); assert.match(routes, /getenv\('SUITECRM_CLIENT_ID'\)/)
  assert.match(routes, /getAttribute\('oauth_user_id'\)/); assert.match(routes, /!\$caller->isAdmin\(\)/)
})
console.log(`Native Email projection passed ${checks} local mock/static checks; no live calls or permission changes.`)
