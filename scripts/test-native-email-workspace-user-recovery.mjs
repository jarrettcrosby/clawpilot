#!/usr/bin/env node
// Actual recovery + immutable plan/typed lifecycle validators. Query and runtime
// are mocked: no database authorization, native execution or production proof.
import assert from 'node:assert/strict'
import * as crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'

const ts = createRequire(new URL('../app_src/package.json', import.meta.url))('typescript')
const source = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8')
function load(path, dependencies) {
  const module = { exports: {} }
  const compiled = ts.transpileModule(source(path), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText
  new Function('module', 'exports', 'require', compiled)(module, module.exports, name => {
    assert.ok(Object.hasOwn(dependencies, name), 'Unmocked dependency ' + name)
    return dependencies[name]
  })
  return module.exports
}
const protocol = load('app_src/lib/crm/nativeEmailPublication.ts', { 'node:crypto': crypto })
const projection = load('app_src/lib/crm/suiteCrmNativeEmailProjection.ts', { 'node:crypto': crypto })
const capability = load('app_src/lib/crm/nativeEmailCapabilityContract.ts', {
  'node:crypto': crypto, './nativeEmailPublication': protocol,
})
const authority = load('app_src/lib/crm/nativeEmailAuthorityTransition.ts', {
  './nativeEmailPublication': protocol, './suiteCrmNativeEmailProjection': projection,
  './nativeEmailCapabilityContract': capability,
})
const contract = load('app_src/lib/crm/nativeEmailWorkspaceUserEligibility.ts', { './nativeEmailPublication': protocol })
const identityContract=load('app_src/lib/crm/nativeEmailIdentityLinkChange.ts',{
  './nativeEmailPublication':protocol,'./nativeEmailWorkspaceUserEligibility':contract,
})
const fixture = JSON.parse(execFileSync(process.execPath, ['scripts/test-native-email-authority-v2.mjs', '--emit-fixture'], {
  encoding: 'utf8',
}))
const clone = value => JSON.parse(JSON.stringify(value))
const json = contract.nativeEmailEligibilityRowJson
const actor = 'owner@example.test', user = 'reader@example.test'
const workspace = fixture.plan.revoke.bindings[0].before.workspace_id
const parent = '00000000-0000-4000-8000-000000000099'
const transitionId = fixture.plan.revoke.transitionId
class Pending extends Error {
  status = 409
  code = 'CRM_ACCESS_CHANGE_PENDING'
  constructor(id = null) { super('CRM access change is pending'); this.transitionId = id }
}

function desired(action = { kind: 'status', status: 'disabled' }, sourceWorkspace = workspace) {
  const identity = { email: user, status: 'active', suitecrm_user_id: 'reader-a', role: 'member',
    permissions: {}, organization_id: workspace }
  const membership = { user_email: user, organization_id: workspace, status: 'active', role: 'member',
    permissions: { viewCrm: true }, trashed_at: null, trashed_by: null, pre_trash_status: null }
  let before = membership, after = { ...membership, status: 'disabled' }
  if (action.kind === 'access') after = { ...membership, role: action.role, permissions: action.permissions }
  if (action.kind === 'trash') {
    const trashed = { ...membership, status: 'disabled', trashed_at: '2026-10-30T12:00:00+00:00',
      trashed_by: actor, pre_trash_status: 'active' }
    before = action.trashed ? membership : trashed
    after = action.trashed ? trashed : membership
  }
  const path = sourceWorkspace === workspace ? [{ id: workspace, parent_id: null, is_demo: false }]
    : [{ id: workspace, parent_id: sourceWorkspace, is_demo: false }, { id: sourceWorkspace, parent_id: null, is_demo: false }]
  return contract.prepareNativeEmailWorkspaceUserEligibilityChange({
    kind: 'workspace_user_eligibility_v1', ...contract.normalizeNativeEmailWorkspaceUserEligibilityRequest({
      workspaceId: workspace, userEmail: user, action,
    }), actorScope: { workspaceId: sourceWorkspace, ancestryJson: json(path) }, pipelineIntentFingerprint: 'a'.repeat(64),
    appUser: { beforeJson: json({ ...identity, status: before.status }), afterJson: json({ ...identity, status: after.status }) },
    membership: { beforeJson: json(before), afterJson: json(after) }, demoMembership: null, restoreFrom: null,
  })
}
function planFor(change) {
  const { planHash: _discard, ...input } = clone(fixture.plan)
  input.desiredAppChange = change
  input.revoke.desiredAppChangeHash = input.grant.desiredAppChangeHash = protocol.nativeEmailDigest(change)
  if(change.kind==='user_identity_link_v1')for(const phase of ['revoke','grant'])input[phase].identityLinks=[clone(change.nativeIdentity)]
  return authority.prepareNativeEmailAuthorityTransition(input)
}
function identityDesired(sourceWorkspace=workspace){
  const before={email:user,status:'active',suitecrm_user_id:null,suitecrm_username:null,role:'member',permissions:{},
    organization_id:workspace,reference_code:'gu1234567',crm_user_enabled:true}
  return identityContract.prepareNativeEmailUserIdentityLinkChange({kind:'user_identity_link_v1',workspaceId:workspace,
    userEmail:user,actorScope:desired(undefined,sourceWorkspace).actorScope,contextFingerprint:'b'.repeat(64),
    appUser:{beforeJson:json(before),afterJson:json({...before,suitecrm_user_id:'reader-a',suitecrm_username:'gu1234567'})},
    nativeIdentity:{userId:'reader-a',globalId:'gu1234567',username:'gu1234567'}})
}
function rowFor(change = desired()) {
  const plan = planFor(change)
  return { enabled: true, active_transition_id: transitionId, active_operation_id: null,
    transition_id: transitionId, actor_email: actor, plan_hash: plan.planHash, plan }
}
function harness(options = {}) {
  const calls = [], identityCalls=[], queries = []
  const rows = Object.hasOwn(options, 'rows') ? options.rows : [rowFor(options.change)]
  const recovery = load('app_src/lib/crm/nativeEmailWorkspaceUserRecovery.ts', {
    '../persistence/postgres': { query: async (sql, values) => {
      queries.push({ sql, values })
      if (options.queryError) throw Error('private SQL credential diagnostic')
      return { rows }
    } },
    './nativeEmailPublication': protocol, './nativeEmailAuthorityTransition': authority,
    './nativeEmailWorkspaceUserEligibility': contract,
    './nativeEmailIdentityLinkChange':identityContract,
    './nativeEmailAuthorityRuntime': { NativeEmailAccessPendingError: Pending },
    './nativeEmailWorkspaceUserRuntime': { changeWorkspaceUserWithNativeAuthority: async (...args) => {
      calls.push(args)
      if (options.runtimeError) throw options.runtimeError
      return Object.hasOwn(options, 'result') ? options.result : true
    },resumePendingExistingUserIdentityWithNativeAuthority:async(...args)=>{
      identityCalls.push(args)
      if(options.runtimeError)throw options.runtimeError
      return Object.hasOwn(options,'result')?options.result:true
    } },
  })
  return { ...recovery, queries, calls,identityCalls }
}
const safePending = id => error => error instanceof Pending && error.status === 409
  && error.code === 'CRM_ACCESS_CHANGE_PENDING' && error.transitionId === id
  && error.message === 'CRM access change is pending'
let checks = 0
async function check(label, fn) { await fn(); checks++; console.log('PASS ' + label) }

await check('no active owned lifecycle returns null without invoking runtime', async () => {
  for (const rows of [[], [{ ...rowFor(), enabled: false }], [{ ...rowFor(), active_transition_id: null }],
    [{ ...rowFor(), actor_email: 'other@example.test' }], [{ ...rowFor(), plan: fixture.plan }],
    [rowFor(desired(undefined, parent))]]) {
    const h = harness({ rows })
    assert.equal(await h.getPendingWorkspaceUserAuthorityChange(actor, workspace), null)
    assert.equal(h.calls.length, 0)
  }
})
await check('owned discovery exposes only frozen bounded scope and performs one read-only query', async () => {
  const h = harness()
  const pending = await h.getPendingWorkspaceUserAuthorityChange(actor, workspace)
  assert.deepEqual(pending, { transitionId, userEmail: user, workspaceId: workspace, actionKind: 'status' })
  assert.ok(Object.isFrozen(pending))
  assert.equal(h.queries.length, 1); assert.equal(h.calls.length, 0)
  const { sql, values } = h.queries[0]
  assert.deepEqual(values, [actor, workspace])
  assert.match(sql, /^SELECT /)
  assert.doesNotMatch(sql, /\b(?:FOR UPDATE|INSERT|UPDATE|DELETE|pg_advisory|LOCK)\b/i)
  for (const required of ["actor.status='active'", "m.status='active'", 'm.trashed_at IS NULL',
    "m.role='owner'", "m.role='admin'", "m.permissions->'manageUserAccess'='true'::jsonb",
    'NOT source.is_demo', 't.actor_email=$1', "->>'workspaceId'=$2::text", 'LIMIT 1']) assert.ok(sql.includes(required), required)
  assert.doesNotMatch(JSON.stringify(pending), /native|capabilities|permissions|reader-a|beforeJson|planHash/)
})
await check('parent manager recovers only original selected source while target remains descendant', async () => {
  const h = harness({ change: desired(undefined, parent) })
  const pending = await h.getPendingWorkspaceUserAuthorityChange(actor, parent)
  assert.equal(pending.workspaceId, workspace)
  assert.equal(await h.getPendingWorkspaceUserAuthorityChange(actor, workspace), null)
  await h.resumeWorkspaceUserAuthorityChange(actor, parent, transitionId)
  assert.equal(h.calls[0][1].workspaceId, workspace); assert.equal(h.calls[0][2], parent)
})
await check('plan hashes command scope and active operation mismatches fail closed without execution', async () => {
  const changes = [v => { v.plan_hash = 'f'.repeat(64) }, v => { v.plan.planHash = 'f'.repeat(64) },
    v => { v.active_transition_id = 'f'.repeat(64) }, v => { v.transition_id = 'f'.repeat(64) },
    v => { v.active_operation_id = 'f'.repeat(64) }, v => { v.plan.grant.desiredAppChangeHash = 'f'.repeat(64) },
    v => { v.plan.revoke.operationId = 'invalid' }, v => { v.plan.extra = true }, v => { v.plan = [] }]
  for (const mutate of changes) {
    const row = clone(rowFor()); mutate(row)
    const h = harness({ rows: [row] })
    await assert.rejects(() => h.getPendingWorkspaceUserAuthorityChange(actor, workspace), safePending(null))
    await assert.rejects(() => h.resumeWorkspaceUserAuthorityChange(actor, workspace, transitionId), safePending(null))
    assert.equal(h.calls.length, 0)
  }
})
await check('rehashing malformed typed lifecycle cannot bypass exact action and identity validation', async () => {
  for (const mutate of [v => { v.extra = true }, v => { v.membership.afterJson = v.membership.beforeJson },
    v => { v.appUser.afterJson = json({ ...JSON.parse(v.appUser.afterJson), suitecrm_user_id: 'someone-else' }) },
    v => { v.actorScope.ancestryJson = json([{ id: parent, parent_id: null, is_demo: false }]) }]) {
    const change = desired(); mutate(change)
    const h = harness({ rows: [rowFor(change)] })
    await assert.rejects(() => h.resumeWorkspaceUserAuthorityChange(actor, workspace, transitionId), safePending(null))
    assert.equal(h.calls.length, 0)
  }
})
await check('malformed identity is rejected before any query or runtime call', async () => {
  for (const [email, selected] of [['Owner@example.test', workspace], [actor + '\n', workspace], [actor, workspace + '\n'], [actor, '']]) {
    const h = harness()
    await assert.rejects(() => h.getPendingWorkspaceUserAuthorityChange(email, selected), safePending(null))
    assert.equal(h.queries.length, 0); assert.equal(h.calls.length, 0)
  }
  for (const id of [transitionId + '\n', 'bad', null]) {
    const h = harness()
    await assert.rejects(() => h.resumeWorkspaceUserAuthorityChange(actor, workspace, id), safePending(null))
    assert.equal(h.queries.length, 0); assert.equal(h.calls.length, 0)
  }
})
await check('resume reconstructs exact status trash restore and access actions with expected transition fence', async () => {
  for (const action of [{ kind: 'status', status: 'disabled' }, { kind: 'trash', trashed: true },
    { kind: 'trash', trashed: false }, { kind: 'access', role: 'admin', permissions: { viewCrm: false, viewPos: true } }]) {
    const h = harness({ change: desired(action) })
    const result = await h.resumeWorkspaceUserAuthorityChange(actor, workspace, transitionId,
      { action: { kind: 'access', role: 'owner', permissions: { manageUserAccess: true } } })
    assert.deepEqual(h.calls, [[actor, { workspaceId: workspace, userEmail: user, action }, workspace, transitionId]])
    assert.deepEqual(result, { userEmail: user, workspaceId: workspace }); assert.ok(Object.isFrozen(result))
  }
})
await check('unowned unrelated or completed request cannot invoke global resume or leak active identity', async () => {
  for (const options of [{ rows: [] }, { rows: [{ ...rowFor(), actor_email: 'other@example.test' }] },
    { rows: [{ ...rowFor(), plan: fixture.plan }] }, { change: desired(undefined, parent) }]) {
    const h = harness(options)
    await assert.rejects(() => h.resumeWorkspaceUserAuthorityChange(actor, workspace, transitionId), safePending(null))
    assert.equal(h.calls.length, 0)
  }
  const h = harness()
  await assert.rejects(() => h.resumeWorkspaceUserAuthorityChange(actor, workspace, 'f'.repeat(64)), safePending(null))
  assert.equal(h.calls.length, 0)
})
await check('only strict runtime confirmation succeeds and all diagnostics remain sanitized', async () => {
  for (const result of [false, undefined, null, 1, 'true']) {
    const h = harness({ result })
    await assert.rejects(() => h.resumeWorkspaceUserAuthorityChange(actor, workspace, transitionId), safePending(transitionId))
    assert.equal(h.calls.length, 1)
  }
  for (const runtimeError of [new Error('private provider credential'), new Pending('f'.repeat(64))]) {
    const h = harness({ runtimeError })
    await assert.rejects(() => h.resumeWorkspaceUserAuthorityChange(actor, workspace, transitionId), safePending(transitionId))
  }
  const h = harness({ queryError: true })
  await assert.rejects(() => h.getPendingWorkspaceUserAuthorityChange(actor, workspace), safePending(null))
  await assert.rejects(() => h.resumeWorkspaceUserAuthorityChange(actor, workspace, transitionId), safePending(null))
  assert.equal(h.calls.length, 0)
})

await check('existing-identity links appear in the same owned saved-change banner without exposing native evidence',async()=>{
  const h=harness({change:identityDesired()})
  const pending=await h.getPendingWorkspaceUserAuthorityChange(actor,workspace)
  assert.deepEqual(pending,{transitionId,userEmail:user,workspaceId:workspace,actionKind:'identity_link'})
  assert.ok(Object.isFrozen(pending));assert.equal(h.queries.length,1)
  assert.equal(h.calls.length,0);assert.equal(h.identityCalls.length,0)
  assert.ok(h.queries[0].sql.includes("'user_identity_link_v1'"))
  assert.doesNotMatch(JSON.stringify(pending),/reader-a|gu1234567|nativeIdentity|beforeJson|contextFingerprint/)
})
await check('identity Resume sends only the owned saved selection to the receipt resumer, never form-supplied identity state',async()=>{
  const h=harness({change:identityDesired(parent)})
  assert.equal(await h.getPendingWorkspaceUserAuthorityChange(actor,workspace),null)
  const result=await h.resumeWorkspaceUserAuthorityChange(actor,parent,transitionId,{nativeIdentity:{userId:'attacker'}})
  assert.deepEqual(h.identityCalls,[[actor,workspace,user,transitionId,parent]])
  assert.equal(h.calls.length,0);assert.deepEqual(result,{userEmail:user,workspaceId:workspace})
})
await check('unowned malformed or unconfirmed identity recovery cannot publish an ID or claim success',async()=>{
  for(const rows of [[],[{...rowFor(identityDesired()),actor_email:'other@example.test'}],
    [rowFor(identityDesired(parent))]]){
    const h=harness({rows})
    await assert.rejects(()=>h.resumeWorkspaceUserAuthorityChange(actor,workspace,transitionId),safePending(null))
    assert.equal(h.identityCalls.length,0);assert.equal(h.calls.length,0)
  }
  const malformed=clone(identityDesired());malformed.appUser.afterJson=json({...JSON.parse(malformed.appUser.afterJson),role:'owner'})
  const h=harness({rows:[rowFor(malformed)]})
  await assert.rejects(()=>h.resumeWorkspaceUserAuthorityChange(actor,workspace,transitionId),safePending(null))
  assert.equal(h.identityCalls.length,0)
  for(const options of [{result:false},{runtimeError:new Error('private native credential')},
    {runtimeError:new Pending('f'.repeat(64))}]){
    const held=harness({...options,change:identityDesired()})
    await assert.rejects(()=>held.resumeWorkspaceUserAuthorityChange(actor,workspace,transitionId),safePending(transitionId))
    assert.equal(held.calls.length,0);assert.equal(held.identityCalls.length,1)
  }
})
console.log(`PASS ${checks} bounded workspace-user recovery groups; mocked query/runtime, no SQL/native/production proof`)
