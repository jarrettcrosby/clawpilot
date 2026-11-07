#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'
import vm from 'node:vm'
const require = createRequire(import.meta.url)
const { SCOPE, audienceSnapshot, messagePlan, reviewedPreviewRequestDrafts, collect, inspectionFailure } = require('./inspect-bpo-email-recovery-readonly.cjs')
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
await check('five observed messages produce only separate unsigned three-plus-two preview drafts', () => {
  const caches = ['legacy-one','legacy-two','legacy-three','756e4e17-2458-470b-b00c-129c85ee821a','78a5b2cc-ba50-4a71-a17c-adaf0c1041c2']
  const rows = SCOPE.messageIds.map((messageId,index)=>({ messageId,threadId:SCOPE.threadId,cacheId:caches[index],
    intakePipelineId:'0ce9d945-0b71-495b-88ef-420ddd51fd9c',holds:[],reviewedAssociationDraft:{
      messageId,threadId:SCOPE.threadId,primaryOrganizationReference:SCOPE.primaryOrganizationReference,
      contactReferences:['gc0000001','gc0000002'] } }))
  const drafts = reviewedPreviewRequestDrafts(rows)
  assert.equal(drafts.length,2)
  assert.deepEqual(drafts[0].body.messageIds,SCOPE.messageIds.slice(0,3)); assert.equal(drafts[0].body.admissionScope,undefined)
  assert.deepEqual(drafts[1].body.messageIds,SCOPE.messageIds.slice(3)); assert.equal(drafts[1].body.admissionScope,'casey-reviewed-two-v1')
  for(const draft of drafts){assert.equal(draft.body.apply,false);assert.equal(draft.body.decisionKind,'review')
    assert.equal(draft.body.expectedDigest,undefined);assert.equal(draft.body.messageIds.length,draft.body.reviewedAssociations.length)}
  for(const changed of [rows.slice(0,4),[...rows,rows[0]],[...rows.slice(0,4),rows[0]],
    rows.map((row,index)=>index===3?{...row,cacheId:'changed-cache'}:row),
    rows.map((row,index)=>index===4?{...row,intakePipelineId:'changed-intake'}:row),
    rows.map((row,index)=>index===4?{...row,reviewedAssociationDraft:{...row.reviewedAssociationDraft,messageId:rows[0].messageId}}:row),
    rows.map((row,index)=>index===4?{...row,reviewedAssociationDraft:{...row.reviewedAssociationDraft,contactReferences:[]}}:row)]){
    assert.deepEqual(reviewedPreviewRequestDrafts(changed),[])
  }
  assert.match(collectorSource,/previewRequestDraft: null, previewRequestDrafts: \[\]/)
})
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
await check('metadata preflight fails closed on aliases of the five exact reviewed provider IDs', async () => {
  const keys = ['cache_alias','interaction_alias','canonical_source_alias']
  const clean = Object.fromEntries(keys.map(key=>[key,false]))
  for (const alias of [null,...keys,'unknown']) {
    const statements = []
    const report = await collect({ query: async (sql, values) => {
      statements.push(sql)
      if (sql.startsWith('SELECT now()')) return { rows:[{ transaction_read_only:'on',isolation:'repeatable read' }] }
      if (sql.includes('FROM information_schema.tables')) return { rows:values[0].map(table_name=>({table_name})) }
      if (sql.includes('AS cache_alias')) {
        assert.deepEqual(values,[SCOPE.ownerEmail,SCOPE.messageIds])
        for (const [table,column] of [['m','external_message_id'],['i','provider_message_id'],['s','provider_message_id']]) {
          assert.ok(sql.includes(`lower(btrim(${table}.${column}))=ANY($2::text[])`))
          assert.ok(sql.includes(`NOT (${table}.${column}=ANY($2::text[]))`))
        }
        assert.match(sql,/m\.owner_email=\$1[\s\S]+p\.owner_email=\$1[\s\S]+s\.owner_email=\$1/)
        return { rows:alias==='unknown'?[]:[{...clean,...(alias?{[alias]:true}:{})}] }
      }
      return { rows:[] }
    } })
    const expected = (alias==='unknown'?keys:alias?[alias]:[]).map(key=>`reviewed_provider_identity_conflict:${key}`).sort()
    assert.deepEqual(report.holds.filter(hold=>hold.startsWith('reviewed_provider_identity_conflict:')),expected)
    assert.equal(report.rolledBack,true)
    assert.equal(statements.at(-1),'ROLLBACK')
  }
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
const wrapperSource=readFileSync(new URL('./run-bpo-email-recovery-readonly.mjs',import.meta.url),'utf8')
const wrapperDeclarations=declaration('scripts/run-bpo-email-recovery-readonly.mjs',
  ['DEFAULT_RAILWAY_BINARY','RAILWAY_HASH','readOnlyOptions','verifiedRailwayBinary'])
const binaryBytes=Buffer.from('synthetic reviewed CLI bytes, never executed')
const binarySha=createHash('sha256').update(binaryBytes).digest('hex')
const reviewedBinary='/reviewed/private/railway'
function wrapperFixture(args,options={}) {
  const calls=[],writes=[],logs=[],reads=[]
  let binaryReads=0
  const fakeProcess={argv:['node','run-bpo-email-recovery-readonly.mjs',...args],getuid:()=>1000,exitCode:undefined}
  const defaultAlias='/opt/homebrew/bin/railway',defaultCanonical='/reviewed/private/default-railway'
  const stat=()=>({uid:options.foreignOwner?2000:1000,mode:options.writable?0o100777:0o100755,
    size:binaryBytes.length,isFile:()=>!options.notFile,isSymbolicLink:()=>Boolean(options.symlink)})
  const files={lstatSync:()=>{
    if(options.missingFile)throw new Error('PRIVATE_FILE_PATH_ERROR')
    return stat()
  },realpathSync:path=>path===defaultAlias?defaultCanonical:options.symlink?'/another/railway':path,
  readFileSync:(path)=>{
    if(path instanceof URL)return '#!/usr/bin/env node\n// SELECT-only collector fixture; not executed\n'
    reads.push(path);binaryReads++
    return options.changedAt===binaryReads?Buffer.from('different CLI bytes'):binaryBytes
  },writeFileSync:(path,bytes,flags)=>writes.push({path,document:JSON.parse(bytes),flags})}
  const collector={SCOPE,validateReadOnlyPostgresTrust:bundle=>{
    assert.equal(bundle.projectId,SCOPE.projectId);assert.equal(bundle.environmentId,SCOPE.environmentId);assert.equal(bundle.service,'Postgres')
    return {leafFingerprint256:'fixture-leaf',rootFingerprint256:'fixture-root',serverName:'fixture-postgres'}
  }}
  const execFileSync=(program,argv,opts)=>{
    calls.push({program,argv,opts})
    if(options.transportFailure){const error=new Error('PRIVATE_TRANSPORT_ERROR');error.stderr='PRIVATE_SECRET unauthorized';throw error}
    if(calls.length===1)return options.invalidCertificates?'no certificates':
      '-----BEGIN CERTIFICATE-----\nQQ==\n-----END CERTIFICATE-----\n-----BEGIN CERTIFICATE-----\nQg==\n-----END CERTIFICATE-----'
    return JSON.stringify({failed:false,kind:'bpo-exact-email-recovery-readonly-v1',readOnly:true,rolledBack:true,
      messages:[],interactions:[],holds:[],previewRequestDraft:null})
  }
  const mocks={'node:fs':files,'node:child_process':{execFileSync},'node:crypto':require('node:crypto'),
    'node:path':require('node:path'),'node:url':require('node:url'),'node:module':{createRequire:()=>name=>{
      assert.equal(name,'./inspect-bpo-email-recovery-readonly.cjs');return collector
    }}}
  const code=ts.transpileModule(wrapperSource.replace(/^#![^\n]*\n/u,'').replaceAll('import.meta.url',JSON.stringify(new URL('./run-bpo-email-recovery-readonly.mjs',import.meta.url).href)),
    {fileName:'run-bpo-email-recovery-readonly.ts',compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText
  let error
  try {new Function('require','module','exports','process','console',code)(name=>{
    assert.ok(Object.hasOwn(mocks,name),'Unexpected wrapper dependency: '+name);return mocks[name]
  },{exports:{}},{},fakeProcess,{log:line=>logs.push(line)})}catch(caught){error=caught}
  return {calls,writes,logs,reads,process:fakeProcess,error}
}
await check('wrapper accepts only exact read-only plus complete explicit binary/hash pairs',()=>{
  const context={isAbsolute,createHash,process:{getuid:()=>1000}}
  vm.runInNewContext(wrapperDeclarations+'\nglobalThis.options=readOnlyOptions;',context)
  const plain=value=>JSON.parse(JSON.stringify(value))
  assert.deepEqual(plain(context.options(['--read-only'])),{binary:'/opt/homebrew/bin/railway',sha256:null,explicit:false})
  const pair=[`--railway-binary=${reviewedBinary}`,`--railway-sha256=${binarySha}`]
  assert.deepEqual(plain(context.options([...pair,'--read-only'])),{binary:reviewedBinary,sha256:binarySha,explicit:true})
  for(const args of [[],pair,['--read-only=true'],['--read-only','--apply'],['--read-only','--public'],
    ['--read-only','--read-only'],['--read-only',pair[0]],['--read-only',pair[1]],['--read-only','--railway-binary'],
    ['--read-only',...pair,pair[0]],['--read-only',...pair,pair[1]],['--read-only',`--railway-binary=relative-cli`,pair[1]],
    ['--read-only','--railway-binary=/private/cli\n',pair[1]],['--read-only',pair[0],'--railway-sha256=bad'],
    ['--read-only',pair[0],`--railway-sha256=${binarySha.toUpperCase()}`]]) {
    const result=wrapperFixture(args)
    assert.match(result.error?.message||'',/Explicit --read-only/);assert.equal(result.calls.length+result.writes.length+result.reads.length,0)
  }
})
await check('explicit protected CLI is rehashed before both fixed-scope SSH steps and retained only in private evidence',()=>{
  const result=wrapperFixture(['--read-only',`--railway-binary=${reviewedBinary}`,`--railway-sha256=${binarySha}`])
  assert.equal(result.error,undefined);assert.equal(result.calls.length,2);assert.equal(result.reads.length,3)
  for(const call of result.calls){assert.equal(call.program,reviewedBinary);assert.equal(call.argv[0],'ssh')
    assert.equal(call.argv[call.argv.indexOf('-p')+1],SCOPE.projectId);assert.equal(call.argv[call.argv.indexOf('-e')+1],SCOPE.environmentId)}
  assert.equal(result.calls[0].argv[result.calls[0].argv.indexOf('-s')+1],'Postgres')
  assert.equal(result.calls[1].argv[result.calls[1].argv.indexOf('-s')+1],'clawpilot')
  assert.match(result.calls[1].argv.at(-1),/CLAWPILOT_BPO_READONLY_TLS_TRUST=[\s\S]* -- --read-only$/)
  assert.equal(result.writes.length,1);assert.deepEqual(result.writes[0].flags,{flag:'wx',mode:0o600})
  assert.deepEqual(result.writes[0].document.railwayCli,{binary:reviewedBinary,sha256:binarySha,selection:'explicit-hash-pin'})
  assert.equal(result.writes[0].document.tlsTrust.source,'authenticated-exact-service-ssh')
  assert.equal(result.writes[0].document.result.failed,false)
  assert.ok(!result.logs[0].includes(reviewedBinary)&&!result.logs[0].includes(binarySha))
})
await check('explicit CLI symlink writable foreign non-file missing and hash mismatches hold before any SSH',()=>{
  const args=['--read-only',`--railway-binary=${reviewedBinary}`,`--railway-sha256=${binarySha}`]
  for(const options of [{symlink:true},{writable:true},{foreignOwner:true},{notFile:true},{missingFile:true},{changedAt:1},{changedAt:2}]){
    const result=wrapperFixture(args,options)
    assert.equal(result.error,undefined);assert.equal(result.calls.length,0)
    assert.equal(result.writes.length,1);assert.equal(result.process.exitCode,1)
    assert.match(result.writes[0].document.result.errorCode,/READONLY_RAILWAY_BINARY_(?:INVALID|CHANGED)/)
    assert.equal(result.writes[0].document.result.diagnostic,'railway-binary-guard')
    assert.ok(!JSON.stringify(result.logs).includes('PRIVATE_FILE_PATH_ERROR'))
  }
  const changed=wrapperFixture(args,{changedAt:3})
  assert.equal(changed.calls.length,1,'A changed binary after certificate collection must never run the app collector')
  assert.equal(changed.writes[0].document.result.errorCode,'READONLY_RAILWAY_BINARY_CHANGED')
})
await check('default Homebrew alias stays compatible but its resolved bytes are pinned for both calls',()=>{
  const result=wrapperFixture(['--read-only'])
  assert.equal(result.error,undefined);assert.equal(result.calls.length,2)
  assert.ok(result.calls.every(call=>call.program==='/reviewed/private/default-railway'))
  assert.deepEqual(result.writes[0].document.railwayCli,{binary:'/reviewed/private/default-railway',sha256:binarySha,selection:'observed-default'})
  const changed=wrapperFixture(['--read-only'],{changedAt:3})
  assert.equal(changed.calls.length,1);assert.equal(changed.writes[0].document.result.errorCode,'READONLY_RAILWAY_BINARY_CHANGED')
})
await check('CLI choice never weakens TLS certificate gating or transport diagnostics',()=>{
  const args=['--read-only',`--railway-binary=${reviewedBinary}`,`--railway-sha256=${binarySha}`]
  const certificates=wrapperFixture(args,{invalidCertificates:true})
  assert.equal(certificates.calls.length,1);assert.equal(certificates.writes[0].document.result.errorCode,'READONLY_TLS_TRUST_INVALID')
  const transport=wrapperFixture(args,{transportFailure:true})
  assert.equal(transport.calls.length,1);assert.equal(transport.writes[0].document.result.errorCode,'READONLY_TRANSPORT_FAILED')
  assert.equal(transport.writes[0].document.result.diagnostic,'authentication-unavailable')
  assert.ok(!JSON.stringify(transport.writes).includes('PRIVATE_SECRET')&&!JSON.stringify(transport.logs).includes('PRIVATE_TRANSPORT_ERROR'))
  assert.doesNotMatch(wrapperSource,/rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED|npm\s+(?:install|update)|shell\s*:\s*true|\b(?:spawnSync|execSync)\(/)
})
console.log(`BPO recovery metadata collector passed ${checks} local synthetic/source checks. No database, provider, login or recovery executed.`)
