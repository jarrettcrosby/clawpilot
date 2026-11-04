#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
const require = createRequire(import.meta.url)
const { SCOPE, audienceSnapshot, messagePlan, collect, inspectionFailure } = require('./inspect-bpo-email-recovery-readonly.cjs')
const ts = createRequire(new URL('../app_src/package.json', import.meta.url))('typescript')
let checks = 0
async function check(label, fn) { await fn(); checks++; console.log('PASS ' + label) }
const scope = [{ workspace_id: SCOPE.workspaceId, owner_email: SCOPE.ownerEmail, owner_native_id: 'native-owner', is_demo: false }]
const owner = { email: SCOPE.ownerEmail, status: 'active', membership_status: 'active', suitecrm_user_id: 'native-owner', membership_role: 'owner', membership_permissions: {},
  membership_trashed_at: null, access_role: null, native_identity_count: 1 }
const reader = { ...owner, email: 'reader@example.test', suitecrm_user_id: 'native-reader', membership_role: 'member', access_role: 'viewer' }
const contact = (id, company, email) => ({ id, organization_id: company, reference_code: 'gc' + id,
  pipeline_id: SCOPE.pipelineId, email, entity: 'contacts' })
const contacts = [contact('1', 'a', 'globus@example.test'), contact('2', 'b', 'airspace@example.test')]
const companies = [{ id: 'a', reference_code: SCOPE.primaryOrganizationReference, active: true },
  { id: 'b', reference_code: SCOPE.organizationReferences[1], active: true }]
const message = { id: 'cache-1', message_id: SCOPE.messageIds[0], thread_id: SCOPE.threadId, provider: 'gmail', source_owner_active: true,
  headers: { version: 1, from: [{ address: 'globus@example.test' }], to: [{ address: 'airspace@example.test' }] } }

function declaration(path, names) {
  const source = readFileSync(new URL('../' + path, import.meta.url), 'utf8')
  const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true)
  return names.map(name => {
    const node = ast.statements.find(node => (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name?.text === name
      || ts.isVariableStatement(node) && node.declarationList.declarations.some(item => item.name.getText(ast) === name))
    assert.ok(node, name); return node.getText(ast)
  }).join('\n')
}
const code = declaration('app_src/lib/crm/nativeEmailPublication.ts', ['NativeEmailPublicationHeld','requireNativeEmail']) + '\n'
  + declaration('app_src/lib/crm/nativeEmailEligibility.ts', ['viewCrmPermission','nativeEmailPrincipalIsEligible',
    'nativeEmailManualPipelinePrincipals','nativeEmailEffectivePipelinePrincipals']) + '\n'
  + declaration('app_src/lib/persistence/crm.ts', ['reviewedEmailAudienceUnderNativeControlWithClient']) + '\n'
  + declaration('app_src/lib/crm/suiteCrmNativeEmailProjection.ts', ['suiteCrmEmailAudienceFingerprint'])
const runtime = { exports: {}, createHash: require('node:crypto').createHash,
  collectNativeEmailRootSourcesWithClient:async()=>[],projectNativeEmailRootReaders:()=>[] }
vm.runInNewContext(ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, runtime)
async function actualAudience(rows, selected = scope) {
  let call = 0
  return runtime.exports.reviewedEmailAudienceUnderNativeControlWithClient({ query: async () => ({ rows: call++ ? rows : selected }) }, SCOPE.pipelineId)
}

await check('audience snapshot matches actual canonical helper, including owner override and native fingerprint', async () => {
  for (const rows of [[owner], [owner,reader], [{ ...owner,membership_permissions:{ viewCrm:false } }],
    [owner,{ ...reader,membership_role:'admin',membership_permissions:{} }]]) {
    const expected = await actualAudience(rows)
    const snapshot = audienceSnapshot(scope, rows)
    assert.deepEqual(snapshot.holds, [])
    assert.deepEqual(snapshot.audience, JSON.parse(JSON.stringify(expected)))
  }
})
await check('valid inactive denied and trashed members remain observed but are not effective readers', async () => {
  const variants = [{ status:'disabled' },{ status:'invited' },{ membership_status:'disabled' },{ membership_status:'invited' },
    { membership_trashed_at:'2026-10-30T12:00:00Z' },{ membership_permissions:{ viewCrm:false } },
    { membership_role:'admin',membership_permissions:{ viewCrm:false } }]
  for (const variant of variants) {
    const rows=[owner,{ ...reader,...variant }], before=JSON.stringify(rows)
    const expected=await actualAudience(rows), snapshot=audienceSnapshot(scope,rows)
    assert.deepEqual(snapshot.holds,[])
    assert.deepEqual(snapshot.audience,JSON.parse(JSON.stringify(expected)))
    assert.deepEqual(snapshot.audience.allowedSuiteCrmUserIds,['native-owner'])
    assert.equal(snapshot.readers.length,2)
    assert.equal(snapshot.readers[1].effectiveReader,false)
    assert.equal(snapshot.readers[1].eligibility,'excluded')
    assert.equal(JSON.stringify(rows),before)
  }
})
await check('explicit app-only sharing stays observed without native identities or duplicate NULL holds', async () => {
  const first={...reader,suitecrm_user_id:null,native_identity_count:0}
  const second={...first,email:'second-app-only@example.test'}
  for(const rows of [[owner,first],[owner,first,second],[owner,{...first,status:'disabled'}]]){
    const expected=await actualAudience(rows),snapshot=audienceSnapshot(scope,rows)
    assert.deepEqual(snapshot.holds,[])
    assert.deepEqual(snapshot.audience,JSON.parse(JSON.stringify(expected)))
    assert.deepEqual(snapshot.audience.allowedSuiteCrmUserIds,['native-owner'])
    assert.ok(snapshot.readers.slice(1).every(p=>p.eligibility==='app-only'&&!p.effectiveReader))
  }
  for(const native_identity_count of [undefined,null,'0',1,2]){
    const rows=[owner,{...first,native_identity_count}]
    await assert.rejects(actualAudience(rows));assert.ok(audienceSnapshot(scope,rows).holds.length)
  }
  for(const change of [{membership_permissions:null},{membership_role:'unknown'},{status:null}]){
    const rows=[owner,{...first,...change}]
    await assert.rejects(actualAudience(rows));assert.ok(audienceSnapshot(scope,rows).holds.length)
  }
  const appOwner=[{...owner,suitecrm_user_id:null,native_identity_count:0},reader]
  await assert.rejects(actualAudience(appOwner))
  assert.ok(audienceSnapshot(scope,appOwner).holds.includes('owner_native_identity_missing_or_ineligible'))
})
await check('missing malformed and ambiguous principals hold even when explicitly ineligible', async () => {
  const variants = [{ membership_trashed_at:'not-a-date' },{ membership_trashed_at:'' },{ membership_trashed_at:undefined },
    { status:null },{ status:'Inactive' },{ membership_status:null },{ membership_status:'unknown' },
    { membership_role:'unexpected' }, { membership_permissions:null },
    { membership_permissions:[] }, { membership_permissions:{ viewCrm:'false' } },
    { email:'Reader@example.test' },{ email:'reader@example.test\n' },
    { access_role:null }, { access_role:'owner' }, { suitecrm_user_id:null }, { suitecrm_user_id:'native-reader\n' },
    { suitecrm_user_id:'x'.repeat(37) },{ suitecrm_user_id:'native-owner' }, { native_identity_count:2 }]
  for (const baseline of [reader,{ ...reader,status:'disabled' },{ ...reader,membership_permissions:{ viewCrm:false } }]) for (const variant of variants) {
    const rows = [owner,{ ...baseline,...variant }]
    await assert.rejects(actualAudience(rows))
    assert.ok(audienceSnapshot(scope, rows).holds.length)
    assert.equal(audienceSnapshot(scope,rows).audience,null)
  }
  for (const rows of [[],[reader],[owner,reader,reader],[owner,reader,{ ...reader,suitecrm_user_id:'different-native' }]]) {
    await assert.rejects(actualAudience(rows)); assert.ok(audienceSnapshot(scope, rows).holds.length)
  }
})
await check('pipeline owner must be eligible and mapped even when other readers are valid', async () => {
  for (const variant of [{ status:'disabled' },{ status:'invited' },{ membership_status:'disabled' },
    { membership_trashed_at:'2026-10-30' },{ membership_role:'member',membership_permissions:{ viewCrm:false } },
    { suitecrm_user_id:'unexpected-owner' }]) {
    const rows=[{ ...owner,...variant },reader]
    await assert.rejects(actualAudience(rows))
    assert.equal(audienceSnapshot(scope,rows).audience,null)
    assert.ok(audienceSnapshot(scope,rows).holds.includes('owner_native_identity_missing_or_ineligible'))
  }
})
await check('per-message contact selection comes from actual headers, never inherited thread/contact allowlist', () => {
  assert.deepEqual(messagePlan(message,contacts,companies).reviewedAssociationDraft.contactReferences,['gc1','gc2'])
  const third = contact('3','b','another@example.test')
  const next = { ...message, message_id:SCOPE.messageIds[1], headers:{ version:1,from:[{ address:'globus@example.test' }],cc:[{ address:third.email }] } }
  assert.deepEqual(messagePlan(next,[...contacts,third],companies).reviewedAssociationDraft.contactReferences,['gc1','gc3'])
  assert.equal(messagePlan({ ...message,headers:{ version:1,from:[{ address:'globus@example.test' }] } },contacts,companies).reviewedAssociationDraft,null)
})
await check('foreign/duplicate mappings, wrong thread, invalid addresses, excluded labels and archive hold', () => {
  for (const [row, candidates, organizations] of [
    [message,[...contacts,{ ...contacts[0],id:'other',pipeline_id:'foreign' }],companies],
    [message,[...contacts,{ ...contacts[0],id:'duplicate' }],companies],
    [{ ...message,thread_id:'changed' },contacts,companies],
    [{ ...message,excluded_label:true },contacts,companies],
    [{ ...message,headers:{ version:1,from:[{ address:'BODY MUST NOT LEAK' }] } },contacts,companies],
    [message,contacts,[{ ...companies[0],active:false },companies[1]]],
  ]) assert.equal(messagePlan(row,candidates,organizations).reviewedAssociationDraft,null)
  assert.ok(!JSON.stringify(messagePlan({ ...message,headers:{ from:[{ address:'BODY MUST NOT LEAK' }] } },contacts,companies)).includes('BODY MUST NOT LEAK'))
})

const collectorSource = readFileSync(new URL('./inspect-bpo-email-recovery-readonly.cjs',import.meta.url),'utf8')
await check('inspection retains intended principals and only the five exact reviewed messages including Casey', () => {
  const match=collectorSource.match(/const readers = await q\(`([\s\S]*?)`, \[SCOPE.pipelineId\]\)/)
  assert.ok(match)
  const query=match[1]
  assert.match(query,/JOIN LATERAL \(SELECT p\.owner_email AS email UNION/)
  assert.match(query,/SELECT user_email FROM pipeline_space_members WHERE pipeline_id=p\.id/)
  assert.match(query,/LEFT JOIN app_users u ON u\.email=intended\.email/)
  assert.match(query,/LEFT JOIN app_user_organization_memberships m ON m\.user_email=intended\.email/)
  assert.match(query,/u\.status,m\.status AS membership_status/)
  assert.match(query,/ORDER BY intended\.email LIMIT 501/)
  assert.doesNotMatch(query,/\b(?:u|m)\.status\s*=|trashed_at\s+IS\s+NULL/i)
  assert.deepEqual(SCOPE.messageIds,['1a17e730c78d319c','1a17f5004f29592c','1a17f5d46a224e0a',
    '1a18e03ea586cd7e','1a18f01749eb87a6'])
  assert.equal(new Set(SCOPE.messageIds).size,5)
  assert.match(collectorSource,/m\.external_message_id=ANY\(\$2::text\[\]\).*LIMIT 6/)
  assert.match(collectorSource,/messages\.length !== SCOPE\.messageIds\.length/)
  assert.doesNotMatch(collectorSource,/exact_three_cached_messages/)
  assert.equal(SCOPE.threadId,'1a179e9e2743f926')
})
await check('standalone collector has no mutation/provider/body output paths and requires exact explicit environment', () => {
  assert.doesNotMatch(collectorSource, /\bfetch\s*\(|execFile|spawn\(|https?:\/\/|body_text|\bsnippet\b|SELECT\s+\*/i)
  // X.509 certificates have a subject too; the mail collectors still must not
  // select, read or output email subjects or bodies.
  assert.doesNotMatch([audienceSnapshot,messagePlan,collect].map(fn=>fn.toString()).join('\n'),/\bsubject\b|body_text|\bsnippet\b/i)
  assert.match(collectorSource,/REPEATABLE READ READ ONLY/)
  assert.match(collectorSource,/EXACT_PRODUCTION_ENVIRONMENT_REQUIRED/)
  assert.match(collectorSource,/EXPLICIT_READ_ONLY_MODE_REQUIRED/)
  assert.doesNotMatch(collectorSource,/expectedDigest\s*:/)
  assert.match(collectorSource,/apply: false/)
})
await check('missing schema returns bounded metadata hold and always rolls back', async () => {
  const statements = []
  const report = await collect({ query: async (sql) => {
    statements.push(sql)
    if (sql.startsWith('SELECT now()')) return { rows:[{ transaction_read_only:'on',isolation:'repeatable read' }] }
    return { rows:[] }
  } })
  assert.deepEqual(report.holds,['required_metadata_schema_missing'])
  assert.equal(report.rolledBack,true)
  assert.equal(report.previewRequestDraft,null)
  assert.equal(statements.at(-1),'ROLLBACK')
})
await check('query failure and row-bound overrun roll back rather than return partial success', async () => {
  for (const mode of ['failure','overflow']) {
    const statements = []
    await assert.rejects(collect({ query: async sql => {
      statements.push(sql)
      if (sql.startsWith('SELECT now()')) {
        if (mode==='failure') throw new Error('synthetic query failure')
        return { rows:[{},{}] }
      }
      return { rows:[] }
    } }))
    assert.equal(statements.at(-1),'ROLLBACK')
  }
})
await check('diagnostics distinguish safe runtime stages without returning arbitrary error messages or connection details',()=>{
  const secret='PRIVATE_DATABASE_TOKEN'
  const result=inspectionFailure({message:secret,code:'SELF_SIGNED_CERT_IN_CHAIN',detail:secret,connectionString:secret},'connect')
  assert.equal(result.inspectionStage,'connect');assert.equal(result.runtimeCode,'SELF_SIGNED_CERT_IN_CHAIN')
  assert.equal(result.errorCode,'READONLY_INSPECTION_FAILED');assert.equal(JSON.stringify(result).includes(secret),false)
  assert.equal(inspectionFailure({message:secret,code:secret},secret).inspectionStage,'unverified')
  assert.equal(inspectionFailure({message:secret,code:secret},'metadata').runtimeCode,null)
  assert.equal(inspectionFailure({message:'EXACT_PRODUCTION_ENVIRONMENT_REQUIRED'},'environment').errorCode,'EXACT_PRODUCTION_ENVIRONMENT_REQUIRED')
  assert.equal(inspectionFailure({message:secret,code:'42703'},'metadata').databaseCode,'42703')
})
console.log(`BPO recovery metadata collector passed ${checks} local synthetic/source checks. No database, provider, login or recovery executed.`)
